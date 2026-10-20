import assert from "node:assert/strict"
import test from "node:test"
import { incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase } from "./helpers/qqbot-fixture.mjs"

// yenai-plugin 99efcd758ece6a489b88b171f6b3cf3808d6cff2,
// lib/common/sendMsgMod.js:147 uses group.sendMsg(msg, quote ? e : undefined).
test("独立群联系人 sendMsg(content, source) 引用显式消息，默认主动发送不借用最近消息", async t => {
  const f = await incomingFixture(t)
  const original = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "explicit-source", content: "原消息" })
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "latest-source", content: "最近消息" })
  const sent = []
  f.sdk.sendGroupMessage = async (target, message) => { sent.push({ target, message }); return { id: `sent-${sent.length}` } }
  const group = f.account.pickGroup(incomingGroup)
  await group.sendMsg("引用原消息", original)
  await group.sendMsg("主动消息")
  await f.account.sendGroupMsg(incomingGroup, "账号引用", { message_id: "explicit-source" })
  assert.equal(sent[0].target, incomingGroup)
  assert.equal(sent[0].message.find(part => part.type === "reply").data.id, "explicit-source")
  assert.equal(sent[1].message.some(part => part.type === "reply"), false)
  assert.equal(sent[2].message.find(part => part.type === "reply").data.id, "explicit-source")
})

test("引用只按真实 message_id 或当前会话已缓存的 seq 定位，缺失游标不能取最新消息", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "latest-source", content: "最新消息" })
  await f.adapter.makeMessage(incomingSelf, { ...f.captured.at(-1).raw, message_id: "with-real-seq", seq: 42 })
  const sent = []
  f.sdk.sendGroupMessage = async (_target, message) => { sent.push(message); return { id: "sent" } }
  const group = f.account.pickGroup(incomingGroup)
  await group.sendMsg("按缓存 seq 引用", { seq: 42 })
  assert.equal(sent[0].find(part => part.type === "reply").data.id, "with-real-seq")
  for (const source of [{ seq: 999 }, { seq: undefined }, {}, { message_id: 42 }])
    await assert.rejects(group.sendMsg("无法定位", source), /真实 message_id/)
  await assert.rejects(group.sendMsg("错误会话", { ...f.captured.at(-1), group_id: "OTHER" }), /当前会话/)
  await assert.rejects(group.sendMsg("错误账号", { message_id: "source", self_id: "OTHER" }), /其他账号/)
  assert.equal(sent.length, 1)
})

test("C2C、频道和频道私信的显式引用保留原联系人路由", async t => {
  const f = await incomingFixture(t)
  const privateSource = await f.receive("C2C_MESSAGE_CREATE", { id: "private-source", content: "私聊", timestamp: incomingBase.timestamp, author: { user_openid: incomingUser } })
  const guildPayload = { id: "guild-source", guild_id: "GUILD", channel_id: "CHANNEL", content: "频道", timestamp: incomingBase.timestamp,
    author: { id: "CHANNEL_USER", username: "频道用户" } }
  const guildSource = await f.receive("MESSAGE_CREATE", guildPayload)
  const directSource = await f.receive("DIRECT_MESSAGE_CREATE", { ...guildPayload, id: "direct-source" })
  const sent = []
  for (const [method, scene] of [["sendPrivateMessage", "private"], ["sendGuildMessage", "guild"], ["sendDirectMessage", "direct"]])
    f.sdk[method] = async (target, message) => { sent.push({ scene, target, message }); return { id: `${scene}-sent` } }
  await f.account.pickFriend(incomingUser).sendMsg("引用私聊", privateSource)
  await f.account.pickGroup("qg_GUILD-CHANNEL").sendMsg("引用频道", guildSource)
  await f.account.pickFriend("qg_CHANNEL_USER").sendMsg("引用私信", directSource)
  assert.deepEqual(sent.map(({ scene, target, message }) => [scene, target, message.find(part => part.type === "reply").data.id]), [
    ["private", incomingUser, "private-source"], ["guild", "CHANNEL", "guild-source"], ["direct", "GUILD", "direct-source"],
  ])
  await assert.rejects(f.account.pickFriend("OTHER").sendMsg("错误私聊", privateSource), /当前会话/)
})

test("引用有效期交给 QQ 校验，强制被动模式不把超时引用偷偷换成主动推送", async t => {
  const f = await incomingFixture(t)
  f.config.activeMsg = false
  const sent = []
  const expired = Object.assign(new Error("reply expired"), { code: 40034128 })
  f.sdk.sendGroupMessage = async (_target, message) => { sent.push(message); throw expired }
  const group = f.account.pickGroup(incomingGroup)
  await assert.rejects(group.sendMsg("旧消息引用", { message_id: "old-source", time: 1 }), error => error === expired)
  assert.ok(sent.length > 0)
  assert.ok(sent.every(message => message.find(part => part.type === "reply")?.data.id === "old-source"))
})

// chatgpt-plugin 35e8bf98b9dca406e1d64737bafac5deceea519e,
// utils/message.js:99/101 requests the referenced attachment through the current contact.
test("独立联系人可解析已接收缓存文件的真实 URL，群、C2C、频道和私信互相隔离", async t => {
  const f = await incomingFixture(t)
  const attachment = name => [{ url: `https://example.com/${name}.txt`, filename: `${name}.txt`, content_type: "text/plain" }]
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "group-file", attachments: attachment("group") })
  await f.receive("C2C_MESSAGE_CREATE", { id: "private-file", content: "", timestamp: incomingBase.timestamp, author: { user_openid: incomingUser }, attachments: attachment("private") })
  const guildPayload = { id: "guild-file", guild_id: "GUILD", channel_id: "CHANNEL", content: "", timestamp: incomingBase.timestamp,
    author: { id: "CHANNEL_USER", username: "频道用户" }, attachments: attachment("guild") }
  await f.receive("MESSAGE_CREATE", guildPayload)
  await f.receive("DIRECT_MESSAGE_CREATE", { ...guildPayload, id: "direct-file", attachments: attachment("direct") })
  for (const [contact, name] of [[f.account.pickGroup(incomingGroup), "group"], [f.account.pickFriend(incomingUser), "private"],
    [f.account.pickGroup("qg_GUILD-CHANNEL"), "guild"], [f.account.pickFriend("qg_CHANNEL_USER"), "direct"]]) {
    assert.equal(await contact.getFileUrl(`https://example.com/${name}.txt`), `https://example.com/${name}.txt`)
    await assert.rejects(async () => contact.getFileUrl("missing-id"), /文件|附件/)
  }
  await assert.rejects(async () => f.account.pickGroup("OTHER").getFileUrl("https://example.com/group.txt"), /文件|附件/)
  await assert.rejects(async () => f.account.pickFriend(incomingUser).getFileUrl("https://example.com/group.txt"), /文件|附件/)
})

// phi-plugin e5eb548a60a684caa49eebc8ee1048d25d65b885,
// components/platform/yunzai.js:526 calls Bot.sendFriendMsg(botId, userId, msg).
test("phi 全局 sendFriendMsg(botId,uid,msg) 和账号 sendFriendMsg(uid,msg) 分别按实际签名路由", async t => {
  const f = await incomingFixture(t)
  f.bot.adapter = [incomingSelf, "SECOND_ACCOUNT"]
  const secondary = f.bot.SECOND_ACCOUNT = { uin: "SECOND_ACCOUNT", adapter: "QQBot", info: {}, fl: new Map(), gl: new Map(), gml: new Map(),
    sdk: { sendPrivateMessage: async (target, message) => { sent.push({ account: "second", target, message }); return { id: "second-sent" } } },
    ...f.adapter.accountMethods("SECOND_ACCOUNT"), pickFriend: uid => f.adapter.pickFriend("SECOND_ACCOUNT", uid),
  }
  const sent = []
  f.sdk.sendPrivateMessage = async (target, message) => { sent.push({ account: "first", target, message }); return { id: "first-sent" } }
  await f.load("lib/bot.js")
  const Bot = f.getBot()
  await Bot.sendFriendMsg("SECOND_ACCOUNT", incomingUser, "指定账号")
  await f.account.sendFriendMsg(incomingUser, "账号别名")
  await Bot.sendFriendMsg(undefined, incomingUser, "默认账号")
  await Bot.sendFriendMsg("SECOND_ACCOUNT", incomingUser, "显式引用", { message_id: "second-source" })
  assert.equal(secondary.uin, "SECOND_ACCOUNT")
  assert.deepEqual(sent.map(({ account, target }) => [account, target]), [
    ["second", incomingUser], ["first", incomingUser], ["first", incomingUser], ["second", incomingUser],
  ])
  assert.equal(sent[0].message.some(part => part.type === "reply"), false)
  assert.equal(sent[3].message.find(part => part.type === "reply").data.id, "second-source")
  await assert.rejects(Bot.sendFriendMsg("MISSING", incomingUser, "不存在账号"), /账号不存在/)
})
