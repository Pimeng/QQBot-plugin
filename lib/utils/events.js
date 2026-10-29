import { AsyncLocalStorage } from "node:async_hooks"
import cfg from "../../../../lib/config/config.js"
import { config } from "./cfg.js"
import { orgUin } from "../uin.js"
import { fileName } from "../../adapter/compat.js"
import { qblog } from "./logger.js"
import { dispatchWithPluginActivity } from "./plugin-activity.js"

let adapter = null
export function bindAdapter(instance) {
  adapter = instance
}

let pluginsLoader = null
function getPluginsLoader() {
  pluginsLoader ||= import("../../../../lib/plugins/loader.js").then(m => m.default)
  return pluginsLoader
}

/**
 * QQBot 账号（Bot[id]）列表
 *
 * miao 的 Bot.uin 是单个 icqq 账号，没有多适配器账号数组，
 * 因此这里直接扫描全局 Bot 上注册的 QQBot 账号对象。
 */
function qqbotIds() {
  const real = globalThis.Bot
  if (!real) return []
  /** miao 约定同 napcat-adapter：Bot[id].adapter 是适配器名字符串 */
  return Object.keys(real).filter(key => real[key]?.adapter === "QQBot")
}

/**
 * 维护全局 Bot.adapter
 *
 * miao 社区约定（napcat-adapter / plugins/system/stdin.js）：
 * Bot.adapter 是「在线适配器账号」的数组，元素是 uin 而不是适配器对象，
 * 这样 yenai 的 `Bot.adapter.includes(e.self_id)`、快递订阅等才能识别本适配器的账号。
 */
function markAdapterId(id, online) {
  const real = globalThis.Bot
  if (!real) return
  if (!Array.isArray(real.adapter)) real.adapter = []
  const index = real.adapter.indexOf(id)
  if (online) {
    if (index < 0) real.adapter.push(id)
    const hasUin = real.uin !== undefined && real.uin !== null && real.uin !== ""
    if (!hasUin || Array.isArray(real.uin)) {
      const hasOrgUin = orgUin !== undefined && orgUin !== null && orgUin !== "" && !Array.isArray(orgUin)
      real.uin = hasOrgUin ? orgUin : id
    }
  } else if (index >= 0) {
    real.adapter.splice(index, 1)
  }
}

function masterList() {
  const list = [...(cfg.masterQQ || [])]
  if (Array.isArray(config.master)) list.push(...config.master)
  return list.map(String)
}

/**
 * 解析主人身份：
 * - 普通 QQ 号（前缀已被剥掉）直接匹配 miao 的 masterQQ
 * - 官方 Bot 的 user_id 是 openid，只能靠 #QQBot绑定用户 的绑定关系还原
 */
function isMasterUser(rawUserId, plainUserId) {
  const masters = masterList()
  if (!masters.length) return false
  const candidates = []
  const bind = adapter?.bind_user?.[rawUserId]
  if (bind) candidates.push(String(bind))
  const cached = cachedFriend(rawUserId)
  if (cached?.real_id) candidates.push(String(cached.real_id))
  if (plainUserId) candidates.push(String(plainUserId))
  return candidates.some(id => masters.includes(id) || masters.includes(String(Number(id))))
}

function cachedFriend(rawUserId) {
  try {
    const real = globalThis.Bot
    for (const id of qqbotIds()) {
      const info = real[id]?.fl?.get?.(rawUserId)
      if (info) return info
    }
  } catch (err) {}
  return undefined
}

/** 把适配器的内部 data 转成 miao 插件能吃的 icqq 风格事件 */
function buildMiaoEvent(data) {
  if (!adapter) return null
  const sep = adapter.sep
  const selfId = String(data.self_id ?? "")
  const prefix = `${selfId}${sep}`
  const strip = value =>
    typeof value === "string" && prefix.length > 1 && value.startsWith(prefix)
      ? value.slice(prefix.length)
      : value

  const rawUserId = data.user_id ?? data.sender?.user_id
  const rawGroupId = typeof data.group_id === "string" ? data.group_id : undefined
  const plainUserId = strip(rawUserId)
  const plainGroupId = strip(rawGroupId)

  /** at 段里的 qq 同样去掉实例前缀，miao 插件按裸 ID 比对 */
  const message = (data.message || []).map(i =>
    i?.type === "at" ? { ...i, qq: strip(i.qq) } : i,
  )

  const e = {
    raw: data.raw,
    bot: data.bot,
    self_id: data.self_id,
    post_type: data.post_type || "message",
    message_type: data.message_type,
    sub_type: data.sub_type,
    notice_type: data.notice_type,
    request_type: data.request_type,
    operator_id: strip(data.operator_id),
    notice_id: data.notice_id,
    event_id: data.event_id,
    flag: data.flag,
    comment: data.comment,
    message_id: data.message_id,
    ...(data.seq !== undefined ? { seq: data.seq } : {}),
    ...(data.rand !== undefined ? { rand: data.rand } : {}),
    source: data.source && adapter.messageSource?.(data.self_id, data.message_type, rawGroupId ?? rawUserId, data.source) || data.source,
    time: data.time,
    timestamp: data.time,
    message,
    raw_message: data.raw_message,
    message_format: data.message_format || "array",
    user_id: plainUserId,
    sender: { ...(data.sender || {}), user_id: plainUserId },
    qqbot: true,
  }
  for (const key of ["guild_id", "channel_id", "src_guild_id", "guild_name", "channel_name", "channel_type", "emoji", "thread_id", "post_id", "reply_id", "author_id", "title", "content", "type", "result", "roles", "is_bot", "error_message"])
    if (data[key] !== undefined) e[key] = data[key]

  if (rawGroupId) e.group_id = plainGroupId
  if (data.target_id) e.target_id = strip(data.target_id)
  e.nickname = e.sender.nickname
  const file = message.find(item => item?.type === "file")
  if (file) e.file = { ...file }
  const sentParts = new Map()
  const scopedReply = typeof data.reply === "function" ? async (...args) => {
    const result = await data.reply(...args)
    if (typeof result?.message_id === "string" && Array.isArray(result.message_ids) && result.message_ids.length > 1) {
      sentParts.set(result.message_id, [...result.message_ids])
      if (sentParts.size > 32) sentParts.delete(sentParts.keys().next().value)
    }
    return result
  } : undefined
  const bindRecall = peer => {
    const recall = peer?.recallMsg
    if (typeof recall !== "function") return
    peer.recallMsg = async message => {
      const ids = typeof message === "string" ? sentParts.get(message) : undefined
      if (!ids) return recall.call(peer, message)
      const results = await recall.call(peer, ids)
      const pending = ids.filter((_id, index) => !Array.isArray(results) || !results[index])
      const success = pending.length === 0
      if (success) sentParts.delete(message)
      else sentParts.set(message, pending)
      return success
    }
  }
  if (data.raw?.message_type === "guild" || data.guild_id !== undefined) e.detail_type = "guild"
  if (e.detail_type === "guild") e.isGuild = true
  /** 适配器标识（napcat-adapter 同样会给事件挂 e.adapter），供插件区分平台 */
  e.adapter = adapter.id

  try {
    const sendFile = (file, pidOrName, name) => {
      const resolved = e.message_type === "group" ? fileName(pidOrName, name) : pidOrName
      return scopedReply({ type: "file", file, ...(resolved ? { name: resolved } : {}) })
    }

    if (rawGroupId) {
      e.group = adapter.pickGroup(data.self_id, rawGroupId)
      if (e.message_type === "group" && typeof data.reply === "function") {
        e.group.sendFile = sendFile
        e.group.sendMsg = (msg, source) => scopedReply(msg, source)
        bindRecall(e.group)
      }
      e.group_name = data.group_name || e.group?.name || plainGroupId
      e.group.getFileUrl = fid => adapter.contactFileUrl(data.self_id, "group", rawGroupId, fid, message)
      if (rawUserId) {
        e.member = adapter.pickMember(data.self_id, rawGroupId, rawUserId)
        Object.defineProperty(e.member, "group", { enumerable: true, configurable: true, get: () => e.group })
        if (!e.sender.nickname) e.sender = { ...e.member.info, ...e.sender, nickname: e.member.nickname || plainUserId }
      }
    }
    if (rawUserId && (e.message_type === "private" || e.notice_type === "friend")) {
      e.friend = adapter.pickFriend(data.self_id, rawUserId)
      if (!e.sender.nickname) e.sender.nickname = e.friend.nickname || plainUserId
      if (typeof data.reply === "function") {
        e.friend.sendFile = sendFile
        e.friend.sendMsg = (msg, source) => scopedReply(msg, source)
        bindRecall(e.friend)
      }
      e.friend.getFileUrl = fid => adapter.contactFileUrl(data.self_id, "private", rawUserId, fid, message)
    }
  } catch (err) {
    qblog.debug(`[${data.self_id}] 构造场景对象失败`, err)
  }
  e.nickname = e.sender.nickname

  if (isMasterUser(rawUserId, plainUserId)) e.isMaster = true
  /**
   * 群里 @ 了机器人
   *
   * 保留官方事件确定的机器人 @，同时标记 atBot，供不经过核心 dealMsg 的监听器使用。
   */
  if (data._at) e.atBot = true
  if (e.post_type === "message") {
    e.hasReply = Boolean(e.source)
    if (e.source?.message_id) e.reply_id = e.source.message_id
    e.getReply = async () => {
      if (!e.source) return undefined
      if (!e.source.message_id) throw new Error("QQBot 引用消息未提供可定位的消息 ID")
      return adapter.contactMessage(data.self_id, data.message_type, rawGroupId ?? rawUserId, e.source.message_id)
    }
    e.isPrivate = e.message_type === "private"
    e.isGroup = e.message_type === "group"
    e.isGuild = e.detail_type === "guild" || data.sub_type === "direct"
    e.atme = Boolean(data._at || message.some(item => item?.type === "at" && String(item.qq) === selfId))
    e.atall = message.some(item => item?.type === "at" && item.qq === "all")
    if (e.isPrivate) { e.from_id = plainUserId; e.to_id = data.self_id }
    if (e.group || e.friend) e.recall = () => (e.group || e.friend).recallMsg(e.message_id)
  }
  if (typeof data.approve === "function") e.approve = data.approve
  Object.defineProperties(e, {
    toString: { value: () => e.raw_message || "" },
    toJSON: { value: keys => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(e))
      .filter(key => !["raw", "bot", "group", "friend", "member"].includes(key) && typeof e[key] !== "function")
      .map(key => [key, e[key]])) },
  })
  /** 透传 reply 第 3 个参数（keyboard / button / markdown 等 QQ 官方扩展） */
  if (scopedReply) installReplyExtra(e, scopedReply)
  return e
}

/**
 * 透传 reply 的第 3 个参数
 *
 * miao 的 PluginsLoader.reply 只把 (msg, quote) 交给适配器，插件用
 * `e.reply(msg, quote, { keyboard / button / markdown })` 传的 QQ 官方扩展会被丢掉。
 *
 * 这里只在事件自己的 reply 上包一层：
 *   1. 核心先读 e.reply（getter 给出适配器原始 reply）存进 e.replyNew；
 *   2. 核心再回写包装后的 e.reply，落入 setter，被我们记下来；
 *   3. AsyncLocalStorage 将扩展参数绑定到本次异步调用，核心的
 *      at / recallMsg / 计数逻辑照旧执行，并发回复不会互相覆盖 replyNew。
 */
const replyExtraContext = new AsyncLocalStorage()
function installReplyExtra(e, rawReply) {
  let coreReply = null
  const baseReply = (msg, quote, extra) => {
    const current = replyExtraContext.getStore()
    return rawReply(msg, quote, extra ?? (current?.event === e ? current.extra : undefined))
  }
  Object.defineProperty(e, "reply", {
    configurable: true,
    enumerable: true,
    get() {
      return coreReply || baseReply
    },
    set(fn) {
      coreReply = async (msg, quote, extra) => {
        if (!extra || typeof extra !== "object" || !Object.keys(extra).length)
          return fn(msg, quote, extra)
        return replyExtraContext.run({ event: e, extra }, () => fn(msg, quote, extra))
      }
    },
  })
}

function emitEvent(emitter, event, root, detail) {
  emitter.emit(root, event)
  if (!detail) return
  emitter.emit(`${root}.${detail}`, event)
  if (event.sub_type) emitter.emit(`${root}.${detail}.${event.sub_type}`, event)
}

/** 同一规范事件投递给账号和宿主；宿主无根监听器时直接交给插件加载器。 */
async function dispatch(event, data) {
  if (typeof event === "string" && event.startsWith("connect.")) {
    globalThis.Bot?.emit?.(event, data)
    return
  }
  if (!data || typeof data !== "object") return
  if (!["message", "notice", "request"].includes(data.post_type)) return

  const e = buildMiaoEvent(data)
  if (!e) return
  if (e.post_type === "message") warnUnreachable(e)

  const real = globalThis.Bot
  const root = e.post_type
  const hasRootListeners = typeof real?.listenerCount === "function"
    ? real.listenerCount(root) > 0
    : typeof real?.listeners === "function" && real.listeners(root).length > 0
  if (typeof real?.emit === "function") {
    const detail = e.message_type || e.request_type || e.notice_type
    if (data.bot !== real && typeof data.bot?.emit === "function") emitEvent(data.bot, e, root, detail)
    emitEvent(real, e, root, detail)
    if (hasRootListeners) return
  }

  try {
    const loader = await getPluginsLoader()
    if (config.inputNotify === true && e.message_type === "private" && e.sub_type === "friend")
      await dispatchWithPluginActivity(loader, e, () => adapter?.sendInputNotify(e))
    else
      await loader.deal(e)
  } catch (err) {
    qblog.error(`[${e.self_id}] 插件事件处理错误`, err)
  }
}

/** 被 other.yaml 白名单静默拦截时给出一次提示，避免"机器人没反应"无从排查 */
const warned = new Set()
function warnUnreachable(e) {
  try {
    const other = cfg.getOther?.() || {}
    const key = `${e.self_id}:${e.group_id ?? e.user_id}`
    if (warned.has(key)) return

    if (e.group_id) {
      if (
        other.whiteGroup?.length &&
        !other.whiteGroup.find(a => a == `${e.self_id}:${e.group_id}` || a == e.group_id)
      ) {
        warned.add(key)
        qblog.warn(
          `[${e.self_id}] 群 ${e.self_id}:${e.group_id} 不在 config/config/other.yaml 的 whiteGroup 中，消息不会触发任何插件；` +
            "如需启用请把上面这个 id 加进 whiteGroup",
        )
      }
      return
    }

    const uid = Number(e.user_id) || String(e.user_id)
    if (other.whiteQQ?.length && !other.whiteQQ.includes(uid)) {
      warned.add(key)
      qblog.warn(`[${e.self_id}] 用户 ${uid} 不在 config/config/other.yaml 的 whiteQQ 中，消息不会触发任何插件`)
    }
  } catch (err) {}
}

export {
  getPluginsLoader,
  qqbotIds,
  markAdapterId,
  masterList,
  isMasterUser,
  cachedFriend,
  buildMiaoEvent,
  installReplyExtra,
  dispatch,
  warned,
  warnUnreachable,
}
