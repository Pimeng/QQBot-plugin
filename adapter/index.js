import fs from "node:fs/promises"
import path from "node:path"
import imageSize from "image-size"
import urlRegexSafe from "url-regex-safe"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import { randomInt } from "node:crypto"
import QRCode from "qrcode"
import { ulid } from "ulid"
import { config, CFG_FILE } from "../lib/utils/cfg.js"
import {
  createBot,
  login as sdkLogin,
  logout as sdkLogout,
  normalizeEvent,
  adaptSendableForSDK,
  SDK_NAME,
  SDK_VERSION,
} from "./sdk.js"
import {
  bindAdapter,
  dispatch,
  escapeMarkdownText,
  exec,
  expandForwardNodes,
  fileToUrl,
  getMap,
  GROUP_INTENTS,
  GUILD_MESSAGE_INTENTS,
  hasAtSegment,
  isActiveMsgDenied,
  isMarkdownDenied,
  isPassiveReplyLimit,
  isPublicUrl,
  log,
  markAdapterId,
  markdownImage,
  needsMarkdown,
  normalizeForwardNodes,
  OPTIONAL_INTENTS,
  protectText,
  qqbotIds,
  restoreText,
  rm,
  sendModeOf,
  sharp,
  sleep,
  toBuffer,
  toPlainMsg,
  toStr,
  webhook,
} from "../lib/utils/common.js"

export default class QQBotAdapter {
  constructor() {
    this.id = "QQBot"
    this.name = "QQBot"
    this.path = "data/QQBot/"
    this.version = `${SDK_NAME} v${SDK_VERSION}`

    switch (typeof config.toQRCode) {
      case "boolean":
        this.toQRCodeRegExp = config.toQRCode ? urlRegexSafe() : false
        break
      case "string":
        this.toQRCodeRegExp = new RegExp(config.toQRCode, "g")
        break
      case "object":
        this.toQRCodeRegExp = urlRegexSafe(config.toQRCode)
        break
    }

    this.sep = ":"
    if (process.platform === "win32") this.sep = ""
    this.bind_user = {}
    this.appid = {}
    /** 每个账号实际握手成功的 intents（降级后可能少于申请值） */
    this.activeIntents = {}
    /** 已经提醒过“带回调按钮但没开按钮交互”的账号 */
    this.interactionWarned = {}
  }

  async makeRecord(file) {
    if (config.toBotUpload)
      for (const i of qqbotIds()) {
        if (!Bot[i].uploadRecord) continue
        try {
          const url = await Bot[i].uploadRecord(file)
          if (url) return url
        } catch (err) {
          log("error", ["Bot", i, "语音上传错误", file, err])
        }
      }
    const buffer = await toBuffer(file)
    if (!Buffer.isBuffer(buffer)) return file
    if (isSilk(buffer)) return buffer

    const convFile = path.join("temp", ulid())
    try {
      await fs.writeFile(convFile, buffer)
      await exec(`ffmpeg -i "${convFile}" -f s16le -ar 48000 -ac 1 "${convFile}.pcm"`)
      file = Buffer.from((await encodeSilk(await fs.readFile(`${convFile}.pcm`), 48000)).data)
    } catch (err) {
      log("error", ["silk 转码错误", file, err])
    }
    ;[convFile, `${convFile}.pcm`].map(i => rm(i))

    return file
  }

  async makeQRCode(data) {
    return (await QRCode.toDataURL(data)).replace("data:image/png;base64,", "base64://")
  }

  async makeRawMarkdownText(data, text, button) {
    /** 生成的图片标记要保护起来，否则里面的 URL 会被转义破坏 */
    const protectedList = []
    const match = text.match(this.toQRCodeRegExp)
    if (match)
      for (const url of match) {
        if (button) button.push(...this.makeButtons(data, [[{ text: url, link: url }]]))
        const img = await this.makeMarkdownImage(data, await this.makeQRCode(url), "二维码")
        /** 二维码前面补换行独占一行；后面还跟着文字才再补一个换行，结尾/块之间不用 */
        const at = text.indexOf(url)
        const tail = at >= 0 ? text.slice(at + url.length) : ""
        const code = `${markdownImage(img)}${/\S/.test(tail) ? "\n" : ""}`
        text = text.replace(url, protectText(protectedList, code))
      }
    return restoreText(escapeMarkdownText(text), protectedList)
      .replace(/@/g, "@​")
      .replace(/<qqbot-/g, "<qqbot-​")
  }

  async makeBotImage(file) {
    if (config.toBotUpload)
      for (const i of qqbotIds()) {
        if (!Bot[i].uploadImage) continue
        try {
          const image = await Bot[i].uploadImage(file)
          if (image.url) return image
        } catch (err) {
          log("error", ["Bot", i, "图片上传错误", file, err])
        }
      }
  }

  async makeMarkdownImage(data, file, summary = "图片") {
    if (sharp) file = await this.compressImage(data, file)
    const buffer = await toBuffer(file)
    const image = (await this.makeBotImage(buffer)) || { url: await fileToUrl(file) }

    if (!image.width || !image.height)
      try {
        const size = imageSize(buffer)
        image.width = size.width
        image.height = size.height
      } catch (err) {
        log("error", ["图片分辨率检测错误", file, err], data.self_id)
      }

    return {
      des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
      url: `(${image.url})`,
      /** 只有公网地址才能嵌进 markdown，否则要作为普通图片消息单独上传 */
      inline: isPublicUrl(image.url),
    }
  }

  makeButton(data, button, style) {
    const msg = {
      id: ulid(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text,
        style,
        ...button.QQBot?.render_data,
      },
    }

    if (button.input)
      msg.action = {
        type: 2,
        permission: { type: 2 },
        data: button.input,
        enter: button.send,
        ...button.QQBot?.action,
      }
    else if (button.callback) {
      if (config.toCallback) {
        msg.action = {
          type: 1,
          permission: { type: 2 },
          ...button.QQBot?.action,
        }
        if (!Array.isArray(data._ret_id)) data._ret_id = []
        data.bot.callback[msg.id] = {
          id: data.message_id,
          user_id: data.user_id,
          group_id: data.group_id,
          message: button.callback,
          message_id: data._ret_id,
        }
        setTimeout(() => delete data.bot.callback[msg.id], 300000)
      } else {
        msg.action = {
          type: 2,
          permission: { type: 2 },
          data: button.callback,
          enter: true,
          ...button.QQBot?.action,
        }
      }
    } else if (button.link)
      msg.action = {
        type: 0,
        permission: { type: 2 },
        data: button.link,
        ...button.QQBot?.action,
      }
    else return false

    if (button.permission) {
      if (button.permission === "admin") {
        msg.action.permission.type = 1
      } else {
        msg.action.permission.type = 0
        msg.action.permission.specify_user_ids = []
        if (!Array.isArray(button.permission)) button.permission = [button.permission]
        for (const id of button.permission)
          msg.action.permission.specify_user_ids.push(id.replace(`${data.self_id}${this.sep}`, ""))
      }
    }
    return msg
  }

  makeButtons(data, button_square) {
    const msgs = [],
      random = Math.floor(Math.random() * 2)
    for (const button_row of button_square) {
      let column = 0
      const buttons = []
      for (let button of button_row) {
        button = this.makeButton(data, button, (random + msgs.length + buttons.length) % 2)
        if (button) buttons.push(button)
      }
      if (buttons.length) msgs.push({ type: "button", buttons })
    }
    return msgs
  }

  makeTextChain(data, button) {
    let msg

    if (button.input) msg = `text="${button.input}"`
    else if (button.callback) msg = `text="${button.callback}"`
    else if (button.link) msg = `text="${button.link}"`
    else return false

    if (button.text) msg += ` show="[${button.text}]"`
    return `<qqbot-cmd-input ${msg} />`
  }

  makeTextChains(data, button_square) {
    const msgs = []
    for (const button_row of button_square) {
      const buttons = []
      for (let button of button_row) {
        button = this.makeTextChain(data, button)
        if (button) buttons.push(button)
      }
      if (buttons.length) msgs.push(buttons.join(" "))
    }
    if (msgs.length) msgs.unshift("")
    return msgs.join("\n")
  }

  /**
   * 解析 at 段的目标 id
   *
   * 兼容三种写法：`qq`（icqq 习惯）、`id`（QQBot 事件原始 openid）、`user_id`（SDK 习惯）；
   * 会剥掉实例前缀与 `qg_` 前缀，`0`/空值视为拿不到。
   */
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
        if (i === undefined || i === null) continue
        if (typeof i !== "object") i = { type: "text", text: toStr(i) }
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

  async makeRawMarkdownMsg(data, msg, keyboard, nested) {
    msg = this.dedupeAt(data, msg)
    const messages = [],
      button = [],
      keyboards = [],
      medias = []
    /** 带 at 时不能整条转普通消息（普通 content 的 <@id> 不渲染），图片改为单独成条 */
    const keepMarkdown = hasAtSegment(msg)
    let content = "",
      reply

    msg = normalizeForwardNodes(msg)

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: toStr(i) }

      switch (i.type) {
        case "node":
          /** 合并转发：渲染成 markdown 块引用（> 每行），并入本条消息 */
          content += `\n${await this.makeForwardQuote(data, i.data ?? i)}\n`
          break
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "face":
        case "ark":
        case "embed":
          messages.push([i])
          break
        case "file":
          if (i.file) i.file = await fileToUrl(i.file, i)
          content += await this.makeRawMarkdownText(data, `文件：${i.file}`, keyboard && button)
          break
        case "at": {
          /** 拿不到 id 时不渲染标签，避免出现 id="undefined" / id="0" */
          if (i.qq === "all" || i.user_id === "all" || i.id === "all")
            content += "<qqbot-at-everyone />"
          else {
            const atId = this.atTargetId(i, data)
            if (atId) content += `<qqbot-at-user id="${atId}" />`
          }
          break
        }
        case "text":
          content += await this.makeRawMarkdownText(data, i.text, keyboard && button)
          break
        case "image": {
          const { des, url, inline } = await this.makeMarkdownImage(data, i.file, i.summary)
          if (inline) {
            /** 前换行保证图片独占一行；后换行留给后面的段，图片在结尾时由 content.trimEnd() 收掉 */
            content += `${markdownImage({ des, url })}\n`
            break
          }
          /**
           * 没有公网直链时 markdown 嵌不进去：
           * - 消息里有 at → 保留 markdown（at 只能靠 markdown 标签渲染），图片单独成条
           * - 没有 at → 整条改走普通消息，文本/@/图片 合成一条富媒体消息
           */
          if (keepMarkdown) {
            if (sharp && i.file) i.file = await this.compressImage(data, i.file)
            medias.push({ ...i, type: "image" })
            break
          }
          return null
        }
        case "markdown":
          /** 兼容两种写法：{data:{...}}（QQ 原始 markdown 对象）与 {content:"..."}（miao/icqq segment.markdown） */
          if (i.data && typeof i.data === "object") messages.push([{ type: "markdown", ...i.data }])
          else content += i.data ?? i.content ?? ""
          break
        case "keyboard":
          /** QQ 官方消息键盘：挂到同一条 markdown 消息上 */
          keyboards.push({ ...i })
          break
        case "button":
          if (keyboard) button.push(...this.makeButtons(data, i.data))
          else content += this.makeTextChains(data, i.data)
          break
        case "reply":
          reply = i
          continue
        case "raw":
          messages.push(Array.isArray(i.data) ? i.data : [i.data])
          break
        default:
          content += await this.makeRawMarkdownText(data, toStr(i), keyboard && button)
      }
    }

    /** 图片在结尾时 markdownImage 前后的占位换行没有意义，收掉 */
    content = content.trimEnd()
    if (content) messages.unshift([{ type: "markdown", content }])
    for (const media of medias) messages.push([media])

    if (button.length) {
      for (const i of messages) {
        if (i[0].type === "markdown") i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length)
        messages.push([{ type: "markdown", content: " " }, ...button.splice(0, 5)])
    }

    if (keyboards.length) {
      const target = messages.find(m => m[0]?.type === "markdown")
      if (target) target.push(...keyboards)
      else messages.push(keyboards)
    }

    if (!reply && this.useReply(data))
      reply = { type: "reply", id: data.message_id }
    if (reply) {
      if (reply.id.startsWith("event_"))
        reply = { type: "reply", event_id: reply.id.replace(/^event_/, "") }
      for (const i in messages) {
        if (Array.isArray(messages[i])) messages[i].unshift(reply)
        else messages[i] = [reply, messages[i]]
      }
    }
    return messages
  }

  makeMarkdownText_(data, text) {
    /** 生成的链接标记要保护起来，否则里面的 URL 会被转义破坏 */
    const protectedList = []
    const match = text.match(this.toQRCodeRegExp)
    if (match)
      for (const url of match)
        text = text.replace(
          url,
          protectText(protectedList, this.makeTextChain(data, { text: "链接", link: url })),
        )
    return restoreText(escapeMarkdownText(text), protectedList)
      .replace(/\n/g, "\r")
      .replace(/@/g, "@​")
      .replace(/<qqbot-/g, "<qqbot-​")
  }

  makeMarkdownText(data, text, content) {
    const match = text.match(/!?\[.*?\]\s*\(\w+:\/\/.*?\)/g)
    if (match) {
      const temp = []
      let last = ""
      for (const i of match) {
        const match = i.match(/(!?\[.*?\])\s*(\(\w+:\/\/.*?\))/)
        text = text.split(i)
        temp.push([last + this.makeMarkdownText_(data, text.shift()), match[1]])
        text = text.join(i)
        last = match[2]
      }
      temp[0][0] = content + temp[0][0]
      return [last + this.makeMarkdownText_(data, text), temp]
    }
    return [this.makeMarkdownText_(data, text)]
  }

  makeMarkdownTemplate(data, templates) {
    const msgs = []
    for (const template of templates) {
      if (!template.length) continue

      const params = []
      for (const i in template)
        params.push({
          key: config.markdown.template[i],
          values: [template[i]],
        })

      msgs.push([
        {
          type: "markdown",
          custom_template_id: config.markdown[data.self_id],
          params,
        },
      ])
    }
    return msgs
  }

  makeMarkdownTemplatePush(content, template, templates) {
    for (const i of content) {
      if (template.length === config.markdown.template.length - 1) {
        template.push(i.shift())
        template = i
        templates.push(template)
      } else {
        template.push(i.join(""))
      }
    }
    return template
  }

  async makeMarkdownMsg(data, msg, nested) {
    msg = this.dedupeAt(data, msg)
    const messages = [],
      keyboards = [],
      medias = [],
      templates = [[]]
    const keepMarkdown = hasAtSegment(msg)
    let content = "",
      reply,
      template = templates[0]

    msg = normalizeForwardNodes(msg)

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: toStr(i) }

      switch (i.type) {
        case "node":
          /** 合并转发：渲染成 markdown 块引用（> 每行） */
          content += `\n${await this.makeForwardQuote(data, i.data ?? i)}\n`
          break
        case "record":
          i.type = "audio"
          i.file = await this.makeRecord(i.file)
        case "video":
        case "face":
        case "ark":
        case "embed":
          messages.push([i])
          break
        case "file":
          if (i.file) i.file = await fileToUrl(i.file, i)
          content += this.makeTextChain(data, { text: `文件：${i.name || i.file}`, link: i.file })
          break
        case "at": {
          /** 拿不到 id 时不渲染标签，避免出现 id="undefined" / id="0" */
          if (i.qq === "all" || i.user_id === "all" || i.id === "all")
            content += "<qqbot-at-everyone />"
          else {
            const atId = this.atTargetId(i, data)
            if (atId) content += `<qqbot-at-user id="${atId}" />`
          }
          break
        }
        case "text": {
          const [text, temp] = this.makeMarkdownText(data, i.text, content)
          if (Array.isArray(temp)) {
            template = this.makeMarkdownTemplatePush(temp, template, templates)
            content = text
          } else {
            content += text
          }
          break
        }
        case "image": {
          const { des, url, inline } = await this.makeMarkdownImage(data, i.file, i.summary)
          if (!inline) {
            if (keepMarkdown) {
              if (sharp && i.file) i.file = await this.compressImage(data, i.file)
              medias.push({ ...i, type: "image" })
              break
            }
            return null
          }
          template = this.makeMarkdownTemplatePush([[content, des]], template, templates)
          content = url
          break
        }
        case "markdown":
          /** 兼容两种写法：{data:{...}}（QQ 原始 markdown 对象）与 {content:"..."}（miao/icqq segment.markdown） */
          if (i.data && typeof i.data === "object") messages.push([{ type: "markdown", ...i.data }])
          else content += i.data ?? i.content ?? ""
          break
        case "keyboard":
          /** QQ 官方消息键盘：挂到同一条 markdown 消息上 */
          keyboards.push({ ...i })
          break
        case "button":
          content += this.makeTextChains(data, i.data)
          break
        case "reply":
          reply = i
          continue
        case "raw":
          messages.push(Array.isArray(i.data) ? i.data : [i.data])
          break
        default: {
          const [text, temp] = this.makeMarkdownText(data, toStr(i), content)
          if (Array.isArray(temp)) {
            template = this.makeMarkdownTemplatePush(temp, template, templates)
            content = text
          } else {
            content += text
          }
        }
      }
    }

    if (content) template.push(content)
    messages.push(...this.makeMarkdownTemplate(data, templates))
    for (const media of medias) messages.push([media])

    if (keyboards.length) {
      const target = messages.find(m => m[0]?.type === "markdown")
      if (target) target.push(...keyboards)
      else messages.push(keyboards)
    }

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
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: toStr(i) }

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
  mediaTarget(data) {
    const type = data.raw?.message_type
    if (type === "group" && data.group_id) return { target_type: "group", target_id: data.group_id }
    if (type === "private" && data.sub_type === "friend" && data.user_id)
      return { target_type: "user", target_id: data.user_id }
    return null
  }

  /**
   * 上传富媒体，拿到 file_info（srv_send_msg: false，只上传不发送）
   *
   * 拆开发送的第一步：先把媒体都传上去，这样后面每条媒体都能作为被动回复
   * （带 msg_id）单独发，不占用主动消息频次。
   */
  async uploadFileInfo(data, elem, target) {
    const fileType = { image: 1, video: 2, audio: 3 }[elem.type]
    if (!fileType) return null
    try {
      const info = await data.bot.sdk.fileProcessor.uploadForMessage(
        { file_type: fileType, file: elem.file, file_name: elem.name || elem.file_name },
        { targetType: target.target_type, targetId: target.target_id, sendMessage: false },
      )
      log("debug", ["富媒体上传完成", target, info], data.self_id)
      return info
    } catch (err) {
      log("error", ["富媒体上传失败", elem.type, err], data.self_id)
      return null
    }
  }

  /** 单独发一条富媒体消息（msg_type 7），带引用时走被动回复；content 作为图片下方文字 */
  async sendFileInfoMessage(data, target, info, reply, content = "") {
    const payload = {
      msg_type: 7,
      media: { file_info: info.file_info },
      msg_seq: randomInt(1, 1000000),
    }
    if (content) payload.content = content
    const eventId =
      reply?.event_id ||
      (typeof reply?.id === "string" && reply.id.startsWith("event_") ? reply.id : undefined)
    if (eventId) payload.event_id = String(eventId).replace(/^event_/, "")
    else if (reply?.id) payload.msg_id = String(reply.id)

    const { data: ret } = await data.bot.sdk.request.post(
      `/v2/${target.target_type}s/${target.target_id}/messages`,
      payload,
    )
    log("debug", ["富媒体消息已发送", target, ret], data.self_id)
    return ret
  }

  /**
   * 发送一批消息
   *
   * 带媒体时不再走 SDK 的「富媒体 + caption 合成一条」（SDK 的分片上传有 850019 的坑），
   * 而是自己上传后按 `msg_type 7` 直发：
   *   1. 先把媒体全部上传（任一失败就整体回退给 SDK，避免发出半条）
   *   2. 非媒体内容并进**第一条**媒体的 `content`（QQ 里就是图片下面那行字），图文合成一条
   *   3. 每条媒体都带同一个引用（同一 msg_id、不同 msg_seq），走被动回复，不占主动频次
   *
   * 两种例外仍然拆开发送：
   *   - 非媒体部分里有无法塞进 `content` 的段（markdown / keyboard / ark 等）；
   *   - caption 被平台拒绝（例如超长）时退回「媒体一条 + 文字一条」，不让整条消息发不出去。
   */
  async sendBatch(data, batch, send) {
    const isMedia = s => ["image", "video", "audio"].includes(s?.type)
    const media = batch.filter(isMedia)
    if (!media.length) return await send(batch)

    const target = this.mediaTarget(data)
    if (!target) return await send(batch)

    const others = batch.filter(s => !isMedia(s))
    const reply = others.find(s => s?.type === "reply")

    const infos = []
    for (const elem of media) {
      const info = await this.uploadFileInfo(data, elem, target)
      if (!info?.file_info) return await send(batch)
      infos.push(info)
    }

    const contentSegs = others.filter(s => s?.type !== "reply")
    /** 只有全是文本段才能并进 caption（SDK 拼 content 时也是把文本首尾直接相接，这里保持一致） */
    const textOnly = contentSegs.length > 0 && contentSegs.every(s => typeof s?.text === "string")
    const caption = textOnly ? contentSegs.map(s => s.text).join("") : ""

    const rets = []
    const post = async (i, content) =>
      rets.push(await this.sendFileInfoMessage(data, target, infos[i], reply, content))
    const strip = list => list.map(({ _atText, ...rest }) => rest)

    let inline = !!caption
    if (inline)
      try {
        await post(0, caption)
      } catch (err) {
        /** 回复超时/无主动权限这类错误交给 sendMsg 的降级逻辑处理，不要在这里吞掉 */
        if (isPassiveReplyLimit(err) || isActiveMsgDenied(err)) throw err
        inline = false
        log("warn", ["图文合成一条发送失败，改为拆开发送", err], data.self_id)
      }

    if (inline) {
      for (let i = 1; i < infos.length; i++) await post(i, "")
    } else {
      for (let i = 0; i < infos.length; i++) await post(i, "")
      if (contentSegs.length) rets.push(await send(strip(others)))
    }
    return rets.length === 1 ? rets[0] : rets
  }

  /**
   * 检查待发送的消息里有没有「回调按钮」（action.type=1）
   *
   * 回调按钮依赖 INTERACTION intent：没申请/没开通时点击事件不会推到机器人，
   * 用户点完（有 modal 的话是二次确认之后）客户端只会提示“请求第三方失败”。
   * 这里提前把原因写进日志，免得对着一句客户端提示排查。
   */
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
      msgs = await this.buildPlainMsgs(data, msg)
      await sendAll()
    }

    if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
    return rets
  }

  /** active: true 表示主动推送（不带 msg_id），不属于回复；普通回复不要传 */
  sendFriendMsg(data, msg, active = false) {
    if (active) data = { ...data, active: true }
    return this.sendMsg(data, msg => data.bot.sdk.sendPrivateMessage(data.user_id, adaptSendableForSDK(msg)), msg)
  }

  sendGroupMsg(data, msg, active = false) {
    if (active) data = { ...data, active: true }
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
      if (typeof i === "object") i = { ...i }
      else i = { type: "text", text: toStr(i) }

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
  makeForwardMsg(nodes = []) {
    return { type: "node", data: (Array.isArray(nodes) ? nodes : [nodes]).filter(Boolean) }
  }

  pickFriend(id, user_id) {
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildFriend(id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...i,
      /** pickFriend(...).sendMsg 是主动推送，不是回复（不拿缓存的上一条消息当引用） */
      sendMsg: msg => this.sendFriendMsg(i, msg, true),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`,
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildMember(id, group_id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    else if (group_id.startsWith("qg_")) return this.pickGuild(id, group_id)
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...i,
      /** pickGroup(...).sendMsg 是主动推送，不是回复（不拿群里最后一条消息当引用） */
      sendMsg: msg => this.sendGroupMsg(i, msg, true),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
    }
  }

  pickGuildFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...i,
      /** pickGuildFriend(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
    }
  }

  pickGuildMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...this.pickGuildFriend(id, user_id),
      ...i,
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
    }
  }

  pickGuild(id, group_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
    }
    return {
      ...i,
      /** pickGuild(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendGuildMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
    }
  }

  async makeFriendMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.user_name,
    }
    log("info", `好友消息：[${data.user_id}] ${data.raw_message}`, data.self_id)

    data.reply = (msg, quote, extra) =>
      this.sendFriendMsg(
        {
          ...data,
          user_id: event.sender.user_id,
          replyExtra: extra,
        },
        msg,
      )
    await this.setFriendMap(data)
  }

  async makeGroupMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.user_name,
    }
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    log(
      "info",
      `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = (msg, quote, extra) =>
      this.sendGroupMsg(
        {
          ...data,
          group_id: event.group_id,
          replyExtra: extra,
        },
        msg,
      )
    /** @ 机器人由 buildMiaoEvent 直接置 e.atBot，这里不再往消息里插 at 段 */
    await this.setGroupMap(data)
  }

  async makeDirectMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.user_name,
      avatar: event.author.avatar,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id,
    }
    log(
      "info",
      `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = (msg, quote, extra) =>
      this.sendDirectMsg(
        {
          ...data,
          user_id: event.user_id,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
          replyExtra: extra,
        },
        msg,
      )
    await this.setFriendMap(data)
  }

  async makeGuildMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.message_type = "group"
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.user_name,
      card: event.member.nick,
      avatar: event.author.avatar,
      src_guild_id: event.guild_id,
      src_channel_id: event.channel_id,
    }
    data.group_id = `qg_${event.guild_id}-${event.channel_id}`
    log(
      "info",
      `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )
    data.reply = (msg, quote, extra) =>
      this.sendGuildMsg(
        {
          ...data,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
          replyExtra: extra,
        },
        msg,
      )
    await this.setFriendMap(data)
    await this.setGroupMap(data)
  }

  async setFriendMap(data) {
    if (!data.user_id) return
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.sender,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async setGroupMap(data) {
    if (!data.group_id) return
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      time: data.time,
      message_id: data.message_id,
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      ...data.sender,
    })
  }

  async makeMessage(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      time: event.timestamp,
      get user_id() {
        return this.sender.user_id
      },
      message: event.message,
      raw_message: event.raw_message,
      /** 是否群里 @ 了机器人（1.3.0 用事件名区分，message_type 都是 group） */
      _at: event._eventName === "message.group.at",
    }

    for (const i of data.message)
      switch (i.type) {
        case "at":
          if (data.message_type === "group")
            i.qq = i.is_you === "true" ? data.self_id : `${data.self_id}${this.sep}${i.user_id}`
          else i.qq = `qg_${i.user_id}`
          break
      }

    switch (data.message_type) {
      case "private":
        if (data.sub_type === "friend") await this.makeFriendMessage(data, event)
        else await this.makeDirectMessage(data, event)
        break
      case "group":
        await this.makeGroupMessage(data, event)
        break
      case "guild":
        await this.makeGuildMessage(data, event)
        break
      default:
        log("warn", ["未知消息", event], id)
        return
    }

    dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeBotCallback(id, event, callback) {
    const data = {
      raw: event,
      bot: Bot[callback.self_id],
      self_id: callback.self_id,
      post_type: "message",
      message_id: `event_${event.notice_id}`,
      message_type: callback.group_id ? "group" : "private",
      sub_type: "callback",
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    data.message.push(
      { type: "at", qq: callback.self_id },
      { type: "text", text: callback.message },
    )
    data.raw_message += callback.message

    if (callback.group_id) {
      data.group_id = callback.group_id
      data.group = data.bot.pickGroup(callback.group_id)
      data.group_name = data.group.name
      data.friend = Bot[id].pickFriend(data.user_id)
      if (data.friend.real_id) {
        data.friend = data.bot.pickFriend(data.friend.real_id)
        data.member = data.group.pickMember(data.friend.user_id)
        data.sender = {
          ...((await data.member.getInfo()) || data.member),
        }
      } else {
        if (Bot[id].callback[data.user_id]) return event.reply(3)
        Bot[id].callback[data.user_id] = true

        let msg = `请先发送 #QQBot绑定用户${data.user_id}`
        const real_id = callback.message.replace(/^#[Qq]+[Bb]ot绑定用户确认/, "").trim()
        if (this.bind_user[real_id] === data.user_id) {
          await Bot[id].fl.set(data.user_id, {
            ...Bot[id].fl.get(data.user_id),
            real_id,
          })
          msg = `绑定成功 ${data.user_id} → ${real_id}`
        }

        event.reply(0)
        return data.group.sendMsg(msg)
      }
      log(
        "info",
        [
          `群按钮点击事件：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})]`,
          data.raw_message,
        ],
        data.self_id,
      )
    } else {
      await Bot[id].fl.set(data.user_id, {
        ...Bot[id].fl.get(data.user_id),
        real_id: callback.user_id,
      })
      data.friend = data.bot.pickFriend(callback.user_id)
      data.sender = {
        ...((await data.friend.getInfo()) || data.friend),
      }
      log(
        "info",
        [`好友按钮点击事件：[${data.sender.nickname}(${data.user_id})]`, data.raw_message],
        data.self_id,
      )
    }

    event.reply(0)
    dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeCallback(id, event) {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        const result = await reply(...args)
        if (result === false) {
          log(
            "error",
            ["回复按钮点击事件失败", {
              notice_id: event.notice_id,
              group_id: event.group_id,
              operator_id: event.operator_id,
              code: args[0],
            }],
            id,
          )
        }
        return result
      } catch (err) {
        log(
          "error",
          ["回复按钮点击事件错误", {
            notice_id: event.notice_id,
            group_id: event.group_id,
            operator_id: event.operator_id,
            message: err?.message || String(err),
          }],
          id,
        )
      }
    }

    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
      message_type: event.notice_type,
      sub_type: "callback",
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    const callback = data.bot.callback[event.data?.resolved?.button_id]
    if (callback) {
      if (callback.self_id) return this.makeBotCallback(id, event, callback)
      if (!event.group_id && callback.group_id) event.group_id = callback.group_id
      if (callback.message_id.length) {
        for (const id of callback.message_id) data.message.push({ type: "reply", id })
        data.raw_message += `[回复：${callback.message_id}]`
      }
      data.message.push({ type: "text", text: callback.message })
      data.raw_message += callback.message
    } else {
      if (event.data?.resolved?.button_id) {
        data.message.push({ type: "reply", id: event.data?.resolved?.button_id })
        data.raw_message += `[回复：${event.data?.resolved?.button_id}]`
      }
      if (event.data?.resolved?.button_data) {
        data.message.push({ type: "text", text: event.data?.resolved?.button_data })
        data.raw_message += event.data?.resolved?.button_data
      } else {
        event.reply(1)
      }
    }
    event.reply(0)

    switch (data.message_type) {
      case "friend":
        data.message_type = "private"
        log("info", [`好友按钮点击事件：[${data.user_id}]`, data.raw_message], data.self_id)

        data.reply = (msg, quote, extra) =>
          this.sendFriendMsg({ ...data, user_id: event.operator_id, replyExtra: extra }, msg)
        await this.setFriendMap(data)
        break
      case "group":
        data.group_id = `${id}${this.sep}${event.group_id}`
        log(
          "info",
          [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message],
          data.self_id,
        )

        data.reply = (msg, quote, extra) =>
          this.sendGroupMsg({ ...data, group_id: event.group_id, replyExtra: extra }, msg)
        await this.setGroupMap(data)
        break
      case "guild":
        break
      default:
        log("warn", ["未知按钮点击事件", event], data.self_id)
    }

    dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  makeNotice(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
    }

    switch (data.sub_type) {
      case "action":
        return this.makeCallback(id, event)
      case "increase":
      case "decrease":
      case "update":
      case "member.increase":
      case "member.decrease":
      case "member.update":
        break
      default:
        log("warn", ["未知通知", event], id)
        return
    }

    //dispatch(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  getFriendMap(id) {
    return getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return getMap(`${this.path}${id}/Member`)
  }

  /**
   * 生成 intents
   *
   * 默认**只申请群聊事件**：频道相关的 intent 需要机器人在 QQ 开放平台具备频道能力，
   * 没开通时申请它会让整个握手被 4014 拒绝（intents 是整包校验的）。
   * 群聊默认带上 INTERACTION（按钮交互），这样消息按钮里的「回调按钮」才能收到
   * INTERACTION_CREATE；若该机器人没开通按钮能力，connect() 会自动摘掉它重连。
   * 需要频道/消息审核时，请在 plugins/QQBot-Plugin/config/config/cfg.yaml 的 intents 里显式填写。
   */
  makeIntents(token) {
    if (Array.isArray(config.intents) && config.intents.length) return [...config.intents]

    /** 群Bot：群聊消息事件 + 按钮交互 */
    if (+token[4]) return [...GROUP_INTENTS]
    /** 只声明了频道（不是群Bot）：那就只给频道事件 */
    if (+token[5]) return [...GUILD_MESSAGE_INTENTS]
    return []
  }

  /**
   * 依次尝试的 intents 组合
   *
   * intents 是整包校验的：只要里面有一个没授权的，整个握手就 4013/4014。
   * 因此这里按“能力从多到少”排好队，把需要单独申请的 OPTIONAL_INTENTS 作为可摘除项，
   * 保证多要一个 INTERACTION 不会让机器人直接掉线。
   */
  buildIntentQueue(token, explicit) {
    const wanted = this.makeIntents(token)
    const candidates = []
    const push = list => {
      const unique = [...new Set(list.filter(Boolean))]
      const key = [...unique].sort().join("|")
      if (!unique.length || candidates.some(i => i.key === key)) return
      candidates.push({ list: unique, key })
    }

    push(wanted)
    /** 摘掉需单独申请的 intent 再试一次 */
    push(wanted.filter(i => !OPTIONAL_INTENTS.includes(i)))

    if (!explicit && +token[5] && !wanted.some(i => GUILD_MESSAGE_INTENTS.includes(i))) {
      push([...GUILD_MESSAGE_INTENTS])
      push(GUILD_MESSAGE_INTENTS.filter(i => !OPTIONAL_INTENTS.includes(i)))
    }

    /** 兜底：任何情况下都留一条最保守的群聊组合 */
    if (!explicit && +token[4]) push(["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"])

    return candidates
  }

  async connect(token) {
    token = token.split(":")
    const id = token[0]
    delete this.activeIntents[id]

    const explicit = Array.isArray(config.intents) && config.intents.length > 0
    const wanted = this.makeIntents(token)
    const queue = this.buildIntentQueue(token, explicit)

    let lastError = null
    for (let i = 0; i < queue.length; i++) {
      const { list } = queue[i]
      const ret = await this.connectOnce(id, token, list)
      if (ret.ok) {
        this.activeIntents[id] = [...list]
        if (Bot[id]?.info) Bot[id].info.intents = [...list]
        /** 供插件（例如小游戏）判断能否使用「回调按钮」 */
        if (Bot[id]) Bot[id].interaction = list.includes("INTERACTION")
        const dropped = wanted.filter(x => !list.includes(x))
        if (dropped.length)
          log(
            "warn",
            [
              `以下 intents 申请被平台拒绝，已自动降级连接：${dropped.join(" | ")}`,
              dropped.includes("INTERACTION")
                ? "没有 INTERACTION 就收不到按钮点击事件（INTERACTION_CREATE）：" +
                  "消息按钮里的回调按钮（action.type=1）点完二次确认后，客户端会提示“请求第三方失败”。" +
                  "请到 QQ 开放平台为该机器人开启「消息按钮/按钮交互」能力。"
                : "请在 QQ 开放平台确认该机器人已开启对应能力。",
              `当前生效 intents：${list.join(" | ")}`,
            ],
            id,
          )
        else if (i > 0) log("warn", [`已改用兜底 intents：${list.join(" | ")}`], id)
        return true
      }
      if (!ret.intentError) return false
      lastError = ret.error
    }

    log(
      "error",
      [
        `intents 被拒绝（${lastError}），最后一次申请：${queue[queue.length - 1].list.join(" | ") || "（空）"}`,
        "4013/4014 说明其中有 intent 未被该机器人授权：请到 QQ 开放平台确认已开启对应能力，" +
          `或在 ${CFG_FILE} 的 intents 里只保留已授权的项。` +
          "可用项：群消息 GROUP_AT_MESSAGE_CREATE、C2C_MESSAGE_CREATE；" +
          "频道 GUILDS、GUILD_MESSAGES、PUBLIC_GUILD_MESSAGES、GUILD_MESSAGE_REACTIONS、DIRECT_MESSAGE、GUILD_MEMBERS；" +
          "按钮交互 INTERACTION；消息审核 MESSAGE_AUDIT（后两者需单独申请）",
      ],
      id,
    )
    return false
  }

  /** 单次连接尝试，intents 由 connect() 决定 */
  async connectOnce(id, token, intents) {
    const opts = {
      ...config.bot,
      appid: token[1],
      token: token[2],
      secret: token[3],
      intents,
    }
    log("info", [`申请 intents：${intents.join(" | ") || "（空）"}`], id)

    Bot[id] = {
      /** miao 约定：Bot[id].adapter 是适配器名字符串（napcat-adapter 用 'OneBotv11'） */
      adapter: this.id,
      sdk: createBot(opts),
      login: () => sdkLogin(Bot[id].sdk, opts.connectTimeout || 30000),
      logout() {
        /** 断开后从 Bot.adapter 摘掉，避免其它插件把它当在线账号 */
        markAdapterId(id, false)
        return sdkLogout(this.sdk)
      },

      uin: id,
      info: {
        id,
        ...opts,
        avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`,
      },
      get nickname() {
        return this.info.username
      },
      get avatar() {
        return this.info.avatar
      },

      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: { start_time: Date.now() / 1000 },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() {
        return this.gl
      },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),

      callback: {},
    }

    /**
     * SDK 日志：转发到 miao 的 logger
     *   - `recv from` 是每条消息的原始事件，太吵，直接丢掉
     *   - 断线重连过程静默：只保留真正的错误，重连成功单独记一条「自动重连成功」
     */
    const SILENT_SDK_LOG = [
      "等待断线重连中",
      "重新连接中，尝试次数",
      "连接成功", // 1.1.0 的重连成功提示，改由 receiver ready 统一记录
      "[WebSocketReceiver] 连接关闭：",
      "[WebSocketReceiver] 连接断开，第",
      "[WebSocketReceiver] 等待 ",
      "WebSocket连接已建立",
    ]
    Bot[id].sdk.logger = {}
    for (const level of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
      Bot[id].sdk.logger[level] = (...args) => {
        const head = String(args[0] ?? "")
        if (head.startsWith("recv from")) return
        if (level !== "error" && level !== "fatal" && SILENT_SDK_LOG.some(p => head.includes(p)))
          return
        return log(level, args, id)
      }

    /**
     * 断线重连由 SDK 自己退避重连；
     * 这里只在「非首次 ready」时记一条成功日志，避免一串重连过程刷屏。
     */
    let readyCount = 0
    Bot[id].sdk.sessionManager.receiver?.on("ready", () => {
      readyCount += 1
      if (readyCount > 1) log("mark", "自动重连成功", id)
    })

    try {
      if (token[4] === "2") {
        await Bot[id].sdk.sessionManager.getAccessToken()
        Bot[id].login = () => (this.appid[opts.appid] = Bot[id])
        Bot[id].logout = () => delete this.appid[opts.appid]
      }

      await Bot[id].login()
      Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
    } catch (err) {
      const msg = err?.message || String(err)
      const intentError = /^40(13|14)\b/.test(msg)
      log("error", [`${this.name}(${this.id}) ${this.version} 连接失败：${msg}`], id)

      if (/^491[45]\b/.test(msg))
        log("error", ["4914/4915：机器人已下架或封禁，请到 QQ 开放平台处理"], id)

      try {
        await Bot[id].sdk.stop()
      } catch (e) {}
      delete Bot[id]
      markAdapterId(id, false)
      if (token[4] === "2") delete this.appid[opts.appid]
      return { ok: false, intentError, error: msg }
    }

    Bot[id].sdk.on("message", event => this.makeMessage(id, normalizeEvent(event)))
    Bot[id].sdk.on("notice", event => this.makeNotice(id, normalizeEvent(event)))

    /** 连接成功才登记到 Bot.adapter（miao 约定：数组元素是账号 uin） */
    markAdapterId(id, true)
    log("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    dispatch(`connect.${id}`, { self_id: id })
    return { ok: true }
  }

  async makeWebHookSign(id, req, secret) {
    const { sign } = (await import("tweetnacl")).default
    const { plain_token, event_ts } = req.body.d
    while (secret.length < 32) secret = secret.repeat(2).slice(0, 32)
    const signature = Buffer.from(
      sign.detached(
        Buffer.from(`${event_ts}${plain_token}`),
        sign.keyPair.fromSeed(Buffer.from(secret)).secretKey,
      ),
    ).toString("hex")
    log("debug", ["QQBot 签名生成", { plain_token, signature }], id)
    req.res.send({ plain_token, signature })
  }

  makeWebHook(req) {
    const appid = req.headers["x-bot-appid"]
    if (!(appid in this.appid)) return log("warn", "找不到对应 QQBot", appid)
    if ("plain_token" in req.body?.d)
      return this.makeWebHookSign(this.appid[appid].uin, req, this.appid[appid].info.secret)
    if ("t" in req.body) this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
    req.res.sendStatus(200)
  }

  /**
   * 启动适配器（幂等）
   *
   *   - load() 会同步注册 WebHook 路由，之后再启动监听端口
   *   - WebHook 模式、或配置了公网直链（文件服务）时都要起内置 http 服务
   */
  async init() {
    if (this.started) return
    this.started = true

    this.load().catch(err => log("error", ["QQBot 适配器启动错误", err]))

    if (
      Number(config.webhookPort) > 0 ||
      config.url ||
      (config.token || []).some(token => /:2$/.test(token))
    )
      webhook.start()
  }

  async load() {
    webhook.use(`/${this.name}`, this.makeWebHook.bind(this))
    for (const token of config.token) await sleep(5000, this.connect(token))
  }
}

/**
 * 全局单例
 *
 * 适配器只需要一个实例（一个实例内部按 config.token 连接多个账号），
 * 指令插件与 WebHook 路由都通过它访问适配器，所以在这里创建并注入给 common.js。
 */
export const qqbot = new QQBotAdapter(config)
bindAdapter(qqbot)
