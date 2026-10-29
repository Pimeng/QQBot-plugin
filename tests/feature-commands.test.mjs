import assert from "node:assert/strict"
import test from "node:test"
import { fixture, incomingSelf } from "./helpers/qqbot-fixture.mjs"

async function pluginFixture(t) {
  const f = await fixture(t, {
    accounts: [{ uin: incomingSelf, appid: "mock-app", secret: "secret", group: true }],
    dau: { enabled: true, retentionDays: 62 },
  })
  const { QQBotPlugin } = (await f.load("lib/plugin.js")).namespace
  const plugin = new QQBotPlugin()
  const replies = []
  plugin.reply = (...args) => { replies.push(args); return true }
  f.setBot({
    [incomingSelf]: {
      dau: {
        enabled: true,
        report: () => "DAU-REPORT",
        userReport: () => "USER-REPORT",
      },
    },
  })
  return { ...f, plugin, replies }
}

test("DAU 与用户统计命令使用当前或指定账号的真实统计器", async t => {
  const f = await pluginFixture(t)
  f.plugin.e = { msg: "#QQBotDAU", self_id: incomingSelf }
  await f.plugin.DAU()
  f.plugin.e.msg = "#QQBot用户统计"
  await f.plugin.UserStats()
  assert.deepEqual(f.replies.map(([message]) => message), ["DAU-REPORT", "USER-REPORT"])

  f.plugin.e.msg = "#QQBotDAUunknown"
  await f.plugin.DAU()
  assert.match(f.replies.at(-1)[0], /没有找到 QQBot 账号 unknown/)
})

test("面板保存 DAU、流式输出和输入状态配置无需重启", async t => {
  const f = await fixture(t, {
    dau: { enabled: true, retentionDays: 62 },
    stream: false,
    inputNotify: false,
    inputNotifySeconds: 30,
  })
  const panel = (await f.load("elia.support.js")).namespace.supportPanel()
  const current = await panel.configInfo.getConfigData()
  assert.equal(current.dau.retentionDays, 62)
  assert.equal(current.stream, false)
  assert.equal(current.inputNotifySeconds, 30)
  const Result = {
    ok: (_data, message) => ({ success: true, message }),
    error: message => ({ success: false, message }),
  }
  const result = await panel.configInfo.setConfigData({
    _version: current._version,
    "dau.enabled": true,
    "dau.retentionDays": 90,
    stream: true,
    inputNotify: true,
    inputNotifySeconds: 45,
  }, { Result })
  assert.equal(result.success, true)
  assert.match(result.message, /无需重启/)
  assert.equal(f.config.dau.retentionDays, 90)
  assert.equal(f.config.stream, true)
  assert.equal(f.config.inputNotify, true)
  assert.equal(f.config.inputNotifySeconds, 45)
})

test("管理面板概览读取持久化今日 DAU 而不是本次连接计数", async t => {
  const f = await fixture(t, { accounts: [{ uin: incomingSelf, appid: "mock-app", secret: "secret" }] })
  const { createQQBotPanelService } = (await f.load("lib/panel/service.js")).namespace
  const bot = {
    [incomingSelf]: {
      adapter: "QQBot", uin: incomingSelf, online: true,
      info: { appid: "mock-app", intents: [] },
      gl: new Map(), fl: new Map(), messageCache: new Map(),
      stat: { recv_msg_cnt: 1, sent_msg_cnt: 2 },
      dau: { stats: () => ({ receive_msg_count: 10, send_msg_count: 20, user_count: 3, group_count: 4 }) },
    },
  }
  const service = createQQBotPanelService(f.config, () => bot)
  const [account] = service.summaries()
  assert.equal(account.received, 1)
  assert.equal(account.todayReceived, 10)
  assert.equal(account.todaySent, 20)
  assert.equal(account.dauUsers, 3)
  assert.equal(account.dauGroups, 4)
  assert.equal(service.summary().dauGroups, 4)
})
