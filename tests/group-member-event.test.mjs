import assert from "node:assert/strict"
import test from "node:test"
import { incomingFixture, incomingGroup, incomingSelf } from "./helpers/qqbot-fixture.mjs"

const memberPayload = {
  group_openid: incomingGroup,
  member_openid: "JOINED",
  username: "新成员",
  member_role: "member",
  bot: false,
  timestamp: 1700000000000,
}

test("普通成员入群投递 icqq 事件，由插件捕获后自行主动推送", async t => {
  const f = await incomingFixture(t)
  const received = []
  f.bot.on("notice.group.increase", event => received.push(event))
  await f.notify("GROUP_MEMBER_ADD", memberPayload)
  assert.equal(received.length, 1)
  const event = received[0]
  assert.equal(event.user_id, "JOINED")
  assert.equal(event.group_id, incomingGroup)
  assert.equal(event.member.nickname, "新成员")
  assert.equal(event.group.group_id, incomingGroup)
  assert.equal(event.event_id, "mock-notice")
  assert.equal(event.reply, undefined)

  const sent = []
  f.sdk.sendGroupMessage = async (group, message) => {
    sent.push({ group, message })
    return { id: "plugin-welcome" }
  }
  const result = await event.group.sendMsg([{ type: "at", qq: event.user_id, text: "@新成员" }, "欢迎"])
  assert.equal(result.message_id, "plugin-welcome")
  assert.equal(sent[0].group, incomingGroup)
  assert.equal(sent[0].message.some(item => item.type === "reply"), false)
  assert.equal(sent[0].message.map(item => item.data?.text).join(""), "@新成员欢迎")
})

test("群成员角色变更映射 icqq notice.group.admin 的 set/unset", async t => {
  const f = await incomingFixture(t)
  await f.notify("GROUP_MEMBER_ADD", memberPayload)
  const admins = []
  f.bot.on("notice.group.admin", event => admins.push(event))
  const update = role => f.adapter.makeNotice(incomingSelf, {
    post_type: "notice", notice_type: "group", sub_type: "member.update",
    group_id: incomingGroup, user_id: "JOINED", username: "新成员",
    member_role: role, timestamp: 1700000000000,
  })
  await update("admin")
  assert.equal(admins.length, 1)
  assert.equal(admins[0].notice_type, "group")
  assert.equal(admins[0].sub_type, "admin")
  assert.equal(admins[0].set, true)
  assert.equal(admins[0].previous_role, "member")
  assert.equal(admins[0].role, "admin")
  assert.equal(admins[0].user_id, "JOINED")
  assert.equal(admins[0].group_id, incomingGroup)

  await update("member")
  assert.equal(admins.length, 2)
  assert.equal(admins[1].sub_type, "admin")
  assert.equal(admins[1].set, false)
  assert.equal(admins[1].previous_role, "admin")
  assert.equal(admins[1].role, "member")
})

test("机器人自身入群与成员入群分开，并为官方通知保留 event_id 被动回复", async t => {
  const f = await incomingFixture(t)
  const received = []
  f.bot.on("notice.group.increase", event => received.push(event))
  await f.notify("GROUP_ADD_ROBOT", { group_openid: incomingGroup, op_member_openid: "INVITER", timestamp: 1700000000000 })
  const event = received[0]
  assert.equal(event.user_id, incomingSelf)
  assert.equal(event.operator_id, "INVITER")
  assert.equal(event.event_id, "mock-notice")
  assert.equal(typeof event.reply, "function")

  const sent = []
  f.sdk.sendGroupMessage = async (group, message) => {
    sent.push({ group, message })
    return { id: "notice-reply" }
  }
  await event.reply("感谢邀请")
  const reply = sent[0].message.find(item => item.type === "reply")
  assert.equal(reply.data.event_id, "mock-notice")
  assert.equal(reply.data.id, undefined)
})

test("好友新增与接收开关提供对应 icqq 场景和 event_id 回复", async t => {
  const f = await incomingFixture(t)
  const sent = []
  f.sdk.sendPrivateMessage = async (user, message) => {
    sent.push({ user, message })
    return { id: `private-${sent.length}` }
  }

  const friends = []
  f.bot.on("notice.friend.increase", event => friends.push(event))
  await f.notify("FRIEND_ADD", { openid: "FRIEND", timestamp: 1700000000000 })
  assert.equal(friends[0].user_id, "FRIEND")
  assert.equal(friends[0].friend.user_id, "FRIEND")
  await friends[0].reply("你好")
  assert.equal(sent[0].user, "FRIEND")
  assert.equal(sent[0].message[0].data.event_id, "mock-notice")

  const opened = []
  f.bot.on("notice.friend.receive_open", event => opened.push(event))
  await f.notify("C2C_MSG_RECEIVE", { openid: "FRIEND", timestamp: 1700000000000 })
  assert.equal(opened[0].friend.receive_msg, true)
  await opened[0].reply("已开启")
  assert.equal(sent[1].message[0].data.event_id, "mock-notice")

  const groups = []
  f.bot.on("notice.group.receive_open", event => groups.push(event))
  await f.notify("GROUP_MSG_RECEIVE", { group_openid: incomingGroup, op_member_openid: "ADMIN", timestamp: 1700000000000 })
  f.sdk.sendGroupMessage = async (group, message) => {
    sent.push({ group, message })
    return { id: "group-open" }
  }
  await groups[0].reply("群消息接收已开启")
  assert.equal(sent[2].group, incomingGroup)
  assert.equal(sent[2].message[0].data.event_id, "mock-notice")
})
