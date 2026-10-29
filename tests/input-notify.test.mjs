import assert from "node:assert/strict"
import test from "node:test"
import { incomingFixture, incomingBase, incomingUser } from "./helpers/qqbot-fixture.mjs"

function loaderFixture(entries) {
  return {
    priority: entries.map((plugin, index) => ({ name: `plugin-${index}`, class: plugin })),
    async deal(event) {
      const instances = this.priority.map(entry => new entry.class(event))
      for (const plugin of instances) {
        if (plugin.accept) await plugin.accept(event)
      }
      for (const plugin of instances) {
        if (plugin.getContext) {
          const context = { ...plugin.getContext(), ...plugin.getContext(false, true) }
          for (const [name, value] of Object.entries(context)) if (value) await plugin[name](value)
        }
      }
      for (const plugin of instances) {
        for (const rule of plugin.rule || []) {
          if (!new RegExp(rule.reg).test(event.msg)) continue
          if (event.permissionDenied) return "denied"
          await plugin[rule.fnc](event)
        }
      }
      return "done"
    },
  }
}

test("实际规则、accept 和上下文方法才触发插件处理回调，私有字段和返回值不变", async t => {
  const f = await incomingFixture(t)
  const { dispatchWithPluginActivity } = (await f.load("lib/utils/plugin-activity.js")).namespace
  const calls = []
  class Rule {
    #value = "private-ok"
    constructor() { this.rule = [{ reg: "^test$", fnc: "run" }] }
    run() { calls.push("rule"); return this.#value }
  }
  class Accept {
    accept() { calls.push("accept"); return true }
  }
  class Context {
    getContext() { return { check: true } }
    check(value) { calls.push(["context", value]); return "continue" }
  }
  const loader = loaderFixture([Rule, Accept, Context])
  const originalClass = loader.priority[0].class
  const observed = []
  const result = await dispatchWithPluginActivity(loader, { msg: "test" }, () => observed.push("handled"))
  assert.equal(result, "done")
  assert.equal(loader.priority[0].class, originalClass)
  assert.deepEqual(observed, ["handled"])
  assert.equal(calls.length, 3)
  const contextCall = calls.find(call => Array.isArray(call))
  assert.equal(contextCall[0], "context")
  assert.equal(contextCall[1], true)
})

test("仅构造、规则未命中和权限拒绝不触发输入回调，多方法也只触发一次", async t => {
  const f = await incomingFixture(t)
  const { dispatchWithPluginActivity } = (await f.load("lib/utils/plugin-activity.js")).namespace
  let constructed = 0
  class Plugin {
    constructor() { constructed++; this.rule = [{ reg: "match", fnc: "run" }] }
    run() {}
  }
  for (const event of [{ msg: "other" }, { msg: "match", permissionDenied: true }]) {
    let handled = 0
    await dispatchWithPluginActivity(loaderFixture([Plugin]), event, () => handled++)
    assert.equal(handled, 0)
  }
  assert.equal(constructed, 2)
})

test("C2C 输入状态使用官方 msg_type=6，时长限制且失败不影响调用", async t => {
  const f = await incomingFixture(t)
  const event = await f.receive("C2C_MESSAGE_CREATE", {
    id: "typing-message", content: "处理", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "Alice" },
  })
  const posts = []
  f.sdk.request.post = async (url, payload) => {
    posts.push({ url, payload })
    return { data: {} }
  }
  f.config.inputNotify = true
  f.config.inputNotifySeconds = 90
  assert.equal(await f.adapter.sendInputNotify(event), true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, `/v2/users/${incomingUser}/messages`)
  assert.equal(posts[0].payload.msg_type, 6)
  assert.equal(posts[0].payload.input_notify.input_second, 60)
  assert.equal(posts[0].payload.msg_id, "typing-message")

  f.sdk.request.post = async () => { throw new Error("denied") }
  assert.equal(await f.adapter.sendInputNotify(event), false)
})

test("开关关闭、群消息和无消息 ID 不发送输入状态", async t => {
  const f = await incomingFixture(t)
  let calls = 0
  f.sdk.request.post = async () => { calls++; return { data: {} } }
  const privateEvent = await f.receive("C2C_MESSAGE_CREATE", {
    id: "private-off", content: "", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "Alice" },
  })
  f.config.inputNotify = false
  assert.equal(await f.adapter.sendInputNotify(privateEvent), false)
  f.config.inputNotify = true
  assert.equal(await f.adapter.sendInputNotify({ ...privateEvent, message_id: "" }), false)
  const groupEvent = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "group-off" })
  assert.equal(await f.adapter.sendInputNotify(groupEvent), false)
  assert.equal(calls, 0)
})
