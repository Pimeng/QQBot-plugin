import crypto from "node:crypto"
import YAML from "yaml"
import { config, configSave } from "./lib/utils/cfg.js"
import { getAccounts, normalizeAccount } from "./lib/utils/accounts.js"

const SEND_MODES = new Set(["auto", "markdown", "text"])
const ACTIVE_MESSAGE_MODES = new Set(["auto", "true", "false"])

function configVersion() {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

function fieldValue(data, field) {
  if (Object.hasOwn(data, field)) return data[field]
  return field.split(".").reduce((value, key) => value?.[key], data)
}

function textValue(value, label) {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`${label}必须是文本`)
  return String(value).trim()
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label}必须是布尔值`)
  return value
}

function numberValue(value, label, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)) || number < min || number > max)
    throw new Error(`${label}数值无效`)
  return number
}

function parseYaml(value, label, fallback) {
  try {
    return YAML.parse(String(value ?? "")) ?? fallback
  } catch (error) {
    throw new Error(`${label} YAML 格式错误：${error.message}`)
  }
}

function parseLineList(value, label) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : null
  if (!items) throw new Error(`${label}必须是文本列表`)
  return [...new Set(items.map(item => textValue(item, label)).filter(Boolean))]
}

function qrCodeValue(value) {
  if (value === true || value === false) return value
  const expression = textValue(value, "链接转二维码规则")
  if (expression === "true") return true
  if (expression === "false") return false
  try {
    new RegExp(expression, "g")
  } catch {
    throw new Error("链接转二维码规则不是有效的正则表达式")
  }
  return expression
}

function parseSendModes(value) {
  const modes = typeof value === "string" ? parseYaml(value, "发送模式", {}) : value
  if (!modes || typeof modes !== "object" || Array.isArray(modes))
    throw new Error("发送模式必须是 YAML 键值对象")

  const result = {}
  for (const [account, mode] of Object.entries(modes)) {
    const key = account.trim()
    const value = textValue(mode, `发送模式 ${key || "default"}`)
    if (!key || !SEND_MODES.has(value))
      throw new Error(`发送模式 ${key || "default"} 只能是 auto、markdown 或 text`)
    result[key] = value
  }
  if (!Object.hasOwn(result, "default")) result.default = "auto"
  return result
}

function parseAccounts(value) {
  const entries = Array.isArray(value) ? value : parseYaml(value, "账号配置", [])
  if (!Array.isArray(entries)) throw new Error("账号配置必须是 YAML 列表")

  const existing = new Map(getAccounts(config).map(account => [account.appid, account]))
  const appids = new Set()
  const uins = new Set()

  return entries.filter(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true
    const uin = entry["机器人QQ号"] ?? entry.uin
    const appid = entry.AppID ?? entry.appid
    const secret = entry.AppSecret ?? entry.secret
    return [uin, appid, secret].some(value => value != null && String(value).trim())
  }).map((entry, index) => {
    const label = `账号 ${index + 1}`
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${label}必须是键值对象`)

    const appid = textValue(entry.AppID ?? entry.appid ?? "", `${label} AppID`)
    if (!appid) throw new Error(`${label}缺少 AppID`)
    const uin = textValue(entry["机器人QQ号"] ?? entry.uin ?? appid, `${label}机器人标识`) || appid
    const secretValue = entry.AppSecret ?? entry.secret
    const secretInput = secretValue == null ? "" : textValue(secretValue, `${label} AppSecret`)
    const secret = secretInput || existing.get(appid)?.secret || ""
    if (!secret) throw new Error(`${label}缺少 AppSecret；新增账号时请填写密钥`)

    const options = [
      ["群聊", "group"],
      ["频道", "guild"],
      ["WebHook", "webhook"],
    ]
    for (const [displayKey, configKey] of options) {
      const option = entry[displayKey] ?? entry[configKey]
      if (option !== undefined && typeof option !== "boolean")
        throw new Error(`${label}的 ${displayKey} 必须是 true 或 false`)
    }
    if (appids.has(appid)) throw new Error(`AppID ${appid} 重复`)
    if (uins.has(uin)) throw new Error(`机器人标识 ${uin} 重复`)
    appids.add(appid)
    uins.add(uin)

    return normalizeAccount({
      uin,
      appid,
      secret,
      group: entry["群聊"] ?? entry.group,
      guild: entry["频道"] ?? entry.guild,
      webhook: entry.WebHook ?? entry.webhook,
    })
  })
}

function readAccounts() {
  const source = {
    ...config,
    accounts: Array.isArray(config.accounts) ? config.accounts : [],
    token: Array.isArray(config.token) ? config.token : [],
  }
  const accounts = getAccounts(source).map(({ uin, appid, group, guild, webhook }) => ({
    "机器人QQ号": uin,
    AppID: appid,
    AppSecret: "",
    "群聊": group,
    "频道": guild,
    WebHook: webhook,
  }))
  return accounts.length ? accounts : [{
    "机器人QQ号": "",
    AppID: "",
    AppSecret: "",
    "群聊": true,
    "频道": false,
    WebHook: false,
  }]
}

function readObject(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback
}

export function supportPanel() {
  return {
    pluginInfo: {
      name: "QQBot-Plugin",
      title: "QQBot 官方机器人适配器",
      description: "将 QQ 开放平台机器人接入 Yunzai",
      author: "Pimeng",
      link: "https://github.com/Pimeng/QQBot-plugin",
      icon: "mdi:robot-outline",
      iconColor: "#27856b",
    },
    configInfo: {
      schemas: [
        { label: "账号与连接", component: "SOFT_GROUP_BEGIN" },
        {
          field: "accounts",
          label: "机器人账号",
          bottomHelpMessage: "每个账号单独编辑；已有账号的 AppSecret 不会回显，留空会保留原密钥。新增账号需填写 AppID 和 AppSecret。",
        },
        {
          field: "intents",
          label: "Intents",
          bottomHelpMessage: "每行一个；留空表示按账号能力自动申请。需要重启 Bot 生效。",
          component: "GTags",
        },
        {
          field: "master",
          label: "额外主人",
          bottomHelpMessage: "QQ 号或平台 user_id；按 Enter 添加。",
          component: "GTags",
        },
        { field: "bot.sandbox", label: "使用沙箱环境", component: "Switch" },
        {
          field: "bot.maxRetry",
          label: "断线重连次数",
          component: "InputNumber",
          componentProps: { min: 0, precision: 0 },
        },
        {
          field: "bot.timeout",
          label: "请求超时（毫秒）",
          component: "InputNumber",
          componentProps: { min: 1, precision: 0 },
        },
        {
          field: "bot.connectTimeout",
          label: "连接超时（毫秒）",
          component: "InputNumber",
          componentProps: { min: 1, precision: 0 },
        },
        {
          field: "bot.retryDelay",
          label: "重连基础间隔（毫秒）",
          component: "InputNumber",
          componentProps: { min: 0, precision: 0 },
        },
        {
          field: "webhookPort",
          label: "WebHook 端口",
          bottomHelpMessage: "0 表示关闭；启用还需配置公网地址和反向代理。修改后需重启 Bot。",
          component: "InputNumber",
          componentProps: { min: 0, max: 65535, precision: 0 },
        },
        {
          field: "url",
          label: "公网基础地址",
          bottomHelpMessage: "用于生成 QQ 可访问的媒体链接，例如 https://bot.example.com。",
          component: "Input",
          componentProps: { placeholder: "https://bot.example.com" },
        },
        { label: "消息与权限", component: "SOFT_GROUP_BEGIN" },
        {
          field: "permission",
          label: "管理指令权限",
          bottomHelpMessage: "使用 Yunzai 权限标识，例如 master 或 admin。",
          component: "Input",
        },
        {
          field: "toQRCode",
          label: "链接转二维码规则",
          bottomHelpMessage: "true 表示识别常见链接，false 表示关闭；也可填写正则表达式。",
          component: "Input",
        },
        { field: "toCallback", label: "Markdown 链接转回调", component: "Switch" },
        { field: "toBotUpload", label: "上传至 QQ 官方素材库", component: "Switch" },
        { field: "hideGuildRecall", label: "频道撤回对所有人隐藏", component: "Switch" },
        { field: "escapeMarkdown", label: "转义 Markdown 特殊字符", component: "Switch" },
        {
          field: "imageLength",
          label: "图片压缩阈值（MB）",
          bottomHelpMessage: "0 表示不压缩；需要安装 sharp 才能压缩。",
          component: "InputNumber",
          componentProps: { min: 0, step: 0.1 },
        },
        {
          field: "activeMsg",
          label: "引用回复策略",
          component: "Select",
          componentProps: {
            options: [
              { label: "自动", value: "auto" },
              { label: "始终主动发送", value: "true" },
              { label: "始终引用回复", value: "false" },
            ],
          },
        },
        {
          field: "sendMode",
          label: "发送模式映射",
          bottomHelpMessage: "按 default 或机器人标识配置，值为 auto、markdown 或 text。",
          component: "GSubForm",
        },
        {
          field: "markdown.template",
          label: "Markdown 模板 ID",
          component: "Input",
        },
      ],
      async getConfigData() {
        const bot = readObject(config.bot, {})
        const markdown = readObject(config.markdown, {})
        const sendMode = readObject(config.sendMode, { default: "auto" })
        const accounts = readAccounts()
        return {
          accounts,
          intents: Array.isArray(config.intents) ? config.intents.map(String) : [],
          master: Array.isArray(config.master) ? config.master.map(String) : [],
          bot: {
            sandbox: bot.sandbox === true,
            maxRetry: Number(bot.maxRetry ?? 3),
            timeout: Number(bot.timeout ?? 30000),
            connectTimeout: Number(bot.connectTimeout ?? 30000),
            retryDelay: Number(bot.retryDelay ?? 5000),
          },
          webhookPort: Number(config.webhookPort ?? 0),
          url: String(config.url ?? ""),
          permission: String(config.permission ?? "master"),
          toQRCode: typeof config.toQRCode === "boolean" ? String(config.toQRCode) : String(config.toQRCode ?? "true"),
          toCallback: config.toCallback !== false,
          toBotUpload: config.toBotUpload !== false,
          hideGuildRecall: config.hideGuildRecall === true,
          escapeMarkdown: config.escapeMarkdown !== false,
          imageLength: Number(config.imageLength ?? 3),
          activeMsg: config.activeMsg === true ? "true" : config.activeMsg === false ? "false" : "auto",
          sendMode: { ...sendMode },
          markdown: { template: String(markdown.template ?? "") },
          _version: configVersion(),
        }
      },
      async setConfigData(data, { Result }) {
        if (!data || typeof data !== "object" || Array.isArray(data))
          return Result.error("配置数据格式无效")
        if (data._version !== undefined && data._version !== configVersion())
          return Result.error("配置已被其他操作修改，请刷新后重试")

        try {
          const botConfig = readObject(config.bot, {})
          const markdownConfig = readObject(config.markdown, {})
          const activeMsg = textValue(fieldValue(data, "activeMsg") ?? "auto", "引用回复策略")
          if (!ACTIVE_MESSAGE_MODES.has(activeMsg))
            throw new Error("引用回复策略只能是 auto、true 或 false")

          const webhookPort = numberValue(fieldValue(data, "webhookPort") ?? config.webhookPort ?? 0, "WebHook 端口", {
            integer: true,
            min: 0,
            max: 65535,
          })
          const imageLength = numberValue(fieldValue(data, "imageLength") ?? config.imageLength ?? 3, "图片压缩阈值", {
            min: 0,
          })
          const url = textValue(fieldValue(data, "url") ?? config.url ?? "", "公网基础地址")
          if (url) {
            let parsedUrl
            try {
              parsedUrl = new URL(url)
            } catch {
              throw new Error("公网基础地址必须是有效的 http(s) URL")
            }
            if (!(["http:", "https:"].includes(parsedUrl.protocol) && !parsedUrl.username && !parsedUrl.password))
              throw new Error("公网基础地址必须是有效的 http(s) URL，且不能包含凭据")
          }

          const permission = textValue(fieldValue(data, "permission") ?? config.permission ?? "master", "管理指令权限")
          if (!permission) throw new Error("管理指令权限不能为空")

          const bot = {
            ...botConfig,
            sandbox: booleanValue(fieldValue(data, "bot.sandbox") ?? botConfig.sandbox ?? false, "沙箱环境"),
            maxRetry: numberValue(fieldValue(data, "bot.maxRetry") ?? botConfig.maxRetry ?? 3, "断线重连次数", {
              integer: true,
              min: 0,
            }),
            timeout: numberValue(fieldValue(data, "bot.timeout") ?? botConfig.timeout ?? 30000, "请求超时", {
              integer: true,
              min: 1,
            }),
            connectTimeout: numberValue(
              fieldValue(data, "bot.connectTimeout") ?? botConfig.connectTimeout ?? 30000,
              "连接超时",
              { integer: true, min: 1 },
            ),
            retryDelay: numberValue(
              fieldValue(data, "bot.retryDelay") ?? botConfig.retryDelay ?? 5000,
              "重连基础间隔",
              { integer: true, min: 0 },
            ),
          }

          const accountsInput = fieldValue(data, "accounts")
          const accounts = accountsInput === undefined ? undefined : parseAccounts(accountsInput)
          const sendMode = parseSendModes(fieldValue(data, "sendMode") ?? config.sendMode ?? { default: "auto" })
          const markdownTemplate = textValue(
            fieldValue(data, "markdown.template") ?? markdownConfig.template ?? "",
            "Markdown 模板 ID",
          )

          const changes = {
            bot,
            webhookPort,
            url,
            permission,
            toQRCode: qrCodeValue(fieldValue(data, "toQRCode") ?? config.toQRCode ?? true),
            toCallback: booleanValue(fieldValue(data, "toCallback") ?? config.toCallback ?? true, "Markdown 链接回调"),
            toBotUpload: booleanValue(fieldValue(data, "toBotUpload") ?? config.toBotUpload ?? true, "官方素材上传"),
            hideGuildRecall: booleanValue(
              fieldValue(data, "hideGuildRecall") ?? config.hideGuildRecall ?? false,
              "频道撤回隐藏",
            ),
            escapeMarkdown: booleanValue(
              fieldValue(data, "escapeMarkdown") ?? config.escapeMarkdown ?? true,
              "Markdown 转义",
            ),
            imageLength,
            activeMsg: activeMsg === "auto" ? "auto" : activeMsg === "true",
            sendMode,
            markdown: { ...markdownConfig, template: markdownTemplate },
            intents: parseLineList(fieldValue(data, "intents") ?? config.intents ?? [], "Intents"),
            master: parseLineList(fieldValue(data, "master") ?? config.master ?? [], "额外主人"),
          }

          Object.assign(config, changes)
          if (accounts !== undefined) {
            config.accounts = accounts
            config.token = []
          }
          configSave()
          configSave.flush()
          return Result.ok({}, "配置已保存；账号、Intents、Bot 连接参数及 WebHook 端口变更需重启 Bot 生效")
        } catch (error) {
          return Result.error(error?.message || "配置保存失败")
        }
      },
    },
  }
}