import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { createRequire } from "node:module"
import { createQQBotPanelService } from "../lib/panel/service.js"
import { fixture } from "./helpers/qqbot-fixture.mjs"

const require = createRequire(import.meta.url)
const { MenuPanelService } = require(path.join(path.dirname(require.resolve("qq-official-bot")), "services/menu-panel.js"))
const copy = value => JSON.parse(JSON.stringify(value))
const menu = { items: [{ name: "帮助", type: "send_message", send_message: "/help" }] }
const panel = { items: [{ name: "帮助", type: "command", desc: "查看帮助" }], remark: "服务入口" }

function setup() {
  const config = { accounts: [
    { uin: "1001", appid: "app1", secret: "private-secret-one" },
    { uin: "1002", appid: "app2", secret: "private-secret-two", webhook: true },
  ] }
  const calls = []
  const record = { panel_id: "panel-1", scope: "c2c", target_type: "specific", panel, version: 3, user_openids: ["A".repeat(32)] }
  const states = Object.fromEntries(config.accounts.map(item => [item.uin, { menu: copy(menu), panels: [copy(record)] }]))
  const bots = {}
  for (const account of config.accounts) {
    const state = states[account.uin]
    const request = {}
    for (const method of ["get", "post", "put", "delete"]) request[method] = async (url, data) => {
      calls.push({ account: account.uin, method, url, data })
      if (url === "/v2/menu" && method === "get") return { data: { menu: copy(state.menu), version: 7 } }
      if (url === "/v2/menu" && method === "put") { state.menu = copy(data.menu); return { data: { version: 8 } } }
      if (url === "/v2/panels" && method === "get") return { data: { records: state.panels.filter(p => p.scope === data.params.scope), is_end: true, next_cursor: "" } }
      if (url === "/v2/panels" && method === "post") return { data: { panel_id: "created-panel" } }
      if (url === "/v2/panels/panel-1" && method === "get") return { data: copy(state.panels[0]) }
      return { data: { version: 4 } }
    }
    bots[account.uin] = { uin: account.uin, adapter: "QQBot", online: true,
      info: { appid: account.appid, secret: account.secret, access_token: "private-token", intents: ["INTERACTION"] },
      nickname: `机器人 ${account.uin}`, sdk: new MenuPanelService(request),
      gl: new Map([["B".repeat(32), { group_name: "测试群", member_count: 6, secret: "contact-secret" }]]),
      fl: new Map([["A".repeat(32), { nickname: "测试用户" }]]),
      stat: { recv_msg_cnt: 12, sent_msg_cnt: 8, start_time: 12345 }, messageCache: new Map([["m", {}]]) }
  }
  return { config, bots, calls, states, service: createQQBotPanelService(config, () => bots) }
}

const select = (view, rest = {}) => ({ view, account: "1001", scope: "c2c", panelId: "", ...rest })

test("QQBot 扩展：通过真实 SDK 菜单服务读写正确账号，不泄露凭据或改写本地配置", async () => {
  const f = setup(), before = copy(f.config)
  const accounts = await f.service.read()
  assert.equal(accounts.accounts.length, 2)
  assert.equal(accounts.accounts[1].mode, "WebHook")
  assert.deepEqual(f.service.summary(), { accounts: 2, online: 2, groups: 2, friends: 2, received: 24, sent: 16, cachedMessages: 2 })
  assert.ok(!JSON.stringify(accounts).includes("private-"))
  assert.equal(f.calls.length, 0)
  const current = await f.service.read({ selection: select("menu", { account: "1002" }) })
  assert.deepEqual(current.menu, menu)
  assert.equal(current.platformVersion, 7)
  await f.service.write({ action: "menu", menu: { items: [] } }, { selection: select("menu", { account: "1002" }) })
  assert.deepEqual(f.states["1002"].menu, { items: [] })
  assert.deepEqual(f.states["1001"].menu, menu)
  assert.deepEqual(f.config, before)
  assert.ok(f.calls.every(call => call.account === "1002"))
  assert.deepEqual(f.calls.at(-1), { account: "1002", method: "put", url: "/v2/menu", data: { menu: { items: [] } } })
})

test("QQBot 扩展：指令面板创建、内容修改、对象修改和删除沿用 SDK 参数", async () => {
  const f = setup()
  const selection = select("panel", { panelId: "panel-1" })
  const list = await f.service.read({ selection: select("panels") })
  assert.equal(list.panels[0].panel_id, "panel-1")
  assert.deepEqual(f.calls.at(-1).data, { params: { scope: "c2c", limit: 50 } })
  const current = await f.service.read({ selection })
  assert.equal(current.user_openids[0], "A".repeat(32))
  const created = await f.service.write({ action: "create", scope: "c2c", target_type: "specific", panel, user_openids: ["D".repeat(32)] }, { selection: select("panels") })
  assert.equal(created.panel_id, "created-panel")
  assert.equal(f.calls.at(-1).url, "/v2/panels")
  assert.deepEqual(f.calls.at(-1).data.user_openids, ["D".repeat(32)])
  await f.service.write({ action: "update", panel: { ...panel, remark: "新备注" } }, { selection })
  assert.deepEqual(f.calls.at(-1).data, { panel: { ...panel, remark: "新备注" } })
  await f.service.write({ action: "targets", op: "del", user_openids: ["A".repeat(32)] }, { selection })
  assert.deepEqual(f.calls.at(-1), { account: "1001", method: "put", url: "/v2/panels/panel-1/target", data: { op: "del", user_openids: ["A".repeat(32)] } })
  await f.service.write({ action: "delete" }, { selection })
  assert.equal(f.calls.at(-1).method, "delete")
  assert.equal(f.calls.at(-1).url, "/v2/panels/panel-1")
})

test("QQBot 扩展：拒绝跨账号冒用、离线账号、非法路径和不匹配场景", async () => {
  const f = setup()
  f.bots["1001"].online = false
  await assert.rejects(f.service.read({ selection: select("menu") }), /尚未连接/)
  f.bots["1001"].online = true
  f.bots["1001"].info.appid = "other-app"
  await assert.rejects(f.service.read({ selection: select("menu") }), /尚未连接/)
  f.bots["1001"].info.appid = "app1"
  await assert.rejects(f.service.read({ selection: select("panel", { panelId: "../token" }) }), /ID 无效/)
  await assert.rejects(f.service.write({ action: "delete" }, { selection: select("menu") }), /对应/)
  await assert.rejects(f.service.write({ action: "menu", menu, token: "ignored?" }, { selection: select("menu") }), /字段无效/)
  await assert.rejects(f.service.write({ action: "create", scope: "group", target_type: "all", panel }, { selection: select("panels") }), /场景与当前列表不一致/)
  await assert.rejects(f.service.read({ selection: select("panel", { scope: "group", panelId: "panel-1" }) }), /不属于当前选择的场景/)
  assert.ok(f.calls.every(call => call.method === "get"))
  f.config.accounts = []
  await assert.rejects(f.service.read({ selection: select("menu") }), /账号已移除/)
})

test("QQBot 扩展：缓存联系人过滤分页、数量统计和字段白名单", () => {
  const f = setup()
  const page = f.service.contacts({ search: "1002", offset: 0, limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].account, "1002")
  assert.ok(!JSON.stringify(page).includes("secret"))
  assert.equal(f.service.contacts({ search: "不存在" }).total, 0)
  f.bots["1002"].online = false
  assert.equal(f.service.summary().online, 1)
  assert.equal(f.calls.length, 0)
})

test("QQBot 扩展：列表遍历分页，拒绝重复游标和异常平台响应", async () => {
  const f = setup()
  let queried = 0
  f.bots["1001"].sdk.getCommandPanels = async () => {
    queried++
    return { records: [], next_cursor: "same-cursor", is_end: false }
  }
  await assert.rejects(f.service.read({ selection: select("panels") }), /分页游标无效/)
  assert.equal(queried, 2)
  f.bots["1001"].sdk.getCommandPanels = async () => ({ records: null })
  await assert.rejects(f.service.read({ selection: select("panels") }), /列表响应无效/)
  f.bots["1001"].sdk.getCustomMenu = async () => ({ version: 0 })
  assert.deepEqual((await f.service.read({ selection: select("menu") })).menu, { items: [] })
})

test("QQBot 扩展：平台异常脱敏，不把 SDK 的 HTTP 凭据显示到页面", async () => {
  const f = setup()
  f.bots["1001"].sdk.getCustomMenu = async () => { throw new Error("code: 11241 Authorization: private-token secret=private-secret-one") }
  await assert.rejects(f.service.read({ selection: select("menu") }), error => {
    assert.match(error.message, /11241/)
    assert.ok(!error.message.includes("private-"))
    return true
  })
})

test("QQBot 扩展：supportPanel 暴露真实服务，仍保留原配置表单", async t => {
  const f = await fixture(t, { accounts: [{ uin: "1001", appid: "app1", secret: "test-secret" }] })
  const support = (await f.load("elia.support.js")).namespace.supportPanel()
  assert.equal(typeof support.configInfo.getConfigData, "function")
  assert.equal(support.panelExtensions.version, 1)
  const page = support.panelExtensions.pages.find(page => page.id === "qqbot")
  assert.deepEqual(Object.keys(page.blocks[0].read()).sort(), ["accounts", "cachedMessages", "friends", "groups", "online", "received", "sent"])
  const editor = page.blocks.find(block => block.id === "menu")
  assert.equal(editor.type, "resource")
  assert.equal(editor.mode, "singleton")
  const data = await editor.read({ selection: {} })
  assert.equal(data.options.accounts[0].value, "1001")
  assert.ok(!JSON.stringify(data).includes("test-secret"))
})

test("QQBot 扩展：通用 resource 数据声明与真实 SDK 写操作连通", async () => {
  const f = setup()
  const selection = { account: "1001", scope: "c2c", id: "panel-1" }
  const empty = await f.service.readResource("menu", { selection: {} })
  assert.equal(empty.options.accounts.length, 2)
  assert.equal(f.calls.length, 0)
  const list = await f.service.readResource("panels", { selection: { account: "1001", scope: "c2c", id: "" } })
  assert.equal(list.items[0].id, "panel-1")
  const detail = await f.service.readResource("panels", { selection })
  assert.deepEqual(detail.values, { panel })
  assert.equal(detail.identity.appid, "app1")
  await f.service.writeResource("panels", { operation: "targets", values: { op: "add", openids: "D".repeat(32) } }, { selection })
  assert.deepEqual(f.calls.at(-1).data, { op: "add", user_openids: ["D".repeat(32)] })
  await f.service.writeResource("menu", { operation: "save", values: menu }, { selection: { account: "1002" } })
  assert.equal(f.calls.at(-1).account, "1002")
  assert.deepEqual(f.calls.at(-1).data, { menu })
  await assert.rejects(f.service.writeResource("panels", { operation: "targets", values: { op: "add", openids: "A\nA" } }, { selection }), /重复 OpenID/)
  await f.service.writeResource("menu", { operation: "save", values: { items: [{
    name: "帮助", type: "send_message", send_message: "/help", link: "", switch: { switch_id: "" }, sub_menu_items: [],
  }] } }, { selection: { account: "1001" } })
  assert.deepEqual(f.calls.at(-1).data, { menu })
  await f.service.writeResource("panels", { operation: "update", values: { panel: { ...panel,
    items: [{ ...panel.items[0], link: "" }],
  } } }, { selection })
  assert.deepEqual(f.calls.at(-1).data, { panel })
})

test("QQBot 扩展：账号 AppID 变化影响读取基线，写入响应丢失提示先核实结果", async () => {
  const f = setup()
  const initial = await f.service.readResource("menu", { selection: { account: "1001" } })
  f.config.accounts[0].appid = "replacement-app"
  f.bots["1001"].info.appid = "replacement-app"
  const replaced = await f.service.readResource("menu", { selection: { account: "1001" } })
  assert.notDeepEqual(initial.identity, replaced.identity)
  let applied = 0
  f.bots["1001"].sdk.createCommandPanel = async () => { applied++; throw new Error("ETIMEDOUT private-token") }
  await assert.rejects(f.service.writeResource("panels", { operation: "create", values: { panel, target_type: "all" } },
    { selection: { account: "1001", scope: "c2c", id: "" } }), /结果可能已生效，请先刷新确认/)
  assert.equal(applied, 1)
})
