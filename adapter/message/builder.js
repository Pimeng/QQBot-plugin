import { config } from "../../lib/utils/cfg.js"
import {
  expandForwardNodes,
  log,
  normalizeForwardNodes,
  sharp,
  toBuffer,
  toSegment,
  toStr,
} from "../../lib/utils/common.js"
import MessageMedia from "./media.js"

export default class MessageBuilder extends MessageMedia {
  atTargetId(seg, data) {
    const prefix = data ? `${data.self_id}${this.sep}` : ""
    for (const raw of [seg?.qq, seg?.id, seg?.user_id]) {
      if (raw === undefined || raw === null || raw === "") continue
      const id = String(raw).replace(prefix, "").replace(/^qg_/, "")
      if (!id || id === "0") continue
      return id
    }
    return ""
  }

  /**
   * 当前消息发送者的 openid（已剥掉实例前缀与 `qg_` 前缀）
   *
   * 用于判断「reply 引用的就是发言人本人」，这种情况不需要再补一个 @。
   */
  plainSenderId(data) {
    const prefix = data ? `${data.self_id}${this.sep}` : ""
    const raw = data?.sender?.user_id ?? data?.user_id ?? ""
    return String(raw).replace(prefix, "").replace(/^qg_/, "")
  }

  /**
   * 普通消息里 @ 的可见名字
   *
   * 群/单聊的纯文本 content 不支持 @ 标签，只能退化成「@昵称」。查找顺序：
   *   1. at 段自带的名字（`segment.at(qq, name)`）
   *   2. 如果是发消息的人本人 → 直接用 sender 的群名片/昵称
   *   3. 群成员缓存 gml（键是「实例前缀 + 群 openid」，而 data.group_id 可能是裸 openid，两种都试）
   *   4. 好友缓存 fl
   *   5. 兜底「用户」
   */
  atDisplayName(data, atId, seg) {
    const inline = seg?.text || seg?.name || seg?.nickname
    if (inline && String(inline).trim()) return String(inline).trim()

    const prefix = `${data?.self_id ?? ""}${this.sep}`
    const strip = value =>
      String(value ?? "")
        .replace(prefix, "")
        .replace(/^qg_/, "")
    const pick = info => {
      const name = info?.card || info?.nickname || info?.name
      return name && String(name).trim() ? String(name).trim() : ""
    }

    try {
      const bot = data?.bot

      /** 2) @ 的就是发言人本人 */
      const sender = data?.sender
      if (sender && strip(sender.user_id) === atId) {
        const name = pick(sender)
        if (name) return name
      }

      const memberKeys = [`${prefix}${atId}`, atId]
      /** 3) 群成员缓存（群 key 两种写法都试） */
      for (const groupKey of [...new Set([data.group_id, `${prefix}${strip(data.group_id)}`])]) {
        const members = bot?.gml?.get?.(groupKey)
        if (!members) continue
        for (const key of memberKeys) {
          const name = pick(members.get?.(key))
          if (name) return name
        }
      }

      /** 4) 好友缓存 */
      for (const key of memberKeys) {
        const name = pick(bot?.fl?.get?.(key))
        if (name) return name
      }
    } catch (err) {}
    return "用户"
  }

  /**
   * 把 at 段渲染成普通消息里的可见文本
   *
   * 群/单聊的纯文本 content 没有 @ 标签，只能退化成 `@昵称`；
   * 拿不到目标就返回空串，调用方跳过该段。
   */
  atToText(data, seg) {
    if (seg?.qq === "all" || seg?.id === "all" || seg?.user_id === "all") return "@全体成员"
    const atId = this.atTargetId(seg, data)
    if (!atId) return ""
    return `@${this.atDisplayName(data, atId, seg)}`
  }

  /**
   * 该段是否有可见内容（纯空白不算）
   *
   * 用来判断两个 @ 之间是不是只隔着空白，见 dedupeAt。
   */
  isVisibleSegment(item) {
    if (item === undefined || item === null) return false
    if (typeof item === "string") return Boolean(item.trim())
    if (typeof item !== "object") return true
    if (item.type === "text") return Boolean(String(item.text ?? "").trim())
    if (item.type === "markdown") {
      /** 与 toPlainMsg 一致：兼容 {data:{params:[…]}} 的 QQ 原始 markdown 对象 */
      const params = Array.isArray(item.data?.params) ? item.data.params : []
      const content =
        item.data && typeof item.data === "object"
          ? (item.data.content ?? params.flatMap(param => param?.values || []).join(" "))
          : (item.content ?? item.data ?? "")
      /** 去掉空白与 markdown 语法符号后还有字，才算可见 */
      return Boolean(String(content).replace(/[\s>#*_~`|+-]/g, ""))
    }
    return true
  }

  /**
   * 去掉核心补的重复 at 段
   *
   * 很常见：插件自己发了 `segment.at(e.user_id)`，同时 reply 又带了 `{ at: true }`，
   * miao 核心会 `msg.unshift(segment.at(at, text), "\n")` 再补一个 at；两段目标相同，
   * 但一个带群名片、一个没有，渲染出来就变成「@群名片 @昵称」两个 @。
   *
   * 但**只有中间没有隔着真正内容**时才去重：
   * 插件明确写了两遍同一个人（如「@A 埋下了 14 号薯片」「@A 吃了 19 号薯片」），
   * 那是它有意为之，一旦把后面那段的 at 吃掉，插件写在它前后的
   * 「、」「（埋雷者：）」就会孤零零地留下来，变成莫名其妙的顿号。
   */
  dedupeAt(data, msg) {
    /** 已经出现过、且其后还没出现可见内容的 at；只有这种才算核心补的重复 */
    const recent = new Set()
    const out = []
    for (const item of Array.isArray(msg) ? msg : [msg]) {
      if (item && typeof item === "object" && item.type === "at") {
        const id = this.atTargetId(item, data)
        const key = id || `raw:${item.qq ?? item.id ?? item.user_id}`
        if (recent.has(key)) continue
        recent.add(key)
      } else if (this.isVisibleSegment(item)) {
        /** 中间已经隔了真正的内容，之后的同名 @ 是插件有意重复，不再算重复 */
        recent.clear()
      }
      out.push(item)
    }
    return out
  }

  /**
   * 把合并转发（node）渲染成 markdown 块引用
   *
   * QQ 官方接口没有合并转发能力，而官方 markdown 支持 `>` 块引用语法，
   * 因此这里把转发内容按行加 "> " 前缀，多个节点之间用空引用行（>）分隔。
   */
  async makeForwardQuote(data, nodes) {
    const blocks = []
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
      if (!node) continue
      const parts = []
      const list = Array.isArray(node.message) ? node.message : [node.message]
      for (let i of list) {
        /** Buffer / Uint8Array 按图片处理，必须在展开前判断 */
        i = toSegment(i)
        if (!i) continue
        switch (i.type) {
          case "text":
            parts.push(await this.makeRawMarkdownText(data, i.text ?? ""))
            break
          case "image": {
            const { des, url, inline } = await this.makeMarkdownImage(data, i.file, i.summary)
            if (inline) parts.push(`${des}${url}`)
            break
          }
          case "at": {
            if (i.qq === "all" || i.user_id === "all" || i.id === "all")
              parts.push("<qqbot-at-everyone />")
            else {
              const atId = this.atTargetId(i, data)
              if (atId) parts.push(`<qqbot-at-user id="${atId}" />`)
            }
            break
          }
          case "face":
          case "record":
          case "video":
          case "file":
          case "node":
          case "raw":
          case "markdown":
          case "button":
          case "reply":
            break
          default:
            parts.push(await this.makeRawMarkdownText(data, toStr(i)))
        }
      }
      const text = parts.join("").trim()
      if (text) blocks.push(text)
    }

    return blocks
      .map(block =>
        block
          .split("\n")
          .map(line => `> ${line}`.trimEnd())
          .join("\n"),
      )
      .join("\n>\n")
  }

  async compressImage(data, file) {
    try {
      const size = config.imageLength * 1024 * 1024
      const buffer = await toBuffer(file, { http: true })

      if (!Buffer.isBuffer(buffer)) return file

      if (buffer.length <= size) return buffer

      let quality = 105,
        output
      do {
        quality -= 10
        output = await sharp(buffer).jpeg({ quality }).toBuffer()
        log(
          "debug",
          `图片压缩完成 ${quality}%(${(output.length / 1024).toFixed(2)}KB)`,
          data.self_id,
        )
      } while (output.length > size && quality > 10)

      return output
    } catch (err) {
      log("error", ["图片压缩错误", err], data.self_id)
      return file
    }
  }

  async makeMsg(data, msg, nested) {
    msg = this.dedupeAt(data, msg)
    const messages = [],
      button = []
    let message = [],
      reply,
      /** 被当作「引用已有 @」丢掉的 at 文本，用于整条消息只剩它时兜底 */
      droppedAtText = ""

    /** 合并转发：内容并入本条消息，避免拆成一堆消息刷屏 */
    msg = expandForwardNodes(normalizeForwardNodes(msg))

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      /** Buffer / Uint8Array 按图片处理（icqq 同样行为），必须在展开前判断 */
      i = toSegment(i)
      if (!i) continue

      switch (i.type) {
        case "at": {
          /**
           * 普通（含富媒体 caption）消息的 content 不支持 @ 标签：
           * QQ 只在 markdown 里认 `<qqbot-at-user>`，SDK 塞的 `<@openid>` 会被客户端
           * 原样显示成文本。所以这里渲染成可见的「@昵称」；
           * 想要真 @ 请用 markdown 模式。
           *
           * 但被动回复（引用）本身就会显示「回复 @对方」，此时再写一遍 @昵称 就是多余的，
           * 直接丢掉（这就是「前面 QQ 的 @ 有用、后面我们补的 @ 无用」的那一个）。
           */
          const atId = this.atTargetId(i, data)
          if (!atId) continue
          if (this.useReply(data) && atId === this.plainSenderId(data)) {
            /** 整条消息只有这个 at 时不能让消息变空，末尾会兜底补回来 */
            droppedAtText ||= this.atToText(data, i)
            continue
          }

          const atText = this.atToText(data, i)
          if (!atText) continue
          /** _atText 标记：sendBatch 用它判断「这批非媒体部分是否只有 @」 */
          i = { type: "text", text: atText, _atText: true }
          break
        }
        case "text":
          if (!i.text || !i.text.trim()) continue
          break
        case "face":
        case "ark":
        case "embed":
          break
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "image":
          /**
           * 不再在这里把媒体和前面的文字切成两批：交给 sendBatch 统一拆
           * （它能把「只有 @」并进图片文字、其余文字单独一条，且媒体走自己的直传路径）。
           */
          if (sharp && i.file) i.file = await this.compressImage(data, i.file)
          break
        case "file":
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (i.data && typeof i.data === "object") i = { type: "markdown", ...i.data }
          else i = { type: "markdown", content: i.data ?? i.content ?? "" }
          break
        case "button":
          //button.push(...this.makeButtons(data, i.data))
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
            if (message.length) {
              messages.push(message)
              message = []
            }
            message.push(msg)
            i.text = i.text.replace(url, "[链接(请扫码查看)]")
          }
      }

      message.push(i)
    }

    /** 丢掉冗余 at 之后整条消息空了（例如插件只发了 segment.at(发言人)）：至少留下「@昵称」 */
    if (droppedAtText && !message.length && !messages.length)
      message.push({ type: "text", text: droppedAtText, _atText: true })

    if (message.length) messages.push(message)

    while (button.length)
      messages.push([
        {
          type: "keyboard",
          content: { rows: button.splice(0, 5) },
        },
      ])

    if (!reply && this.useReply(data))
      reply = { type: "reply", id: data.message_id }
    if (reply)
      for (const i of messages)
        i.unshift(
          reply.id.startsWith("event_")
            ? { type: "reply", event_id: reply.id.replace(/^event_/, "") }
            : reply,
        )
    return messages
  }

  /**
   * 是否给这条消息加引用（被动回复）
   *
   * 有 message_id 就优先走引用（被动回复）：
   *   - 只有「带 msg_id 的被动回复」不消耗主动推送配额，机器人没开主动权限时也能发出去；
   *   - QQ 自己会对超时的被动回复返回 40034128，本地再拿时间戳判断只会误伤
   *     （实测：消息 322 秒前发的，本地 300 秒门限直接判成主动消息 → 40034105 无权限，整条发不出去）；
   *   - 真被 QQ 拒了（40034128）才降级成主动消息，降级状态按账号记 5 分钟，过期自动恢复引用。
   *
   * 只有明确没有 message_id、或 activeMsg: true、或调用方显式声明为主动推送时才走主动消息。
   */

}
