import { qqbot } from "../adapter/index.js"
import { config, configSave } from "./utils/cfg.js"
import { SEND_MODES, sharp } from "./utils/common.js"

/** QQBot 适配器的管理指令（其余能力由 adapter/index.js 提供） */
export class QQBotPlugin extends plugin {
  constructor() {
    super({
      name: "QQBotAdapter",
      dsc: "QQBot 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#[Qq]+[Bb]ot账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot设置[0-9]+:[0-9]+:.+:.+:([01]:[01]|2)$",
          fnc: "Token",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?[0-9]+:",
          fnc: "Markdown",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot图片限制.+$",
          fnc: "ImageLength",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot发送模式",
          fnc: "SendMode",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+[Bb]ot绑定用户.+$",
          fnc: "BindUser",
        },
      ],
    })
  }

  /**
   * 适配器启动入口
   *
   * 与 index.js 里的 `qqbot.init()` 是同一个幂等函数：
   * index.js 在插件加载时就调用一次，核心加载插件时还会调用本方法，
   * 靠 qqbot.started 保证只真正启动一次。
   */
  async init() {
    return qqbot.init()
  }

  List() {
    this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#[Qq]+[Bb]ot设置/, "").trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item !== token)
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await qqbot.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply(`账号连接失败`, true)
        return false
      }
    }
    return configSave()
  }

  Markdown() {
    let token = this.e.msg
      .replace(/^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?/, "")
      .trim()
      .split(":")
    const bot_id = token.shift()
    token = token.join(":")
    this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${token}`, true)
    config.markdown[bot_id] = token
    return configSave()
  }

  /**
   * 发送模式
   *   #QQBot发送模式                   查询
   *   #QQBot发送模式:text              全局默认改纯文本
   *   #QQBot发送模式3889013403:auto    指定账号
   */
  SendMode() {
    const token = this.e.msg.replace(/^#[Qq]+[Bb]ot发送模式/, "").trim()
    if (!token) {
      const list = Object.entries(config.sendMode || {})
        .map(([key, value]) => `${key}=${value}`)
        .join("，")
      return this.reply(`当前发送模式：${list || "default=markdown"}`, true)
    }

    const parts = token.split(":")
    const mode = parts.pop()?.trim()
    const bot_id = parts.join(":").trim() || "default"
    if (!SEND_MODES.includes(mode))
      return this.reply("发送模式只能是 markdown / text / auto", true)

    if (!config.sendMode || typeof config.sendMode !== "object")
      config.sendMode = { default: "auto" }
    config.sendMode[bot_id] = mode
    this.reply(`Bot ${bot_id} 发送模式已设置为 ${mode}`, true)
    return configSave()
  }

  ImageLength() {
    const imageLength = +this.e.msg.replace(/^#[Qq]+[Bb]ot图片限制/, "").trim()
    if (!(imageLength > 0)) return this.reply("请输入正确数字", true)
    if (!sharp) return this.reply("请检查 sharp 是否正确安装", true)
    this.reply(`图片大小已限制为 ${imageLength}MB`, true)
    config.imageLength = imageLength
    return configSave()
  }

  BindUser() {
    const id = this.e.msg.replace(/^#[Qq]+[Bb]ot绑定用户(确认)?/, "").trim()
    if (id === this.e.user_id) return this.reply("请切换到对应Bot")

    qqbot.bind_user[this.e.user_id] = id
    this.reply([
      `绑定 ${id} → ${this.e.user_id}`,
      segment.button([
        {
          text: "确认绑定",
          callback: `#QQBot绑定用户确认${this.e.user_id}`,
          permission: this.e.user_id,
        },
      ]),
    ])
  }
}
