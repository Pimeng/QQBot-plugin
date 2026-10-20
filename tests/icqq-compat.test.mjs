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
  const denied = new Error("fixture guild member permission denied")
  f.sdk.request.get = async () => { throw denied }
  await assert.rejects(f.account.getGroupMemberList(e.group_id, true), error => error === denied)
  assert.equal((await f.account.getGroupMemberList(e.group_id)).has("qg_CHANNEL_USER"), true)
  const p = await f.receive("DIRECT_MESSAGE_CREATE", { id: "direct-message", guild_id: "GUILD", channel_id: "CHANNEL", content: "私信", timestamp: incomingBase.timestamp, author: { id: "CHANNEL_USER", username: "频道用户" } })
  assert.equal(p.user_id, "qg_CHANNEL_USER")
  assert.equal(p.isPrivate, true)
  assert.equal(p.friend.user_id, "CHANNEL_USER")
})

test("icqq 历史接口按账号、群/C2C 和频道标识路由，好友共同群仅取本账号观察缓存", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "普通群" })
  await f.receive("MESSAGE_CREATE", { id: "guild-history", guild_id: "GUILD", channel_id: "CHANNEL", content: "频道", timestamp: incomingBase.timestamp, author: { id: incomingUser, username: "频道用户" } })
  const calls = []
  f.adapter.getMsg = (...args) => { calls.push(["getMsg", ...args]); return "message" }
  f.adapter.getChatHistory = (...args) => { calls.push(["getChatHistory", ...args]); return "history" }
  f.adapter.contactHistory = (...args) => { calls.push(["contactHistory", ...args]); return "history" }
  f.adapter.contactMessage = (...args) => { calls.push(["contactMessage", ...args]); return "message" }
  assert.equal(f.account.getMsg("one"), "message")
  assert.equal(f.account.getChatHistory("one", 2), "history")
  f.account.pickGroup(`${incomingSelf}:${incomingGroup}`).getChatHistory(0, 4)
  f.account.pickFriend(`${incomingSelf}:${incomingUser}`).getMsg("private")
  f.account.pickGroup(`${incomingSelf}:qg_GUILD-CHANNEL`).getMsg("guild")
  f.account.pickFriend(`${incomingSelf}:qg_${incomingUser}`).getChatHistory("direct", 5)
  f.account.getGroupMsgHistory(incomingGroup, "anchor", 6)
  f.account.getFriendMsgHistory(incomingUser, "anchor", 7)
  assert.deepEqual(calls, [
    ["getMsg", incomingSelf, "one"], ["getChatHistory", incomingSelf, "one", 2],
    ["contactHistory", incomingSelf, "group", incomingGroup, 0, 4],
    ["contactMessage", incomingSelf, "private", incomingUser, "private"],
    ["contactMessage", incomingSelf, "group", "qg_GUILD-CHANNEL", "guild"],
    ["contactHistory", incomingSelf, "private", `qg_${incomingUser}`, "direct", 5],
    ["contactHistory", incomingSelf, "group", incomingGroup, "anchor", 6],
    ["contactHistory", incomingSelf, "private", incomingUser, "anchor", 7],
  ])
  assert.deepEqual(Array.from(await f.account.pickFriend(incomingUser).searchSameGroup(), item => item.group_id), [incomingGroup])
  assert.deepEqual(Array.from(await f.account.pickFriend(`qg_${incomingUser}`).searchSameGroup(), item => item.group_id), ["qg_GUILD-CHANNEL"])
  assert.equal((await f.account.getFriendInfo(incomingUser)).nickname, "Alice")
  await assert.rejects(f.account.getStrangerInfo(incomingUser, true), /资料刷新接口/)
})

test("icqq 频道资料、成员详情和完整分页按需刷新，不吞权限错误或重复游标", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("MESSAGE_CREATE", { id: "guild-refresh", guild_id: "GUILD", channel_id: "CHANNEL", content: "频道", timestamp: incomingBase.timestamp, author: { id: "CHANNEL_USER", username: "旧昵称" } })
  const group = f.account.pickGroup(e.group_id), member = group.pickMember("CHANNEL_USER")
  const calls = []
  const raw = (id, username = id) => ({ user: { id, username, avatar: "https://example.invalid/avatar.png" }, nick: "频道名片", roles: ["2"], joined_at: incomingBase.timestamp })
  const first = Array.from({ length: 100 }, (_item, index) => raw(index ? `USER_${index}` : "CHANNEL_USER", index ? `成员${index}` : "分页昵称"))
  f.sdk.request.get = async (url, options) => {
    calls.push({ url, options })
    await delay(1)
    if (url === "/guilds/GUILD") return { data: { id: "GUILD", name: "官方频道", icon: "https://example.invalid/icon.png", owner_id: "OWNER" } }
    if (url === "/channels/CHANNEL") return { data: { id: "CHANNEL", name: "官方子频道", guild_id: "GUILD" } }
    if (url === "/guilds/GUILD/members/CHANNEL_USER") return { data: raw("CHANNEL_USER", "详情昵称") }
    assert.equal(url, "/guilds/GUILD/members")
    return { data: options.params.after ? [raw("LAST_MEMBER")] : first }
  }
  await group.getInfo(true)
  assert.equal(group.name, "官方子频道")
  assert.equal(group.info.guild_name, "官方频道")
  assert.equal(group.getAvatarUrl(), "https://example.invalid/icon.png")
  assert.equal((await member.getInfo(true)).nickname, "详情昵称")
  assert.equal(member.card, "频道名片")
  assert.equal(member.is_admin, true)
  const maps = await Promise.all([group.getMemberMap(true), f.account.getGroupMemberList(e.group_id, true)])
  assert.equal(maps[0].size, 101)
  assert.equal(maps[1].size, 101)
  assert.equal(member.nickname, "分页昵称")
  assert.equal(calls.filter(item => item.url === "/guilds/GUILD/members").length, 2)
  const denied = new Error("fixture later page denied")
  f.sdk.request.get = async (_url, options) => { if (options.params.after) throw denied; return { data: first } }
  await assert.rejects(group.getMemberMap(true), error => error === denied)
  assert.equal((await group.getMemberMap()).size, 101)
  let loopCalls = 0
  f.sdk.request.get = async () => { loopCalls++; return { data: first } }
  await assert.rejects(group.getMemberMap(true), /游标/)
  assert.equal(loopCalls, 2)
  assert.equal((await group.getMemberMap()).has("qg_LAST_MEMBER"), true)
})

test("icqq 频道修改、禁言、角色、踢人和消息操作调用真实 SDK 路由，失败不更新缓存", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("MESSAGE_CREATE", { id: "guild-operations", guild_id: "GUILD", channel_id: "CHANNEL", content: "频道", timestamp: incomingBase.timestamp, author: { id: "CHANNEL_USER", username: "频道用户" } })
  const group = f.account.pickGroup(e.group_id), member = group.pickMember("CHANNEL_USER")
  const calls = []
  for (const method of ["put", "patch", "delete", "post"]) f.sdk.request[method] = async (url, data) => {
    calls.push({ method, url, data })
    return { status: method === "patch" ? 200 : 204, data: {} }
  }
  f.sdk.request.get = async url => { calls.push({ method: "get", url }); return { data: { message_ids: ["pinned"] } } }
  assert.equal(await group.setName("重命名"), true)
  assert.equal(group.name, "重命名")
  assert.equal(await member.mute(60), true)
  assert.ok(member.mute_left > 0)
  assert.equal(await f.account.setGroupBan(e.group_id, "qg_CHANNEL_USER", 0), true)
  assert.equal(member.mute_left, 0)
  assert.equal(await group.muteAll(true, 120), true)
  assert.equal(group.all_muted, true)
  assert.equal(await group.muteAll(false), true)
  assert.equal(group.all_muted, false)
  assert.equal(await group.setAdmin("qg_CHANNEL_USER", true), true)
  assert.equal(member.is_admin, true)
  assert.equal(await member.setAdmin(false), true)
  assert.equal(member.is_admin, false)
  assert.deepEqual(await group.getPins(), ["pinned"])
  await group.pinMsg("pin")
  await group.unpinMsg("pin")
  await group.setAnnounce("announcement")
  await group.addReaction("react", 1, "123")
  await group.deleteReaction("react", 1, "123")
  await assert.rejects(group.announce("公告正文"), /QQBot 官方接口不支持/)
  await assert.rejects(group.setReaction("react", "123", false), /QQBot 官方接口不支持/)
  const denied = new Error("fixture mutation denied")
  f.sdk.request.put = async () => { throw denied }
  await assert.rejects(member.mute(30), error => error === denied)
  assert.equal(member.mute_left, 0)
  await assert.rejects(group.muteAll(true, -1), /时长/)
  assert.equal(await member.kick("", true), true)
  assert.equal((await group.getMemberMap()).has("qg_CHANNEL_USER"), false)
  assert.ok(calls.some(item => item.url === "/guilds/GUILD/members/CHANNEL_USER/mute" && item.data.mute_seconds === "60"))
  assert.ok(calls.some(item => item.url === "/guilds/GUILD/members/CHANNEL_USER/roles/2" && item.method === "put"))
  assert.ok(calls.some(item => item.url === "/guilds/GUILD/members/CHANNEL_USER" && item.data.data.add_blacklist === true))
  assert.ok(calls.some(item => item.url === "/channels/CHANNEL/pins/pin" && item.method === "post"))
  assert.ok(calls.some(item => item.url === "/guilds/GUILD/announces" && item.data.message_id === "announcement"))
  assert.ok(calls.some(item => item.url === "/channels/CHANNEL/messages/react/reactions/1/123" && item.method === "put"))
})

test("icqq 不支持的 QQ 群、好友和账号方法明确拒绝，不伪造成功或文件目录", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  for (const operation of [() => e.group.setName("群名"), () => e.group.muteAll(true), () => e.group.setAdmin(incomingUser), () => e.group.fs.ls(), () => e.group.fs.upload("file"), () => e.member.setCard("名片"), () => e.member.setAdmin(true), () => f.account.pickFriend(incomingUser).poke(), () => f.account.sendLike(incomingUser), () => f.account.setNickname("昵称"), () => f.account.getForwardMsg("forward")])
    await assert.rejects(operation(), /QQBot 官方接口不支持/)
})

test("icqq 频道列表返回官方频道字段，刷新失败保留已知频道", async t => {
  const f = await incomingFixture(t)
  f.sdk.request.get = async (url, options) => {
    assert.equal(url, "/users/@me/guilds")
    assert.equal(options.params.limit, 100)
    return { data: [{ id: "GUILD", name: "频道名称", joined_at: incomingBase.timestamp, icon: "https://example.invalid/icon.png" }] }
  }
  const list = await f.account.getGuildList()
  assert.equal(list[0].guild_id, "GUILD")
  assert.equal(list[0].guild_name, "频道名称")
  assert.equal(list[0].join_time, Math.floor(Date.parse(incomingBase.timestamp) / 1000))
  assert.equal(f.account.guilds.get("GUILD").guild_name, "频道名称")
  const denied = new Error("fixture guild list permission denied")
  f.sdk.request.get = async () => { throw denied }
  await assert.rejects(f.account.getGuildList(), error => error === denied)
  assert.equal(f.account.guilds.get("GUILD").guild_name, "频道名称")
})

test("官方群机器人和禁言状态同步角色、成员及机器人剩余禁言，查询失败保留缓存", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  const group = f.account.pickGroup(incomingGroup), member = group.pickMember(incomingUser)
  let role = "admin"
  let setting = { global_rule: { mode: "always" }, members: [
    { member_openid: incomingUser, username: "禁言昵称", mute_expire_at: new Date(Date.now() + 120000).toISOString() },
    { member_openid: "BOT_OPENID", username: "机器人", mute_expire_at: new Date(Date.now() + 60000).toISOString() },
  ] }
  f.sdk.request.get = async url => {
    if (url.endsWith("/bot_state")) return { data: { member_openid: "BOT_OPENID", member_role: role, allow_proactive_msg: true, recv_msg_setting: "all" } }
    assert.equal(url, `/v2/groups/${incomingGroup}/restrict_chat_setting`)
    return { data: setting }
  }
  assert.equal((await f.account.getGroupBotState(incomingGroup)).member_role, "admin")
  assert.equal(group.is_admin, true)
  assert.equal((await group.getMuteSetting()).global_rule.mode, "always")
  assert.equal(group.all_muted, true)
  assert.ok(group.mute_left > 0)
  assert.ok(member.mute_left > 0)
  assert.equal(member.nickname, "禁言昵称")
  const denied = new Error("fixture mute state denied")
  const request = f.sdk.request.get
  f.sdk.request.get = async () => { throw denied }
  await assert.rejects(f.account.getGroupMuteSetting(incomingGroup), error => error === denied)
  assert.equal(group.all_muted, true)
  assert.ok(member.mute_left > 0)
  f.sdk.request.get = request
  setting = { global_rule: { mode: "none" }, members: [] }
  await f.account.getGroupMuteSetting(incomingGroup)
  assert.equal(group.all_muted, false)
  assert.equal(group.mute_left, 0)
  assert.equal(member.mute_left, 0)
  role = "member"
  await group.getBotState()
  assert.equal(group.is_admin, false)
  assert.equal(e.member.info.user_id, incomingUser)
})

test("官方群全员禁言按绝对时段与北京时间周期规则动态判断跨日边界", async t => {
  const f = await incomingFixture(t)
  const { globalMuteActive } = (await f.load("adapter/bot-api.js")).namespace
  const time = value => Date.parse(value)
  assert.equal(globalMuteActive({ mode: "always" }, time("2026-10-20T00:00:00+08:00")), true)
  assert.equal(globalMuteActive({ mode: "none" }, time("2026-10-20T00:00:00+08:00")), false)
  const absolute = { mode: "schedule", schedule_rules: [{ enabled: true, start_at: "2026-10-20T10:00:00+08:00", end_at: "2026-10-20T11:00:00+08:00" }] }
  assert.equal(globalMuteActive(absolute, time("2026-10-20T10:00:00+08:00")), true)
  assert.equal(globalMuteActive(absolute, time("2026-10-20T11:00:00+08:00")), false)
  const recurring = { mode: "schedule", recurring_rules: [{ enabled: true, weekdays: [1], start_time: "23:00", end_time: "02:00" }] }
  assert.equal(globalMuteActive(recurring, time("2026-10-19T23:00:00+08:00")), true)
  assert.equal(globalMuteActive(recurring, time("2026-10-20T01:59:59+08:00")), true)
  assert.equal(globalMuteActive(recurring, time("2026-10-20T02:00:00+08:00")), false)
  assert.equal(globalMuteActive(recurring, time("2026-10-20T23:00:00+08:00")), false)
  recurring.recurring_rules[0].enabled = false
  assert.equal(globalMuteActive(recurring, time("2026-10-20T01:00:00+08:00")), false)
})

test("官方群批量禁言和解禁保留真实 op，限制20条及RFC3339期限，失败不更新缓存", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  const group = f.account.pickGroup(incomingGroup), member = group.pickMember(incomingUser)
  const calls = []
  f.sdk.request.post = async (url, data) => { calls.push({ url, data }); return { data: {} } }
  const expires = new Date(Date.now() + 60000).toISOString()
  assert.equal(await f.account.setGroupMemberMute(incomingGroup, [{ op: "add", member_openid: `${incomingSelf}:${incomingUser}`, mute_expire_at: expires }]), true)
  assert.equal(calls[0].url, `/v2/groups/${incomingGroup}/restrict_chat_setting`)
  assert.equal(calls[0].data.members[0].member_openid, incomingUser)
  assert.equal(calls[0].data.members[0].op, "add")
  assert.ok(member.mute_left > 0)
  await group.muteMembers([{ op: "update", member_openid: incomingUser, mute_expire_at: new Date(Date.now() + 120000).toISOString() }])
  assert.ok(member.mute_left > 60)
  await group.setMemberMute([{ op: "del", member_openid: incomingUser, mute_expire_at: "" }])
  assert.equal(member.mute_left, 0)
  await assert.rejects(group.muteMembers(Array.from({ length: 21 }, () => ({ op: "del", member_openid: incomingUser }))), /20/)
  await assert.rejects(group.muteMembers([{ op: "invalid", member_openid: incomingUser }]), /op/)
  await assert.rejects(group.muteMembers([{ op: "add", member_openid: incomingUser, mute_expire_at: "tomorrow" }]), /RFC3339/)
  await assert.rejects(group.muteMembers([{ op: "add", member_openid: incomingUser, mute_expire_at: new Date(Date.now() + 31 * 86400000).toISOString() }]), /30/)
  const denied = new Error("fixture batch mute denied")
  f.sdk.request.post = async () => { throw denied }
  await assert.rejects(group.muteMembers([{ op: "add", member_openid: incomingUser, mute_expire_at: expires }]), error => error === denied)
  assert.equal(member.mute_left, 0)
})

test("官方群踢人、批量移除和黑名单使用新官方接口并保留拉黑部分失败", async t => {
  const f = await incomingFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  const group = f.account.pickGroup(incomingGroup)
  const calls = []
  let blacklistFails = []
  f.sdk.request.post = async (url, data) => {
    calls.push({ url, data })
    return { data: url.endsWith("/batch_remove_members") ? { remove_members_result: "success", add_to_member_blacklist_fail_openids: blacklistFails } : { fail_openids: ["BLACKLIST_FAILED"] } }
  }
  assert.equal(await group.kickMember(incomingUser, "", true), true)
  assert.equal((await group.getMemberMap()).has(incomingUser), false)
  assert.equal(calls[0].data.add_to_member_blacklist, true)
  assert.deepEqual(Array.from(calls[0].data.member_openids), [incomingUser])
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  blacklistFails = [incomingUser]
  await assert.rejects(f.account.setGroupKick(incomingGroup, incomingUser, true), error => error.partial === true && error.result.add_to_member_blacklist_fail_openids[0] === incomingUser)
  assert.equal((await group.getMemberMap()).has(incomingUser), false)
  const result = await group.kickMembers(["ONE", "TWO"], true)
  assert.deepEqual(Array.from(result.add_to_member_blacklist_fail_openids), [incomingUser])
  const blacklist = await group.updateBlacklist({ op: "del", member_openids: ["BLACKLIST_FAILED"] })
  assert.deepEqual(Array.from(blacklist.fail_openids), ["BLACKLIST_FAILED"])
  f.sdk.request.get = async (url, options) => {
    assert.equal(url, `/v2/groups/${incomingGroup}/member_blacklist`)
    assert.equal(options.params.cursor, "next")
    return { data: { users: [{ member_openid: "BANNED", username: "黑名单成员" }], next_cursor: "" } }
  }
  assert.equal((await f.account.getGroupMemberBlacklist(incomingGroup, { cursor: "next", limit: 100 })).users[0].member_openid, "BANNED")
  await assert.rejects(group.kickMembers(Array.from({ length: 21 }, () => incomingUser)), /20/)
  await assert.rejects(group.updateBlacklist({ op: "other", member_openids: [incomingUser] }), /add 或 del/)
  await assert.rejects(group.getBlacklist({ limit: 101 }), /100/)
})

test("官方群入群查询、审批及自动审批策略账号方法透传官方参数和异步执行响应", async t => {
  const f = await incomingFixture(t)
  const calls = []
  const names = ["getGroupJoinRequests", "approveGroupJoinRequest", "getGroupJoinApprovalStrategies", "createGroupJoinApprovalStrategy", "updateGroupJoinApprovalStrategy", "deleteGroupJoinApprovalStrategy", "executeGroupJoinApprovalStrategy", "updateGroupJoinApprovalWhitelist"]
  for (const name of names) f.sdk[name] = async (...args) => { calls.push({ name, args }); return { accepted: name } }
  const options = { cursor: "next", limit: 20 }
  await f.account.getGroupJoinRequests(`${incomingSelf}:${incomingGroup}`, options)
  await f.account.approveGroupJoinRequest(incomingGroup, `${incomingSelf}:${incomingUser}`, { op: "decline", join_request_id: "REQUEST" })
  await f.account.getGroupJoinApprovalStrategies(options)
  await f.account.createGroupJoinApprovalStrategy({ group_openids: [incomingGroup], is_enable: "on" })
  await f.account.updateGroupJoinApprovalStrategy("STRATEGY", { remark: "备注" })
  await f.account.deleteGroupJoinApprovalStrategy("STRATEGY")
  const accepted = await f.account.executeGroupJoinApprovalStrategy("STRATEGY")
  assert.equal(accepted.accepted, "executeGroupJoinApprovalStrategy")
  await f.account.updateGroupJoinApprovalWhitelist("STRATEGY", { op: "add", whitelist_users: ["123456789"] })
  assert.equal(calls[0].args[0], incomingGroup)
  assert.equal(calls[1].args[1], incomingUser)
  assert.equal(calls.at(-1).args[1].whitelist_users[0], "123456789")
  assert.deepEqual(calls.map(item => item.name), names)
})
