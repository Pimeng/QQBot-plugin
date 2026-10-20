import "./lib/uin.js"
import "./lib/bot.js"
import { qqbot } from "./adapter/index.js"
import { config } from "./lib/utils/cfg.js"
import { qblog } from "./lib/utils/logger.js"
import { SDK_NAME, SDK_VERSION } from "./adapter/sdk.js"

qblog.mark(`官方依赖 ${SDK_NAME} v${SDK_VERSION}`)
qblog.mark("欢迎使用 QQBot Plugin（Miao-Yunzai 适配版），正在加载")

// Bot.adapter 按社区约定存放在线账号 ID。
if (!Array.isArray(Bot.adapter)) Bot.adapter = []

qqbot.init().catch(err => qblog.error("启动错误", err))

qblog.info("QQBot 适配器插件加载完成")

export { QQBotPlugin } from "./lib/plugin.js"
export { qqbot, config }
