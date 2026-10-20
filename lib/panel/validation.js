/** QQ 官方菜单/指令面板的请求校验；不访问账号、配置或网络。 */
export const PANEL_LIMITS = Object.freeze({
  menuItems: 10,
  subMenuItems: 5,
  menuName: 10,
  subMenuName: 14,
  panelItems: 20,
  panelName: 14,
  panelDescription: 30,
  panelRemark: 255,
  targetsPerRequest: 20,
})

const SCOPES = new Set(["c2c", "group", "channel", "dm"])
const MENU_TYPES = new Set(["send_message", "link", "switch", "menu"])
const SUB_MENU_TYPES = new Set(["send_message", "link"])
const PANEL_TYPES = new Set(["command", "link"])
const MAX_JSON_BYTES = 128 * 1024

/** 文档中的名称/描述长度：ASCII 为 1，中文等非 ASCII 字符为 2。 */
export function panelTextLength(value) {
  return Array.from(value).reduce((length, char) => length + (char.codePointAt(0) <= 0x7f ? 1 : 2), 0)
}

function fail(message) {
  throw new Error(message)
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}必须是对象`)
  return value
}

// 保留平台将来新增的字段，同时阻止非 JSON 值、循环结构与不受限的请求体。
function cloneInput(value, label) {
  const ancestors = new Set()
  let entries = 0
  function check(item, depth) {
    if (depth > 16) fail(`${label}嵌套层级过深`)
    if (++entries > 8192) fail(`${label}数据过大`)
    if (item === null || typeof item === "boolean") return
    if (typeof item === "string") {
      if (item.length > MAX_JSON_BYTES) fail(`${label}数据过大`)
      return
    }
    if (typeof item === "number" && Number.isFinite(item)) return
    if (!item || typeof item !== "object") fail(`${label}必须是有效 JSON 数据`)
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      fail(`${label}必须是普通 JSON 对象`)
    if (ancestors.has(item)) fail(`${label}不能包含循环引用`)
    ancestors.add(item)
    for (const key of Object.keys(item)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        fail(`${label}包含不支持的字段 ${key}`)
      check(item[key], depth + 1)
    }
    ancestors.delete(item)
  }
  object(value, label)
  check(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) fail(`${label}数据过大（最多 128 KiB）`)
  return JSON.parse(json)
}

function text(value, label, { max, required = true, weighted = true } = {}) {
  if (typeof value !== "string") fail(`${label}必须是文本`)
  if (required && !value.trim()) fail(`${label}不能为空`)
  const length = weighted ? panelTextLength(value) : Array.from(value).length
  if (max !== undefined && length > max)
    fail(`${label}最多 ${max} 个字符${weighted ? "（中文按 2 个计）" : ""}`)
  return value
}

function array(value, label, max) {
  if (!Array.isArray(value)) fail(`${label}必须是数组`)
  if (value.length > max) fail(`${label}最多 ${max} 项`)
  return value
}

function httpsLink(value, label) {
  text(value, label)
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label}必须是有效的 https:// 链接`)
  }
  if (!value.startsWith("https://") || url.protocol !== "https:" || !url.hostname || url.username || url.password)
    fail(`${label}必须是有效的 https:// 链接且不能包含凭据`)
  return value
}

function optionalBoolean(value, key, label) {
  if (Object.hasOwn(value, key) && typeof value[key] !== "boolean") fail(`${label}必须是布尔值`)
}

function validateMenuItem(item, index, child, switchIds) {
  const label = `${child ? "子菜单" : "菜单"}第 ${index + 1} 项`
  object(item, label)
  text(item.name, `${label}名称`, { max: child ? PANEL_LIMITS.subMenuName : PANEL_LIMITS.menuName })
  if (!(child ? SUB_MENU_TYPES : MENU_TYPES).has(item.type))
    fail(`${label}类型只能是 ${child ? "send_message 或 link" : "send_message、link、switch 或 menu"}`)
  if (Object.hasOwn(item, "send_message")) text(item.send_message, `${label}消息内容`, { required: false })
  if (Object.hasOwn(item, "link")) httpsLink(item.link, `${label}链接`)
  if (item.type === "send_message") text(item.send_message, `${label}消息内容`)
  if (item.type === "link") httpsLink(item.link, `${label}链接`)
  if (Object.hasOwn(item, "switch")) {
    object(item.switch, `${label}开关配置`)
    text(item.switch.switch_id, `${label}开关标识`)
    optionalBoolean(item.switch, "default", `${label}开关默认状态`)
  }
  if (item.type === "switch") {
    object(item.switch, `${label}开关配置`)
    const id = text(item.switch.switch_id, `${label}开关标识`)
    if (switchIds.has(id)) fail(`开关标识 ${id} 重复`)
    switchIds.add(id)
    if (!Object.hasOwn(item.switch, "default")) item.switch.default = false
  }
  if (Object.hasOwn(item, "sub_menu_items")) {
    if (child) fail("子菜单不能再次嵌套")
    array(item.sub_menu_items, `${label}子菜单`, PANEL_LIMITS.subMenuItems)
    item.sub_menu_items.forEach((entry, i) => validateMenuItem(entry, i, true, switchIds))
  }
  if (item.type === "menu" && !Array.isArray(item.sub_menu_items)) fail(`${label}缺少子菜单数组`)
  return item
}

export function validateMenu(value) {
  const menu = cloneInput(value, "自定义菜单")
  const ids = new Set()
  array(menu.items, "一级菜单", PANEL_LIMITS.menuItems)
    .forEach((item, index) => validateMenuItem(item, index, false, ids))
  return menu
}

function checkPanel(panel) {
  object(panel, "指令面板")
  array(panel.items, "面板元素", PANEL_LIMITS.panelItems).forEach((item, index) => {
    const label = `面板第 ${index + 1} 项`
    object(item, label)
    text(item.name, `${label}名称`, { max: PANEL_LIMITS.panelName })
    if (!PANEL_TYPES.has(item.type)) fail(`${label}类型只能是 command 或 link`)
    if (Object.hasOwn(item, "desc"))
      text(item.desc, `${label}描述`, { max: PANEL_LIMITS.panelDescription, required: false })
    optionalBoolean(item, "only_admin", `${label}仅管理员可操作`)
    if (Object.hasOwn(item, "link")) httpsLink(item.link, `${label}链接`)
    if (item.type === "link") httpsLink(item.link, `${label}链接`)
  })
  if (Object.hasOwn(panel, "remark"))
    text(panel.remark, "面板备注", { max: PANEL_LIMITS.panelRemark, weighted: false, required: false })
  if (Object.hasOwn(panel, "version") && (!Number.isSafeInteger(panel.version) || panel.version < 0))
    fail("面板版本号必须是非负整数")
  return panel
}

export function validatePanel(value) {
  return checkPanel(cloneInput(value, "指令面板"))
}

function checkScope(scope) {
  if (!SCOPES.has(scope)) fail("生效场景只能是 c2c、group、channel 或 dm")
}

function checkOpenids(value, key, required = false) {
  if (!Object.hasOwn(value, key)) {
    if (required) fail("请填写要添加或移除的 OpenID")
    return
  }
  const list = array(value[key], key === "user_openids" ? "用户 OpenID" : "群 OpenID", PANEL_LIMITS.targetsPerRequest)
  const result = list.map((id, index) => text(id, `第 ${index + 1} 个 OpenID`).trim())
  if (new Set(result).size !== result.length) fail("OpenID 列表不能重复")
  if (required && !result.length) fail("请填写要添加或移除的 OpenID")
  value[key] = result
}

function checkTargetLists(value, scope, targetType, required = false) {
  checkOpenids(value, "user_openids")
  checkOpenids(value, "group_openids")
  const key = scope === "c2c" ? "user_openids" : scope === "group" ? "group_openids" : null
  for (const field of ["user_openids", "group_openids"]) {
    if ((targetType !== "specific" || field !== key) && value[field]?.length)
      fail(`当前场景和生效范围不支持 ${field}`)
    if (targetType !== "specific" || field !== key) delete value[field]
  }
  if (required) checkOpenids(value, key, true)
}

export function validateCreatePanel(value) {
  const request = cloneInput(value, "创建面板请求")
  checkScope(request.scope)
  request.target_type ??= "all"
  if (!["all", "specific"].includes(request.target_type)) fail("生效范围只能是 all 或 specific")
  if (["channel", "dm"].includes(request.scope) && request.target_type !== "all")
    fail("文字子频道和频道私信仅支持全局面板（all）")
  checkPanel(request.panel)
  checkTargetLists(request, request.scope, request.target_type)
  return request
}

export function validateTargets(value, detail) {
  const request = cloneInput(value, "关联对象请求")
  object(detail, "面板详情")
  checkScope(detail.scope)
  if (!["c2c", "group"].includes(detail.scope) || detail.target_type !== "specific")
    fail("仅单聊或群聊的指定对象面板支持修改关联对象")
  if (!["add", "del"].includes(request.op)) fail("关联操作只能是 add 或 del")
  checkTargetLists(request, detail.scope, detail.target_type, true)
  return request
}
