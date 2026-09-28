import urlRegexSafe from "url-regex-safe"
import { config } from "../lib/utils/cfg.js"
import { SDK_NAME, SDK_VERSION } from "./sdk.js"
import { bindAdapter } from "../lib/utils/common.js"
import AdapterEvents from "./events.js"

export default class QQBotAdapter extends AdapterEvents {
  constructor() {
    super()
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
}

/**
 * 全局单例
 *
 * 适配器只需要一个实例（一个实例内部按 config.accounts / config.token 连接多个账号），
 * 指令插件与 WebHook 路由都通过它访问适配器，所以在这里创建并注入给 common.js。
 */
export const qqbot = new QQBotAdapter(config)
bindAdapter(qqbot)
