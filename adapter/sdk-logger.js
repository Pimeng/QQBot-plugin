import { qblog, logEventPacket } from "../lib/utils/logger.js"

const CONNECTION_LOGS = [
  "等待断线重连中",
  "重新连接中，尝试次数",
  "连接成功",
  "[WebSocketReceiver] 连接关闭：",
  "[WebSocketReceiver] 连接断开，第",
  "[WebSocketReceiver] 等待 ",
  "WebSocket连接已建立",
]
const WS_PACKET_PREFIX = "[WebSocketReceiver] 收到消息: "

// SDK 会重复记录消息和连接状态，只在此处过滤；业务日志直接调用 qblog。
export function createSdkLogger(account) {
  const sdkLogger = {}
  for (const level of Object.keys(qblog)) {
    sdkLogger[level] = (...args) => {
      const head = String(args[0] ?? "")
      if (head.startsWith("recv from")) return

      if (level === "debug") {
        if (!account.webhook && head.startsWith(WS_PACKET_PREFIX))
          return logEventPacket("WebSocket", head.slice(WS_PACKET_PREFIX.length), account.uin)

        const packet = args[1]
        if (packet && typeof packet === "object" && packet.t === args[0] && "d" in packet)
          return account.webhook ? logEventPacket(args[0], packet, account.uin) : undefined
      }

      if (level !== "error" && level !== "fatal" && CONNECTION_LOGS.some(text => head.includes(text))) return
      return qblog[level](`[${account.uin}]`, ...args)
    }
  }
  return sdkLogger
}
