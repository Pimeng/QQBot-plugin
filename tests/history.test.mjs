import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase } from "./helpers/qqbot-fixture.mjs"

test("群历史直接收录普通和 @ 消息，按 ID/真实 seq 定位，按接收顺序分页", async t => {
  const f = await incomingFixture(t)
  for (const [id, type] of [["first", "GROUP_MESSAGE_CREATE"], ["middle", "GROUP_AT_MESSAGE_CREATE"], ["last", "GROUP_MESSAGE_CREATE"]])
    await f.receive(type, { ...incomingBase, id, content: id })
  const group = f.account.pickGroup(`${incomingSelf}:${incomingGroup}`)
  assert.deepEqual(Array.from(await group.getChatHistory(0, 2), e => e.message_id), ["middle", "last"])
  assert.deepEqual(Array.from(await group.getChatHistory("middle", 2), e => e.message_id), ["first", "middle"])
  assert.deepEqual(Array.from(await f.account.getChatHistory("middle", 1), e => e.message_id), ["middle"])
  assert.deepEqual(Array.from(await f.account.getGroupMsgHistory(incomingGroup), e => e.message_id), ["first", "middle", "last"])
  const middle = await f.account.getMsg("middle")
  assert.equal(middle.atme, true)
  assert.equal(middle.group_id, incomingGroup)
  assert.equal(middle.user_id, incomingUser)
  assert.equal(middle.seq, undefined)
  await f.adapter.makeMessage(incomingSelf, { ...f.captured.at(-1).raw, message_id: "with-seq", seq: 42 })
  assert.deepEqual(Array.from(await group.getChatHistory(42, 1), e => [e.message_id, e.seq]), [["with-seq", 42]])
  assert.equal((await group.getChatHistory("unknown", 2)).length, 0)
  await assert.rejects(group.getMsg("unknown"), /未缓存/)
  await assert.rejects(group.getChatHistory(0, -1), /非负整数/)
})

test("历史快照先于宿主修改保存，每次读取独立，取出的消息可回复和撤回", async t => {
  const f = await incomingFixture(t)
  f.bot.on("message", e => { e.message[0].text = "被插件改写"; e.raw_message = "被插件改写"; e.sender.nickname = "被插件改名" })
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "original", content: "原始正文" })
  const message = await f.account.getMsg("original")
  assert.equal(message.raw_message, "原始正文")
  assert.equal(message.message[0].text, "原始正文")
  assert.equal(message.sender.nickname, "Alice")
  message.message[0].text = "改写查询结果"
  assert.equal((await f.account.getMsg("original")).message[0].text, "原始正文")
  const sent = [], recalled = []
  f.sdk.sendGroupMessage = async (group, content) => { sent.push({ group, content }); return { id: "reply-id" } }
  f.sdk.recallGroupMessage = async (group, id) => { recalled.push([group, id]); return true }
  assert.equal((await message.reply("历史回复")).message_id, "reply-id")
  assert.equal(sent[0].group, incomingGroup)
  assert.equal(sent[0].content[0].data.id, "original")
  assert.equal(await message.recall(), true)
  assert.deepEqual(recalled, [[incomingGroup, "original"]])
  assert.equal(typeof message.group.getChatHistory, "function")
  assert.doesNotThrow(() => JSON.stringify(message))
})

test("群和私聊、不同会话及账号的历史互相隔离，同 ID 的重复包去重", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "same", content: "群一" })
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "same", content: "群一更新" })
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, group_openid: "OTHER", group_id: "OTHER", id: "same", content: "群二" })
  await f.receive("C2C_MESSAGE_CREATE", { id: "private", content: "私聊", timestamp: incomingBase.timestamp, author: { user_openid: incomingUser } })
  const group = f.account.pickGroup(incomingGroup), friend = f.account.pickFriend(incomingUser)
  assert.equal((await group.getChatHistory()).length, 1)
  assert.equal((await group.getMsg("same")).raw_message, "群一更新")
  assert.equal((await f.account.pickGroup("OTHER").getMsg("same")).raw_message, "群二")
  assert.equal((await friend.getChatHistory())[0].raw_message, "私聊")
  assert.equal((await f.account.getFriendMsgHistory(incomingUser))[0].message_id, "private")
  await assert.rejects(friend.getMsg("same"), /未缓存/)
  f.bot.OTHER_ACCOUNT = { messageCache: new Map() }
  await assert.rejects(f.adapter.getMsg("OTHER_ACCOUNT", "private"), /未缓存/)
})

test("消息留档有界、可关闭、可序列化恢复；不缓存伪造的按钮消息", async t => {
  const f = await incomingFixture(t)
  f.config.messageCacheSize = 2
  for (const id of ["first", "second", "third"])
    await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id, content: id })
  assert.equal(f.account.messageCache.size, 2)
  await assert.rejects(f.account.getMsg("first"), /未缓存/)
  f.account.messageCache = new Map(JSON.parse(JSON.stringify([...f.account.messageCache])))
  const restored = await f.account.getMsg("second")
  assert.equal(restored.raw_message, "second")
  assert.equal(typeof restored.reply, "function")
  f.adapter.cacheMessage({ self_id: incomingSelf, message_id: "event-callback", sub_type: "callback" })
  assert.equal(f.account.messageCache.size, 2)
  f.config.messageCacheSize = 0
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "disabled", content: "不缓存" })
  assert.equal(f.account.messageCache.size, 0)
})

test("频道与频道私信可查历史，并保留原始频道发送上下文及附件地址", async t => {
  const f = await incomingFixture(t)
  const payload = { id: "guild-message", guild_id: "GUILD", channel_id: "CHANNEL", content: "频道正文", timestamp: incomingBase.timestamp,
    author: { id: "CHANNEL_USER", username: "频道用户" }, attachments: [{ url: "https://example.com/file.txt", filename: "file.txt", content_type: "text/plain" }] }
  await f.receive("MESSAGE_CREATE", payload)
  await f.receive("DIRECT_MESSAGE_CREATE", { ...payload, id: "direct-message", content: "私信" })
  const group = f.account.pickGroup("qg_GUILD-CHANNEL"), friend = f.account.pickFriend("qg_CHANNEL_USER")
  const [guild] = await group.getChatHistory()
  const [direct] = await friend.getChatHistory()
  assert.equal(guild.isGuild, true)
  assert.equal(direct.isPrivate, true)
  assert.equal(guild.message_id, "guild-message")
  assert.equal(direct.message_id, "direct-message")
  assert.equal(await guild.group.getFileUrl(guild.file.fid), "https://example.com/file.txt")
  assert.equal((await f.account.getChatHistory("direct-message"))[0].message_id, "direct-message")
  const sent = []
  f.sdk.sendGuildMessage = async (target, content) => { sent.push(["guild", target, content]); return { id: "g-sent" } }
  f.sdk.sendDirectMessage = async (target, content) => { sent.push(["direct", target, content]); return { id: "d-sent" } }
  await guild.reply("回复频道")
  await direct.reply("回复私信")
  assert.deepEqual(sent.map(([type, target]) => [type, target]), [["guild", "CHANNEL"], ["direct", "GUILD"]])
})

test("实际接收的历史落盘后重新加载，仍可通过群对象查询和回复", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "qqbot-history-"))
  const f = await incomingFixture(t)
  f.adapter.path = `${directory}/`
  const file = `${f.adapter.path}${incomingSelf}/Message.json`
  t.after(async () => {
    const store = f.mapCache.get(file)
    if (store?.timer) clearTimeout(store.timer)
    await rm(directory, { recursive: true, force: true })
  })
  f.account.messageCache = await f.adapter.getMessageMap(incomingSelf)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "persistent", content: "保存正文" })
  const store = f.mapCache.get(file)
  clearTimeout(store.timer)
  await f.saveMap(store)
  f.mapCache.delete(file)
  f.account.messageCache = await f.adapter.getMessageMap(incomingSelf)
  const [message] = await f.account.pickGroup(incomingGroup).getChatHistory()
  assert.equal(message.message_id, "persistent")
  assert.equal(message.raw_message, "保存正文")
  const sent = []
  f.sdk.sendGroupMessage = async (_gid, content) => { sent.push(content); return { id: "persist-reply" } }
  assert.equal((await message.reply("回复落盘消息")).message_id, "persist-reply")
  assert.equal(sent[0][0].data.id, "persistent")
})
