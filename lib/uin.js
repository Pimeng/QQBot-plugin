/**
 * Bot.uin 多账号 shim（写法与 napcat-adapter / snowluma-adapter 的 lib/uin.js 一致）
 *
 * miao 的 Bot.uin 是单个 icqq 账号，而这里可能同时有 icqq + 若干 QQBot 账号。
 * 把它换成一个数组，并让 toString / valueOf / toJSON 返回第一个元素，
 * 这样 `Bot[Bot.uin]`、`${Bot.uin}` 这类老写法照旧能用，
 * 而 yenai 的 `BotList = Bot.uin`、DF 的 `Array.isArray(Bot.uin)` 也能拿到全部账号。
 */
const orgUin = Bot.uin

Bot.uin = Object.assign([], {
  toString() {
    return this[0]
  },
  toJSON() {
    return this[0]
  },
  valueOf() {
    return this[0]
  },
})

if (orgUin) Bot.uin.push(orgUin)

/**
 * 让 Bot.uin 与 Bot.adapter（在线适配器账号数组）保持一致
 * 由 utils/common.js 的 markAdapterId() 在账号上下线时调用。
 */
export function syncUin() {
  const list = []
  /** 第一个元素始终是 icqq 账号：老的 `Bot[Bot.uin]` / `${Bot.uin}` 依赖它 */
  if (orgUin) list.push(orgUin)
  for (const id of Array.isArray(Bot.adapter) ? Bot.adapter : [])
    if (!list.includes(id)) list.push(id)
  Bot.uin.splice(0, Bot.uin.length, ...list)
  return Bot.uin
}
