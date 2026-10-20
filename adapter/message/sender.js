import { config, CFG_FILE } from "../../lib/utils/cfg.js"
import { adaptSendableForSDK } from "../sdk.js"
import {
  expandForwardNodes,
  isActiveMsgDenied,
  isMarkdownDenied,
  isPassiveReplyLimit,
  needsMarkdown,
  normalizeForwardNodes,
  sendModeOf,
  toPlainMsg,
  toSegment,
  toStr,
} from "../../lib/utils/message.js"
import { fileToUrl } from "../../lib/utils/file-upload.js"
import { sharp } from "../../lib/utils/files.js"
import { qblog } from "../../lib/utils/logger.js"
import MessageTransport from "./transport.js"
import { sentResult } from "../compat.js"

function hasSegment(messages, type) {
  return messages.some(message => Array.isArray(message) && message.some(segment => segment?.type === type))
}

export default class MessageSender extends MessageTransport {
  async trackSend(data, pending) {
    const result = await pending
    if (data.bot.stat && result?.data?.length)
      data.bot.stat.sent_msg_cnt = (data.bot.stat.sent_msg_cnt || 0) + result.data.length
    return result
  }

  activeMsgMode(data) {
    if (data?.message_type !== "group" || data.sub_type === "callback" || !data.group_id)
      return config.activeMsg

    const prefix = `${data.self_id}${this.sep}`
    const groupId = String(data.group_id).startsWith(prefix)
      ? String(data.group_id).slice(prefix.length)
      : String(data.group_id)
    const mode = config.activeMsgGroups?.[`${data.self_id}:${groupId}`]
    if (mode === true || mode === "true") return true
    if (mode === false || mode === "false") return false
    return config.activeMsg
  }

  useReply(data) {
    if (data.active) return false
    if (!data.message_id) return false
    if (data.sub_type === "callback") return true
    const mode = this.activeMsgMode(data)
    if (mode === true) return false
    if (mode !== false && this.replyBlocked(data.self_id)) return false
    return true
  }

  /** 该账号是否处于「被动回复被拒后」的临时降级期（5 分钟，过期自动恢复引用回复） */
  replyBlocked(id) {
    const until = this.noReply?.[id]
    if (!until) return false
    if (Date.now() < until) return true
    delete this.noReply[id]
    return false
  }

  /** 被动回复被 QQ 拒绝：短时间内改用主动消息，5 分钟后自动恢复引用回复 */
  markNoReply(id, reason) {
    if (this.activeMsgMode({ self_id: id }) === false) return
    if (!this.noReply) this.noReply = {}
    if (this.replyBlocked(id)) return
    this.noReply[id] = Date.now() + 5 * 60 * 1000
    qblog.warn(
      `[${id}] ${reason}，5 分钟内改用主动消息`,
      `该状态到期会自动恢复引用回复；如想始终用引用回复，可设置 ${CFG_FILE}: activeMsg: false`,
    )
  }

  /**
   * 把 reply 第 3 个参数里的 QQ 官方扩展并入消息
   * （keyboard 旧客户端键盘 / button / markdown）
   */
  appendReplyExtra(msg, extra) {
    if (!extra || typeof extra !== "object") return msg
    const list = Array.isArray(msg) ? [...msg] : [msg]
    if (extra.keyboard) list.push({ type: "keyboard", ...extra.keyboard })
    if (extra.button) list.push({ type: "button", data: extra.button })
    if (extra.markdown) list.push({ type: "markdown", ...extra.markdown })
    return list
  }

  /** 纯文本 / 富媒体构建（含 replyExtra，剥掉 markdown 段） */
  async buildPlainMsgs(data, msg) {
    return await this.makeMsg(data, toPlainMsg(this.appendReplyExtra(msg, data.replyExtra)))
  }

  /** 按配置构建待发送的消息体 */
  async buildMsgs(data, msg) {
    msg = this.appendReplyExtra(msg, data.replyExtra)
    const mode = sendModeOf(data.self_id)
    /**
     * text：始终普通消息（连显式 markdown 段也不走 markdown）
     * auto：只有显式 markdown / 按钮 才值得用 markdown，其余一律普通消息（硬拆）
     */
    if (mode === "text" || (mode === "auto" && !needsMarkdown(msg)))
      return await this.makeMsg(data, msg)

    const msgs = await this.buildMarkdownMsgs(data, msg, config.markdown[data.self_id])
    /** 构建器返回 null：消息里有无法内嵌的图片，整条改用普通（富媒体）消息 */
    return msgs === null ? await this.makeMsg(data, toPlainMsg(msg)) : msgs
  }

  async buildMarkdownMsgs(data, msg, mode) {
    if (!mode || mode === "raw") return await this.makeRawMarkdownMsg(data, msg, true)
    if (mode === "inline") return await this.makeRawMarkdownMsg(data, msg)
    if (mode === "legacy") return null
    return await this.makeMarkdownMsg(data, msg)
  }

  /** 没有申请按钮交互事件时，提前提示回调按钮为什么无法使用。 */
  checkInteractionButtons(data, msg) {
    const id = data?.self_id
    if (!id || this.interactionWarned?.[id]) return

    const active = this.activeIntents?.[id] || Bot[id]?.info?.intents
    if (Array.isArray(active) && active.includes("INTERACTION")) return

    /** keyboard 既可能在消息段里，也可能由 reply 的第 3 个参数（replyExtra）带进来 */
    const hasCallback = this.hasCallbackButton(msg) || this.hasCallbackButton(data.replyExtra)
    if (!hasCallback) return

    this.interactionWarned[id] = true
    qblog.warn(
      `[${id}] 本条消息带「回调按钮」(keyboard.action.type=1)，但当前连接没有 INTERACTION intent（按钮交互）。`,
      "用户点击（若有二次确认，则在确认之后）会提示“请求第三方失败”，机器人也收不到 INTERACTION_CREATE。",
      "解决：到 QQ 开放平台为该机器人开启「消息按钮/按钮交互」能力，重启后本插件会自动申请 INTERACTION；" +
        `也可在 ${CFG_FILE} 的 intents 里显式写上 INTERACTION。`,
      "若只想让按钮变成“发消息”，可把按钮改成 action.type=2（指令按钮）。",
    )
  }

  /** 递归找 keyboard 里的 action.type=1 按钮（兼容 QQ 官方 keyboard 与 miao 的 button 段） */
  hasCallbackButton(msg) {
    const hit = node => {
      if (!node || typeof node !== "object") return false
      if (Array.isArray(node)) return node.some(hit)

      if (node.action && Number(node.action.type) === 1) return true

      for (const key of ["keyboard", "content", "rows", "buttons", "data", "message", "button"])
        if (node[key] && node[key] !== node && hit(node[key])) return true
      return false
    }
    return hit(msg)
  }

  appendSendResult(result, sent) {
    for (const item of [sent].flat(Infinity)) {
      result.data.push(item)
      if (item?.id) result.message_id.push(item.id)
    }
  }

  /** 一旦有消息发出，就保留真实结果；后续失败不能整批重发。 */
  async sendBatches(data, messages, send, result) {
    if (result.partial) return false
    for (const message of messages) {
      try {
        qblog.debug(`[${data.self_id}] 发送消息`, message)
        const sent = await this.sendBatch(data, message, send)
        qblog.debug(`[${data.self_id}] 发送消息返回`, sent)
        this.appendSendResult(result, sent)
      } catch (error) {
        if (Array.isArray(error?.qqbotSent)) this.appendSendResult(result, error.qqbotSent)
        if (result.data.length) result.partial = true
        qblog.error(`[${data.self_id}] 发送消息错误`, message, error)
        result.error.push(error)
        return false
      }
    }
    return true
  }

  /** 群、单聊和频道共用发送顺序，消息构建仍使用各自的规则。 */
  async sendWithFallback(data, send, msg, guild = false) {
    const result = { message_id: [], data: [], error: [] }
    const build = plain => {
      if (guild) return this.makeGuildMsg(data, plain ? toPlainMsg(msg) : msg)
      return plain ? this.buildPlainMsgs(data, msg) : this.buildMsgs(data, msg)
    }
    let messages = await build(false)
    // 构建后才会展开 replyExtra 和 miao 的 button 段。
    if (!guild) this.checkInteractionButtons(data, messages ?? msg)
    if (await this.sendBatches(data, messages, send, result)) return result
    if (result.partial) return result

    // Markdown 无权限或审核失败时，改发普通消息。
    if (result.error.some(isMarkdownDenied) && hasSegment(messages, "markdown")) {
      messages = await build(true)
      if (await this.sendBatches(data, messages, send, result)) return result
    }

    // 群回调必须保留引用；其他消息在被动回复超限后尝试主动发送。
    if (
      (guild || data.sub_type !== "callback") &&
      result.error.some(isPassiveReplyLimit) &&
      this.activeMsgMode(data) !== false
    ) {
      const blocked = this.replyBlocked(data.self_id)
      this.markNoReply(
        data.self_id,
        guild ? "频道被动回复超出时间/次数限制" : "被动回复超出时间/次数限制（40034128）",
      )
      if (!blocked) {
        messages = await build(false)
        if (await this.sendBatches(data, messages, send, result)) return result
      }
    }

    // 没有主动推送权限时，尝试恢复带引用的被动回复。
    if (result.error.some(isActiveMsgDenied) && !hasSegment(messages, "reply") && this.useReply(data)) {
      messages = await build(false)
      if (await this.sendBatches(data, messages, send, result)) return result
    }

    // 文件不能作为普通文本再次投递；频道文件已在构建时转为链接。
    if (!guild && hasSegment(messages, "file")) return result
    messages = await build(true)
    await this.sendBatches(data, messages, send, result)
    return result
  }

  async sendMsg(data, send, msg) {
    const result = await this.sendWithFallback(data, send, msg)
    if (Array.isArray(data._ret_id)) data._ret_id.push(...result.message_id)
    return sentResult(result)
  }

  /** active: true 表示主动推送（不带 msg_id），不属于回复；普通回复不要传 */
  sendFriendMsg(data, msg, active = false) {
    data = {
      ...data,
      ...(active ? { active: true } : {}),
      _mediaTarget: { target_type: "user", target_id: data.user_id },
    }
    const send = message => data.bot.sdk.sendPrivateMessage(data.user_id, adaptSendableForSDK(message))
    return this.trackSend(data, this.sendMsg(data, send, msg))
  }

  sendGroupMsg(data, msg, active = false) {
    data = {
      ...data,
      ...(active ? { active: true } : {}),
      _mediaTarget: { target_type: "group", target_id: data.group_id },
    }
    const send = message => data.bot.sdk.sendGroupMessage(data.group_id, adaptSendableForSDK(message))
    return this.trackSend(data, this.sendMsg(data, send, msg))
  }

  async makeGuildMsg(data, msg) {
    msg = this.dedupeAt(data, msg)
    const messages = []
    let message = [],
      reply

    /** 合并转发：内容并入本条消息，避免拆成一堆消息刷屏 */
    msg = expandForwardNodes(normalizeForwardNodes(msg))

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      /** Buffer / Uint8Array 按图片处理（icqq 同样行为），必须在展开前判断 */
      i = toSegment(i)
      if (!i) continue

      switch (i.type) {
        case "at": {
          const atId = this.atTargetId(i, data)
          if (!atId) continue
          i.user_id = atId
          break
        }
        case "text":
        case "face":
        case "ark":
        case "embed":
          break
        case "image":
          if (sharp && i.file) i.file = await this.compressImage(data, i.file)

          message.push(i)
          messages.push(message)
          message = []
          continue
        case "record":
        case "video":
        case "file":
          if (i.file) i.file = await fileToUrl(i.file, i)
          i = { type: "text", text: `文件：${i.file}` }
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (i.data && typeof i.data === "object") i = { type: "markdown", ...i.data }
          else i = { type: "markdown", content: i.data ?? i.content ?? "" }
          break
        case "button":
          continue
        case "keyboard":
          /** QQ 官方消息键盘：原样交给 SDK */
          break
        case "raw":
          if (Array.isArray(i.data)) {
            messages.push(i.data)
            continue
          }
          i = i.data
          break
        default:
          i = { type: "text", text: toStr(i) }
      }

      if (i.type === "text" && i.text) {
        const match = i.text.match(this.toQRCodeRegExp)
        if (match)
          for (const url of match) {
            const msg = segment.image(await this.makeQRCode(url))
            message.push(msg)
            messages.push(message)
            message = []
            i.text = i.text.replace(url, "[链接(请扫码查看)]")
          }
      }

      message.push(i)
    }

    if (message.length) messages.push(message)
    if (!reply && this.useReply(data)) reply = { type: "reply", id: data.message_id }
    if (reply)
      for (const i of messages)
        i.unshift(
          reply.id?.startsWith?.("event_")
            ? { type: "reply", event_id: reply.id.replace(/^event_/, "") }
            : reply,
        )
    return messages
  }

  async sendGMsg(data, send, msg) {
    return sentResult(await this.sendWithFallback(data, send, msg, true))
  }

  async sendDirectMsg(data, msg) {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        qblog.error(`[${data.self_id}] 发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg)
        return false
      }
      const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
      data.guild_id = dms.guild_id
      data.channel_id = dms.channel_id
      data.bot.fl.set(`qg_${data.user_id}`, {
        ...data.bot.fl.get(`qg_${data.user_id}`),
        ...dms,
      })
    }
    const send = message => data.bot.sdk.sendDirectMessage(data.guild_id, adaptSendableForSDK(message))
    return this.trackSend(data, this.sendGMsg(data, send, msg))
  }

  sendGuildMsg(data, msg) {
    const send = message => data.bot.sdk.sendGuildMessage(data.channel_id, adaptSendableForSDK(message))
    return this.trackSend(data, this.sendGMsg(data, send, msg))
  }

  async recallMsg(data, recall, message_id) {
    const supplied = message_id?.message_ids ?? message_id?.message_id ?? message_id
    const multiple = Array.isArray(supplied)
    message_id = multiple ? supplied : [supplied]
    const msgs = []
    for (const i of message_id)
      try {
        msgs.push(await recall(i))
      } catch (err) {
        qblog.debug(`[${data.self_id}] 撤回消息错误`, i, err)
        msgs.push(false)
      }
    return multiple ? msgs : Boolean(msgs[0])
  }

  recallFriendMsg(data, message_id) {
    qblog.info(`[${data.self_id}] 撤回好友消息：[${data.user_id}] ${message_id}`)
    return this.recallMsg(data, i => data.bot.sdk.user(data.user_id).recall(i), message_id)
  }

  recallGroupMsg(data, message_id) {
    qblog.info(`[${data.self_id}] 撤回群消息：[${data.group_id}] ${message_id}`)
    return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
  }

  recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
    qblog.info(`[${data.self_id}] 撤回${hide ? "并隐藏" : ""}频道私聊消息：[${data.guild_id}] ${message_id}`)
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide),
      message_id,
    )
  }

  recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
    qblog.info(`[${data.self_id}] 撤回${hide ? "并隐藏" : ""}频道消息：[${data.channel_id}] ${message_id}`)
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide),
      message_id,
    )
  }
}
