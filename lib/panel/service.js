import { getAccounts } from "../utils/accounts.js"
import { validateMenu, validatePanel, validateCreatePanel, validateTargets } from "./validation.js"

const scopes = new Set(["c2c", "group", "channel", "dm"])
const views = new Set(["accounts", "menu", "panels", "panel"])
const object = value => value && typeof value === "object" && !Array.isArray(value)
const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0
const text = value => typeof value === "string" || typeof value === "number" ? String(value) : ""
const snapshot = value => JSON.parse(JSON.stringify(value))

/** 仅使用已配置、已连接的 QQBot 实例，不创建客户端或输出运行时凭据。 */
export function createQQBotPanelService(config, getBot = () => globalThis.Bot) {
  function runtime(account) {
    const bot = getBot()?.[account.uin || account.appid]
    return bot?.adapter === "QQBot" && String(bot.uin) === String(account.uin || account.appid)
      && String(bot.info?.appid) === account.appid ? bot : undefined
  }

  function summaries() {
    return getAccounts(config).map(account => {
      const bot = runtime(account)
      return {
        id: account.uin || account.appid, appid: account.appid,
        nickname: text(bot?.nickname || bot?.info?.username), online: bot?.online === true,
        mode: account.webhook ? "WebHook" : "WebSocket",
        environment: (bot?.info?.sandbox ?? config.bot?.sandbox) ? "沙箱" : "正式",
        groups: count(bot?.gl?.size), friends: count(bot?.fl?.size),
        received: count(bot?.stat?.recv_msg_cnt), sent: count(bot?.stat?.sent_msg_cnt),
        startedAt: count(bot?.stat?.start_time), cachedMessages: count(bot?.messageCache?.size),
        intents: Array.isArray(bot?.info?.intents) ? bot.info.intents.filter(item => typeof item === "string") : [],
        groupEnabled: account.group, guildEnabled: account.guild,
      }
    })
  }

  function selectionOf(selection = {}) {
    const { view = "accounts", account = "", scope = "c2c", panelId = "" } = selection
    if (!views.has(view) || !scopes.has(scope) || typeof account !== "string" || account.length > 200
      || typeof panelId !== "string" || panelId.length > 200)
      throw new Error("QQBot 页面选择参数无效")
    if (view !== "accounts" && !account) throw new Error("请先选择 QQBot 账号")
    if (view === "panel" && !/^[a-zA-Z0-9_-]{1,200}$/.test(panelId)) throw new Error("指令面板 ID 无效")
    return { view, account, scope, panelId }
  }

  function connected(id) {
    const account = getAccounts(config).find(item => (item.uin || item.appid) === id)
    if (!account) throw new Error("QQBot 账号已移除，请刷新账号列表")
    const bot = runtime(account)
    if (!bot?.online || !bot.sdk) throw new Error("QQBot 账号尚未连接，请检查账号状态")
    return bot
  }

  async function call(bot, method, ...args) {
    if (typeof bot.sdk[method] !== "function") throw new Error("当前 QQBot SDK 不支持此操作，请检查插件依赖版本")
    try { return await bot.sdk[method](...args) }
    catch (error) {
      // SDK 异常可能夹带 HTTP 配置和令牌；不把原始异常传到管理接口。
      const code = text(error?.code).match(/^\d{3,10}$/)?.[0]
        || text(error?.message).match(/(?:code\D{0,8}|^)(\d{5,10})\b/i)?.[1]
      const hint = method.startsWith("get") ? "请检查账号权限或稍后重试" : "结果可能已生效，请先刷新确认，勿直接重复提交"
      throw new Error(`QQ 平台请求失败${code ? `（错误码 ${code}）` : ""}，${hint}`)
    }
  }

  async function panels(bot, scope) {
    const result = new Map(), cursors = new Set()
    let cursor = ""
    for (let page = 0; page < 20; page++) {
      const response = await call(bot, "getCommandPanels", { scope, limit: 50, ...(cursor ? { cursor } : {}) })
      if (!object(response) || !Array.isArray(response.records)) throw new Error("QQ 平台指令面板列表响应无效")
      for (const item of response.records) {
        if (!object(item) || typeof item.panel_id !== "string" || item.scope !== scope || !object(item.panel))
          throw new Error("QQ 平台指令面板记录无效")
        result.set(item.panel_id, item)
      }
      if (result.size > 20) throw new Error("QQ 平台指令面板数量超出当前支持上限")
      if (response.is_end === true || !response.next_cursor) return [...result.values()].sort((a, b) => a.panel_id.localeCompare(b.panel_id))
      if (typeof response.next_cursor !== "string" || cursors.has(response.next_cursor)) throw new Error("QQ 平台指令面板分页游标无效")
      cursor = response.next_cursor
      cursors.add(cursor)
    }
    throw new Error("QQ 平台指令面板分页超出上限")
  }

  async function detail(bot, selection) {
    const panel = await call(bot, "getCommandPanel", selection.panelId)
    if (!object(panel) || panel.panel_id !== selection.panelId || !object(panel.panel)) throw new Error("QQ 平台指令面板详情响应无效")
    if (panel.scope !== selection.scope) throw new Error("该指令面板不属于当前选择的场景，请重新读取列表")
    return panel
  }

  async function read(query = {}) {
    const selection = selectionOf(query.selection)
    if (selection.view === "accounts") return { accounts: summaries() }
    const bot = connected(selection.account)
    const identity = { appid: String(bot.info.appid), sandbox: (bot.info.sandbox ?? config.bot?.sandbox) === true }
    if (selection.view === "menu") {
      const response = await call(bot, "getCustomMenu")
      if (!object(response) || response.menu != null && (!object(response.menu) || !Array.isArray(response.menu.items)))
        throw new Error("QQ 平台自定义菜单响应无效")
      return { account: selection.account, identity, menu: snapshot(response.menu || { items: [] }),
        exists: response.menu != null, platformVersion: response.version ?? null }
    }
    if (selection.view === "panels") return { account: selection.account, identity, scope: selection.scope, panels: snapshot(await panels(bot, selection.scope)) }
    return { ...snapshot(await detail(bot, selection)), account: selection.account, identity }
  }

  async function write(data, context = {}) {
    const selection = selectionOf(context.selection)
    if (!object(data)) throw new Error("QQBot 操作数据必须是对象")
    const allowed = {
      menu: ["action", "menu"], create: ["action", "scope", "target_type", "panel", "user_openids", "group_openids"],
      update: ["action", "panel"], delete: ["action"], targets: ["action", "op", "user_openids", "group_openids"],
    }
    if (!Object.hasOwn(allowed, data.action) || Object.keys(data).some(key => !allowed[data.action].includes(key)))
      throw new Error("QQBot 操作或提交字段无效")
    const expectedView = data.action === "menu" ? "menu" : data.action === "create" ? "panels" : "panel"
    if (selection.view !== expectedView) throw new Error("请从对应的菜单或指令面板页面提交操作")
    const bot = connected(selection.account)
    if (data.action === "menu") {
      await call(bot, "updateCustomMenu", validateMenu(data.menu))
      return { ok: true, message: "自定义菜单已提交到 QQ 平台，对该账号全部单聊用户生效" }
    }
    if (data.action === "create") {
      const { action, ...input } = data
      const options = validateCreatePanel(input)
      if (options.scope !== selection.scope) throw new Error("创建场景与当前列表不一致，请重新读取")
      const result = await call(bot, "createCommandPanel", options)
      if (!result || typeof result.panel_id !== "string") throw new Error("QQ 平台未返回新面板 ID；请先刷新列表确认创建结果")
      return { ok: true, panel_id: result.panel_id, message: "指令面板已创建" }
    }
    const current = await detail(bot, selection)
    if (data.action === "update") {
      await call(bot, "updateCommandPanel", selection.panelId, validatePanel(data.panel))
      return { ok: true, message: "指令面板已更新" }
    }
    if (data.action === "delete") {
      await call(bot, "deleteCommandPanel", selection.panelId)
      return { ok: true, message: "指令面板已删除" }
    }
    const { action, ...input } = data
    await call(bot, "updateCommandPanelTargets", selection.panelId, validateTargets(input, current))
    return { ok: true, message: "指令面板关联对象已更新" }
  }

  function contacts({ offset = 0, limit = 50, search = "" } = {}) {
    const items = []
    for (const account of getAccounts(config)) {
      const bot = runtime(account)
      for (const [kind, map] of [["群", bot?.gl], ["好友", bot?.fl]]) {
        if (!map || typeof map.entries !== "function") continue
        for (const [id, info] of map) {
          const row = { account: account.uin || account.appid, kind, openid: text(id),
            name: text(info?.group_name || info?.nickname || info?.user_name || info?.card),
            members: kind === "群" && info?.member_count != null ? count(info.member_count) : "—" }
          if (!search || Object.values(row).some(value => String(value).toLowerCase().includes(search.toLowerCase()))) items.push(row)
        }
      }
    }
    items.sort((a, b) => a.account.localeCompare(b.account) || a.kind.localeCompare(b.kind) || a.openid.localeCompare(b.openid))
    return { items: items.slice(offset, offset + limit), total: items.length }
  }

  function summary() {
    const accounts = summaries()
    const sum = key => accounts.reduce((total, account) => total + account[key], 0)
    return { accounts: accounts.length, online: accounts.filter(item => item.online).length,
      groups: sum("groups"), friends: sum("friends"), received: sum("received"), sent: sum("sent"), cachedMessages: sum("cachedMessages") }
  }
  function openids(value) {
    if (typeof value !== "string") throw new Error("关联对象必须为每行一个 OpenID 的文本")
    const ids = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    if (new Set(ids).size !== ids.length) throw new Error("关联对象不能包含重复 OpenID")
    return ids
  }

  function menuValues(value) {
    return { items: (value.items || []).map(item => ({ name: item.name, type: item.type,
      ...(item.type === "send_message" ? { send_message: item.send_message } : {}),
      ...(item.type === "link" ? { link: item.link } : {}),
      ...(item.type === "switch" ? { switch: item.switch } : {}),
      ...(item.type === "menu" ? { sub_menu_items: menuValues({ items: item.sub_menu_items || [] }).items } : {}),
    })) }
  }

  function panelValues(value) {
    return { ...value, items: value?.items?.map(item => {
      const { link, ...rest } = item
      return item.type === "link" ? { ...rest, link } : rest
    }) }
  }

  /** 面板只解释通用 resource 声明，账号、场景和 SDK 适配留在插件内部。 */
  async function readResource(kind, query = {}) {
    const selection = query.selection || {}
    const options = { accounts: summaries().map(account => ({ value: account.id, label: `${account.id} · AppID ${account.appid}` })) }
    if (!selection.account || kind === "panels" && !selection.scope) return { options, items: [] }
    const selected = { account: selection.account, scope: kind === "menu" ? "c2c" : selection.scope,
      view: kind === "menu" ? "menu" : selection.id ? "panel" : "panels", panelId: selection.id || "" }
    const data = await read({ selection: selected })
    if (kind === "menu") return { options, values: menuValues(data.menu), identity: data.identity, remote: data,
      details: { "生效范围": "该机器人全部单聊用户", "平台版本": data.platformVersion ?? "未设置" } }
    if (!selection.id) return { options, identity: data.identity, remote: data.panels,
      items: data.panels.map(item => ({ id: item.panel_id, title: item.panel.remark || item.panel_id,
        description: `${item.target_type === "specific" ? "指定对象" : "全部对象"} · ${item.panel.items?.length || 0} 条指令 · ${item.panel_id}` })) }
    const targets = data.user_openids || data.group_openids || []
    return { options, values: { panel: { items: data.panel.items, remark: data.panel.remark || "" } }, identity: data.identity, remote: data,
      details: { "面板 ID": data.panel_id, "场景": data.scope,
        "生效对象": data.target_type === "specific" ? "指定对象" : "全部对象", "平台版本": data.version ?? "未知",
        "关联 OpenID（最多返回 1000 条）": targets.length ? targets.join("\n") : "无" } }
  }

  async function writeResource(kind, data, context = {}) {
    const selection = context.selection || {}, values = data.values || {}
    if (kind === "menu") {
      if (data.operation !== "save") throw new Error("菜单不支持此操作")
      return write({ action: "menu", menu: menuValues(values) }, { selection: { account: selection.account, view: "menu", scope: "c2c" } })
    }
    const selected = { account: selection.account, scope: selection.scope, panelId: selection.id || "",
      view: data.operation === "create" ? "panels" : "panel" }
    if (data.operation === "create") {
      const ids = openids(values.openids || "")
      return write({ action: "create", scope: selection.scope, target_type: values.target_type || "all", panel: panelValues(values.panel),
        ...(ids.length ? { [selection.scope === "c2c" ? "user_openids" : "group_openids"]: ids } : {}) }, { selection: selected })
    }
    if (data.operation === "update") return write({ action: "update", panel: panelValues(values.panel) }, { selection: selected })
    if (data.operation === "delete") return write({ action: "delete" }, { selection: selected })
    if (data.operation === "targets") return write({ action: "targets", op: values.op,
      [selection.scope === "c2c" ? "user_openids" : "group_openids"]: openids(values.openids) }, { selection: selected })
    throw new Error("指令面板不支持此操作")
  }
  return { read, write, readResource, writeResource, summaries, summary, contacts }
}
