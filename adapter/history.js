import AdapterLifecycle from "./lifecycle.js"
import { config } from "../lib/utils/cfg.js"
import { buildMiaoEvent, getMap } from "../lib/utils/common.js"
import { plainId } from "./compat.js"
import { receivedFileUrl } from "./message/received.js"

const copy = value => JSON.parse(JSON.stringify(value))
const messageId = value => value && typeof value === "object" ? value.message_id ?? value.id : value

/** QQ 官方收到的消息本地留档；不调用不存在的群/C2C 历史接口。 */
export default class AdapterHistory extends AdapterLifecycle {
  historyLimit() {
    const limit = Number(config.messageCacheSize ?? 1000)
    return Number.isSafeInteger(limit) && limit >= 0 ? limit : 1000
  }

  trimHistory(store) {
    const limit = this.historyLimit()
    while (store.size > limit) store.delete(store.keys().next().value)
    return store
  }

  async getMessageMap(id) {
    return this.trimHistory(await getMap(`${this.path}${id}/Message`))
  }

  historyStore(id) {
    const bot = Bot[id]
    if (!bot) throw new Error(`QQBot 账号不存在：${id}`)
    return this.trimHistory(bot.messageCache ??= new Map())
  }

  historyPeer(id, target) {
    return plainId(target, id, this.sep)
  }

  cacheMessage(data) {
    if (!data.message_id || data.sub_type === "callback") return
    if (data.bot.stat) data.bot.stat.recv_msg_cnt = (data.bot.stat.recv_msg_cnt || 0) + 1
    const store = this.historyStore(data.self_id)
    if (!this.historyLimit()) return
    const snapshot = {}
    for (const key of ["self_id", "post_type", "message_type", "sub_type", "message_id", "seq", "rand",
      "time", "sender", "user_id", "group_id", "group_name", "target_id", "message", "source", "raw_message", "_at"])
      if (data[key] !== undefined) snapshot[key] = data[key]
    // 频道回复还需要原始频道/会话上下文，但不保留 SDK 的对象和函数。
    snapshot.raw = { message_type: data.raw?.message_type }
    for (const key of ["guild_id", "channel_id", "src_guild_id", "src_channel_id"])
      if (data.raw?.[key] !== undefined) snapshot[key] = data.raw[key]
    const peer = this.historyPeer(data.self_id, data.group_id ?? data.user_id)
    const key = JSON.stringify([data.message_type, peer, String(data.message_id)])
    store.set(key, copy(snapshot))
    this.trimHistory(store)
  }

  restoreMessage(id, snapshot) {
    const data = { ...copy(snapshot), bot: Bot[id] }
    data.reply = (msg, quote, extra) => {
      const context = { ...data, replyExtra: extra,
        user_id: this.historyPeer(id, data.user_id).replace(/^qg_/, ""),
        group_id: this.historyPeer(id, data.group_id) }
      if (data.raw?.message_type === "guild") return this.sendGuildMsg(context, msg)
      if (data.sub_type === "direct") return this.sendDirectMsg(context, msg)
      if (data.message_type === "group") return this.sendGroupMsg(context, msg)
      return this.sendFriendMsg(context, msg)
    }
    const e = buildMiaoEvent(data)
    if (snapshot.seq !== undefined) e.seq = snapshot.seq
    if (snapshot.rand !== undefined) e.rand = snapshot.rand
    return e
  }

  matchingHistory(id, type, target) {
    const peer = this.historyPeer(id, target)
    return [...this.historyStore(id).values()].filter(item => item.message_type === type &&
      this.historyPeer(id, item.group_id ?? item.user_id) === peer)
  }

  messageSource(id, type, target, source) {
    if (!source) return source
    const record = source.message_id && this.matchingHistory(id, type, target)
      .findLast(item => String(item.message_id) === String(source.message_id))
    if (!record) return { ...source }
    return { ...source, user_id: this.historyPeer(id, record.user_id), time: record.time,
      ...(record.seq !== undefined ? { seq: record.seq } : {}),
      ...(record.rand !== undefined ? { rand: record.rand } : {}),
      message: copy(record.message), raw_message: record.raw_message }
  }

  async contactFileUrl(id, type, target, fid, currentMessage = []) {
    for (const message of [currentMessage, ...this.matchingHistory(id, type, target).reverse().map(item => item.message)]) {
      try { return receivedFileUrl(message, fid) } catch {}
    }
    throw new Error("QQBot 本会话已接收消息中未提供该文件的下载地址")
  }

  async contactMessage(id, type, target, value) {
    const mid = messageId(value)
    const record = this.matchingHistory(id, type, target).findLast(item => String(item.message_id) === String(mid))
    if (!record) throw new Error(`QQBot 消息未缓存或已过期：${mid}`)
    return this.restoreMessage(id, record)
  }

  async getMsg(id, value) {
    const mid = messageId(value)
    const record = [...this.historyStore(id).values()].findLast(item => String(item.message_id) === String(mid))
    if (!record) throw new Error(`QQBot 消息未缓存或已过期：${mid}`)
    return this.restoreMessage(id, record)
  }

  async contactHistory(id, type, target, cursor = 0, count = 20) {
    const size = Number(count)
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("历史消息数量须为非负整数")
    if (!size) return []
    const records = this.matchingHistory(id, type, target)
    const anchor = messageId(cursor)
    const latest = anchor === undefined || anchor === null || anchor === "" || anchor === 0 || anchor === "0"
    let end = latest ? records.length - 1 : records.findLastIndex(item =>
      String(item.message_id) === String(anchor) || item.seq !== undefined && String(item.seq) === String(anchor))
    // icqq 私聊历史以真实接收时间为游标；群消息不将数字索引伪装成平台序号。
    if (end < 0 && type === "private" && Number.isFinite(Number(anchor)))
      end = records.findLastIndex(item => Number.isFinite(item.time) && item.time <= Number(anchor))
    if (end < 0) return []
    return records.slice(Math.max(0, end + 1 - size), end + 1).map(item => this.restoreMessage(id, item))
  }

  async getChatHistory(id, value, count = 20) {
    const message = await this.getMsg(id, value)
    return this.contactHistory(id, message.message_type, message.group_id ?? message.user_id, message.message_id, count)
  }
}
