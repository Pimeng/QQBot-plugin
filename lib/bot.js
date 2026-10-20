/** 全局 Bot 兼容层：保留宿主事件总线，并把账号调用交给实际在线的客户端。 */
import { qqbot } from "../adapter/index.js"
import { log } from "./utils/common.js"
import { isHostOnline } from "./uin.js"

const hostBot = globalThis.Bot
const registered = {}
const boundMethods = new WeakMap()
const infoViews = new WeakMap()
const protocolMethods = new Map()
const unavailableMethods = new Map()
// 记录宿主原生协议方法，后续插件挂到 Bot 上的扩展仍可按原样调用。
for (let prototype = Object.getPrototypeOf(hostBot); prototype; prototype = Object.getPrototypeOf(prototype)) {
  if (["Object", "EventEmitter", "Trapper"].includes(prototype.constructor?.name)) continue
  for (const key of Reflect.ownKeys(prototype)) {
    const value = Reflect.getOwnPropertyDescriptor(prototype, key)?.value
    if (key !== "constructor" && typeof value === "function" && !protocolMethods.has(key))
      protocolMethods.set(key, value)
  }
}
for (const name of ["pickGuild", "pickDiscuss", "heartbeat", "getCmdWhiteList", "getApiQQVer", "getSign", "requestSignToken", "submitSsoPacket"])
  if (typeof hostBot[name] === "function") protocolMethods.set(name, hostBot[name])
const maps = Object.fromEntries(["gl", "fl", "gml"].map(name => [name, aggregateMap(name)]))
const botMethods = {
  pickGroup,
  pickFriend,
  pickUser: pickFriend,
  pickMember,
  isOnline: () => isHostOnline() || accounts().length > 0,
  sendGroupMsg: (gid, ...args) => pickGroup(gid)?.sendMsg(...args),
  sendPrivateMsg: (uid, ...args) => pickFriend(uid)?.sendMsg(...args),
  // phi-plugin 的全局便捷接口为 (botId, userId, message)，账号方法则为 (userId, message)。
  sendFriendMsg: async (selfId, uid, msg, source) => {
    const bot = selfId === undefined || selfId === null ? defaultBot()
      : String(selfId) === String(hostBot.uin) ? hostBot : read(String(selfId))
    if (typeof bot?.pickFriend !== "function") throw new Error(`QQBot 账号不存在：${selfId}`)
    return bot.pickFriend(uid).sendMsg(msg, source)
  },
  getGroupInfo: (gid, ...args) => pickGroup(gid)?.getInfo(...args),
  getGroupMemberInfo: (gid, uid, ...args) => pickMember(gid, uid)?.getInfo(...args),
  getGroupMemberList: (gid, ...args) => pickGroup(gid)?.getMemberMap(...args),
  getFriendInfo: (uid, ...args) => pickFriend(uid)?.getInfo(...args),
  getStrangerInfo: (uid, ...args) => pickFriend(uid)?.getInfo(...args),
  getGroupMsgHistory: (gid, ...args) => pickGroup(gid)?.getChatHistory(...args),
  getFriendMsgHistory: (uid, ...args) => pickFriend(uid)?.getChatHistory(...args),
  getMsg: (value, ...args) => messageCall("getMsg", value, ...args),
  getChatHistory: (value, ...args) => messageCall("getChatHistory", value, ...args),
  getGroupMap: () => maps.gl,
  getFriendMap: () => maps.fl,
  getGroupList: async () => maps.gl,
  getFriendList: async () => maps.fl,
}

function read(prop) {
  return Object.hasOwn(registered, prop) ? registered[prop] : Reflect.get(hostBot, prop, hostBot)
}

/** 账号注册在代理或原客户端上时都可见，Bot.adapter 负责记录已连接的账号。 */
function accounts(includeOffline = false) {
  const online = read("adapter")
  return [...new Set([...(Array.isArray(online) ? online.map(String) : []), ...Object.keys(registered), ...Object.keys(hostBot)])]
    .map(key => [key, read(key)])
    .filter(([key, bot]) => bot && bot !== hostBot &&
      (typeof bot === "object" || typeof bot === "function") &&
      String(bot.uin) === key &&
      (typeof bot.pickGroup === "function" || typeof bot.pickFriend === "function") &&
      (includeOffline || (Array.isArray(online) ? online.some(id => String(id) === key) :
        typeof bot.isOnline === "function" && bot.isOnline())))
    .map(([, bot]) => bot)
}

function defaultBot() {
  if (isHostOnline()) return hostBot
  const online = accounts()
  const preferred = Object.hasOwn(registered, "uin") ? registered.uin : hostBot.uin
  return online.find(bot => String(bot.uin) === String(preferred)) || online[0] || hostBot
}

/** icqq 的方法可能访问私有字段，事件方法和宿主方法必须绑定原始客户端。 */
function bound(bot, prop, value) {
  if (typeof value !== "function" || prop === "constructor") return value
  let cache = boundMethods.get(bot)
  if (!cache) boundMethods.set(bot, cache = new Map())
  const previous = cache.get(prop)
  if (previous?.value === value) return previous.bound
  const result = value.bind(bot)
  cache.set(prop, { value, bound: result })
  return result
}

const eventMethods = new Set([
  "adapter", "constructor", "toString", "toLocaleString", "valueOf",
  "on", "once", "off", "addListener", "removeListener", "removeAllListeners", "emit",
  "listeners", "rawListeners", "listenerCount", "eventNames", "getMaxListeners", "setMaxListeners",
  "prependListener", "prependOnceListener", "em",
  "trap", "trapOnce", "offTrap", "trip", "bail", "getListeners", "getMatchers", "addMatcher",
])

globalThis.Bot = new Proxy(registered, {
  get(target, prop) {
    if (Object.hasOwn(botMethods, prop)) return botMethods[prop]
    if (Object.hasOwn(maps, prop)) return maps[prop]
    const primary = defaultBot()
    if (prop === "uin") return primary === hostBot ? read(prop) : primary.uin
    if (Object.hasOwn(target, prop)) return target[prop]
    if (primary !== hostBot && !eventMethods.has(prop) && !Object.hasOwn(Object.prototype, prop) && prop in primary)
      return bound(primary, prop, Reflect.get(primary, prop, primary))
    const original = Reflect.get(hostBot, prop, hostBot)
    if (!eventMethods.has(prop) && typeof original === "function" && protocolMethods.get(prop) === original &&
      !isHostOnline() && accounts(true).some(bot => bot.adapter === "QQBot")) {
      if (!unavailableMethods.has(prop)) unavailableMethods.set(prop, async () => {
        throw new Error(`QQBot 官方接口不支持 Bot.${String(prop)}`)
      })
      return unavailableMethods.get(prop)
    }
    return bound(hostBot, prop, original)
  },
  has(target, prop) {
    return Object.hasOwn(botMethods, prop) || Object.hasOwn(maps, prop) ||
      Reflect.has(target, prop) || Reflect.has(hostBot, prop) || Reflect.has(defaultBot(), prop)
  },
  ownKeys(target) {
    return [...new Set([...Reflect.ownKeys(hostBot), ...Reflect.ownKeys(target)])]
  },
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop)
    if (own) return own
    const original = Reflect.getOwnPropertyDescriptor(hostBot, prop)
    return original ? { ...original, configurable: true } : undefined
  },
  deleteProperty(target, prop) {
    if (Object.hasOwn(target, prop)) return Reflect.deleteProperty(target, prop)
    return Reflect.deleteProperty(hostBot, prop)
  },
})

/** 官方消息 ID 不是 icqq 编码，先在实际收到消息的账号中查找。 */
async function messageCall(method, value, ...args) {
  const mid = value && typeof value === "object" ? value.message_id ?? value.id : value
  const all = accounts(true)
  let selected = value?.self_id === undefined ? undefined : all.find(bot => String(bot.uin) === String(value.self_id))
  selected ||= all.find(bot => [...(bot.messageCache?.values?.() || [])]
    .some(message => String(message.message_id) === String(mid)))
  if (!selected && isHostOnline()) selected = hostBot
  if (!selected) {
    const online = accounts()
    if (online.length === 1) selected = online[0]
  }
  if (typeof selected?.[method] !== "function") throw new Error(`QQBot 消息未缓存或已过期：${mid}`)
  return selected[method](value, ...args)
}

function plainId(id, bot) {
  const prefix = `${bot.uin}${qqbot.sep}`
  return typeof id === "string" && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

function keyOf(bot, name, id) {
  const map = bot?.[name]
  if (typeof map?.has !== "function") return undefined
  const plain = plainId(id, bot)
  const candidates = [id, `${bot.uin}${qqbot.sep}${plain}`, plain]
  if (bot === hostBot && /^\d+$/.test(String(id))) candidates.push(Number(id))
  return candidates.find(key => map.has(key))
}

/** 先按实例前缀选账号，再查缓存；单 QQBot 可对尚未缓存的 openid 主动调用。 */
function contact(name, id, strict) {
  id = typeof id === "number" ? id : String(id)
  const online = accounts()
  const scoped = online.find(bot => typeof id === "string" && id.startsWith(`${bot.uin}${qqbot.sep}`))
  if (scoped) {
    const key = keyOf(scoped, name, id)
    if (key !== undefined || !strict) return { bot: scoped, id: key ?? id }
  } else {
    for (const bot of [...online, ...(isHostOnline() ? [hostBot] : [])]) {
      const key = keyOf(bot, name, id)
      if (key !== undefined) return { bot, id: key }
    }
    if (!strict) {
      if (isHostOnline() && /^\d+$/.test(String(id))) return { bot: hostBot, id: Number(id) }
      if (online.length === 1) return { bot: online[0], id }
    }
  }
  const error = new Error(`获取${name === "gl" ? "群" : "好友"}对象错误：找不到${name === "gl" ? "群" : "好友"} ${id}`)
  if (strict) throw error
  log("error", error.message)
}

function pickGroup(gid, strict) {
  const selected = contact("gl", gid, strict)
  return selected?.bot.pickGroup(selected.id, strict)
}

function pickFriend(uid, strict) {
  const selected = contact("fl", uid, strict)
  return selected?.bot.pickFriend(selected.id, strict)
}

function pickMember(gid, uid, strict) {
  if (uid == 88888) {
    const nickname = "Yunzai-Bot"
    return {
      group_id: gid, user_id: uid, nickname, card: nickname, sex: "female", age: 6,
      join_time: "", last_sent_time: "", level: 1, role: "member", title: "",
      title_expire_time: "", shutup_time: 0, update_time: "", area: "南极洲", rank: "潜水",
    }
  }
  const selected = contact("gl", gid, strict)
  if (!selected) return
  if (typeof selected.bot.pickMember === "function")
    return selected.bot.pickMember(selected.id, uid, strict)
  return selected.bot.pickGroup(selected.id, strict)?.pickMember(uid, strict)
}

/** 聚合资料保持实时，并补上所属账号，供依赖 Bot.gl.get(id).uin 的插件路由。 */
function infoView(info, bot, name) {
  if (name === "gml" || !info || typeof info !== "object") return info
  let views = infoViews.get(info)
  if (!views) infoViews.set(info, views = new Map())
  if (!views.has(bot)) views.set(bot, new Proxy({}, {
    get: (_target, prop) => prop === "uin" ? bot.uin : Reflect.get(info, prop, info),
    set: (_target, prop, value) => Reflect.set(info, prop, value, info),
    has: (_target, prop) => prop === "uin" || prop in info,
    ownKeys: () => [...new Set([...Reflect.ownKeys(info), "uin"])],
    getOwnPropertyDescriptor: (_target, prop) => prop === "uin" || Object.hasOwn(info, prop)
      ? { configurable: true, enumerable: true, writable: true, value: prop === "uin" ? bot.uin : info[prop] }
      : undefined,
  }))
  return views.get(bot)
}

/** Map 引用可长久保存；每次访问都读原账号缓存，连接、退出和收到新消息会立即反映。 */
function aggregateMap(name) {
  const sources = () => [...(isHostOnline() ? [hostBot] : []), ...accounts()]
  const snapshot = () => {
    const merged = new Map()
    for (const bot of sources()) for (const [key, value] of bot[name] || []) {
      const plain = bot === hostBot ? key : plainId(key, bot)
      const output = merged.has(plain) ? `${bot.uin}${qqbot.sep}${plain}` : plain
      merged.set(output, infoView(value, bot, name))
    }
    return merged
  }
  const locate = id => {
    const bots = sources()
    const scoped = bots.find(bot => bot !== hostBot && typeof id === "string" && id.startsWith(`${bot.uin}${qqbot.sep}`))
    for (const bot of scoped ? [scoped] : bots) {
      const key = keyOf(bot, name, id)
      if (key !== undefined) return { bot, key }
    }
  }
  let view
  const methods = {
    get(id) {
      const source = locate(id)
      return source && infoView(source.bot[name].get(source.key), source.bot, name)
    },
    has: id => Boolean(locate(id)),
    set(id, value) {
      const owner = value?.uin === undefined ? undefined : sources().find(bot => String(bot.uin) === String(value.uin))
      const source = locate(id)
      const bot = owner || source?.bot || defaultBot()
      if (!bot[name]) bot[name] = new Map()
      bot[name].set(owner && owner !== source?.bot ? id : source?.key ?? id, value)
      return view
    },
    delete(id) {
      const source = locate(id)
      return source ? source.bot[name].delete(source.key) : false
    },
    clear() { for (const bot of sources()) bot[name]?.clear() },
    forEach(callback, thisArg) {
      for (const [key, value] of snapshot()) callback.call(thisArg, value, key, view)
    },
  }
  view = new Proxy(new Map(), {
    get(_target, prop) {
      if (Object.hasOwn(methods, prop)) return methods[prop]
      const current = snapshot()
      const value = Reflect.get(current, prop, current)
      return typeof value === "function" && prop !== "constructor" ? value.bind(current) : value
    },
  })
  return view
}
