// node --experimental-vm-modules --test tests/webhook-lifecycle.test.mjs
import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import http from "node:http"
import { EventEmitter, once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import { fixture, incomingFixture, incomingSelf, incomingUser, incomingGroup, incomingBase, mentionedUser } from "./helpers/qqbot-fixture.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const account = { uin: "10001", appid: "20001", secret: "test-secret", webhook: true }


test("gateway event debug logs preserve the complete packet", async t => {
  const f = await fixture(t, null)
  const packet = {
    t: "UNKNOWN_EVENT",
    d: { nested: { value: "x".repeat(1200) }, entries: Array.from({ length: 60 }, (_, i) => i) },
  }
  f.logEventPacket(packet.t, packet, "10001")
  assert.equal(f.debugLogs.length, 1)
  assert.ok(f.debugLogs[0].includes("收到事件包 [UNKNOWN_EVENT]"))
  assert.ok(f.debugLogs[0].includes("x".repeat(1200)))
  assert.ok(f.debugLogs[0].includes("59"))
})

test("QQBot 消息通过真实 ICQQ TripTrap 投递，缺少 listenerCount 不再绕过面板", async t => {
  const f = await fixture(t, null)
  const hostRequire = createRequire(new URL("../../../package.json", import.meta.url))
  const require = createRequire(hostRequire.resolve("icqq"))
  const { Trapper } = require("triptrap")
  const bot = new Trapper(), captured = []
  bot.on = bot.trap.bind(bot)
  bot.emit = bot.trip.bind(bot)
  assert.equal(typeof bot.listenerCount, "undefined")
  bot.on("message", event => captured.push(event))
  bot.on("message.group", event => captured.push(event))
  f.setBot(bot)
  f.bindAdapter({ id: "QQBot", sep: ":", pickGroup: () => ({}), pickMember: () => ({}) })
  await f.dispatch("message.group", { self_id: "10001", post_type: "message", message_type: "group", group_id: "10001:GROUP", sender: { user_id: "10001:USER", permissions: ["owner"] }, message_id: "mock-received", message: [{ type: "text", text: "mock" }], raw_message: "mock" })
  assert.equal(captured.length, 2)
  assert.equal(captured[0], captured[1])
  assert.equal(captured[0].group_id, "GROUP")
  assert.deepEqual([...captured[0].sender.permissions], ["owner"])
})

test("真实 SDK 引用事件 103 保留引用摘要，正文与引用分开，不虚构 msg_idx 映射", async t => {
  const f = await fixture(t, null)
  const sdkModule = (await f.load("adapter/sdk.js")).namespace
  const sdk = sdkModule.createBot({ appid: "10000", secret: randomBytes(24).toString("hex"), intents: [] })
  const base = { id: "incoming-quote", group_openid: "GROUP", content: "回复正文", author: { id: "USER", member_openid: "USER", username: "Member" }, timestamp: new Date().toISOString(), message_type: 103, msg_elements: [{ content: "被引用的原文", message_type: 0, msg_idx: "different-index" }] }
  const event = sdk.processPayload("event", "message.group", { ...base })
  assert.equal(event.message_type, "group")
  assert.equal(event._qqbotMessageType, 103)
  sdkModule.normalizeEvent(event)
  assert.equal(event.source.raw_message, "被引用的原文")
  assert.equal(event.source.message_id, "")
  assert.equal(event.message[0].type, "reply")
  assert.equal(event.message[1].text, "回复正文")
  sdkModule.normalizeEvent(event)
  assert.equal(event.message.filter(segment => segment.type === "reply").length, 1)
  const bare = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, id: "bare", content: "" }))
  assert.equal(bare.message.length, 1)
  assert.equal(bare.message[0].type, "reply")
  const media = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, content: "", msg_elements: [{ attachments: [{ content_type: "image/png" }] }] }))
  assert.equal(media.source.raw_message, "[图片]")
  const ordinary = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, message_type: 0 }))
  assert.equal(ordinary.source, undefined)
})


for (const sep of [":", ""]) test(`群 @ 机器人空正文补齐 at 段，兼容 ${sep} 实例分隔符且不重复`, async t => {
  const f = await incomingFixture(t, sep)
  const e = await f.receive("GROUP_AT_MESSAGE_CREATE", { ...incomingBase, content: " " })
  assert.deepEqual(e.message.map(item => item.type), ["at"])
  assert.equal(e.message[0].qq, incomingSelf)
  assert.equal(e.message[0].text, "@DemoBot")
  assert.equal(e.atBot, true)
  assert.equal(e.group_name, "Demo Group")
  assert.equal(e.group.name, "Demo Group")
  assert.equal(e.user_id, incomingUser)
  assert.equal(e.sender.role, "owner")
  assert.equal(e.member.is_owner, true)
  assert.equal(e.message_type, "group")
  assert.equal(e.sub_type, "normal")
  assert.equal(e.message_format, "array")
  assert.equal(e.time, Math.floor(Date.parse(incomingBase.timestamp) / 1000))
  assert.equal(e.raw_message, "@DemoBot")
  await f.adapter.makeMessage(incomingSelf, e.raw)
  assert.equal(f.captured.at(-1).message.filter(item => item.type === "at").length, 1)
})

for (const content of [`<@${mentionedUser}> `, `<@!${mentionedUser}> `, `\\u003c@${mentionedUser}\\u003e `, `&lt;@${mentionedUser}&gt; `])
  test(`群 @ 他人保留消息段、昵称与正文顺序：${content}`, async t => {
    const f = await incomingFixture(t)
    const e = await f.receive("GROUP_MESSAGE_CREATE", {
      ...incomingBase, content: `前文${content}后文`,
      mentions: [{ id: mentionedUser, member_openid: mentionedUser, username: "Bob", is_you: false, member_role: "admin" }],
    })
    assert.deepEqual(e.message.map(item => item.type), ["text", "at", "text"])
    assert.equal(e.message[1].qq, mentionedUser)
    assert.equal(e.message[1].text, "@Bob")
    assert.equal(e.message[1].is_you, false)
    assert.equal(e.atBot, undefined)
    assert.equal(e.raw_message, "前文@Bob 后文")
    assert.equal(f.adapter.atToText({ self_id: incomingSelf, bot: f.account }, e.message[1]), "@Bob")
    assert.equal(e.sender.role, "owner")
  })

test("@ 缺少 mentions 不丢失 OpenID；全体 @ 保留 all；普通正文不凭 mentions 添加他人 @", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: `<@!${mentionedUser}> <@everyone> <@all>正文` })
  assert.deepEqual(e.message.filter(item => item.type === "at").map(item => item.qq), [mentionedUser, "all", "all"])
  assert.equal(e.atBot, undefined)
  const plain = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文", mentions: [{ id: mentionedUser }] })
  assert.deepEqual(plain.message.map(item => item.type), ["text"])
})

for (const is_you of [true, "true"]) test(`显式 @ 机器人 is_you=${typeof is_you} 正确识别，多个 @ 不丢失`, async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_AT_MESSAGE_CREATE", {
    ...incomingBase, content: `<@BOT_OPENID> <@${mentionedUser}> 指令`,
    mentions: [{ id: "BOT_OPENID", username: "DemoBot", is_you }, { id: mentionedUser, username: "群员", is_you: false }],
  })
  assert.equal(e.message.filter(item => item.type === "at" && item.qq === incomingSelf).length, 1)
  assert.equal(e.message.find(item => item.type === "at" && item.qq === mentionedUser).text, "@群员")
  assert.equal(e.atBot, true)
  assert.equal(e.raw_message, "@DemoBot @群员 指令")
})

for (const type of ["C2C_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"]) test(`${type} 文件可通过 e.file 和场景 getFileUrl 读取，名称/大小/URL 对齐`, async t => {
  const f = await incomingFixture(t)
  const url = "https://files.example.com/download?fname=sample.txt&key=mock"
  const payload = {
    ...incomingBase, attachments: [{ content_type: "file", filename: "sample.txt", size: 2048, url }],
  }
  if (type === "C2C_MESSAGE_CREATE") {
    delete payload.group_id
    delete payload.group_openid
    payload.author = { id: incomingUser, user_openid: incomingUser, username: "" }
    f.account.fl.set(`${incomingSelf}:${incomingUser}`, { nickname: "缓存昵称" })
  }
  const e = await f.receive(type, payload)
  assert.equal(e.message.length, 1)
  const file = e.message[0]
  assert.equal(file.type, "file")
  assert.equal(file.name, "sample.txt")
  assert.equal(file.size, 2048)
  assert.equal(file.file_size, 2048)
  assert.equal(file.url, url)
  assert.equal(file.file, url)
  assert.equal(file.fid, url)
  assert.equal(file.file_id, undefined)
  assert.equal(e.file.name, "sample.txt")
  assert.equal(e.raw_message, "[文件]")
  const peer = e.group || e.friend
  // 宿主 dealMsg 会只保留 name/fid，旧插件仍可取得下载地址。
  e.file = { name: file.name, fid: file.fid }
  assert.equal(await peer.getFileUrl(e.file.fid), url)
  await assert.rejects(peer.getFileUrl("其他消息的文件"), /未提供/)
  assert.equal(payload.attachments[0].filename, "sample.txt")
  if (type === "C2C_MESSAGE_CREATE") {
    assert.equal(e.message_type, "private")
    assert.equal(e.sub_type, "friend")
    assert.equal(e.target_id, incomingUser)
    assert.equal(e.sender.nickname, "缓存昵称")
    assert.equal(e.sender.role, undefined)
  }
})

test("混合媒体按 image/record/video/file 分类，保留文件真实 ID、零大小，链接不误归类", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", {
    ...incomingBase, content: "正文<faceType=1,faceId=14>",
    attachments: [
      { content_type: "image/png", filename: "image.png", url: "//files.example.com/image.png", width: 123 },
      { content_type: "audio/silk", filename: "audio.silk", url: "https://files.example.com/audio.silk" },
      { content_type: "video/mp4", filename: "video.mp4", url: "https://files.example.com/video.mp4" },
      { content_type: "application/octet-stream", filename: "empty.bin", size: "0", file_id: "REAL_FILE_ID", url: "https://files.example.com/empty.bin" },
      { content_type: "text/plain", filename: "text.txt", url: "https://files.example.com/text.txt" },
    ],
  })
  assert.deepEqual(e.message.map(item => item.type), ["text", "face", "image", "record", "video", "file", "file"])
  assert.equal(e.message[2].url, "https://files.example.com/image.png")
  assert.equal(e.message[2].width, 123)
  assert.equal(e.message[5].fid, "REAL_FILE_ID")
  assert.equal(e.message[5].file_size, 0)
  assert.equal(await e.group.getFileUrl("REAL_FILE_ID"), "https://files.example.com/empty.bin")
  assert.equal(e.raw_message, "正文[表情:14][图片][语音][视频][文件][文件]")
  const other = f.sdkModule.normalizeEvent({ message: [{ type: "link", data: { url: "https://example.com" } }, { type: "json", data: "原始 JSON 内容" }] })
  assert.equal(other.message[0].type, "link")
  assert.equal(other.message[1].data, "原始 JSON 内容")
})

test("群名未下发时使用已有缓存或 OpenID，角色降为普通群员不会沿用 owner", async t => {
  const f = await incomingFixture(t, ":", {})
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  assert.equal(e.group_name, incomingGroup)
  assert.equal(e.member.is_owner, true)
  const member = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文", group_name: "新群名", author: { ...incomingBase.author, member_role: "member" } })
  assert.equal(member.group.name, "新群名")
  assert.equal(member.sender.role, "member")
  assert.equal(member.member.is_owner, false)
  assert.equal(member.member.is_admin, false)
  const unnamed = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文", author: { ...incomingBase.author, username: "", member_role: "member" } })
  assert.equal(unnamed.sender.nickname, "Alice")
})

test("缺少作者通用 id 仍保留 OpenID；@ 使用 member_openid；缺少附件 URL 不虚构链接", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_MESSAGE_CREATE", {
    ...incomingBase, content: "<@TARGET_ID>", author: { member_openid: incomingUser, member_role: "admin" },
    mentions: [{ id: "TARGET_ID", member_openid: mentionedUser, username: "群员" }],
    attachments: [{ content_type: "file", filename: "unavailable.bin", size: 0 }],
  })
  assert.equal(e.sender.user_id, incomingUser)
  assert.equal(e.sender.role, "admin")
  assert.equal(e.member.is_admin, true)
  assert.equal(e.message[0].qq, mentionedUser)
  assert.equal(e.message[0].id, mentionedUser)
  assert.equal(e.file.name, "unavailable.bin")
  assert.equal(e.file.url, undefined)
  assert.equal(e.file.file, undefined)
  await assert.rejects(e.group.getFileUrl(e.file.fid), /未提供/)
})

test("引用 103、机器人 @ 和文件混合时正文保持独立，重复规范化不增加消息段", async t => {
  const f = await incomingFixture(t)
  const e = await f.receive("GROUP_AT_MESSAGE_CREATE", {
    ...incomingBase, content: "引用后的正文", message_type: 103,
    msg_elements: [{ content: "原消息摘要", msg_idx: "independent-index" }],
    attachments: [{ content_type: "file", filename: "quoted.txt", url: "https://files.example.com/quoted.txt" }],
  })
  assert.deepEqual(e.message.map(item => item.type), ["reply", "at", "text", "file"])
  assert.equal(e.source.message_id, "")
  assert.equal(e.source.raw_message, "原消息摘要")
  assert.equal(e.message[2].text, "引用后的正文")
  const normalized = f.sdkModule.normalizeEvent(e.raw)
  await f.adapter.makeMessage(incomingSelf, normalized)
  assert.deepEqual(f.captured.at(-1).message.map(item => item.type), ["reply", "at", "text", "file"])
})

test("首次没有用户配置时生成默认配置，不启动 HTTP", async t => {
  const f = await fixture(t, null)
  assert.equal(f.files.size, 2)
  f.webhook.use("/QQBot", () => {})
  f.webhook.init()
  assert.equal(f.webhook.server, null)
  assert.equal(f.listenPorts.length, 0)
  assert.equal(f.warnings.length, 0)
})

for (const [name, accounts] of [
  ["无账号", []],
  ["仅有 WebSocket 账号", [{ ...account, webhook: false }]],
  ["WebHook 账号缺少密钥", [{ ...account, secret: "" }]],
]) test(`${name}时配置了端口和公网地址也不启动 HTTP`, async t => {
  const f = await fixture(t, { accounts, webhookPort: 8080, url: "https://example.com" })
  f.webhook.use("/QQBot", () => {})
  f.webhook.init()
  assert.equal(f.webhook.init(), null)
  assert.equal(await f.fileToUrl(Buffer.from("image")), "")
  assert.equal(f.listenPorts.length, 0)
  assert.equal(await f.fileToUrl("https://example.com/image.png"), "https://example.com/image.png")
})

test("WebHook 账号在启动时监听，HTTP 回调可用且初始化幂等", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.use("/QQBot", req => req.res.send({ ok: req.body.d === "hello" }))
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const response = await fetch(`http://127.0.0.1:${f.webhook.server.address().port}/QQBot`, {
    method: "POST", body: JSON.stringify({ d: "hello" }),
  })
  assert.deepEqual(await response.json(), { ok: true })
  f.webhook.files.set("source.mjs", path.join(root, "tests/webhook-lifecycle.test.mjs"))
  const imageRoute = await fetch(`http://127.0.0.1:${f.webhook.server.address().port}/QQBot/File/source.mjs`)
  assert.equal(imageRoute.status, 200)
  assert.match(await imageRoute.text(), /node --experimental-vm-modules --test/)
  f.webhook.init()
  assert.equal(f.listenPorts.length, 1)
  assert.equal(f.webhook.restartNotice(account), "")
})

test("旧 token 格式的 WebHook 账号仍可在启动时监听", async t => {
  const f = await fixture(t, { token: ["10001:20001:ignored:test-secret:2:0"], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  assert.equal(f.listenPorts.length, 1)
})

test("文件热更新新增 WebHook 账号提示重启，不临时启动或连接", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  f.changeFile({ accounts: [account] })
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  f.changeFile({ accounts: [account] })
  assert.equal(f.warnings.length, 1)
  assert.equal(f.webhook.init(), null)
  const Lifecycle = (await f.load("adapter/lifecycle.js")).namespace.default
  assert.equal(await new Lifecycle().connect(account), false)
  assert.equal(f.listenPorts.length, 0)
})

test("运行中通过指令添加 WebHook 账号会保存并回复重启提示", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  const Plugin = (await f.load("lib/plugin.js")).namespace.QQBotPlugin
  const instance = new Plugin()
  const replies = []
  instance.e = { msg: "#QQBot设置10001:20001:ignored:test-secret:2:0" }
  instance.reply = message => replies.push(message)
  await instance.Token()
  f.configSave.flush()
  assert.equal(f.config.accounts[0].webhook, true)
  assert.match(replies[0], /账号配置已添加.*需要重启 Yunzai 后才能接入/)
  assert.equal(f.connections(), 0)
  assert.equal(f.listenPorts.length, 0)
})

test("运行中通过指令添加 WebSocket 账号仍可直接连接", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  const Plugin = (await f.load("lib/plugin.js")).namespace.QQBotPlugin
  const instance = new Plugin()
  const replies = []
  instance.e = { msg: "#QQBot设置10001:20001:test-secret" }
  instance.reply = message => replies.push(message)
  await instance.Token()
  assert.match(replies[0], /账号已连接/)
  assert.equal(f.connections(), 1)
  assert.equal(f.listenPorts.length, 0)
})

test("面板新增 WebHook 账号保存成功并明确提示重启", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  const panel = (await f.load("elia.support.js")).namespace.supportPanel()
  const result = await panel.configInfo.setConfigData({ accounts: [account] }, {
    Result: { ok: (_data, message) => ({ ok: true, message }), error: message => ({ ok: false, message }) },
  })
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /需要重启 Yunzai 后才能接入/)
  assert.equal(f.config.accounts[0].webhook, true)
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  assert.equal(f.listenPorts.length, 0)
})

test("WebHook 账号未启用端口时不启动，后补端口仍需重启", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 0 })
  f.webhook.init()
  assert.equal(f.webhook.server, null)
  f.changeFile({ webhookPort: 8080 })
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  assert.equal(f.webhook.init(), null)
  assert.equal(f.listenPorts.length, 0)
})

async function panelSave(f, data) {
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const result = await panel.setConfigData(data, {
    Result: { ok: (_data, message) => ({ ok: true, message }), error: message => ({ ok: false, message }) },
  })
  assert.equal(result.ok, true, result.message)
  return result.message
}

test("仅修改实时发送设置时无需重启，部分保存保留原引用回复策略", async t => {
  const f = await fixture(t, { activeMsg: true })
  f.webhook.init()
  const message = await panelSave(f, { sendMode: { default: "text" } })
  assert.equal(message, "配置已保存；本次修改无需重启")
  assert.equal(f.config.activeMsg, true)
})

test("面板保存群聊回复策略映射并允许后续部分保存", async t => {
  const f = await fixture(t, {})
  const mapping = { "10001:GROUP_OPENID": "true", "10001:OTHER_GROUP": "false" }
  await panelSave(f, { activeMsgGroups: mapping })
  assert.deepEqual({ ...f.config.activeMsgGroups }, {
    "10001:GROUP_OPENID": true,
    "10001:OTHER_GROUP": false,
  })
  await panelSave(f, { sendMode: { default: "text" } })
  assert.deepEqual({ ...f.config.activeMsgGroups }, {
    "10001:GROUP_OPENID": true,
    "10001:OTHER_GROUP": false,
  })
})

test("群聊回复策略按机器人QQ号和群OpenID覆盖全局策略", async t => {
  const f = await fixture(t, {
    activeMsg: true,
    activeMsgGroups: { "10001:GROUP_OPENID": true, "10001:PASSIVE_GROUP": false },
  })
  const MessageSender = (await f.load("adapter/message/sender.js")).namespace.default
  const sender = Object.create(MessageSender.prototype)
  sender.sep = ""
  sender.noReply = { "10001": Date.now() + 60_000 }
  const event = { self_id: "10001", message_type: "group", message_id: "message" }
  assert.equal(sender.useReply({ ...event, group_id: "GROUP_OPENID" }), false)
  assert.equal(sender.useReply({ ...event, group_id: `10001${sender.sep}PASSIVE_GROUP` }), true)
  assert.equal(sender.useReply({ ...event, group_id: "OTHER_GROUP" }), false)
  assert.equal(sender.useReply({ ...event, self_id: "20002", group_id: "GROUP_OPENID" }), false)
})

for (const [field, value, label] of [
  ["intents", ["INTERACTION"], "Intents"],
  ["bot.timeout", 60000, "Bot 连接参数"],
  ["permission", "admin", "管理指令权限"],
  ["toQRCode", false, "链接转二维码规则"],
]) test(`修改${label}时仅提示对应项需要重启`, async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { [field]: value }), `配置已保存；${label}变更需重启 Yunzai 生效`)
})

test("同时修改连接参数和实时设置时分别提示生效方式", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { "bot.timeout": 60000, toCallback: false }),
    "配置已保存；Bot 连接参数变更需重启 Yunzai 生效；其他修改无需重启")
})

test("完整表单原样保存及保留密钥不会误报账号变更", async t => {
  const f = await fixture(t, { accounts: [{ ...account, webhook: false }] })
  f.webhook.init()
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const data = await panel.getConfigData()
  assert.equal(data.accounts[0].AppSecret, "")
  assert.equal(await panelSave(f, data), "配置已保存；配置内容未变化")
  assert.equal(f.config.accounts[0].secret, account.secret)
})

test("修改账号密钥提示重启且提示不包含密钥", async t => {
  const f = await fixture(t, { accounts: [{ ...account, webhook: false }] })
  f.webhook.init()
  const message = await panelSave(f, { accounts: [{ ...account, webhook: false, secret: "new-test-secret" }] })
  assert.equal(message, "配置已保存；账号变更需重启 Yunzai 生效")
  assert.doesNotMatch(message, /test-secret/)
})

test("存在 WebHook 账号但端口为 0 时提示补齐端口", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  const message = await panelSave(f, { accounts: [account] })
  assert.match(message, /WebHook 端口为 0，请配置有效端口并重启 Yunzai 后接入/)
})

test("没有 WebHook 账号且 HTTP 未启动时调整端口无需重启", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { webhookPort: 8080 }), "配置已保存；本次修改无需重启")
})

test("HTTP 运行中删除最后一个 WebHook 账号提示重启关闭服务", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const message = await panelSave(f, { accounts: [] })
  assert.match(message, /账号变更需重启 Yunzai 生效/)
  assert.match(message, /当前 HTTP 服务仍在运行，重启 Yunzai 后将关闭/)
  assert.equal(f.webhook.server.listening, true)
})

test("HTTP 运行中关闭端口提示端口变更和重启关闭服务", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const message = await panelSave(f, { webhookPort: 0 })
  assert.match(message, /WebHook 端口变更需重启 Yunzai 生效/)
  assert.match(message, /当前 HTTP 服务仍在运行，重启 Yunzai 后将关闭/)
})

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=", "base64")
function uploadBot(handler) {
  const calls = []
  const bot = { adapter: "QQBot", uin: "10001", fl: new Map([["USER", {}]]), gl: new Map([["GROUP", {}]]), gml: new Map(),
    sdk: { fileProcessor: { async uploadForMessage(payload, options) {
      calls.push({ payload, options })
      return handler ? handler(payload, options) : { file_info: "uploaded", raw_url: "https://cos.example.com/image.png", ttl: 60 }
    } } },
  }
  return { bot, calls }
}

test("未配置 HTTP 且旧上传开关关闭时仍优先官方直链，Base64/data URL/Uint8Array 共用缓存", async t => {
  const f = await fixture(t, { toBotUpload: false, webhookPort: 0, url: "" })
  const { bot, calls } = uploadBot()
  f.setBot({ "10001": bot })
  for (const file of [png, `base64://${png.toString("base64")}`, `data:image/png;base64,${png.toString("base64")}`, new Uint8Array(png)])
    assert.equal(await f.fileToUrl(file), "https://cos.example.com/image.png")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.sendMessage, false)
  assert.equal(f.webhook.server, null)
  assert.equal(f.warnings.length, 0)
})

test("群/C2C 上传接口返回尺寸与凭据，filetoUrl 兼容名称使用相同目标缓存", async t => {
  const f = await fixture(t, {})
  const { bot, calls } = uploadBot()
  f.setBot({ "10001": bot })
  const BotApi = (await f.load("adapter/bot-api.js")).namespace.default
  const adapter = Object.create(BotApi.prototype)
  adapter.sep = ""
  for (const peer of [adapter.pickGroup("10001", "10001GROUP"), adapter.pickFriend("10001", "10001USER")]) {
    const image = await peer.uploadImage(png)
    assert.equal(image.width, 1)
    assert.equal(image.height, 1)
    assert.equal(image.file_info, "uploaded")
    assert.equal(await peer.fileToUrl(png), image.url)
    assert.equal(await peer.filetoUrl(png), image.url)
  }
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.targetType, "group")
  assert.equal(calls[0].options.targetId, "GROUP")
  assert.equal(calls[1].options.targetType, "user")
  assert.equal(calls[1].options.targetId, "USER")
})

test("Markdown 图片优先当前账号和当前 C2C 目标，普通图片复用同一上传凭据", async t => {
  const f = await fixture(t, {})
  const { bot, calls } = uploadBot()
  f.setBot({ "10001": bot })
  const MessageTransport = (await f.load("adapter/message/transport.js")).namespace.default
  const media = Object.create(MessageTransport.prototype)
  const data = { self_id: "10001", bot, user_id: "USER", _mediaTarget: { target_type: "user", target_id: "USER" } }
  const image = await media.makeMarkdownImage(data, png)
  assert.equal(image.inline, true)
  assert.match(image.des, /#1px #1px/)
  const info = await media.uploadFileInfo(data, { type: "image", file: png }, data._mediaTarget)
  assert.equal(info.file_info, "uploaded")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.targetType, "user")
})

for (const settings of [{ webhookPort: 0, url: "" }, { webhookPort: 8080, url: "https://bot.example.com" }])
test(`官方不可用且端口 ${settings.webhookPort} 未监听时警告并回退普通图片`, async t => {
  const f = await fixture(t, settings)
  const { bot } = uploadBot(() => { throw new Error("模拟官方上传失败") })
  f.setBot({ "10001": bot })
  const MessageMedia = (await f.load("adapter/message/media.js")).namespace.default
  const media = Object.create(MessageMedia.prototype)
  const image = await media.makeMarkdownImage({ self_id: "10001", bot, group_id: "GROUP" }, png)
  assert.equal(image.inline, false)
  assert.equal(image.url, "()")
  assert.ok(f.warnings.some(warning => /官方文件直链不可用/.test(warning) && /未监听端口/.test(warning)))
  assert.equal(f.webhook.server, null)
  assert.equal(f.listenPorts.length, 0)
})

test("官方未返回 raw_url 时可继续发送普通图片，fileToUrl 不伪造公网链接", async t => {
  const f = await fixture(t, {})
  const { bot } = uploadBot(() => ({ file_info: "normal-image", ttl: 60 }))
  f.setBot({ "10001": bot })
  assert.equal(await f.filetoUrl(png), "")
  const info = await f.uploadBotFile(bot, png, { fileType: 1 })
  assert.equal(info.file_info, "normal-image")
})

test("官方分片不可用时才使用运行中的文件服务，图片和文件均可走 URL 转存回退", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080, url: "https://bot.example.com" })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  t.after(async () => {
    for (const file of f.webhook.files.values()) await rm(file, { force: true })
  })
  const { bot, calls } = uploadBot(payload => {
    if (payload.file) throw new Error("模拟分片上传不可用")
    assert.match(payload.url, /^https:\/\/bot\.example\.com\/QQBot\/File\//)
    return { file_info: "url-fallback", ttl: 60 }
  })
  f.setBot({ "10001": bot })
  for (const [fileType, name] of [[1, "image.png"], [4, "document.txt"]]) {
    const info = await f.uploadBotFile(bot, png, { fileType, name })
    assert.equal(info.file_info, "url-fallback")
  }
  assert.equal(calls.length, 4)
  assert.ok(calls[0].payload.file.equals(png))
  assert.equal(calls[1].payload.file_type, 1)
  assert.equal(calls[3].payload.file_type, 4)
  const localUrl = await f.fileToUrl(png)
  assert.match(localUrl, /^https:\/\/bot\.example\.com\/QQBot\/File\//)
  const name = decodeURIComponent(new URL(localUrl).pathname.split("/").pop())
  const response = await fetch(`http://127.0.0.1:${f.webhook.server.address().port}/QQBot/File/${encodeURIComponent(name)}`)
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(png))
})

test("公网图片 fileToUrl 也先官方分片；URL 转存失败后本机下载重传", async t => {
  const f = await fixture(t, {})
  const server = http.createServer((_req, res) => res.end(png))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/image.png`
  const { bot, calls } = uploadBot(payload => {
    if (payload.url) throw new Error("平台下载失败")
    return { file_info: "chunked", raw_url: "https://cos.example.com/image", ttl: 60 }
  })
  f.setBot({ "10001": bot })
  const info = await f.uploadBotFile(bot, url, { fileType: 1 })
  assert.equal(info.file_info, "chunked")
  assert.equal(calls[0].payload.url, url)
  assert.ok(calls[1].payload.file.equals(png))
  assert.equal(await f.fileToUrl(url), "https://cos.example.com/image")
  assert.equal(calls.length, 2)
})

test("fileToUrl 自动识别视频和 Silk 语音，不以普通文件类型申请 raw_url", async t => {
  const f = await fixture(t, {})
  const { bot, calls } = uploadBot()
  f.setBot({ "10001": bot })
  await f.fileToUrl(Buffer.from("\u0000\u0000\u0000\u0018ftypisom"))
  await f.fileToUrl(Buffer.from("\u0002#!SILK_V3audio"))
  assert.equal(calls[0].payload.file_type, 2)
  assert.equal(calls[1].payload.file_type, 3)
})
