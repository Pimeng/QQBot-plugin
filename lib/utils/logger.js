import { inspect } from "node:util"

// 保留原始参数和 logger 的 this，让宿主负责对象、错误和颜色的输出。
function write(level, args) {
  const logger = globalThis.logger
  const output = logger?.[level] || logger?.info
  return output?.call(logger, "[QQBot]", ...args)
}

export const qblog = {
  trace: (...args) => write("trace", args),
  debug: (...args) => write("debug", args),
  info: (...args) => write("info", args),
  mark: (...args) => write("mark", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
  fatal: (...args) => write("fatal", args),
}

// 原始网关包需要完整保留，单独指定 inspect 选项，避免宿主截断深层字段。
export function logEventPacket(event, packet, id) {
  qblog.debug(`[${id}] 收到事件包 [${event}]`, inspect(packet, {
    depth: null,
    breakLength: 120,
    maxArrayLength: null,
    maxStringLength: null,
  }))
}
