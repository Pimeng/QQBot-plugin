import test from "node:test"
import assert from "node:assert/strict"
import { validateMenu, validatePanel, validateCreatePanel, validateTargets, panelTextLength } from "../lib/panel/validation.js"

const command = (name = "/help") => ({ type: "command", name })
const message = (name = "帮助") => ({ type: "send_message", name, send_message: "/help" })
const panel = () => ({ items: [command()] })

test("menu limits use different top-level and submenu name widths", () => {
  assert.equal(panelTextLength("help帮助"), 8)
  const input = { items: [{ type: "menu", name: "一二三四五", sub_menu_items: [message("一二三四五六七")] }] }
  assert.deepEqual(validateMenu(input), input)
  assert.throws(() => validateMenu({ items: [message("一二三四五六")] }), /最多 10/)
  input.items[0].sub_menu_items[0].name += "八"
  assert.throws(() => validateMenu(input), /最多 14/)
  assert.throws(() => validateMenu({ items: Array.from({ length: 11 }, () => message()) }), /最多 10 项/)
  assert.throws(() => validateMenu({ items: [{ type: "menu", name: "更多", sub_menu_items: Array.from({ length: 6 }, () => message()) }] }), /最多 5 项/)
})

test("menu validates button payloads, switch identities and submenu types", () => {
  const input = { items: [{ type: "switch", name: "搜索", switch: { switch_id: "search" } }] }
  assert.equal(validateMenu(input).items[0].switch.default, false)
  assert.equal(input.items[0].switch.default, undefined)
  assert.throws(() => validateMenu({ items: [input.items[0], input.items[0]] }), /重复/)
  assert.throws(() => validateMenu({ items: [{ type: "menu", name: "更多", sub_menu_items: [input.items[0]] }] }), /send_message 或 link/)
  assert.throws(() => validateMenu({ items: [{ type: "send_message", name: "帮助" }] }), /消息内容/)
  assert.throws(() => validateMenu({ items: [{ type: "link", name: "官网", link: "http://example.com" }] }), /https/)
  assert.deepEqual(validateMenu({ items: [] }), { items: [] })
})

test("panel validates weighted names/descriptions and Unicode remark length", () => {
  const input = { items: [{ type: "link", name: "一二三四五六七", desc: "中".repeat(15), only_admin: false, link: "https://example.com/" }], remark: "中".repeat(255) }
  assert.deepEqual(validatePanel(input), input)
  assert.throws(() => validatePanel({ items: [command("中".repeat(8))] }), /最多 14/)
  assert.throws(() => validatePanel({ items: [{ ...command(), desc: "中".repeat(16) }] }), /最多 30/)
  assert.throws(() => validatePanel({ items: [command()], remark: "中".repeat(256) }), /最多 255/)
  assert.throws(() => validatePanel({ items: Array.from({ length: 21 }, () => command()) }), /最多 20 项/)
  assert.throws(() => validatePanel({ items: [{ ...command(), only_admin: "false" }] }), /布尔/)
  assert.throws(() => validatePanel({ items: [{ type: "link", name: "官网" }] }), /链接/)
  assert.throws(() => validatePanel({ items: [], version: 1.5 }), /非负整数/)
})

test("unknown platform fields survive without mutating input", () => {
  const input = { items: [{ ...command(), future: { value: [1, true, null] } }], future_option: "enabled" }
  const result = validatePanel(input)
  assert.deepEqual(result, input)
  result.items[0].future.value.push(2)
  assert.equal(input.items[0].future.value.length, 3)
})

test("creation enforces scope, target type and matching OpenID lists", () => {
  assert.deepEqual(validateCreatePanel({ scope: "dm", panel: panel() }), { scope: "dm", target_type: "all", panel: panel() })
  assert.deepEqual(validateCreatePanel({ scope: "group", target_type: "specific", panel: panel(), group_openids: [" group_1 "] }).group_openids, ["group_1"])
  assert.doesNotThrow(() => validateCreatePanel({ scope: "c2c", target_type: "specific", panel: panel() }))
  assert.throws(() => validateCreatePanel({ scope: "other", panel: panel() }), /生效场景/)
  assert.throws(() => validateCreatePanel({ scope: "channel", target_type: "specific", panel: panel() }), /仅支持全局/)
  assert.throws(() => validateCreatePanel({ scope: "group", target_type: "specific", panel: panel(), user_openids: ["user_1"] }), /不支持 user_openids/)
  assert.throws(() => validateCreatePanel({ scope: "c2c", target_type: "all", panel: panel(), user_openids: ["user_1"] }), /不支持 user_openids/)
  assert.throws(() => validateCreatePanel({ scope: "group", target_type: "specific", panel: panel(), group_openids: Array.from({ length: 21 }, (_, i) => `g_${i}`) }), /最多 20 项/)
})

test("target changes require official add/del operations and specific supported panels", () => {
  const detail = { scope: "c2c", target_type: "specific" }
  assert.deepEqual(validateTargets({ op: "add", user_openids: ["user_1"] }, detail), { op: "add", user_openids: ["user_1"] })
  assert.deepEqual(validateTargets({ op: "del", group_openids: ["group_1"] }, { scope: "group", target_type: "specific" }), { op: "del", group_openids: ["group_1"] })
  assert.throws(() => validateTargets({ op: "delete", user_openids: ["user_1"] }, detail), /add 或 del/)
  assert.throws(() => validateTargets({ op: "add", user_openids: [] }, detail), /请填写/)
  assert.throws(() => validateTargets({ op: "add", user_openids: ["user_1", " user_1 "] }, detail), /不能重复/)
  assert.throws(() => validateTargets({ op: "add", user_openids: ["user_1"] }, { scope: "c2c", target_type: "all" }), /指定对象/)
  assert.throws(() => validateTargets({ op: "add", user_openids: ["user_1"] }, { scope: "dm", target_type: "specific" }), /指定对象/)
})

test("malformed or oversized JSON and invalid known fields are rejected", () => {
  assert.throws(() => validateMenu(null), /对象/)
  assert.throws(() => validatePanel({ items: {} }), /数组/)
  assert.throws(() => validatePanel({ items: [null] }), /对象/)
  assert.throws(() => validatePanel({ items: [command()], extra: NaN }), /有效 JSON/)
  assert.throws(() => validatePanel({ items: [command()], extra: "x".repeat(128 * 1024) }), /数据过大/)
  assert.throws(() => validatePanel(JSON.parse('{"items":[],"__proto__":{}}')), /不支持的字段/)
  const cycle = { items: [] }
  cycle.extra = cycle
  assert.throws(() => validatePanel(cycle), /循环引用/)
  const input = { items: [] }
  let current = input
  for (let i = 0; i < 17; i++) current = current.extra = {}
  assert.throws(() => validatePanel(input), /嵌套层级/)
})
