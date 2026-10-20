import { inspect } from "node:util"
import { qblog } from "./logger.js"

// 保留旧的工具入口；插件内部按职责直接导入对应模块。
export * from "./logger.js"
export * from "./message.js"
export * from "./files.js"
export * from "./store.js"
export * from "./webhook.js"
export * from "./file-upload.js"
export * from "./events.js"

// 以下仅兼容旧的 qqbotCommon 调用，业务代码直接使用 qblog.info(...) 等方法。
export const LOG_LEVELS = Object.keys(qblog)

export function logValue(data) {
  if (typeof data === "string") return data
  if (data instanceof Error) return data.stack || String(data)
  if (Buffer.isBuffer(data)) return `<Buffer ${data.length}>`
  try {
    return inspect(data, { depth: 4, breakLength: 120, maxArrayLength: 50, maxStringLength: 1000 })
  } catch {
    return String(data)
  }
}

export function log(level, msg, id) {
  const args = (Array.isArray(msg) ? msg : [msg]).map(logValue)
  if (id !== false && id !== undefined && id !== null && id !== "") args.unshift(`[${id}]`)
  const output = LOG_LEVELS.includes(level) ? qblog[level] : qblog.info
  return output(...args)
}
