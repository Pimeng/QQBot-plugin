import assert from "node:assert/strict"
import test from "node:test"
import { incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase } from "./helpers/qqbot-fixture.mjs"

const guildId = "GUILD", channelId = "CHANNEL", channelKey = `qg_${guildId}-${channelId}`
const timestamp = incomingBase.timestamp

test("真实 SDK 频道和子频道通知保留字段，更新和退出仅清理对应频道缓存", async t => {
  const f = await incomingFixture(t)
  const notices = []
  f.bot.on("notice", event => notices.push(event))
  await f.notify("GUILD_CREATE", { id: guildId, name: "测试频道", op_user_id: "OWNER", joined_at: timestamp })
  assert.equal(f.account.guilds.get(guildId).guild_name, "测试频道")
  assert.equal(notices.at(-1).guild_id, guildId)
  assert.equal(notices.at(-1).operator_id, "qg_OWNER")
  assert.equal(notices.at(-1).isGuild, true)
  await f.notify("CHANNEL_CREATE", { id: channelId, guild_id: guildId, name: "旧子频道", channel_type: 0, op_user_id: "OWNER" })
  assert.equal(notices.at(-1).channel_id, channelId)
  assert.equal(notices.at(-1).group_id, channelKey)
  assert.equal(notices.at(-1).group.name, "旧子频道")
  assert.ok(Number.isFinite(notices.at(-1).time))
  const message = await f.receive("MESSAGE_CREATE", { id: "channel-message", guild_id: guildId, channel_id: channelId,
    content: "频道消息", timestamp, author: { id: "USER", username: "频道用户" } })
  assert.equal(message.guild_id, guildId)
  assert.equal(message.channel_id, channelId)
  assert.equal(message.group_name, "旧子频道")
  await f.notify("CHANNEL_UPDATE", { id: channelId, guild_id: guildId, name: "新子频道", op_user_id: "OWNER" })
  assert.equal(message.group.name, "新子频道")
  await f.notify("GUILD_UPDATE", { id: guildId, name: "新频道名", op_user_id: "OWNER" })
  assert.equal(f.account.gl.get(channelKey).guild_name, "新频道名")
  await f.notify("GUILD_DELETE", { id: guildId, op_user_id: "OWNER" })
  assert.equal(f.account.guilds.has(guildId), false)
  assert.equal(f.account.gl.has(channelKey), false)
  assert.equal(f.account.gml.has(channelKey), false)
  assert.equal(f.account.gl.has(`${incomingSelf}:${incomingGroup}`), true)
})

test("频道成员变更使用 qg 用户 ID，同步频道根缓存和子频道缓存", async t => {
  const f = await incomingFixture(t)
  const notices = [], admins = []
  f.bot.on("notice", event => notices.push(event))
  f.bot.on("notice.guild.admin", event => admins.push(event))
  await f.notify("CHANNEL_CREATE", { id: channelId, guild_id: guildId, name: "子频道" })
  const payload = { guild_id: guildId, op_user_id: "OWNER", joined_at: timestamp,
    user: { id: "USER", username: "新成员", avatar: "https://example.com/avatar.png", bot: false }, roles: ["2"], nick: "成员名片" }
  await f.notify("GUILD_MEMBER_ADD", payload)
  const added = notices.at(-1)
  assert.equal(added.user_id, "qg_USER")
  assert.equal(added.sender.nickname, "新成员")
  assert.equal(added.sender.role, "admin")
  assert.equal(added.guild_id, guildId)
  assert.equal(f.account.gml.get(`qg_${guildId}`).get("qg_USER").card, "成员名片")
  const member = f.account.pickMember(channelKey, "qg_USER")
  assert.equal(member.is_admin, true)
  await f.notify("GUILD_MEMBER_UPDATE", { ...payload, roles: ["1"], user: { ...payload.user, username: "更新昵称" } })
  assert.equal(member.nickname, "更新昵称")
  assert.equal(member.is_admin, false)
  assert.equal(admins.length, 1)
  assert.equal(admins[0].notice_type, "guild")
  assert.equal(admins[0].sub_type, "admin")
  assert.equal(admins[0].set, false)
  assert.equal(admins[0].previous_role, "admin")
  assert.equal(admins[0].role, "member")
  assert.equal(admins[0].user_id, "qg_USER")
  await f.notify("GUILD_MEMBER_REMOVE", payload)
  assert.equal(f.account.gml.get(channelKey).has("qg_USER"), false)
  assert.equal(f.account.gml.get(`qg_${guildId}`).has("qg_USER"), false)
})

test("频道表态和论坛通知保留真实消息、表情和帖子标识并关联子频道", async t => {
  const f = await incomingFixture(t)
  const notices = [], reactions = []
  f.bot.on("notice", event => notices.push(event))
  f.bot.on("notice.reaction.add", event => reactions.push(event))
  await f.notify("MESSAGE_REACTION_ADD", { guild_id: guildId, channel_id: channelId, user_id: "USER",
    target: { id: "REAL_MESSAGE", type: 0 }, emoji: { id: "123", type: 1 } })
  const reaction = notices.at(-1)
  assert.equal(reactions[0], reaction)
  assert.equal(reaction.notice_type, "reaction")
  assert.equal(reaction.message_id, "REAL_MESSAGE")
  assert.equal(reaction.emoji.id, "123")
  assert.equal(reaction.group_id, channelKey)
  assert.equal(reaction.member.user_id, "USER")
  await f.notify("FORUM_POST_CREATE", { guild_id: guildId, channel_id: channelId, author_id: "AUTHOR",
    post_info: { thread_id: "THREAD", post_id: "POST", content: "帖子内容", date_time: timestamp } })
  const post = notices.at(-1)
  assert.equal(post.thread_id, "THREAD")
  assert.equal(post.post_id, "POST")
  assert.equal(post.author_id, "AUTHOR")
  assert.equal(post.content, "帖子内容")
  assert.equal(post.group.info.channel_id, channelId)
})

test("缺少按钮指令时只拒绝一次，频道按钮通过真实 SDK 解析并可在本频道回复", async t => {
  const f = await incomingFixture(t)
  f.account.callback = {}
  const rejected = []
  await f.adapter.makeCallback(incomingSelf, { post_type: "notice", notice_type: "group", sub_type: "action",
    group_id: incomingGroup, operator_id: incomingUser, notice_id: "unknown",
    data: { resolved: { button_id: "unknown" } }, reply: async code => { rejected.push(code); return true } })
  assert.deepEqual(rejected, [1])
  assert.equal(f.captured.length, 0)
  const acknowledgements = [], sent = []
  f.sdk.replyAction = async (id, code) => { acknowledgements.push({ id, code }); return true }
  f.adapter.sendGuildMsg = async (data, msg) => { sent.push({ data, msg }); return { message_id: "sent" } }
  await f.notify("INTERACTION_CREATE", { id: "guild-button", scene: "guild", guild_id: guildId, channel_id: channelId,
    data: { resolved: { user_id: "USER", button_id: "button", button_data: "按钮指令" } } })
  const event = f.captured.at(-1)
  assert.equal(acknowledgements.length, 1)
  assert.equal(acknowledgements[0].code, 0)
  assert.equal(event.user_id, "qg_USER")
  assert.equal(event.group_id, channelKey)
  assert.equal(event.isGuild, true)
  await event.reply("回复按钮")
  assert.equal(sent[0].data.channel_id, channelId)
  assert.equal(sent[0].msg, "回复按钮")
})

test("跨账号按钮绑定锁只覆盖处理期间，首次提示后仍能确认绑定", async t => {
  const f = await incomingFixture(t)
  f.account.callback = {}
  f.adapter.bind_user = {}
  const sent = [], codes = []
  f.adapter.sendGroupMsg = async (_data, msg) => { sent.push(msg); return { message_id: "sent" } }
  const event = () => ({ notice_id: "bind-button", operator_id: incomingUser, reply: async code => { codes.push(code); return true } })
  const callback = { self_id: incomingSelf, group_id: incomingGroup, message: "#测试" }
  await f.adapter.makeBotCallback(incomingSelf, event(), callback)
  const user = `${incomingSelf}:${incomingUser}`
  assert.equal(f.account.callback[user], undefined)
  f.adapter.bind_user.REAL_USER = user
  await f.adapter.makeBotCallback(incomingSelf, event(), { ...callback, message: "#QQBot绑定用户确认REAL_USER" })
  assert.equal(f.account.fl.get(user).real_id, "REAL_USER")
  assert.equal(f.account.callback[user], undefined)
  assert.deepEqual(codes, [0, 0])
  assert.equal(sent.length, 2)
})
