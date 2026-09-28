import { config } from "../lib/utils/cfg.js"
import {
  escapeMarkdownText,
  hasAtSegment,
  markdownImage,
  normalizeForwardNodes,
  protectText,
  restoreText,
  sharp,
  toStr,
} from "../lib/utils/common.js"
import MessageBuilder from "./message/builder.js"

export default class MarkdownBuilder extends MessageBuilder {
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
          medias.push(i)
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
          medias.push(i)
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


}
