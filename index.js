/**
 * QQBot 适配器插件入口
 *
 * 目录结构（与 napcat-adapter / snowluma-adapter 保持一致）：
 *   index.js            入口：拉起适配器、导出管理指令插件
 *   adapter/index.js    适配器主体
 *   adapter/sdk.js      qq-official-bot SDK 适配层
 *   lib/index.js        统一出口（qqbotCommon / cfg / config / configSave）
 *   lib/bot.js          全局 Bot 代理（跨适配器 pick*）
 *   lib/uin.js          Bot.uin 多账号 shim
 *   lib/plugin.js       管理指令插件
 *   lib/utils/cfg.js    插件内配置读写
 *   lib/utils/common.js 日志 / 持久化 / WebHook / 消息工具
 *   config/defSet/cfg.yaml   默认配置
 *   config/config/cfg.yaml   用户配置
 */
import "./lib/uin.js"
import "./lib/bot.js"
import { qqbot } from "./adapter/index.js"
import { config } from "./lib/index.js"
import { SDK_NAME, SDK_VERSION } from "./adapter/sdk.js"

logger.mark("===============")
logger.mark(`${logger.blue("[QQBot-Adapter]")} version ${SDK_NAME} v${SDK_VERSION}`)
logger.mark(
  `${logger.blue("[QQBot-Adapter]")} repository https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin`,
)
logger.mark("===============")

logger.info(logger.yellow("- 正在加载 QQBot 适配器插件"))

/** miao 社区约定：Bot.adapter 是「在线适配器账号」数组（napcat-adapter 同样在入口初始化） */
if (!Array.isArray(Bot.adapter)) Bot.adapter = []

/** 拉起适配器：按 config.token 逐个连接，并注册 WebHook 路由 */
qqbot.init().catch(err => logger.error("[QQBot-Adapter] 启动错误", err))

logger.info(logger.green("- QQBot 适配器插件 加载完成"))

export { QQBotPlugin } from "./lib/plugin.js"
export { qqbot, config }
