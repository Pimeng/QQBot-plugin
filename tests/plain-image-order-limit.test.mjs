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

test("单聊文字在前最多带 3 张媒体，群聊可带 4 张", async t => {
  const { sender, data } = await transport(t, { plainImageOrderMaxMedia: 4 })
  const calls = []
  sender.sendFileInfoMessage = async (_data, _target, _info, _reply, content) => {
    calls.push(content)
    return { id: `media-${calls.length}` }
  }
  const send = async () => ({ id: "text" })

  await sender.sendBatch({ ...data, message_type: "private" }, batch("说明", 4), send)
  assert.deepEqual(calls, ["说明", "", "", ""])

  calls.length = 0
  await sender.sendBatch({ ...data, message_type: "group" }, batch("说明", 4), send)
  assert.equal(calls.filter(content => content === "").length, 4)
})
