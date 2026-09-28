import fs from "node:fs/promises"
import path from "node:path"
import imageSize from "image-size"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import QRCode from "qrcode"
import { ulid } from "ulid"
import { config } from "../../lib/utils/cfg.js"
import {
  escapeMarkdownText,
  exec,
  fileToUrl,
  isPublicUrl,
  log,
  markdownImage,
  protectText,
  qqbotIds,
  restoreText,
  rm,
  sharp,
  toBuffer,
} from "../../lib/utils/common.js"
import AdapterLifecycle from "../lifecycle.js"

export default class MessageMedia extends AdapterLifecycle {
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

}
