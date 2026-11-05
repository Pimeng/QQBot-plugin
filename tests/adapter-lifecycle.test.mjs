import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { fixture, incomingFixture, incomingSelf, incomingBase } from "./helpers/qqbot-fixture.mjs"

test("群和频道 intents 同时申请，拒绝时逐级降级；空组合也可连接", async t => {
  const f = await fixture(t)
  const Lifecycle = (await f.load("adapter/lifecycle.js")).namespace.default
  const adapter = new Lifecycle()
  const both = adapter.makeIntents({ group: true, guild: true })
  assert.ok(both.includes("GROUP_AT_MESSAGE_CREATE"))
  assert.ok(both.includes("GROUP_MEMBER"))
  assert.ok(both.includes("GUILD_MESSAGES"))
  const queue = adapter.buildIntentQueue({ group: true, guild: true }, false)
  assert.ok(queue.some(({ list }) => list.includes("GUILD_MESSAGES") && !list.includes("GROUP_AT_MESSAGE_CREATE")))
  assert.ok(queue.some(({ list }) => list.includes("GROUP_AT_MESSAGE_CREATE") && !list.includes("GROUP_MEMBER") && list.includes("INTERACTION")))
  const empty = adapter.buildIntentQueue({ group: false, guild: false }, false)
  assert.equal(empty.length, 1)
  assert.equal(empty[0].list.length, 0)
  Object.assign(adapter, { activeIntents: {}, connectOnce: async () => ({ ok: true }) })
  assert.equal(await adapter.connect({ uin: "BOT", appid: "APP", secret: "secret", group: false, guild: false }), true)
})

test("账号监听与全局监听收到同一规范事件，支持 once/off 和链式调用", async t => {
  const f = await incomingFixture(t)
  const { accountEvents } = (await f.load("adapter/lifecycle.js")).namespace
  accountEvents(f.account)
  const seen = [], removed = () => assert.fail("已删除的 listener 不应触发")
  assert.equal(f.account.on("message.group", e => seen.push(e)), f.account)
  f.account.once("message", e => seen.push(e)).on("message", removed).off("message", removed)
  const first = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "第一条" })
  const second = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, id: "second", content: "第二条" })
  assert.equal(seen.length, 3)
  assert.equal(seen[0], first)
  assert.equal(seen[1], first)
  assert.equal(seen[2], second)
  assert.equal(f.account.listenerCount("message"), 0)
})

test("连接开始前监听消息，在线/退出状态更新，并隔离 SDK 异步处理失败", async t => {
  const receiver = new EventEmitter(), sdk = new EventEmitter()
  sdk.sessionManager = { receiver }
  sdk.stop = async () => {}
  const bot = { adapter: [] }
  let account
  let sawEarlyMessage = false
  const f = await fixture(t, {}, { sdk: {
    createBot: () => sdk,
    login: async () => {
      account = bot[incomingSelf]
      assert.equal(sdk.listenerCount("message"), 1)
      sdk.emit("message", { early: true })
      receiver.emit("ready")
    },
    logout: async () => sdk.stop(),
  } })
  f.setBot(bot)
  const Lifecycle = (await f.load("adapter/lifecycle.js")).namespace.default
  const adapter = new Lifecycle()
  Object.assign(adapter, {
    id: "QQBot", name: "QQBot", appid: {},
    getFriendMap: async () => new Map(), getGroupMap: async () => new Map(), getMemberMap: async () => new Map(), getMessageMap: async () => new Map(),
    accountMethods: () => ({}),
    async makeMessage(_id, e) { sawEarlyMessage = e.early; throw new Error("模拟处理失败") },
    async makeNotice() {},
  })
  sdk.getSelfInfo = async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(sawEarlyMessage, true)
    return { username: "fixture bot" }
  }
  const result = await adapter.connectOnce(incomingSelf, { appid: "APP", secret: "secret" }, [])
  assert.equal(result.ok, true)
  assert.equal(account.isOnline(), true)
  assert.match(account.avatar, new RegExp(`nk=${incomingSelf}$`))
  assert.ok(bot.adapter.includes(incomingSelf))
  receiver.emit("close")
  assert.equal(account.isOnline(), false)
  assert.equal(bot.adapter.includes(incomingSelf), false)
  receiver.emit("ready")
  assert.equal(account.isOnline(), true)
  await account.logout()
  assert.equal(account.isOnline(), false)
  assert.equal(bot.adapter.includes(incomingSelf), false)
})

test("收发统计按收到和成功发送的消息计数，关闭历史也继续统计", async t => {
  const f = await incomingFixture(t)
  f.account.stat = { recv_msg_cnt: 0, sent_msg_cnt: 0 }
  f.config.messageCacheSize = 0
  const event = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "正文" })
  assert.equal(f.account.stat.recv_msg_cnt, 1)
  assert.equal(f.account.messageCache.size, 0)
  f.sdk.sendGroupMessage = async () => ({ id: "stat-sent" })
  await event.reply("回复")
  assert.equal(f.account.stat.sent_msg_cnt, 1)
  f.sdk.sendGroupMessage = async () => { throw new Error("发送失败") }
  await assert.rejects(event.reply("失败"))
  assert.equal(f.account.stat.sent_msg_cnt, 1)
})

async function connectionFixture(t, selfInfo = async () => ({ username: "fixture bot" }), afterReady = () => {}) {
  const bot = { adapter: [] }, sdks = []
  const f = await fixture(t, {}, { sdk: {
    createBot() {
      const sdk = new EventEmitter()
      sdk.sessionManager = { receiver: new EventEmitter(), getAccessToken: async () => "token" }
      const index = sdks.length
      sdk.getSelfInfo = () => selfInfo(sdk, index)
      sdk.stopped = false
      sdk.stop = async () => { sdk.stopped = true; sdk.sessionManager.receiver.emit("close") }
      sdks.push(sdk)
      return sdk
    },
    login: async sdk => { sdk.sessionManager.receiver.emit("ready"); afterReady(sdk) },
    logout: sdk => sdk.stop(),
  } })
  f.setBot(bot)
  const Lifecycle = (await f.load("adapter/lifecycle.js")).namespace.default
  const adapter = new Lifecycle()
  Object.assign(adapter, { id: "QQBot", name: "QQBot", appid: {},
    getFriendMap: async () => new Map(), getGroupMap: async () => new Map(), getMemberMap: async () => new Map(), getMessageMap: async () => new Map(),
    accountMethods: () => ({}), makeMessage() {}, makeNotice() {},
  })
  return { bot, sdks, adapter }
}

test("连接时获取资料期间断开，不会把离线账号重新标成在线", async t => {
  const f = await connectionFixture(t, async sdk => {
    sdk.sessionManager.receiver.emit("close")
    return { username: "fixture bot" }
  })
  await f.adapter.connectOnce(incomingSelf, { appid: "APP", secret: "secret" }, [])
  assert.equal(f.bot[incomingSelf].online, false)
  assert.equal(f.bot.adapter.includes(incomingSelf), false)
})

test("ready 后立即断开时，login 完成不会覆盖 close 的离线状态", async t => {
  const f = await connectionFixture(t, undefined, sdk => sdk.sessionManager.receiver.emit("close"))
  await f.adapter.connectOnce(incomingSelf, { appid: "APP", secret: "secret" }, [])
  assert.equal(f.bot[incomingSelf].online, false)
  assert.equal(f.bot.adapter.includes(incomingSelf), false)
})

for (const webhook of [false, true]) test(`旧连接退出不删除同 ID 的新连接和 WebHook 映射：${webhook}`, async t => {
  const f = await connectionFixture(t)
  const account = { appid: "APP", secret: "secret", webhook }
  await f.adapter.connectOnce(incomingSelf, account, [])
  const old = f.bot[incomingSelf]
  await f.adapter.connectOnce(incomingSelf, account, [])
  const current = f.bot[incomingSelf]
  await old.logout()
  assert.equal(current.online, true)
  assert.equal(f.bot.adapter.includes(incomingSelf), true)
  if (webhook) assert.equal(f.adapter.appid.APP, current)
  else assert.equal(f.sdks[0].stopped, true)
  await assert.rejects(async () => old.login(), /被替换/)
})

test("旧连接的资料请求失败不会停止或删除已经连上的新账号", async t => {
  let rejectOld, entered
  const ready = new Promise(resolve => { entered = resolve })
  const waiting = new Promise((_resolve, reject) => { rejectOld = reject })
  const f = await connectionFixture(t, async (_sdk, index) => {
    if (index) return { username: "current bot" }
    entered()
    return waiting
  })
  const account = { appid: "APP", secret: "secret" }
  const oldConnection = f.adapter.connectOnce(incomingSelf, account, [])
  await ready
  await f.adapter.connectOnce(incomingSelf, account, [])
  const current = f.bot[incomingSelf]
  rejectOld(new Error("旧连接失败"))
  assert.equal((await oldConnection).ok, false)
  assert.equal(f.bot[incomingSelf], current)
  assert.equal(current.online, true)
  assert.equal(f.sdks[1].stopped, false)
  assert.equal(f.bot.adapter.includes(incomingSelf), true)
})
