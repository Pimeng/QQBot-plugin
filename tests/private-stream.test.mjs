import assert from "node:assert/strict"
import test from "node:test"
import { incomingFixture, incomingBase, incomingUser } from "./helpers/qqbot-fixture.mjs"

async function collect(chunks) {
  const result = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}

async function privateEvent(f, id = "private-message") {
  return f.receive("C2C_MESSAGE_CREATE", {
    id, content: "流式触发", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "Alice" },
  })
}

test("显式 stream 段在全局关闭时使用 C2C 流式 API 并保留回执、引用和 DAU", async t => {
  const f = await incomingFixture(t)
  f.config.stream = false
  const event = await privateEvent(f)
  const sent = { chunks: [] }, sentDau = []
  f.account.dau = { recordSend: amount => sentDau.push(amount) }
  f.sdk.sendPrivateStream = async (target, chunks, options) => {
    sent.target = target
    sent.options = options
    sent.chunks = await collect(chunks)
    return { id: "stream-result", timestamp: incomingBase.timestamp }
  }
  const result = await event.reply([
    { type: "stream", data: { chunkSize: 2, delay: 0, inputMode: "replace" } },
    "abcdef",
  ])
  assert.equal(result.message_id, "stream-result")
  assert.equal(result.data[0].id, "stream-result")
  assert.equal(sent.target, incomingUser)
  assert.deepEqual(sent.chunks, ["ab", "abcd", "abcdef"])
  assert.equal(sent.options.source.id, "private-message")
  assert.equal(sent.options.contentType, "text")
  assert.deepEqual(sentDau, [1])
})

test("全局开关处理所有可表达的 C2C 文本和 Markdown，显式 append 按增量分片", async t => {
  const f = await incomingFixture(t)
  f.config.stream = true
  const event = await privateEvent(f, "private-markdown")
  const calls = []
  f.sdk.sendPrivateStream = async (target, chunks, options) => {
    calls.push({ target, options, chunks: await collect(chunks) })
    return { id: `stream-${calls.length}` }
  }
  await event.reply("你好")
  await event.reply([
    { type: "stream", data: { inputMode: "append", chunkSize: 2, delay: 0 } },
    { type: "markdown", content: "**加粗**" },
  ])
  assert.deepEqual(calls[0].chunks, ["你好"])
  assert.deepEqual(calls[1].chunks, ["**", "加粗", "**"])
  assert.equal(calls[1].options.contentType, "markdown")
  assert.equal(calls[1].options.inputMode, "append")
})

test("全局流式不影响群聊，不支持的段和空内容走普通发送", async t => {
  const f = await incomingFixture(t)
  f.config.stream = true
  let streams = 0
  const privateSent = [], groupSent = []
  f.sdk.sendPrivateStream = async () => { streams++; return { id: "unexpected" } }
  f.sdk.sendPrivateMessage = async (user, message) => { privateSent.push(message); return { id: "plain-private" } }
  f.sdk.sendGroupMessage = async (group, message) => { groupSent.push(message); return { id: "plain-group" } }

  const privateEvent = await f.receive("C2C_MESSAGE_CREATE", {
    id: "private-normal", content: "", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "Alice" },
  })
  await privateEvent.reply([{ type: "face", id: 1 }])
  const groupEvent = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "group-normal" })
  await groupEvent.reply("群消息")
  assert.equal(streams, 0)
  assert.equal(privateSent.length, 1)
  assert.equal(groupSent.length, 1)
  assert.equal(groupSent[0][0].data.event_id ?? groupSent[0][0].data.id, "group-normal")
})

test("流式 SDK 失败时去除 stream 标记并回退普通消息", async t => {
  const f = await incomingFixture(t)
  const event = await privateEvent(f, "stream-failure")
  const sent = []
  f.sdk.sendPrivateStream = async () => { throw new Error("stream denied") }
  f.sdk.sendPrivateMessage = async (user, message) => {
    sent.push(message)
    return { id: "fallback-result" }
  }
  const result = await event.reply([{ type: "stream", data: { delay: 0 } }, "普通回退"])
  assert.equal(result.message_id, "fallback-result")
  assert.equal(sent.length, 1)
  assert.equal(sent[0].some(item => item.type === "stream"), false)
  assert.ok(f.warnings.some(message => message.includes("C2C 流式发送失败")))
})

test("流式内容准备拒绝非法参数，append 分片不产生重复前缀", async t => {
  const f = await incomingFixture(t)
  const { preparePrivateStream, privateStreamChunks } = (await f.load("adapter/message/stream.js")).namespace
  const data = { self_id: "bot", message_id: "source", active: false }
  const stream = preparePrivateStream(data, [
    { type: "stream", data: { inputMode: "append", chunkSize: 2, delay: 0 } },
    "abcdef",
  ])
  assert.deepEqual(await collect(privateStreamChunks(stream.content, stream.chunkSize, stream.delay, stream.options.inputMode)), ["ab", "cd", "ef"])
  assert.equal(preparePrivateStream(data, [{ type: "stream", data: { inputMode: "invalid" } }, "text"]), null)
  assert.equal(preparePrivateStream(data, [{ type: "stream", data: { enabled: false } }, "text"]), null)
})
