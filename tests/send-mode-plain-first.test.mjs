import assert from "node:assert/strict"
import test from "node:test"
import { fixture, incomingSelf } from "./helpers/qqbot-fixture.mjs"

async function pluginFixture(t) {
  const f = await fixture(t, {
    accounts: [{ uin: incomingSelf, appid: "mock-app", secret: "secret", group: true }],
    dau: { enabled: true, retentionDays: 62 },
  })
  const { QQBotPlugin } = (await f.load("lib/plugin.js")).namespace
  const plugin = new QQBotPlugin()
  const replies = []
  plugin.reply = (...args) => { replies.push(args); return true }
  return { ...f, plugin, replies }
}

test("发送模式指令接受 plain-first", async t => {
  const f = await pluginFixture(t)
  f.plugin.e = { msg: "#QQBot发送模式:plain-first", self_id: incomingSelf }
  await f.plugin.SendMode()
  assert.equal(f.config.sendMode.default, "plain-first")
  assert.match(f.replies.at(-1)[0], /plain-first/)
})

test("发送模式指令拒绝未知模式", async t => {
  const f = await pluginFixture(t)
  f.plugin.e = { msg: "#QQBot发送模式:unknown", self_id: incomingSelf }
  await f.plugin.SendMode()
  assert.match(f.replies.at(-1)[0], /markdown \/ text \/ auto \/ plain-first/)
})
