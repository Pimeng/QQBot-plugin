import assert from "node:assert/strict"
import test from "node:test"
import { fixture } from "./helpers/qqbot-fixture.mjs"

async function transport(t, initial = {}) {
  const f = await fixture(t, { plainImageOrder: { default: "text-first" }, ...initial })
  const MessageTransport = (await f.load("adapter/message/transport.js")).namespace.default
  const sender = Object.create(MessageTransport.prototype)
  sender.sep = ":"
  sender.mediaTarget = () => ({ target_type: "group", target_id: "GROUP" })
  sender.useReply = () => true
  sender.uploadFileInfo = async () => ({ file_info: "fi" })
  const data = { self_id: "10001", group_id: "10001:GROUP", message_id: "trigger", message_type: "group" }
  return { f, sender, data }
}

function batch(text = "说明", media = 1) {
  return [
    { type: "reply", id: "trigger" },
    ...(text ? [{ type: "text", text }] : []),
    ...Array.from({ length: media }, (_, index) => ({ type: "image", file: `image-${index}.png` })),
  ]
}

test("plainImageOrder 群级优先于账号级，最后才用 default", async t => {
  const { sender, data } = await transport(t, {
    plainImageOrder: {
      default: "auto",
      "10001": "image-first",
      "10001:GROUP": "text-first",
    },
  })
  assert.equal(sender.plainImageOrder({ ...data, group_id: "10001:GROUP" }), "text-first")
  assert.equal(sender.plainImageOrder({ ...data, group_id: "10001:OTHER" }), "image-first")
  assert.equal(sender.plainImageOrder({ ...data, self_id: "20002", group_id: "20002:GROUP" }), "auto")
})

test("text-first 先发文本，再逐条发媒体且不带 caption", async t => {
  const { sender, data } = await transport(t)
  const sent = []
  const media = []
  sender.sendFileInfoMessage = async (_data, _target, info, reply, content) => {
    media.push({ info, reply, content })
    return { id: `media-${media.length}` }
  }
  const result = await sender.sendBatch(data, batch(), async message => {
    sent.push(message)
    return { id: "text-message" }
  })

  assert.equal(sent.length, 1)
  assert.deepEqual(Array.from(sent[0], segment => segment.type), ["reply", "text"])
  assert.equal(sent[0][1].text, "说明")
  assert.equal(media.length, 1)
  assert.equal(media[0].content, "")
  assert.equal(media[0].reply.id, "trigger")
  assert.deepEqual(Array.from(result, item => item.id), ["text-message", "media-1"])
})

test("image-first 保持 caption 合并，不拆文本消息", async t => {
  const { sender, data } = await transport(t, { plainImageOrder: { default: "image-first" } })
  const sent = []
  const media = []
  sender.sendFileInfoMessage = async (_data, _target, info, reply, content) => {
    media.push({ info, reply, content })
    return { id: `media-${media.length}` }
  }
  await sender.sendBatch(data, batch(), async message => {
    sent.push(message)
    return { id: "text-message" }
  })

  assert.equal(sent.length, 0)
  assert.equal(media.length, 1)
  assert.equal(media[0].content, "说明")
})

test("文字 + 媒体超过被动回复上限时退回 caption", async t => {
  const { sender, data } = await transport(t, {
    plainImageOrder: { default: "text-first" },
    plainImageOrderMaxMedia: 1,
  })
  const sent = []
  const media = []
  sender.sendFileInfoMessage = async (_data, _target, info, reply, content) => {
    media.push({ content })
    return { id: `media-${media.length}` }
  }
  await sender.sendBatch(data, batch("说明", 2), async message => {
    sent.push(message)
    return { id: "text-message" }
  })

  assert.equal(sent.length, 0)
  assert.deepEqual(media.map(item => item.content), ["说明", ""])
})

test("没有可用的被动回复时不拆条", async t => {
  const { sender, data } = await transport(t)
  sender.useReply = () => false
  const sent = []
  const media = []
  sender.sendFileInfoMessage = async (_data, _target, info, reply, content) => {
    media.push({ content })
    return { id: `media-${media.length}` }
  }
  await sender.sendBatch(data, batch(), async message => {
    sent.push(message)
    return { id: "text-message" }
  })

  assert.equal(sent.length, 0)
  assert.equal(media[0].content, "说明")
})

test("plain-first 普通消息失败后再尝试 Markdown", async t => {
  const f = await fixture(t, { sendMode: { default: "plain-first" }, activeMsg: "auto" })
  const MessageSender = (await f.load("adapter/message/sender.js")).namespace.default
  const sender = new MessageSender()
  Object.assign(sender, { sep: ":", interactionWarned: {}, activeIntents: {} })
  const data = {
    self_id: "10001", group_id: "GROUP", message_id: "trigger", bot: {},
    message_type: "group", sub_type: "normal", _ret_id: [],
  }
  sender.buildPlainMsgs = async () => [[{ type: "reply", id: "trigger" }, { type: "text", text: "plain" }]]
  sender.buildMsgs = sender.buildPlainMsgs
  sender.buildMarkdownMsgs = async () => [[{ type: "markdown", content: "md" }]]

  const sent = []
  const result = await sender.sendMsg(data, async message => {
    sent.push(message)
    if (sent.length === 1) throw new Error("plain failed")
    return { id: "markdown-message" }
  }, { type: "text", text: "hello" })

  assert.equal(sent.length, 2)
  assert.equal(sent[1][0].type, "markdown")
  assert.equal(result.message_id, "markdown-message")
  assert.equal(result.error.length, 0)
  assert.equal(result.retry_errors[0].message, "plain failed")
})
