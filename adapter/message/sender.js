import { config, CFG_FILE } from "../../lib/utils/cfg.js"
import { adaptSendableForSDK } from "../sdk.js"
import {
  expandForwardNodes,
  fileToUrl,
  isActiveMsgDenied,
  isMarkdownDenied,
  isPassiveReplyLimit,
  log,
  needsMarkdown,
  normalizeForwardNodes,
  sendModeOf,
  sharp,
  toPlainMsg,
  toSegment,
  toStr,
} from "../../lib/utils/common.js"
import MessageTransport from "./transport.js"

export default class MessageSender extends MessageTransport {
  useReply(data) {
    if (data.active) return false
    if (!data.message_id) return false
    if (data.sub_type === "callback") return true
    if (config.activeMsg === true) return false
    if (this.replyBlocked(data.self_id)) return false
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
    if (config.activeMsg === false) return
    if (!this.noReply) this.noReply = {}
    if (this.replyBlocked(id)) return
    this.noReply[id] = Date.now() + 5 * 60 * 1000
    log(
      "warn",
      [
        `${reason}，5 分钟内改用主动消息`,
        `该状态到期会自动恢复引用回复；如想始终用引用回复，可设置 ${CFG_FILE}: activeMsg: false`,
      ],
      id,
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

  /** 富媒体直传的目标（群 / 单聊），其它场景返回 null 交给 SDK */
  checkInteractionButtons(data, msg) {
    const id = data?.self_id
    if (!id || this.interactionWarned?.[id]) return

    const active = this.activeIntents?.[id] || Bot[id]?.info?.intents
    if (Array.isArray(active) && active.includes("INTERACTION")) return

    /** keyboard 既可能在消息段里，也可能由 reply 的第 3 个参数（replyExtra）带进来 */
    const hasCallback = this.hasCallbackButton(msg) || this.hasCallbackButton(data.replyExtra)
    if (!hasCallback) return

    this.interactionWarned[id] = true
    log(
      "warn",
      [
        "本条消息带「回调按钮」(keyboard.action.type=1)，但当前连接没有 INTERACTION intent（按钮交互）。",
        "用户点击（若有二次确认，则在确认之后）会提示“请求第三方失败”，机器人也收不到 INTERACTION_CREATE。",
        "解决：到 QQ 开放平台为该机器人开启「消息按钮/按钮交互」能力，重启后本插件会自动申请 INTERACTION；" +
          `也可在 ${CFG_FILE} 的 intents 里显式写上 INTERACTION。`,
        "若只想让按钮变成“发消息”，可把按钮改成 action.type=2（指令按钮）。",
      ],
      id,
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

  async sendMsg(data, send, msg) {
    const rets = { message_id: [], data: [], error: [] }
    let msgs = await this.buildMsgs(data, msg)
    /** 构建后的消息里才有展开的 keyboard/button（replyExtra、miao button 段都在这一步落地） */
    this.checkInteractionButtons(data, msgs ?? msg)
    let passiveLimited = false
    let activeDenied = false
    let markdownDenied = false

    const sendAll = async () => {
      for (const i of msgs)
        try {
          log("debug", ["发送消息", i], data.self_id)
          const ret = await this.sendBatch(data, i, send)
          log("debug", ["发送消息返回", ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) rets.message_id.push(ret.id)
        } catch (err) {
          log("error", ["发送消息错误", i, err], data.self_id)
          rets.error.push(err)
          if (isPassiveReplyLimit(err)) passiveLimited = true
          if (isActiveMsgDenied(err)) activeDenied = true
          if (isMarkdownDenied(err)) markdownDenied = true
          return false
        }
      return true
    }

    if ((await sendAll()) === false) {
      /** markdown 被平台拒绝（无权限 / 参数错 / 审核）：剥成纯文本重发，重试 markdown 没有意义 */
      if (markdownDenied && msgs.some(i => Array.isArray(i) && i.some(s => s?.type === "markdown"))) {
        msgs = await this.buildPlainMsgs(data, msg)
        if (await sendAll()) {
          if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
          return rets
        }
      }
      /** 被动回复被拒 → 去掉引用改用主动消息重发；成功即说明本账号有主动推送权限 */
      if (data.sub_type !== "callback" && passiveLimited && config.activeMsg !== false) {
        const blocked = this.replyBlocked(data.self_id)
        this.markNoReply(data.self_id, "被动回复超出时间/次数限制（40034128）")
        if (!blocked) {
          msgs = await this.buildMsgs(data, msg)
          if (await sendAll()) {
            if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
            return rets
          }
        }
      }
      /** 反方向兜底：账号没有主动推送权限时，主动消息必然 40034105，改回带引用的被动回复再试一次 */
      if (activeDenied && !msgs.some(i => i.some(s => s?.type === "reply")) && this.useReply(data)) {
        msgs = await this.buildMsgs(data, msg)
        if (await sendAll()) {
          if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
          return rets
        }
      }
      if (msgs.some(i => i.some(s => s?.type === "file"))) {
        if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
        return rets
      }
      msgs = await this.buildPlainMsgs(data, msg)
      await sendAll()
    }

    if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
    return rets
  }

  /** active: true 表示主动推送（不带 msg_id），不属于回复；普通回复不要传 */
  sendFriendMsg(data, msg, active = false) {
    data = {
      ...data,
      ...(active ? { active: true } : {}),
      _mediaTarget: { target_type: "user", target_id: data.user_id },
    }
    return this.sendMsg(data, msg => data.bot.sdk.sendPrivateMessage(data.user_id, adaptSendableForSDK(msg)), msg)
  }

  sendGroupMsg(data, msg, active = false) {
    data = {
      ...data,
      ...(active ? { active: true } : {}),
      _mediaTarget: { target_type: "group", target_id: data.group_id },
    }
    return this.sendMsg(data, msg => data.bot.sdk.sendGroupMessage(data.group_id, adaptSendableForSDK(msg)), msg)
  }

  async makeGuildMsg(data, msg, nested) {
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
    const rets = { message_id: [], data: [], error: [] }
    let msgs = await this.makeGuildMsg(data, msg)
    let passiveLimited = false
    let activeDenied = false
    let markdownDenied = false

    const sendAll = async () => {
      for (const i of msgs)
        try {
          log("debug", ["发送消息", i], data.self_id)
          const ret = await this.sendBatch(data, i, send)
          log("debug", ["发送消息返回", ret], data.self_id)

          rets.data.push(ret)
          if (ret.id) rets.message_id.push(ret.id)
        } catch (err) {
          log("error", ["发送消息错误", i, err], data.self_id)
          rets.error.push(err)
          if (isPassiveReplyLimit(err)) passiveLimited = true
          if (isActiveMsgDenied(err)) activeDenied = true
          if (isMarkdownDenied(err)) markdownDenied = true
          return false
        }
      return true
    }

    if ((await sendAll()) === false) {
      /** markdown 被平台拒绝：剥成纯文本重发 */
      if (markdownDenied && msgs.some(i => Array.isArray(i) && i.some(s => s?.type === "markdown"))) {
        msgs = await this.makeGuildMsg(data, toPlainMsg(msg))
        if (await sendAll()) return rets
      }
      if (passiveLimited && config.activeMsg !== false) {
        const blocked = this.replyBlocked(data.self_id)
        this.markNoReply(data.self_id, "频道被动回复超出时间/次数限制")
        if (!blocked) {
          msgs = await this.makeGuildMsg(data, msg)
          if (await sendAll()) return rets
        }
      }
      /** 反方向兜底：没有主动消息权限时改回带引用的被动回复再试一次 */
      if (activeDenied && !msgs.some(i => i.some(s => s?.type === "reply")) && this.useReply(data)) {
        msgs = await this.makeGuildMsg(data, msg)
        if (await sendAll()) return rets
      }
      msgs = await this.makeGuildMsg(data, toPlainMsg(msg))
      await sendAll()
    }
    return rets
  }

  async sendDirectMsg(data, msg) {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        log(
          "error",
          [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg],
          data.self_id,
        )
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
    return this.sendGMsg(data, msg => data.bot.sdk.sendDirectMessage(data.guild_id, adaptSendableForSDK(msg)), msg)
  }

  sendGuildMsg(data, msg) {
    return this.sendGMsg(data, msg => data.bot.sdk.sendGuildMessage(data.channel_id, adaptSendableForSDK(msg)), msg)
  }

  async recallMsg(data, recall, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      try {
        msgs.push(await recall(i))
      } catch (err) {
        log("debug", ["撤回消息错误", i, err], data.self_id)
        msgs.push(false)
      }
    return msgs
  }

  recallFriendMsg(data, message_id) {
    log("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.user(data.user_id).recall(i), message_id)
  }

  recallGroupMsg(data, message_id) {
    log("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
    return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
  }

  recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
    log(
      "info",
      `撤回${hide ? "并隐藏" : ""}频道私聊消息：[${data.guild_id}] ${message_id}`,
      data.self_id,
    )
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide),
      message_id,
    )
  }

  recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
    log(
      "info",
      `撤回${hide ? "并隐藏" : ""}频道消息：[${data.channel_id}] ${message_id}`,
      data.self_id,
    )
    return this.recallMsg(
      data,
      i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide),
      message_id,
    )
  }

  /**
   * 供 miao 的 common.makeForwardMsg 及插件使用
   *
   * QQ 官方机器人接口没有合并转发能力：这里返回适配器可识别的 node 段，
   * 发送时会把转发内容并成一条消息，并以引用回复（引用触发消息）的形式发出。
   */

}
