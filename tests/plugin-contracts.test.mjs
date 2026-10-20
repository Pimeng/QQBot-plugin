import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import lodash from "lodash"
import { fixture, incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase } from "./helpers/qqbot-fixture.mjs"

/**
 * 第三方插件的调用合同回放：只执行下面列出的调用片段，SDK I/O 使用桩。
 * 不导入、安装依赖或执行下载的第三方插件。真实源码路径和版本保存在抽样报告中。
 * 与仅检查 typeof 不同，这里继续消费返回值、遍历 Map、解析引用和撤回已发送消息。
 */
async function pluginFixture(t, sep = ":") {
  const f = await incomingFixture(t, sep)
  f.account.adapter = "QQBot"
  f.bot.adapter = [incomingSelf]
  await f.load("lib/bot.js")
  return { ...f, Bot: f.getBot() }
}

const textOf = message => message.filter(item => item.type === "text").map(item => item.data?.text ?? item.text ?? "").join("")

test("插件合同：首条消息的群管角色检查读取官方状态，并发复用且权限失败不伪造管理员", async t => {
  const f = await incomingFixture(t)
  f.config.refreshGroupState = true
  let queried = 0
  f.sdk.getGroupBotState = async () => { queried++; return { member_openid: "BOT_OPENID", member_role: "admin" } }
  const events = await Promise.all(["role1", "role2"].map(id => f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id })))
  assert.equal(queried, 1)
  assert.ok(events.every(event => event.group.is_admin))
  f.sdk.getGroupBotState = async () => { throw new Error("无权限") }
  const unavailable = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "other-role", group_openid: "NEW_GROUP", group_id: "NEW_GROUP" })
  assert.equal(unavailable.group.is_admin, false)
})

/**
 * 回放宿主 PluginsLoader.reply 的成功调用约定（本机 lib/plugins/loader.js:518-580）。
 * 这是经过逐行核对的调用方桩，避免把宿主负责的 at / recallMsg 误算成适配器缺口；
 * 测试不要求 npm test 所在目录之外同时存在整份 Yunzai 源码。
 */
async function wrapHostReply(e) {
  const scheduled = [], counted = []
  e.replyNew = e.reply
  e.reply = async (msg = "", quote = false, data = {}) => {
    if (!msg || e.isGroup && e.group?.mute_left > 0) return false
    let { at = "", recallMsg = 0 } = data
    if (at && e.isGroup) {
      let text = e.sender?.card ? lodash.truncate(e.sender.card, { length: 10 }) : ""
      if (at === true) at = Number(e.user_id) || String(e.user_id)
      else if (!isNaN(at)) {
        const info = e.group.pickMember(at).info
        text = lodash.truncate(info.card ?? info.nickname, { length: 10 })
      }
      const mention = { type: "at", qq: at, text }
      if (Array.isArray(msg)) msg.unshift(mention, "\n")
      else msg = [mention, "\n", msg]
    }
    // 实际核心只转交两参；事件 reply setter 必须仍能保留本次调用的官方扩展。
    const result = await e.replyNew(msg, quote)
    if (!e.isGuild && recallMsg > 0 && result?.message_id)
      scheduled.push({ callback: () => (e.isGroup ? e.group : e.friend).recallMsg(result.message_id), milliseconds: recallMsg * 1000 })
    counted.push({ e, msg })
    return result
  }
  return { scheduled, counted }
}

// yenai-plugin apps/assistant/sendMsg.js:157-175 使用 Bot.gl.values() → group_id → pickGroup().sendMsg()。
test("插件合同：全局群 Map 遍历后可按 info.uin 路由实际账号并发送", async t => {
  const f = await pluginFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "触发" })
  const sent = []
  f.sdk.sendGroupMessage = async (group, message) => { sent.push({ group, message }); return { id: "broadcast" } }
  const groups = await f.Bot.getGroupList(), receiver = { groups: [] }
  groups.forEach(function (info, groupId, map) {
    assert.equal(this, receiver)
    assert.equal(map, groups)
    assert.equal(info.uin, incomingSelf)
    assert.equal(info.group_name, "Demo Group")
    this.groups.push({ info, groupId })
  }, receiver)
  assert.ok(groups instanceof Map)
  assert.equal(groups.size, 1)
  assert.deepEqual([...groups.keys()], [incomingGroup])
  const [{ info, groupId }] = receiver.groups
  const result = await f.Bot[info.uin].pickGroup(groupId).sendMsg(`通知 ${info.group_name}`)
  assert.equal(result.message_id, "broadcast")
  assert.equal(sent[0].group, incomingGroup)
  assert.equal(textOf(sent[0].message), "通知 Demo Group")
  assert.ok(!sent[0].message.some(item => item.type === "reply"))
  assert.equal(f.Bot.pickGroup(`${incomingSelf}:${groupId}`).info.group_id, incomingGroup)
  const selected = Array.from(f.Bot.gl.values()).map(item => item.group_id)
  await f.Bot.pickGroup(selected[0]).sendMsg("来自群列表的通知")
  assert.equal(sent[1].group, incomingGroup)
})

// miao-plugin models/ProfileRank.js:215-218；yenai-plugin apps/assistant/other.js:175-179。
test("插件合同：getMemberMap 返回 Map，可遍历角色、取名片并继续调用 pickMember", async t => {
  const f = await pluginFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, author: { ...incomingBase.author, avatar: "https://example.invalid/member-avatar.png" } })
  const group = f.Bot.pickGroup(incomingGroup)
  const members = await group.getMemberMap()
  const rows = []
  members.forEach((info, userId, map) => {
    assert.equal(map, members)
    rows.push({ userId, name: info.card || info.nickname, role: info.role })
  })
  assert.deepEqual(rows, [{ userId: incomingUser, name: "Alice", role: "owner" }])
  const users = {}
  for (const [qq] of members) users[qq] = true
  assert.equal(users[incomingUser], true)
  const member = group.pickMember(rows[0].userId)
  assert.equal(member.info.group_id, incomingGroup)
  assert.equal(member.is_owner, true)
  assert.equal(member.group.group_id, group.group_id)
  assert.equal(member.getAvatarUrl(640), `https://q.qlogo.cn/qqapp/mock-app/${incomingUser}/640`)
  assert.equal((await f.Bot.getGroupMemberList(incomingGroup)).get(incomingUser).nickname, rows[0].name)
  assert.equal((await f.Bot.getGroupMemberInfo(incomingGroup, incomingUser)).role, "owner")
})

test("插件合同：宿主 reply 的 at / recallMsg 与第三参官方扩展走完整发送、撤回链路", async t => {
  const f = await pluginFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "触发" })
  const { scheduled, counted } = await wrapHostReply(e)
  const sent = [], recalled = []
  f.sdk.sendGroupMessage = async (group, message) => { sent.push({ group, message }); return { id: "reply-with-options" } }
  f.sdk.recallGroupMessage = async (group, messageId) => { recalled.push({ group, messageId }); return true }
  const result = await e.reply([{ type: "at", qq: incomingUser }, "答复"], true, { at: true, recallMsg: 10 })
  assert.equal(result.message_id, "reply-with-options")
  assert.equal(counted.length, 1)
  assert.equal(sent[0].group, incomingGroup)
  assert.equal(sent[0].message[0].data.id, incomingBase.id)
  assert.equal(textOf(sent[0].message), "答复")
  assert.equal(scheduled[0].milliseconds, 10_000)
  await scheduled[0].callback()
  assert.deepEqual(recalled, [{ group: incomingGroup, messageId: "reply-with-options" }])
  const markdown = { content: "扩展正文" }
  f.adapter.sendGroupMsg = async (data, message) => {
    assert.equal(data.replyExtra.markdown, markdown)
    assert.equal(message, "扩展消息")
    return { message_id: "official-extension" }
  }
  assert.equal((await e.reply("扩展消息", false, { markdown })).message_id, "official-extension")
})

// miao-plugin apps/character/ImgUpload.js:297-301、yenai-plugin apps/events/recall.js:54-60。
test("插件合同：makeForwardMsg 的裸节点、嵌套节点及宿主描述处理保留实际正文", async t => {
  const f = await pluginFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "触发" })
  const sent = []
  f.sdk.sendGroupMessage = async (_group, message) => { sent.push(message); return { id: `forward-${sent.length}` } }
  const nodes = [{ user_id: incomingUser, nickname: "Alice", message: ["第一段", { type: "node", data: [{ user_id: incomingUser, message: "嵌套正文" }] }] }]
  const forwarded = await e.group.makeForwardMsg(nodes)
  await e.reply(forwarded)
  await e.reply(nodes)
  assert.equal(textOf(sent[0]), "第一段嵌套正文")
  assert.equal(textOf(sent[1]), "第一段嵌套正文")
  // 与宿主 common.makeForwardMsg 的对象分支一致：官方降级产物不伪造 icqq XML。
  assert.equal(typeof forwarded.data, "object")
  assert.equal(forwarded.type, "node")
  assert.ok(!textOf(sent[0]).includes("[object Object]"))
})

// miao-plugin apps/character/ImgUpload.js:50-57、apps/profile/ProfileUtils.js:8-22；
// yenai-plugin lib/common/common.js:181-205；chatgpt-plugin utils/message.js:72-101。
// 这些调用优先使用 getReply；只回放对适配器的调用，不执行插件网络请求、图片下载或文件写入。
for (const privateChat of [false, true]) test(`插件合同：getReply 优先使用真实引用 ID 取图片和文件，后到消息不改变目标：${privateChat ? "私聊" : "群聊"}`, async t => {
  const f = await pluginFixture(t)
  let receivedAt = Date.parse(incomingBase.timestamp)
  const receive = (id, content, extra = {}) => {
    const timestamp = new Date(receivedAt += 1000).toISOString()
    return privateChat
      ? f.receive("C2C_MESSAGE_CREATE", { id, content, timestamp, author: { user_openid: incomingUser, username: "Alice" }, ...extra })
      : f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id, content, timestamp, ...extra })
  }
  const imageUrl = "https://example.invalid/referenced-image.png"
  const fileUrl = "https://example.invalid/referenced-file.txt"
  await receive("original-image", "", { attachments: [{ url: imageUrl, content_type: "image/png" }] })
  const imageReply = await receive("reply-to-image", "查看图片", { message_reference: { message_id: "original-image" } })
  await receive("newer-image", "", { attachments: [{ url: "https://example.invalid/wrong-newer-image.png", content_type: "image/png" }] })
  assert.equal(imageReply.reply_id, "original-image")
  assert.equal(imageReply.hasReply, true)
  assert.equal(imageReply.source.seq, undefined)
  const original = await imageReply.getReply()
  assert.equal(original.message_id, "original-image")
  assert.equal(imageReply.source.time, original.time)
  assert.notEqual(imageReply.source.time, imageReply.time)
  assert.equal(imageReply.source.user_id, incomingUser)
  assert.deepEqual(Array.from(original.message.filter(item => item.type === "image"), item => item.url), [imageUrl])
  await receive("original-file", "", { attachments: [{ url: fileUrl, filename: "reference.txt", content_type: "text/plain" }] })
  const fileReply = await receive("reply-to-file", "查看文件", { message_reference: { message_id: "original-file" } })
  const source = await fileReply.getReply()
  assert.equal(source.message[0].type, "file")
  const contact = privateChat ? fileReply.friend : fileReply.group
  assert.equal(await contact.getFileUrl(source.message[0].fid), fileUrl)
  assert.equal((await f.Bot.getMsg(fileReply.reply_id)).message[0].url, fileUrl)
})

test("插件合同：缺失引用不会误取最新消息，文件查询不能跨会话读取附件", async t => {
  const f = await pluginFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "unrelated-current", content: "最新消息" })
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "uncached-reference", content: "引用未收到的消息", message_reference: { message_id: "not-observed" } })
  let result
  try { result = await e.getReply() } catch (error) { assert.match(error.message, /未缓存|不存在|未收到|找不到/) }
  assert.equal(result, undefined)
  const foreignUrl = "https://example.invalid/foreign.txt"
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, group_openid: "FOREIGN", group_id: "FOREIGN", id: "foreign-file", attachments: [{ url: foreignUrl, filename: "foreign.txt", content_type: "text/plain" }] })
  await assert.rejects(e.group.getFileUrl(foreignUrl), /未提供|未缓存|不存在|找不到/)
})

test("插件合同：获取已收到历史后可按 sender/message 过滤并引用回复、撤回", async t => {
  const f = await pluginFixture(t)
  for (const [id, user, content] of [["h1", incomingUser, "第一条"], ["h2", "OTHER_USER", "别人的消息"], ["h3", incomingUser, "第三条"]])
    await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id, content, author: { ...incomingBase.author, id: user, member_openid: user } })
  const history = await f.Bot.pickGroup(incomingGroup).getChatHistory(0, 20)
  const mine = history.filter(item => item.sender.user_id === incomingUser && item.message.some(segment => segment.type === "text"))
  assert.deepEqual(Array.from(mine, item => item.message_id), ["h1", "h3"])
  const sent = [], recalled = []
  f.sdk.sendGroupMessage = async (_group, message) => { sent.push(message); return { id: "history-follow-up" } }
  f.sdk.recallGroupMessage = async (_group, messageId) => { recalled.push(messageId); return true }
  const response = await mine[0].reply("回复筛选结果")
  assert.equal(sent[0][0].data.id, "h1")
  assert.equal(response.message_id, "history-follow-up")
  assert.equal(await mine[0].group.recallMsg(response.message_id), true)
  assert.deepEqual(recalled, ["history-follow-up"])
})

const contractPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=", "base64")

test("插件合同：图片、Silk语音、视频和文件实际上传并发送官方富媒体参数", async t => {
  const f = await pluginFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "媒体触发" })
  const uploaded = [], posted = []
  f.sdk.fileProcessor.uploadForMessage = async (payload, options) => {
    uploaded.push({ payload, options })
    return { file_info: `media-info-${payload.file_type}`, raw_url: `https://cos.example.com/media-${payload.file_type}`, ttl: 60 }
  }
  f.sdk.request.post = async (url, payload) => { posted.push({ url, payload }); return { data: { id: `media-${posted.length}` } } }
  for (const [type, file, expectedType, name] of [
    ["image", contractPng, 1], ["record", Buffer.from("#!SILK_V3"), 3],
    ["video", Buffer.from("0000ftyp0000"), 2], ["file", Buffer.from("file body"), 4, "合同文件.txt"],
  ]) {
    const result = await e.reply([{ type: "text", text: `说明${type}` }, { type, file, ...(name ? { name } : {}) }])
    assert.equal(result.message_id, `media-${posted.length}`)
    const lastUpload = uploaded.at(-1), lastPost = posted.at(-1)
    assert.equal(lastUpload.payload.file_type, expectedType)
    assert.equal(lastUpload.options.targetType, "group")
    assert.equal(lastUpload.options.targetId, incomingGroup)
    assert.equal(lastPost.url, `/v2/groups/${incomingGroup}/messages`)
    assert.equal(lastPost.payload.msg_type, 7)
    assert.equal(lastPost.payload.msg_id, incomingBase.id)
    assert.equal(lastPost.payload.media.file_info, `media-info-${expectedType}`)
    assert.equal(lastPost.payload.content, `说明${type}`)
    if (name) assert.equal(lastUpload.payload.file_name, name)
  }
  assert.equal(uploaded.length, 4)
  assert.equal(posted.length, 4)
  const sentFile = await f.account.pickGroup(incomingGroup).sendFile(Buffer.from("group file"), undefined, "实际群文件.txt")
  assert.equal(sentFile.message_id, "media-5")
  assert.equal(uploaded.at(-1).payload.file_name, "实际群文件.txt")
  assert.equal(posted.at(-1).payload.msg_id, undefined)
})

test("插件合同：表情、Markdown、按钮和官方键盘保留可执行SDK消息体", async t => {
  const f = await pluginFixture(t)
  f.config.markdown = {}
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "组件触发" })
  const sent = []
  f.sdk.sendGroupMessage = async (_group, message) => { sent.push(message); return { id: `component-${sent.length}` } }
  await e.reply({ type: "face", id: 14 })
  assert.equal(sent.at(-1).find(item => item.type === "face").data.id, 14)
  await f.account.pickGroup(incomingGroup).sendMsg([{ type: "at", qq: incomingUser }, " 开始"])
  assert.equal(textOf(sent.at(-1)), "@Alice 开始")
  await e.reply({ type: "markdown", content: "# 原生标题" })
  assert.equal(sent.at(-1).find(item => item.type === "markdown").data.content, "# 原生标题")
  await e.reply(["操作说明", { type: "button", data: [[{ text: "开始", input: "#开始", send: true }]] }])
  const button = sent.at(-1).find(item => item.type === "button").data.buttons[0]
  assert.equal(button.render_data.label, "开始")
  assert.equal(button.action.type, 2)
  assert.equal(button.action.data, "#开始")
  assert.equal(button.action.enter, true)
  const keyboard = { rows: [{ buttons: [{ id: "existing", render_data: { label: "打开", style: 1 }, action: { type: 0, permission: { type: 2 }, data: "https://example.com" } }] }] }
  await e.reply([{ type: "markdown", content: "原始键盘" }, { type: "keyboard", content: keyboard }])
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).find(item => item.type === "keyboard").data.content)), keyboard)
  assert.ok(sent.filter(message => message.some(item => item.type === "reply")).every(message => message.find(item => item.type === "reply")?.data.id === incomingBase.id))
})

test("插件合同：好友和成员继承方法实际发送、查历史、转发、上传和撤回", async t => {
  const f = await pluginFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "群中成员" })
  await f.receive("C2C_MESSAGE_CREATE", { id: "private-contract", content: "私聊正文", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "好友昵称" }, attachments: [{ url: "https://example.com/private-contract.txt", filename: "合同.txt", content_type: "text/plain" }] })
  const sent = [], recalled = [], uploads = [], posts = []
  f.sdk.sendPrivateMessage = async (target, message) => { sent.push({ target, message }); return { id: `private-output-${sent.length}` } }
  f.sdk.user = target => ({ recall: async messageId => { recalled.push({ target, messageId }); return true } })
  f.sdk.fileProcessor.uploadForMessage = async (payload, options) => {
    uploads.push({ payload, options })
    return { file_info: "contact-media", raw_url: "https://cos.example.com/contact-media.png", ttl: 60 }
  }
  f.sdk.request.post = async (url, payload) => { posts.push({ url, payload }); return { data: { id: "private-file-sent" } } }
  for (const contact of [f.account.pickFriend(incomingUser), f.account.pickMember(incomingGroup, incomingUser)]) {
    assert.equal((await contact.getInfo()).nickname, contact.group_id ? "Alice" : "好友昵称")
    assert.equal((await contact.getSimpleInfo()).user_id, incomingUser)
    assert.equal(contact.getAvatarUrl(100), `https://q.qlogo.cn/qqapp/mock-app/${incomingUser}/100`)
    assert.equal(contact.asFriend().info.user_id, incomingUser)
    assert.equal(contact.asMember(incomingGroup).info.group_id, incomingGroup)
    assert.equal((await contact.searchSameGroup())[0].group_id, incomingGroup)
    assert.equal((await contact.getMsg("private-contract")).message_id, "private-contract")
    assert.equal((await contact.getChatHistory(0, 10))[0].raw_message, "私聊正文[文件]")
    assert.equal(await contact.getFileUrl("https://example.com/private-contract.txt"), "https://example.com/private-contract.txt")
    const result = await contact.sendMsg("继承发送")
    assert.equal(result.message_id, `private-output-${sent.length}`)
    assert.equal(sent.at(-1).target, incomingUser)
    assert.equal(textOf(sent.at(-1).message), "继承发送")
    assert.equal(await contact.recallMsg(result.message_id), true)
    assert.equal(recalled.at(-1).messageId, result.message_id)
    const forward = await contact.makeForwardMsg([{ user_id: incomingUser, nickname: "好友昵称", message: "继承转发正文" }])
    await contact.sendMsg(forward)
    assert.equal(textOf(sent.at(-1).message), "继承转发正文")
    const image = await contact.uploadImage(contractPng)
    assert.equal(image.width, 1)
    assert.equal(image.height, 1)
    assert.equal(image.file_info, "contact-media")
    assert.equal(await contact.fileToUrl(contractPng), image.url)
    assert.equal(await contact.filetoUrl(contractPng), image.url)
    assert.equal(uploads.at(-1).options.targetType, "user")
    assert.equal(uploads.at(-1).options.targetId, incomingUser)
    const file = await contact.sendFile(Buffer.from("contact file"), "继承文件.txt")
    assert.equal(file.message_id, "private-file-sent")
    assert.equal(uploads.at(-1).payload.file_name, "继承文件.txt")
    assert.equal(posts.at(-1).url, `/v2/users/${incomingUser}/messages`)
    assert.equal(posts.at(-1).payload.media.file_info, "contact-media")
  }
})

async function connectedContractFixture(t) {
  const sdk = new EventEmitter(), receiver = new EventEmitter()
  sdk.sessionManager = { receiver }
  sdk.getSelfInfo = async () => ({ username: "连接账号", avatar: "https://example.com/bot-avatar.png" })
  sdk.stop = async () => receiver.emit("close")
  const f = await fixture(t, {}, { sdk: {
    createBot: () => sdk, login: async () => receiver.emit("ready"), logout: async () => sdk.stop(),
  } })
  const host = new EventEmitter()
  f.setBot(host)
  const AdapterEvents = (await f.load("adapter/events.js")).namespace.default
  const adapter = new AdapterEvents()
  const members = new Map([[incomingUser, { user_id: incomingUser, nickname: "连接成员", role: "member" }]])
  Object.assign(adapter, { id: "QQBot", name: "QQBot", sep: ":", appid: {}, interactionWarned: {}, activeIntents: {}, toQRCodeRegExp: false,
    getFriendMap: async () => new Map([[incomingUser, { user_id: incomingUser, nickname: "连接好友" }]]),
    getGroupMap: async () => new Map([[incomingGroup, { group_id: incomingGroup, group_name: "连接群", group_avatar: "https://example.com/group-avatar.png" }]]),
    getMemberMap: async () => new Map([[incomingGroup, members]]), getMessageMap: async () => new Map(),
  })
  f.bindAdapter(adapter)
  assert.equal((await adapter.connectOnce(incomingSelf, { appid: "contract-app", secret: "contract-secret" }, [])).ok, true)
  await f.load("lib/bot.js")
  return { ...f, adapter, sdk, account: f.getBot()[incomingSelf], Bot: f.getBot() }
}

test("插件合同：真实账号构造暴露全局及账号别名、Map、头像、监听和上传方法", async t => {
  const f = await connectedContractFixture(t)
  const sent = [], uploaded = []
  f.sdk.sendPrivateMessage = async (target, message) => { sent.push({ target, message }); return { id: "lifecycle-private" } }
  f.sdk.fileProcessor = { uploadForMessage: async (payload, options) => {
    uploaded.push({ payload, options }); return { file_info: "account-media", raw_url: "https://cos.example.com/account.png", ttl: 60 }
  } }
  for (const bot of [f.Bot, f.account]) {
    assert.equal(bot.pickUser(incomingUser).info.nickname, "连接好友")
    assert.equal(bot.pickMember(incomingGroup, incomingUser).info.nickname, "连接成员")
    assert.equal((await bot.getGroupInfo(incomingGroup)).group_name, "连接群")
    assert.equal((await bot.getStrangerInfo(incomingUser)).nickname, "连接好友")
    assert.equal(bot.getAvatarUrl(640), "https://example.com/bot-avatar.png")
    assert.equal(bot.getGroupMap().get(incomingGroup).group_name, "连接群")
    assert.equal(bot.getFriendMap().get(incomingUser).nickname, "连接好友")
    assert.equal(bot.pickGroup(incomingGroup).getAvatarUrl(), "https://example.com/group-avatar.png")
    const result = await bot.sendPrivateMsg(incomingUser, "全局或账号私聊")
    assert.equal(result.message_id, "lifecycle-private")
    assert.equal(sent.at(-1).target, incomingUser)
    assert.equal(textOf(sent.at(-1).message), "全局或账号私聊")
    const forward = await bot.makeForwardMsg([{ user_id: incomingUser, nickname: "连接好友", message: "账号转发" }])
    await bot.pickUser(incomingUser).sendMsg(forward)
    assert.equal(textOf(sent.at(-1).message), "账号转发")
    const image = await bot.uploadImage(contractPng, { targetType: "group", targetId: incomingGroup })
    assert.equal(image.width, 1)
    assert.equal(image.height, 1)
    assert.equal(image.file_info, "account-media")
    assert.equal(await bot.fileToUrl(contractPng, { targetType: "group", targetId: incomingGroup }), image.url)
    assert.equal(await bot.filetoUrl(contractPng, { targetType: "group", targetId: incomingGroup }), image.url)
    assert.equal(uploaded.at(-1).options.targetId, incomingGroup)
    const seen = [], listener = value => seen.push(value)
    bot.on("contract-event", listener)
    bot.once("contract-event", value => seen.push(`once:${value}`))
    assert.equal(bot.listeners("contract-event").length, 2)
    bot.emit("contract-event", "first")
    bot.emit("contract-event", "second")
    assert.deepEqual(seen, ["first", "once:first", "second"])
    assert.equal(bot.listenerCount("contract-event"), 1)
    bot.off("contract-event", listener)
    assert.equal(bot.listenerCount("contract-event"), 0)
  }
  const map = f.Bot.getGroupMap()
  assert.deepEqual(Array.from(map.entries(), ([id, info]) => [id, info.group_name]), [[incomingGroup, "连接群"]])
  map.set("ANOTHER", { group_id: "ANOTHER", group_name: "临时群", uin: incomingSelf })
  assert.equal(f.account.gl.has("ANOTHER"), true)
  assert.equal(map.delete("ANOTHER"), true)
  assert.equal(f.account.gl.has("ANOTHER"), false)
  map.clear()
  assert.equal(map.size, 0)
  assert.equal(f.account.gl.size, 0)
})

test("插件合同：禁言别名、解禁、踢人和申请黑名单方法执行实际HTTP并更新成员缓存", async t => {
  const f = await pluginFixture(t)
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  const posted = [], queried = []
  f.sdk.request.post = async (url, payload) => {
    posted.push({ url, payload })
    if (url.endsWith("/batch_remove_members")) return { data: { remove_members_result: "success", add_to_member_blacklist_fail_openids: [] } }
    if (url.endsWith("/member_blacklist")) return { data: { fail_openids: [] } }
    return { data: {} }
  }
  f.sdk.request.get = async (url, options) => {
    queried.push({ url, options })
    if (url.endsWith("/join_request_list")) return { data: { requests: [{ member_openid: incomingUser, join_request_id: "REQUEST" }], next_cursor: "" } }
    if (url.endsWith("/member_blacklist")) return { data: { users: [{ member_openid: "BANNED" }], next_cursor: "" } }
    throw new Error(`Unexpected contract HTTP: ${url}`)
  }
  const group = f.account.pickGroup(incomingGroup), member = group.pickMember(incomingUser)
  assert.equal(await f.account.setGroupBan(incomingGroup, incomingUser, 60), true)
  assert.equal(posted.at(-1).url, `/v2/groups/${incomingGroup}/restrict_chat_setting`)
  assert.equal(posted.at(-1).payload.members[0].op, "add")
  assert.ok(member.mute_left > 0)
  assert.equal(await group.unmuteMember(incomingUser), true)
  assert.equal(posted.at(-1).payload.members[0].op, "del")
  assert.equal(member.mute_left, 0)
  await member.mute(60)
  assert.equal(await member.unmute(), true)
  assert.equal(member.mute_left, 0)
  for (const operation of [() => member.kick(), () => f.account.setGroupKick(incomingGroup, incomingUser)]) {
    await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
    assert.equal(await operation(), true)
    assert.equal(posted.at(-1).payload.member_openids[0], incomingUser)
    assert.equal((await group.getMemberMap()).has(incomingUser), false)
  }
  const removed = await f.account.batchRemoveGroupMembers(incomingGroup, ["ONE", "TWO"])
  assert.equal(removed.remove_members_result, "success")
  assert.deepEqual(Array.from(posted.at(-1).payload.member_openids), ["ONE", "TWO"])
  const blacklist = await f.account.setGroupMemberBlacklist(incomingGroup, { op: "add", member_openids: [incomingUser] })
  assert.equal(blacklist.fail_openids.length, 0)
  assert.equal(posted.at(-1).url, `/v2/groups/${incomingGroup}/member_blacklist`)
  assert.equal((await group.getBlacklist({ limit: 20 })).users[0].member_openid, "BANNED")
  assert.equal(queried.at(-1).options.params.limit, 20)
  assert.equal((await group.getJoinRequests({ limit: 20 })).requests[0].join_request_id, "REQUEST")
  assert.equal(queried.at(-1).url, `/v2/groups/${incomingGroup}/join_request_list`)
  assert.equal((await f.account.getGroupJoinRequests(incomingGroup, { limit: 10 })).requests[0].member_openid, incomingUser)
  assert.equal(queried.at(-1).options.params.limit, 10)
  await group.approveJoinRequest(incomingUser, { op: "approve", join_request_id: "REQUEST" })
  assert.equal(posted.at(-1).url, `/v2/groups/${incomingGroup}/approval_join_request/${incomingUser}`)
  assert.equal(posted.at(-1).payload.join_request_id, "REQUEST")
  await f.account.approveGroupJoinRequest(incomingGroup, incomingUser, { op: "decline", join_request_id: "REQUEST", reject_reason: "合同拒绝" })
  assert.equal(posted.at(-1).payload.op, "decline")
  assert.equal(posted.at(-1).payload.reject_reason, "合同拒绝")
})

test("插件合同：账号sendGuildMsg使用频道ID且返回实际发送消息ID", async t => {
  const f = await pluginFixture(t)
  const sent = []
  f.sdk.sendGuildMessage = async (channel, message) => { sent.push({ channel, message }); return { id: "account-guild-sent" } }
  const result = await f.account.sendGuildMsg("GUILD", "CHANNEL", "账号频道消息")
  assert.equal(result.message_id, "account-guild-sent")
  assert.equal(sent[0].channel, "CHANNEL")
  assert.equal(textOf(sent[0].message), "账号频道消息")
  assert.ok(!sent[0].message.some(item => item.type === "reply"))
})

test("插件合同：宿主原生segment.fake、at和markdown构造结果经过实际SDK发送", async t => {
  const hostRequire = createRequire(new URL("../../../package.json", import.meta.url))
  const { segment } = hostRequire("icqq")
  const f = await pluginFixture(t)
  f.config.markdown = {}
  await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase })
  const sent = []
  f.sdk.sendGroupMessage = async (target, message) => { sent.push({ target, message }); return { id: `native-segment-${sent.length}` } }
  const node = segment.fake(incomingUser, [segment.at(incomingUser, "Alice"), segment.text(" 原生转发正文")], "原生昵称", 1700000000)
  const result = await f.Bot.pickGroup(incomingGroup).sendMsg(node)
  assert.equal(result.message_id, "native-segment-1")
  assert.equal(sent[0].target, incomingGroup)
  assert.equal(textOf(sent[0].message), "@Alice 原生转发正文")
  const markdown = await f.Bot.pickGroup(incomingGroup).sendMsg(segment.markdown("# 原生构造标题"))
  assert.equal(markdown.message_id, "native-segment-2")
  assert.equal(sent[1].message.find(item => item.type === "markdown").data.content, "# 原生构造标题")
})
