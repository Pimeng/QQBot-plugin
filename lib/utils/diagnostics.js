/**
 * 连接诊断日志
 *
 * 扫码登录和账号连接失败时，宿主控制台里的信息往往只剩一句「连接失败」：
 * SDK 的握手/重连日志被过滤，HTTP 错误只保留最后一条。这里把关键节点统一记录：
 *
 *   - 控制台：统一走 qblog.debug（[诊断/<模块>]），只有 bot.log_level 设成 debug 才显示，
 *     避免默认配置下刷屏；需要现场排查时把日志等级调到 debug 即可。
 *   - 文件：data/QQBot/diagnostics.log，保留真实级别（info/warn/error），
 *     超过 2MB 自动轮转一份 .1；无论控制台等级如何都会写，方便事后排查。
 *
 * 字段名命中 secret/token/authorization 等关键字的值一律脱敏，只保留长度。
 * 文件写入只在宿主 logger 存在时启用，单测里不会产生多余文件。
 */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { qblog } from "./logger.js"

const LOG_DIR = path.join("data", "QQBot")
const LOG_FILE = path.join(LOG_DIR, "diagnostics.log")
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_STRING = 400
const MAX_DETAIL = 2400
const MAX_ARRAY = 20
const MAX_KEYS = 40

/** 只匹配完整字段名，避免把 message_id / appid 之类误脱敏 */
const SENSITIVE_KEY = /^(?:app_?secret|secret|client_?secret|token|access_?token|refresh_?token|authorization|cookie|set-cookie|password|passwd|key|bot_encrypt_secret|encrypt_secret)$/i

const CLOSE_CODE_HINTS = {
  4001: "无效的 opcode，通常是 SDK 与网关协议不匹配",
  4002: "无效的 payload，检查 intents / 鉴权参数",
  4007: "seq 错误",
  4008: "发送过快被限流，SDK 会自动重连",
  4009: "连接过期，SDK 会自动重连",
  4010: "无效的 shard",
  4011: "机器人所在频道过多，需要分片",
  4012: "无效的 version",
  4013: "intents 无效：平台不认识这个事件类型，检查 intents 配置",
  4014: "intents 无权限：机器人未在开放平台开启对应能力（群消息 / C2C / 群成员 / 按钮交互等）",
  4900: "网关内部错误，SDK 会自动重连",
  4914: "机器人已下架：只能用沙箱环境（打开 bot.sandbox）或重新上架",
  4915: "机器人已封禁：请到 QQ 开放平台申诉解封",
}

/** 常见 HTTP / 平台错误码的排查提示 */
const ERROR_HINTS = [
  [/\b100016\b/, "AppID 或 AppSecret 无效；扫码登录会重置 Secret，请确认配置里保存的是刚拿到的新 Secret"],
  [/\b100017\b/, "AppID 与 Secret 不匹配"],
  [/\binvalid appid\b/i, "AppID 无效或机器人已被删除"],
  [/getAppAccessToken|access_token/i, "获取 access_token 失败：AppID / AppSecret 或网络问题"],
  [/gateway\/bot/i, "获取网关地址失败：access_token 或网络问题"],
  [/ENOTFOUND|EAI_AGAIN/, "域名解析失败：检查网络 / DNS / 代理"],
  [/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i, "网络连接失败：检查网络、代理或防火墙"],
  [/\b401\b/, "鉴权失败（HTTP 401）：AppID / AppSecret 不正确"],
  [/\b4013\b/, CLOSE_CODE_HINTS[4013]],
  [/\b4014\b/, CLOSE_CODE_HINTS[4014]],
  [/\b4914\b/, CLOSE_CODE_HINTS[4914]],
  [/\b4915\b/, CLOSE_CODE_HINTS[4915]],
]

let fileState

/** 真实运行时才落盘：宿主 logger 已就绪，且 fs 提供追加写入能力。 */
function fileEnabled() {
  if (fileState === undefined) {
    fileState = Boolean(globalThis.logger) &&
      typeof fs.mkdirSync === "function" &&
      typeof fs.appendFileSync === "function"
  }
  return fileState
}

function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

const MASK_MARK = "***（已隐藏"

/** 敏感值只用长度说明问题：长度 0 能立刻看出 Secret 没保存进去 */
export function maskSecret(value) {
  if (value === undefined || value === null) return ""
  return `${MASK_MARK}，长度 ${String(value).length}）`
}

/** accountDiag 已经脱敏过的值再被 redact 处理一次时，不要重复脱敏丢失长度信息 */
function isMasked(value) {
  return typeof value === "string" && value.startsWith(MASK_MARK)
}

function truncate(text) {
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…（共 ${text.length} 字符）` : text
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return truncate(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (value instanceof Error) return describeError(value)
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (depth >= 4) return "[深度截断]"
  if (Array.isArray(value))
    return value.slice(0, MAX_ARRAY).map(item => redact(item, depth + 1))
  const output = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS))
    output[key] = SENSITIVE_KEY.test(key) && !isMasked(item) ? maskSecret(item) : redact(item, depth + 1)
  return output
}

/** 供测试和日志格式化复用的脱敏入口 */
export function redactDetail(value) {
  return redact(value)
}

/** 把异常拆成能复制的字段，尽量带出 HTTP 状态、平台错误码和 traceId */
export function describeError(error, extra = {}) {
  if (error === null || error === undefined) return { ...extra, message: "未知错误" }
  if (typeof error !== "object") return { ...extra, message: String(error) }
  const detail = { ...extra }
  detail.name = error.name || "Error"
  detail.message = truncate(String(error.message ?? error))
  for (const key of ["code", "status", "statusCode", "errno", "syscall", "hostname", "address", "port"])
    if (error[key] !== undefined) detail[key] = error[key]
  const response = error.response
  if (response && typeof response === "object") {
    if (response.status !== undefined) detail.httpStatus = response.status
    if (response.data !== undefined) detail.response = redact(response.data)
    const traceId = response.headers?.["x-tps-trace-id"] ?? response.headers?.["x-request-id"]
    if (traceId) detail.traceId = traceId
  }
  const config = error.config
  if (config && typeof config === "object")
    detail.request = { method: config.method, url: config.url }
  if (error.cause && error.cause !== error) detail.cause = describeError(error.cause)
  if (error.stack) detail.stack = String(error.stack).split("\n").slice(0, 8).join("\n")
  return detail
}

/** 网关关闭码的中文含义，用于把 4013/4014/4914 之类变成可执行的结论 */
export function describeCloseCode(code) {
  const numeric = Number(code)
  if (!Number.isFinite(numeric)) return ""
  return CLOSE_CODE_HINTS[numeric] || ""
}

/** 根据错误文本给出排查方向（HTTP 错误码、网络错误、intents 拒绝等） */
export function describeErrorHint(error) {
  const text = [error?.message, error?.code, error?.response?.data?.code, error?.response?.data?.message]
    .filter(value => value !== undefined && value !== null)
    .join(" ")
  for (const [pattern, hint] of ERROR_HINTS)
    if (pattern.test(text)) return hint
  return ""
}

function format(detail) {
  if (detail === undefined) return ""
  try {
    const text = JSON.stringify(redact(detail))
    return text.length > MAX_DETAIL ? ` ${text.slice(0, MAX_DETAIL)}…（已截断）` : ` ${text}`
  } catch {
    return ` ${truncate(inspect(detail, { depth: 3, breakLength: 140 }))}`
  }
}

let headerWritten = false

function fileSize() {
  try {
    return fs.statSync?.(LOG_FILE)?.size || 0
  } catch {
    return 0
  }
}

function append(line) {
  if (!fileEnabled()) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    if (!headerWritten) {
      headerWritten = true
      if (!fs.existsSync(LOG_FILE))
        fs.appendFileSync(LOG_FILE, "# QQBot 连接诊断日志（发报告时请把本文件完整发出来）\n")
    }
    if (fileSize() > MAX_FILE_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    fs.appendFileSync(LOG_FILE, `${line}\n`)
  } catch {
    /** 写日志失败不能影响连接流程 */
    fileState = false
  }
}

/**
 * 输出一条诊断日志；level 为 debug / info / warn / error
 *
 * 级别只写进文件，控制台一律降为 debug：正常运行时保持安静，
 * 把 bot.log_level 调成 debug 才在控制台展开细节。
 */
export function diagnostic(level, scope, message, detail) {
  const body = `${message}${format(detail)}`
  append(`[${stamp()}] [${level}] [${scope}] ${body}`)
  qblog.debug(`[诊断/${scope}] ${body}`)
}

/** 生成带固定模块前缀的诊断器，避免每个调用点重复写模块名 */
export function createDiag(scope) {
  return {
    debug: (message, detail) => diagnostic("debug", scope, message, detail),
    info: (message, detail) => diagnostic("info", scope, message, detail),
    warn: (message, detail) => diagnostic("warn", scope, message, detail),
    error: (message, detail) => diagnostic("error", scope, message, detail),
  }
}

/** 账号摘要：AppID 可以展示，Secret 永远只给长度 */
export function accountDiag(account = {}) {
  return {
    uin: account.uin ?? "",
    appid: account.appid ?? "",
    secret: maskSecret(account.secret),
    group: account.group === true,
    guild: account.guild === true,
    webhook: account.webhook === true,
  }
}
