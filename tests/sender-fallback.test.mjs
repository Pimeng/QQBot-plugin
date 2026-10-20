import assert from "node:assert/strict"
import test from "node:test"
import { fixture } from "./helpers/qqbot-fixture.mjs"

async function senderFixture(t, guild = false, split = false) {
  const f = await fixture(t, { activeMsg: "auto" })
  const MessageSender = (await f.load("adapter/message/sender.js")).namespace.default
  const sender = new MessageSender()
  Object.assign(sender, { sep: ":", interactionWarned: {}, activeIntents: {} })
  const data = {
    self_id: "10001", group_id: "GROUP", message_id: "trigger", bot: {},
    message_type: guild ? "guild" : "group", sub_type: "normal", _ret_id: [],
  }
  // 隔离消息格式转换，保留真实发送、错误收集和回复权限判断。
  const build = async (data, msg) => {
    const segments = Array.isArray(msg) ? msg : [msg]
    const batches = split ? segments.map(segment => [segment]) : [segments]
    return batches.map(batch => sender.useReply(data)
      ? [{ type: "reply", id: data.message_id }, ...batch]
      : [...batch])
  }
  sender.buildMsgs = sender.makeGuildMsg = build
  sender.buildPlainMsgs = (data, msg) => build(data, f.toPlainMsg(msg))
  return {
    sender, data,
    send: (msg, deliver) => sender[guild ? "sendGMsg" : "sendMsg"](data, deliver, msg),
  }
}

for (const guild of [false, true]) {
  const scene = guild ? "频道" : "群聊"

  test(`${scene} Markdown 被拒后发送可读正文，成功结果保留重试错误`, async t => {
    const f = await senderFixture(t, guild)
    const denied = new Error("40034127 markdown denied")
    const sent = []
    const result = await f.send({ type: "markdown", content: "# 标题" }, async message => {
      sent.push(message)
      if (sent.length === 1) throw denied
      return { id: "plain-message" }
    })
    assert.equal(sent.length, 2)
    assert.equal(sent[0].some(segment => segment.type === "markdown"), true)
    assert.equal(sent[1].some(segment => segment.type === "markdown"), false)
    assert.equal(sent[1].find(segment => segment.type === "text").text, "标题")
    assert.equal(result.message_id, "plain-message")
    assert.equal(result.error.length, 0)
    assert.equal(result.retry_errors[0], denied)
    assert.deepEqual(Array.from(f.data._ret_id), guild ? [] : ["plain-message"])
  })

  test(`${scene} 连续降级后部分成功，只保留实际发出的消息且不再投递`, async t => {
    const f = await senderFixture(t, guild, true)
    const failures = [new Error("markdown denied"), new Error("40034128 被动回复超限")]
    const sent = []
    const result = await f.send([
      { type: "markdown", content: "第一部分" },
      { type: "markdown", content: "第二部分" },
    ], async message => {
      sent.push(message)
      if (sent.length <= 2) throw failures[sent.length - 1]
      if (sent.length === 3) return { id: "delivered-once" }
      throw new Error("40034105 主动消息失败")
    })
    assert.equal(sent.length, 4)
    assert.equal(sent[0].some(segment => segment.type === "reply"), true)
    assert.equal(sent[2].some(segment => segment.type === "reply"), false)
    assert.equal(result.partial, true)
    assert.deepEqual(Array.from(result.message_ids), ["delivered-once"])
    assert.equal(result.data.length, 1)
    assert.equal(result.error.length, 3)
  })

  test(`${scene} callback 的被动回复超限处理保留原有场景差异`, async t => {
    const f = await senderFixture(t, guild)
    f.data.sub_type = "callback"
    const sent = []
    const result = await f.send({ type: "markdown", content: "回调回复" }, async message => {
      sent.push(message)
      if (sent.length === 1) throw new Error("40034128 被动回复超限")
      return { id: "callback-response" }
    })
    assert.equal(sent.length, 2)
    assert.equal(sent[1].some(segment => segment.type === "reply"), true)
    assert.equal(sent[1].some(segment => segment.type === "markdown"), guild)
    assert.equal(f.sender.replyBlocked(f.data.self_id), guild)
    assert.equal(result.message_id, "callback-response")
  })

  test(`${scene} 单批次已发出部分媒体时保留 ID，不进入降级重发`, async t => {
    const f = await senderFixture(t, guild)
    const error = Object.assign(new Error("remaining media failed"), {
      qqbotSent: [[{ id: "uploaded-media" }]],
    })
    let calls = 0
    const result = await f.send({ type: "text", text: "媒体说明" }, async () => {
      calls++
      throw error
    })
    assert.equal(calls, 1)
    assert.equal(result.partial, true)
    assert.deepEqual(Array.from(result.message_ids), ["uploaded-media"])
    assert.equal(result.error[0], error)
  })
}

test("群文件发送失败不会再次作为普通消息投递", async t => {
  const f = await senderFixture(t)
  const failure = new Error("file upload failed")
  let calls = 0
  f.sender.sendBatch = async () => { calls++; throw failure }
  await assert.rejects(f.send({ type: "file", file: "report.pdf" }), error => error === failure)
  assert.equal(calls, 1)
})
