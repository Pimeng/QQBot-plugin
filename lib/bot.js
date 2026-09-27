/**
 * 全局 Bot 代理：让 `Bot.pickGroup / pickFriend / pickMember / pickUser` 跨适配器可用
 *
 * 写法取自 Lain-plugin / napcat-adapter 的 lib/bot.js：
 * 代理的目标用**空对象**而不是 CopyBot 本身——get 里取到的 `Bot[uin]`（icqq 自己）
 * 是未被代理的原对象，因此 icqq 的 pick* 不会又绕回这里的跨适配器实现造成递归。
 *
 * 注意：本文件必须在任何 QQBot 账号注册（`Bot[id] = …`）之前导入，
 * 否则那些账号挂在原 Bot 上，`Object.keys(Bot)`（qqbotIds）看不到它们。
 * index.js 在最前面导入它，满足这个顺序。
 */
import { qqbot } from "../adapter/index.js"
import { log, qqbotIds } from "./utils/common.js"

const CopyBot = Bot

const botMethods = { pickGroup, pickFriend, pickMember, pickUser: pickFriend }

Bot = new Proxy(
  {},
  {
    get(target, prop, receiver) {
      if (prop in botMethods) return botMethods[prop]
      if (prop in target) return target[prop]
      return Reflect.get(CopyBot, prop, receiver)
    },
  },
)

/** 某个账号的群/好友缓存里是否存着这个 id（QQBot 的键是「实例前缀 + openid」） */
function findKey(bot, mapName, id) {
  const map = bot?.[mapName]
  if (!map?.has) return null
  for (const key of [`${bot.uin}${qqbot.sep}${id}`, id, `qg_${id}`]) if (map.has(key)) return key
  return null
}

/**
 * 得到一个群对象
 * @param gid 群号 / 群 openid
 * @param strict 严格模式，若群不存在会抛出异常
 */
function pickGroup(gid, strict) {
  gid = String(gid)
  for (const id of qqbotIds()) {
    const bot = Bot[id]
    const key = findKey(bot, "gl", gid)
    if (key) return bot.pickGroup(key)
  }
  const group = CopyBot.gl?.get?.(gid)
  if (group) return CopyBot[group.uin]?.pickGroup?.(gid, strict)
  if (CopyBot[gid]) return CopyBot[gid].pickGroup(gid, strict)
  log("error", `获取群对象错误：找不到群 ${gid}`)
}

/**
 * 得到一个好友对象
 * @param uid 好友账号 / openid
 * @param strict 严格模式，若好友不存在会抛出异常
 */
function pickFriend(uid, strict) {
  uid = String(uid)
  for (const id of qqbotIds()) {
    const bot = Bot[id]
    const key = findKey(bot, "fl", uid)
    if (key) return bot.pickFriend(key)
  }
  const user = CopyBot.fl?.get?.(uid)
  if (user) return CopyBot[user.uin]?.pickFriend?.(uid, strict)
  if (CopyBot[uid]) return CopyBot[uid].pickFriend(uid, strict)
  log("error", `获取好友对象错误：找不到好友 ${uid}`)
}

/**
 * 得到一个群员对象
 * @param gid 群员所在的群号
 * @param uid 群员的账号
 * @param strict 严格模式，若群员不存在会抛出异常
 */
function pickMember(gid, uid, strict) {
  if (uid == 88888) {
    const nickname = "Yunzai-Bot"
    return {
      group_id: gid,
      user_id: uid,
      nickname,
      card: nickname,
      sex: "female",
      age: 6,
      join_time: "",
      last_sent_time: "",
      level: 1,
      role: "member",
      title: "",
      title_expire_time: "",
      shutup_time: 0,
      update_time: "",
      area: "南极洲",
      rank: "潜水",
    }
  }
  const group = pickGroup(gid, strict)
  if (group?.pickMember) return group.pickMember(uid)
  log("error", `获取群员对象错误：从群 ${gid} 中找不到群员 ${uid}`)
}
