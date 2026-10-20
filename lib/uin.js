/** 宿主账号快照；在全局 Bot 被兼容层包装前保留原始客户端。 */
const hostBot = globalThis.Bot
export const orgUin = hostBot?.uin
const hostIsOnline = hostBot?.isOnline

/** 始终用原始客户端作 this，避免把适配器的在线状态误当作 icqq 已登录。 */
export function isHostOnline() {
  try {
    return typeof hostIsOnline === "function" && Boolean(hostIsOnline.call(hostBot))
  } catch {
    return false
  }
}
