import { config } from "./cfg.js"

function circularReplacer() {
  const seen = new WeakSet()
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
    }
    return value
  }
}

/** 二进制（Buffer / TypedArray / ArrayBuffer）统一成 Buffer；不是二进制返回 null */
function toBinary(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/** 把任意数据转成字符串 */
function toStr(data, opts) {
  switch (typeof data) {
    case "string":
      return data
    case "function":
      return String(data)
    case "object": {
      if (data instanceof Error) return data.stack || String(data)
      const binary = toBinary(data)
      if (binary) return `base64://${binary.toString("base64")}`
      if (data instanceof URL) return String(data)
    }
  }
  try {
    return JSON.stringify(data, circularReplacer(), opts) || String(data)
  } catch (err) {
    return String(data)
  }
}

/**
 * 把消息项规范化成消息段
 *
 * icqq/Miao 的适配器允许把 Buffer / Uint8Array 直接塞进消息数组当图片发
 * （不少插件就这么写：`e.reply(await render(...))`），这里保持同样的行为。
 *
 * 必须**先**判断二进制再展开：`{ ...buffer }` 会把字节拆成 `{0:137,1:80,…}` 这样的普通对象，
 * 之后 toStr 只能把它 JSON.stringify 成几万字符的文本，QQ 侧直接
 * 40054017「消息内容被拦截」，而且体积大到日志都刷屏。
 *
 * @returns 段对象；null / undefined 返回 null，调用方跳过
 */
function toSegment(item) {
  if (item === undefined || item === null) return null
  const binary = toBinary(item)
  if (binary) return { type: "image", file: binary }
  if (typeof item === "object") return { ...item }
  return { type: "text", text: toStr(item) }
}

/**
 * 群聊 / 单聊消息事件（两者在网关侧是同一个 bit）
 *
 * 额外申请 INTERACTION：消息按钮（keyboard）里 action.type=1 的「回调按钮」点击后，
 * 平台靠这个 intent 把 INTERACTION_CREATE 推给机器人；不申请的话事件根本到不了本地，
 * 用户点完按钮（二次确认之后）客户端只会提示“请求第三方失败”。
 * GROUP_MEMBER 负责群成员增减事件；平台未授权时会自动降级摘掉，不影响群消息连接。
 */
const GROUP_INTENTS = ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "GROUP_MEMBER", "INTERACTION"]
/**
 * 频道消息相关的 intent，需要机器人具备频道能力，未开通时申请会导致整包 4014。
 * 因此默认一律不申请，只在下列情况使用：账号只声明了频道、或用户显式配置、或群聊 intents 被拒后的兜底重试。
 * 注意不包含 GUILD_MEMBERS（频道成员），它需要在开放平台单独申请。
 */
const GUILD_MESSAGE_INTENTS = ["GUILDS", "GUILD_MESSAGE_REACTIONS", "DIRECT_MESSAGE", "GUILD_MESSAGES"]
/**
 * 需要在 QQ 开放平台单独申请能力、且没开通时会让整个握手 4013/4014 的 intent。
 * 连接失败时会自动把它们摘掉重试，保证机器人不至于因为多要了一个 intent 就完全掉线。
 */
const OPTIONAL_INTENTS = ["GROUP_MEMBER", "INTERACTION", "MESSAGE_AUDIT", "GUILD_MEMBERS", "PUBLIC_GUILD_MESSAGES"]

/** 被动回复（引用）超时/超次数 */
function isPassiveReplyLimit(err) {
  const msg = String(err?.message || err || "")
  return msg.includes("40034128") || msg.includes("被动回复")
}

/** 主动消息权限/配额不足（该机器人不能发主动消息，只能走带 msg_id 的被动回复） */
function isActiveMsgDenied(err) {
  const msg = String(err?.message || err || "")
  return msg.includes("40034105") || msg.includes("主动消息失败")
}

/**
 * markdown 被平台拒绝
 *
 * 常见于：机器人没有「原生 Markdown」权限（304036 / 40034127）、markdown 参数或内容不合法
 * （40034124 / 40034011 / 40034008 / 40034009 / 40034010）、内容里的链接命中 URL 白名单
 * （40034028 / 40054010）、消息类型与内容不匹配（22006）。
 * 这些情况下重试 markdown 没有意义，应当改用纯文本（msg_type 0）重发。
 */
const MARKDOWN_ERROR_CODES = [
  "304036",
  "40034127",
  "40034124",
  "40034011",
  "40034008",
  "40034009",
  "40034010",
  "40034028",
  "40054010",
  "22006",
]
function isMarkdownDenied(err) {
  const msg = String(err?.message || err || "")
  if (MARKDOWN_ERROR_CODES.some(code => msg.includes(code))) return true
  return /markdown/i.test(msg)
}

/**
 * 发送模式：
 *   auto        默认，只有显式 markdown / 按钮 才走 markdown
 *   markdown    强制走 markdown
 *   text        始终普通消息（连 markdown 段也转成文本）
 *   plain-first 普通消息优先，普通消息发不出去时再用 markdown 兜底
 */
const SEND_MODES = ["markdown", "text", "auto", "plain-first"]

/** 读取发送模式：支持 config.sendMode 为字符串，或 { default, [机器人QQ号]: mode } */
function sendModeOf(id) {
  const modes = config.sendMode
  const mode = typeof modes === "string" ? modes : (modes?.[id] ?? modes?.default)
  return SEND_MODES.includes(mode) ? mode : "auto"
}

/**
 * 需要 markdown 才能表达的消息段
 *
 * 只有显式 markdown / 按钮 / 键盘才值得走 markdown 构建器；
 * `at` 不在内：群/单聊的纯文本 content 没有 @ 语法，普通消息里 at 会渲染成可见的「@昵称」。
 */
const MD_FORCING_TYPES = ["markdown", "button", "keyboard"]
function needsMarkdown(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  return list.some(item => item && typeof item === "object" && MD_FORCING_TYPES.includes(item.type))
}

/**
 * markdown 文本 → 纯文本（保守剥离，只去掉语法标记，保留可读内容）
 *
 * 用于 markdown 被平台拒绝时降级重发，尽量不丢信息。
 */
function markdownToText(md) {
  return String(md ?? "")
    .replace(/\u200B/g, "")
    .replace(/<qqbot-at-everyone\s*\/>/g, "@全体成员")
    .replace(/<qqbot-cmd-input[^>]*show="([^"]*)"[^>]*\/>/g, "$1")
    .replace(/<qqbot-[^>]*\/>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^ {0,3}[-*+]\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .trim()
}

/** 把插件传入的 markdown 段剥成纯文本，其余段（图片 / @ / 表情 / 文件…）原样保留 */
function toPlainMsg(msg) {
  const list = Array.isArray(msg) ? msg : [msg]
  const out = []
  for (const item of list) {
    if (item && typeof item === "object" && item.type === "markdown") {
      const content =
        item.data && typeof item.data === "object"
          ? (item.data.content ??
            (item.data.params || []).flatMap(param => param?.values || []).join(" "))
          : (item.data ?? item.content ?? "")
      const text = markdownToText(content)
      if (text) out.push({ type: "text", text })
      continue
    }
    out.push(item)
  }
  return out
}

/** 零宽空格：用来打断 markdown 语法，同时不改变可见文本（插件原本就用它处理 @） */
const ZWSP = "\u200B"

/**
 * 转义 markdown 语法字符
 *
 * QQ 的 markdown 会把 `>`、`#`、`*`、`_`、`~`、`` ` ``、`-` 等当语法解析，
 * 颜文字（如 `>_<`、`¯\_(ツ)_/¯`）会被渲染成引用块/斜体。
 * 处理方式与插件对 `@` 的做法一致：插入零宽空格打断语法，可见文本不变。
 * 需要原始 markdown 文本时可在 plugins/QQBot-Plugin/config/config/cfg.yaml 里设置 escapeMarkdown: false。
 */
function escapeMarkdownText(text) {
  if (config.escapeMarkdown === false) return String(text)

  return String(text)
    .split("\n")
    .map(line => {
      /** 行首的块级标记：> 引用、# 标题、| 表格、* - + _ ~ 列表/分割线、1. 有序列表 */
      let out =
        /^ {0,3}[>#|*\-+_~]/.test(line) || /^ {0,3}\d+[.)]\s/.test(line) ? ZWSP + line : line
      /** 行内强调/代码标记 */
      out = out.replace(/([*_~`])/g, `$1${ZWSP}`)
      return out
    })
    .join("\n")
}

/** 生成 markdown 时保护内部链接等不能转义的片段 */
function protectText(list, value) {
  list.push(value)
  return `\u0000${list.length - 1}\u0000`
}

function restoreText(text, list) {
  return text.replace(/\u0000(\d+)\u0000/g, (match, index) => list[index] ?? match)
}

/** 是否含 at 段（普通消息 content 里的 <@id> QQ 不会渲染成 @，带 at 的消息必须走 markdown） */
function hasAtSegment(msg) {
  for (const item of Array.isArray(msg) ? msg : [msg]) {
    if (!item || typeof item !== "object") continue
    if (item.type === "at") return true
    if (item.type === "node" || item.type === "forward") {
      const nodes = Array.isArray(item.data) ? item.data : [item]
      for (const node of nodes) if (node?.message !== undefined && hasAtSegment(node.message)) return true
    }
    if (item.message !== undefined && (item.user_id !== undefined || item.nickname !== undefined))
      if (hasAtSegment(item.message)) return true
  }
  return false
}

/** 是否为可被 QQ 拉取的公网地址 */
function isPublicUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value)
}

/**
 * markdown 图片标记必须独占一行
 *
 * QQ 的 markdown 把 `![alt](url)` 当**行内**节点：前面没有换行时，它会和相邻的
 * @、文字挤在同一行（实测消息内容为 `<qqbot-at-user .../>![图片](...)签到成功！…`，
 * 客户端就把 @ / 卡片 / 文字排成了一横排）。
 *
 * 所以图片前面统一补换行；后面是否需要换行由调用方决定（跟着有文字才补，
 * 图片在结尾时由 `content.trimEnd()` 收掉多余换行）。
 */
function markdownImage({ des, url }) {
  return `\n\n${des}${url}`
}

/**
 * 归一化合并转发段：把 icqq 的裸转发节点数组 `[{user_id,nickname,message}]`
 * 合并成 `{type:"node", data:[...]}`，便于后续统一渲染
 */
function normalizeForwardNodes(msg) {
  const isBareNode = item =>
    item &&
    typeof item === "object" &&
    item.type === undefined &&
    item.message !== undefined &&
    (item.user_id !== undefined || item.nickname !== undefined)

  const out = []
  let pending = []
  const flush = () => {
    if (pending.length) {
      out.push({ type: "node", data: pending })
      pending = []
    }
  }

  for (const item of Array.isArray(msg) ? msg : [msg]) {
    if (isBareNode(item)) {
      pending.push(item)
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
}

/**
 * 展开合并转发段：把 node 里的消息并入当前消息（用于无 markdown 能力的普通/频道消息）
 * markdown 消息由 makeForwardQuote 渲染成 `>` 块引用，不走这里。
 * 兼容三种形态：
 *   1. {type:"node", data:[{message}, ...]}      —— 本适配器 makeForwardMsg 产物
 *   2. {type:"node", user_id, nickname, message} —— icqq segment.fake 单节点
 *   3. [{user_id, nickname, message}, ...]       —— icqq 裸转发节点数组
 */
function expandForwardNodes(msg, depth = 0) {
  const out = []
  for (const item of Array.isArray(msg) ? msg : [msg]) {
    if (item && typeof item === "object" && depth < 5) {
      if (item.type === "node" || item.type === "forward") {
        const nodes = Array.isArray(item.data) ? item.data : [item]
        for (const node of nodes) {
          if (!node) continue
          if (node.message !== undefined) out.push(...expandForwardNodes(node.message, depth + 1))
          else if (node.data !== undefined) out.push(...expandForwardNodes(node.data, depth + 1))
        }
        continue
      }
      /** 裸转发节点：没有 type，但同时带 message 与 user_id/nickname */
      if (item.type === undefined && item.message !== undefined && (item.user_id !== undefined || item.nickname !== undefined)) {
        out.push(...expandForwardNodes(item.message, depth + 1))
        continue
      }
    }
    out.push(item)
  }
  return out
}

export {
  circularReplacer,
  toBinary,
  toStr,
  toSegment,
  GROUP_INTENTS,
  GUILD_MESSAGE_INTENTS,
  OPTIONAL_INTENTS,
  isPassiveReplyLimit,
  isActiveMsgDenied,
  MARKDOWN_ERROR_CODES,
  isMarkdownDenied,
  SEND_MODES,
  sendModeOf,
  MD_FORCING_TYPES,
  needsMarkdown,
  markdownToText,
  toPlainMsg,
  ZWSP,
  escapeMarkdownText,
  protectText,
  restoreText,
  hasAtSegment,
  isPublicUrl,
  markdownImage,
  normalizeForwardNodes,
  expandForwardNodes,
}
