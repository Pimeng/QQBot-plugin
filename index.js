/**
 * QQBot 适配器插件入口
 *
 * 目录结构（与 napcat-adapter / snowluma-adapter 保持一致）：
 *   index.js            入口：拉起适配器、导出管理指令插件
 *   adapter/index.js    适配器组装、配置和单例出口
 *   adapter/lifecycle.js 账号连接、intents 协商与 WebHook 生命周期
 *   adapter/message/builder.js 普通消息段、@ 与转发节点构建
 *   adapter/message/media.js   语音、图片、二维码和按钮辅助
 *   adapter/markdown.js Markdown 模板与官方标签构建
 *   adapter/message/sender.js 消息组装、回复策略与发送协调
 *   adapter/message/transport.js 富媒体上传与批次传输
 *   adapter/bot-api.js Bot.pick* 对象与主动消息代理
 *   adapter/events.js 入站消息、交互、通知与缓存
 *   adapter/sdk.js      qq-official-bot SDK 适配层
 *   lib/index.js        统一出口（qqbotCommon / cfg / config / configSave）
 *   lib/bot.js          全局 Bot 代理（跨适配器 pick*）
 *   lib/uin.js          宿主 Bot.uin 单账号值快照
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
logger.mark(`${logger.blue("[QQBot-Adapter]")} 官方依赖 ${SDK_NAME} v${SDK_VERSION}`)
logger.mark(`${logger.blue("[QQBot-Adapter]")} 欢迎使用 QQBot Plugin（Miao-Yunzai 适配版），请稍后，正在加载中`)
logger.mark("===============")

/** miao 社区约定：Bot.adapter 是「在线适配器账号」数组（napcat-adapter 同样在入口初始化） */
if (!Array.isArray(Bot.adapter)) Bot.adapter = []

/** 拉起适配器：按 config.accounts / config.token 逐个连接，并注册 WebHook 路由 */
qqbot.init().catch(err => logger.error("[QQBot-Adapter] 启动错误", err))

logger.info(logger.green("QQBot 适配器插件 加载完成"))

export { QQBotPlugin } from "./lib/plugin.js"
export { qqbot, config }
