import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase } from "./helpers/qqbot-fixture.mjs"

for (const sep of [":", ""]) test(`icqq 裸 ID、带前缀 ID 与实时 info 使用同一账号缓存：${sep}`, async t => {
  const f = await incomingFixture(t, sep)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const group = f.account.pickGroup(incomingGroup)
  const member = f.account.pickMember(incomingGroup, incomingUser)
  assert.equal(group.name, "Demo Group")
  assert.equal(group.info.group_id, incomingGroup)
  assert.equal(member.info.user_id, incomingUser)
  assert.equal(member.nickname, "Alice")
  assert.equal(member.is_owner, true)
  assert.equal(member.is_admin, true)
  assert.equal(member.group.name, "Demo Group")
  assert.equal(e.member.group, e.group)
  assert.equal((await group.getInfo()).group_id, incomingGroup)
  assert.equal((await f.account.getGroupMemberInfo(incomingGroup, incomingUser)).nickname, "Alice")
  const members = await group.getMemberMap()
  assert.equal(members.get(incomingUser).role, "owner")
  assert.equal(members.has(`${incomingSelf}${sep}${incomingUser}`), false)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, group_name: "更新群名", author: { ...incomingBase.author, username: "新昵称", member_role: "member" } })
  assert.equal(group.name, "更新群名")
  assert.equal(member.nickname, "新昵称")
  assert.equal(member.is_owner, false)
  assert.equal(member.is_admin, false)
  assert.equal(f.account.pickGroup(`${incomingSelf}${sep}${incomingGroup}`).name, "更新群名")
  await f.receive("C2C_MESSAGE_CREATE", { id: "private", content: "私信", timestamp: incomingBase.timestamp, author: { user_openid: incomingUser, username: "好友" } })
  const friend = f.account.pickFriend(incomingUser)
  assert.equal(friend.nickname, "好友")
  assert.equal((await friend.getSimpleInfo()).user_id, incomingUser)
  assert.equal(friend.asMember(incomingGroup).info.group_id, incomingGroup)
  assert.equal((await f.account.getFriendList()).get(incomingUser).nickname, "好友")
  assert.equal((await f.account.getGroupList()).get(incomingGroup).group_name, "更新群名")
})

test("icqq 群资料和成员按需刷新，完整分页并合并并发请求", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const calls = []
  f.sdk.request.get = async (url, options) => {
    calls.push({ url, options })
    await delay(2)
    if (url.endsWith("/info")) return { data: { group_name: "官方群名", group_member_num: 2 } }
    if (url.endsWith("/bot_state")) return { data: { member_role: "admin" } }
    if (url.endsWith(`/members/${incomingUser}`)) return { data: { member_openid: incomingUser, username: "官方昵称", member_role: "admin", joined_at: "2024-01-01T12:00:00+08:00" } }
    assert.equal(url, `/v2/groups/${incomingGroup}/members`)
    return options.params.cursor ? { data: { members: [{ member_openid: "SECOND", username: "第二人", member_role: "member" }], next_cursor: "" } }
      : { data: { members: [{ member_openid: incomingUser, username: "官方昵称", member_role: "admin" }], next_cursor: "next-page" } }
  }
  const group = f.account.pickGroup(incomingGroup), member = f.account.pickMember(incomingGroup, incomingUser)
  assert.equal(calls.length, 0)
  await group.renew()
  assert.equal(group.name, "官方群名")
  assert.equal(group.info.member_count, 2)
  assert.equal(group.is_admin, true)
  assert.equal(group.is_owner, false)
  await member.renew()
  assert.equal(member.nickname, "官方昵称")
  assert.equal(member.is_admin, true)
  assert.equal(member.is_owner, false)
  assert.equal(member.info.join_time, Date.parse("2024-01-01T12:00:00+08:00") / 1000)
  const [first, second] = await Promise.all([group.getMemberMap(true), f.account.getGroupMemberList(incomingGroup, true)])
  assert.deepEqual([...first.keys()].sort(), ["SECOND", incomingUser].sort())
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort())
  assert.equal(calls.filter(item => item.url.endsWith("/members")).length, 2)
})

test("icqq 刷新分页失败不覆盖已有成员；重复游标停止，权限错误不伪造成功", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  let count = 0
  f.sdk.request.get = async () => {
    count++
    return { data: { members: [{ member_openid: "INCOMPLETE" }], next_cursor: "loop" } }
  }
  await assert.rejects(f.account.getGroupMemberList(incomingGroup, true), /游标/)
  assert.equal(count, 2)
  assert.equal((await f.account.getGroupMemberList(incomingGroup)).get(incomingUser).role, "owner")
  const denied = new Error("fixture permission denied")
  f.sdk.request.get = async () => { throw denied }
  await assert.rejects(f.account.pickMember(incomingGroup, incomingUser).renew(), error => error === denied)
  assert.equal((await f.account.getGroupMemberList(incomingGroup)).has("INCOMPLETE"), false)
})

test("icqq 事件标志、字符串和 JSON 可直接使用，分层监听收到同一个事件", async t => {
  const f = await incomingFixture(t)
  const observed = []
  for (const name of ["message", "message.group", "message.group.normal"]) f.bot.on(name, e => observed.push({ name, e }))
  const e = await f.receive("GROUP_AT_MESSAGE_CREATE", { ...incomingBase, content: "<@everyone> 正文" })
  assert.equal(e.isGroup, true)
  assert.equal(e.isPrivate, false)
  assert.equal(e.atme, true)
  assert.equal(e.atall, true)
  assert.equal(String(e), "@DemoBot@全体成员 正文")
  assert.equal(observed.length, 3)
  assert.ok(observed.every(item => item.e === e))
  const serialized = JSON.parse(JSON.stringify(e))
  assert.equal(serialized.message_id, e.message_id)
  assert.equal(serialized.bot, undefined)
  assert.equal(serialized.raw, undefined)
  assert.equal(serialized.group, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(e.toJSON(["message_id", "user_id"]))), { message_id: e.message_id, user_id: incomingUser })
  const privateEvent = await f.receive("C2C_MESSAGE_CREATE", { id: "private", content: "私信", timestamp: incomingBase.timestamp, author: { user_openid: incomingUser, username: "好友" } })
  assert.equal(privateEvent.from_id, incomingUser)
  assert.equal(privateEvent.to_id, incomingSelf)
  assert.equal(privateEvent.isPrivate, true)
})

test("icqq 场景 sendMsg 保留原事件被动上下文，账号主动发送不使用缓存的消息 ID", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "newer-message", content: "更新消息" })
  const sent = []
  f.sdk.sendGroupMessage = async (group, message) => { sent.push({ group, message }); return { id: `sent-${sent.length}`, timestamp: 1700000000 } }
  const reply = await e.group.sendMsg("事件回复")
  assert.equal(reply.message_id, "sent-1")
  assert.equal(reply.time, 1700000000)
  assert.equal(reply.seq, undefined)
  assert.equal(sent[0].group, incomingGroup)
  assert.equal(sent[0].message[0].type, "reply")
  assert.equal(sent[0].message[0].data.id, incomingBase.id)
  await f.account.sendGroupMsg(incomingGroup, "主动发送")
  assert.ok(!sent[1].message.some(item => item.type === "reply"))
  const p = await f.receive("C2C_MESSAGE_CREATE", { id: "private-message", content: "私信", timestamp: incomingBase.timestamp, author: { id: incomingUser } })
  f.sdk.sendPrivateMessage = async (_user, message) => { sent.push({ message }); return { id: "private-sent" } }
  await p.friend.sendMsg("私聊事件回复")
  assert.equal(sent[2].message[0].data.id, "private-message")
})

test("icqq 群 sendFile 的第三个文件名参数在事件和账号对象上均生效", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const sent = []
  f.adapter.sendGroupMsg = async (_data, message, active) => { sent.push({ message, active }); return { message_id: "file-sent" } }
  await e.group.sendFile(Buffer.from("file"), undefined, "第三参.txt")
  await f.account.pickGroup(incomingGroup).sendFile(Buffer.from("file"), undefined, "主动.txt")
  await e.group.sendFile(Buffer.from("file"), "两参.txt")
  assert.deepEqual(sent.map(item => item.message.name), ["第三参.txt", "主动.txt", "两参.txt"])
  assert.equal(sent[1].active, true)
  assert.throws(() => e.group.sendFile(Buffer.from("file"), "/directory", "目录.txt"), /不支持群文件目录/)
})

test("icqq scalar / 消息对象撤回返回 boolean，多 ID 撤回保留逐条结果", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const recalled = []
  f.sdk.recallGroupMessage = async (_group, id) => { recalled.push(id); return id !== "failed" }
  assert.equal(await e.recall(), true)
  assert.equal(await e.group.recallMsg(e), true)
  assert.equal(await e.group.recallMsg("failed"), false)
  assert.deepEqual(Array.from(await e.group.recallMsg({ message_id: "first", message_ids: ["first", "failed"] })), [true, false])
  assert.deepEqual(recalled, [incomingBase.id, incomingBase.id, "failed", "first", "failed"])
})

test("icqq 宿主按单 message_id 自动撤回时处理同一事件回复的全部拆分消息", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  f.adapter.buildMsgs = async () => [[{ type: "text", text: "第一部分" }], [{ type: "text", text: "第二部分" }]]
  let count = 0
  f.sdk.sendGroupMessage = async () => ({ id: `reply-part-${++count}` })
  const recalled = []
  f.sdk.recallGroupMessage = async (_group, id) => { recalled.push(id); return true }
  const result = await e.reply("两部分回复")
  assert.equal(await e.group.recallMsg(result.message_id), true)
  assert.deepEqual(recalled, ["reply-part-1", "reply-part-2"])
  const otherEvent = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "another-event", content: "下一条" })
  await otherEvent.group.recallMsg(result.message_id)
  assert.deepEqual(recalled, ["reply-part-1", "reply-part-2", "reply-part-1"])
  const next = await e.reply("再次分拆")
  let retry = false
  f.sdk.recallGroupMessage = async (_group, id) => { recalled.push(id); return id !== "reply-part-4" || retry }
  assert.equal(await e.group.recallMsg(next.message_id), false)
  retry = true
  assert.equal(await e.group.recallMsg(next.message_id), true)
  assert.deepEqual(recalled.slice(-3), ["reply-part-3", "reply-part-4", "reply-part-4"])
})

test("icqq 同一事件并发回复的扩展参数不串到其他调用", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const sent = []
  f.adapter.sendGroupMsg = async (data, msg) => { sent.push({ msg, extra: data.replyExtra }); return { message_id: msg } }
  e.replyNew = e.reply
  e.reply = async (msg, quote) => { await delay(msg === "first" ? 20 : 5); return e.replyNew(msg, quote) }
  const first = { markdown: { content: "first extension" } }, second = { keyboard: { id: "second extension" } }
  await Promise.all([e.reply("first", false, first), e.reply("second", false, second), e.reply("ordinary")])
  assert.equal(sent.find(item => item.msg === "first").extra, first)
  assert.equal(sent.find(item => item.msg === "second").extra, second)
  assert.equal(sent.find(item => item.msg === "ordinary").extra, undefined)
})

test("icqq 分拆媒体返回全部真实 ID，部分失败保留已发送结果并避免重复发送", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  f.sdk.fileProcessor.uploadForMessage = async () => ({ file_info: "fixture-info", ttl: 60 })
  f.adapter.buildMsgs = async () => [[{ type: "image", file: Buffer.from("one") }, { type: "image", file: Buffer.from("two") }]]
  let calls = 0
  f.sdk.request.post = async () => ({ data: { id: `media-${++calls}` } })
  const all = await e.reply("模拟两张图片")
  assert.equal(all.message_id, "media-1")
  assert.deepEqual(Array.from(all.message_ids), ["media-1", "media-2"])
  assert.equal(all.data.length, 2)
  f.sdk.request.post = async () => {
    if (++calls === 4) throw new Error("second media failed")
    return { data: { id: "partial-media" } }
  }
  const partial = await e.reply("第二组图片")
  assert.equal(calls, 4)
  assert.equal(partial.partial, true)
  assert.deepEqual(Array.from(partial.message_ids), ["partial-media"])
  assert.equal(partial.error.length, 1)
})

test("icqq 全部发送失败拒绝 Promise，成功降级保留重试信息而不返回失败状态", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  f.sdk.sendGroupMessage = async () => { throw new Error("fixture send failed") }
  await assert.rejects(e.reply("无法发送"), /fixture send failed/)
  f.config.activeMsg = "auto"
  let calls = 0
  f.sdk.sendGroupMessage = async () => {
    if (++calls === 1) throw Object.assign(new Error("passive limited"), { code: 40034128 })
    return { id: "recovered" }
  }
  const result = await e.reply("降级发送")
  assert.equal(result.message_id, "recovered")
  assert.equal(result.error.length, 0)
  assert.equal(result.retry_errors.length, 1)
})

test("icqq 降级重试中的部分成功也不会被下一次普通发送重复投递", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  f.config.activeMsg = "auto"
  f.adapter.buildMsgs = f.adapter.buildPlainMsgs = async () => [[{ type: "text", text: "第一部分" }], [{ type: "text", text: "第二部分" }]]
  let calls = 0
  f.sdk.sendGroupMessage = async () => {
    if (++calls === 1) throw Object.assign(new Error("passive limited"), { code: 40034128 })
    if (calls === 2) return { id: "delivered-once", timestamp: "1700000000" }
    throw new Error("remaining part failed")
  }
  const result = await e.reply("分两次发送")
  assert.equal(calls, 3)
  assert.equal(result.partial, true)
  assert.equal(result.time, 1700000000)
  assert.deepEqual(Array.from(result.message_ids), ["delivered-once"])
})

test("icqq 相同 OpenID 的不同账号查询与主动发送不会混用缓存和 SDK", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  const other = f.bot.OTHER = { uin: "OTHER", info: { appid: "other-app" },
    gl: new Map([[`OTHER:${incomingGroup}`, { group_name: "另一个账号的群" }]]),
    fl: new Map(), gml: new Map([[`OTHER:${incomingGroup}`, new Map([[`OTHER:${incomingUser}`, { nickname: "另一账号的昵称", role: "admin" }]])]]),
    sdk: { sendGroupMessage: async (_group, message) => ({ id: "other-sdk", message }) },
  }
  assert.equal(f.adapter.pickGroup("OTHER", incomingGroup).name, "另一个账号的群")
  assert.equal(f.adapter.pickMember("OTHER", incomingGroup, incomingUser).nickname, "另一账号的昵称")
  const result = await f.adapter.pickGroup("OTHER", incomingGroup).sendMsg("主动发送")
  assert.equal(result.message_id, "other-sdk")
  assert.equal(f.account.pickGroup(incomingGroup).name, "Demo Group")
  assert.equal(other.gml.get(`OTHER:${incomingGroup}`).get(`OTHER:${incomingUser}`).nickname, "另一账号的昵称")
})

test("icqq 成员禁言秒数映射官方时间，零值解禁，失败不更新缓存", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, author: { ...incomingBase.author, member_role: "member" } })
  const calls = []
  f.sdk.group = group => ({
    mute: async (user, expires) => { calls.push({ group, user, expires }) },
    unmute: async user => { calls.push({ group, user, unmute: true }) },
  })
  const before = Date.now()
  await e.member.mute(60)
  assert.equal(calls[0].group, incomingGroup)
  assert.equal(calls[0].user, incomingUser)
  assert.ok(Date.parse(calls[0].expires) >= before + 60000)
  assert.ok(e.member.mute_left > 0)
  await e.group.muteMember(incomingUser, 0)
  assert.equal(calls[1].unmute, true)
  assert.equal(e.member.mute_left, 0)
  await assert.rejects(e.member.mute(-1), /时长/)
  f.sdk.group = () => ({ mute: async () => { throw new Error("permission denied") } })
  await assert.rejects(e.member.mute(60), /permission denied/)
  assert.equal(e.member.mute_left, 0)
})

test("icqq 成员进退群通知逐层投递、更新缓存，机器人退出单独清理群缓存", async t => {
  const f = await incomingFixture(t)
  const notices = []
  for (const name of ["notice", "notice.group", "notice.group.increase"]) f.bot.on(name, e => notices.push({ name, e }))
  await f.notify("GROUP_MEMBER_ADD", { group_openid: incomingGroup, member_openid: "JOINED", username: "新成员", member_role: "member", bot: false, timestamp: incomingBase.timestamp })
  assert.equal(notices.length, 3)
  const e = notices[0].e
  assert.equal(e.post_type, "notice")
  assert.equal(e.sub_type, "increase")
  assert.equal(e.user_id, "JOINED")
  assert.equal(e.group_id, incomingGroup)
  assert.equal(e.time, Math.floor(Date.parse(incomingBase.timestamp) / 1000))
  assert.ok(notices.every(item => item.e === e))
  const joined = (await f.account.getGroupMemberList(incomingGroup)).get("JOINED")
  assert.equal(joined.nickname, "新成员")
  assert.equal(joined.bot, false)
  assert.doesNotThrow(() => JSON.stringify(joined))
  await f.notify("GROUP_MEMBER_REMOVE", { group_openid: incomingGroup, member_openid: "JOINED", timestamp: 1700000000000 })
  assert.equal((await f.account.getGroupMemberList(incomingGroup)).has("JOINED"), false)
  await f.notify("GROUP_DEL_ROBOT", { group_openid: incomingGroup, op_member_openid: incomingUser, timestamp: 1700000000000 })
  assert.equal(notices.at(-1).e.user_id, incomingSelf)
  assert.equal(notices.at(-1).e.operator_id, incomingUser)
  assert.equal(f.account.gl.size, 0)
  assert.equal(f.account.gml.size, 0)
})

test("icqq 好友增减和接收开关通知保留场景对象、时间及缓存状态", async t => {
  const f = await incomingFixture(t)
  const notices = []
  f.bot.on("notice", e => notices.push(e))
  await f.notify("FRIEND_ADD", { openid: incomingUser, timestamp: incomingBase.timestamp })
  assert.equal(notices[0].friend.info.user_id, incomingUser)
  assert.equal(notices[0].time, Math.floor(Date.parse(incomingBase.timestamp) / 1000))
  await f.notify("C2C_MSG_REJECT", { openid: incomingUser, timestamp: 1700000000000 })
  assert.equal(f.account.pickFriend(incomingUser).info.receive_msg, false)
  await f.notify("C2C_MSG_RECEIVE", { openid: incomingUser, timestamp: 1700000000000 })
  assert.equal(f.account.pickFriend(incomingUser).info.receive_msg, true)
  await f.notify("FRIEND_DEL", { openid: incomingUser, timestamp: 1700000000000 })
  assert.equal(f.account.fl.size, 0)
})

test("icqq 入群申请转换 request.group.add，approve 使用本群真实申请 ID", async t => {
  const f = await incomingFixture(t)
  const requests = []
  f.bot.on("request", e => requests.push(e))
  f.bot.on("request.group.add", e => requests.push(e))
  const approvals = []
  f.sdk.approveGroupJoinRequest = async (...args) => approvals.push(args)
  await f.notify("GROUP_JOIN_REQUEST", {
    group_openid: incomingGroup, member_openid: incomingUser, join_request_id: "REAL_JOIN_REQUEST_ID", apply_at: incomingBase.timestamp,
    verify_info: { method: "verify_message", verify_message: "申请理由" },
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0], requests[1])
  assert.equal(requests[0].comment, "申请理由")
  assert.equal(requests[0].flag, "REAL_JOIN_REQUEST_ID")
  await requests[0].approve(false, "拒绝理由", true)
  assert.equal(approvals[0][0], incomingGroup)
  assert.equal(approvals[0][1], incomingUser)
  assert.deepEqual(JSON.parse(JSON.stringify(approvals[0][2])), { op: "decline", join_request_id: "REAL_JOIN_REQUEST_ID", reject_reason: "拒绝理由", add_to_member_blacklist: true })
})

test("icqq 频道缺少 member 时不崩溃，私信和群场景保持原路由", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("MESSAGE_CREATE", { id: "guild-message", guild_id: "GUILD", channel_id: "CHANNEL", content: "正文", timestamp: incomingBase.timestamp, author: { id: "CHANNEL_USER", username: "频道用户" } })
  assert.equal(e.group_id, "qg_GUILD-CHANNEL")
  assert.equal(e.sender.nickname, "频道用户")
  assert.equal(e.isGuild, true)
  assert.equal(e.group.group_id, "qg_GUILD-CHANNEL")
  assert.equal(e.group.info.channel_id, "CHANNEL")
  assert.equal((await f.account.getGroupMemberInfo(e.group_id, "CHANNEL_USER")).nickname, "频道用户")
  assert.equal((await f.account.getGroupMemberList(e.group_id)).has("qg_CHANNEL_USER"), true)
  await assert.rejects(f.account.getGroupMemberList(e.group_id, true), /已观察缓存/)
  const p = await f.receive("DIRECT_MESSAGE_CREATE", { id: "direct-message", guild_id: "GUILD", channel_id: "CHANNEL", content: "私信", timestamp: incomingBase.timestamp, author: { id: "CHANNEL_USER", username: "频道用户" } })
  assert.equal(p.user_id, "qg_CHANNEL_USER")
  assert.equal(p.isPrivate, true)
  assert.equal(p.friend.user_id, "CHANNEL_USER")
})
