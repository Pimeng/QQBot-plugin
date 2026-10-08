import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import http from "node:http"
import path from "node:path"
import util from "node:util"
import { exec as childExec } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import cfg from "../../../../lib/config/config.js"
import { config, configEvents, CFG_FILE } from "./cfg.js"
import { getAccounts } from "./accounts.js"
import { orgUin } from "../uin.js"

/**
 * QQBot 适配器的本地基础设施与消息工具
 *
 * 全部按 miao 原生方式实现：
 *   - 日志 → 全局 logger（核心已提供 mark 等级）
 *   - 持久化 → 本地 JSON Map（路径与旧版一致，老数据直接可用）
 *   - WebHook → 内置 node:http 服务
 *   - 事件 → emit 给全局 Bot，由 miao 的监听器交给插件加载器
 * 全局 Bot 只用于注册 QQBot 账号对象（miao 的 loader.deal 依赖 Bot[self_id]）。
 */

/** 适配器实例：由 adapter/index.js 在构造后注入（buildMiaoEvent / isMasterUser 需要它） */
let adapter = null
export function bindAdapter(instance) {
  adapter = instance
}

/**
 * sharp：图片超过 imageLength 时压缩
 *
 * 放在这里是因为适配器（compressImage）和指令插件（#QQBot图片限制）都要看它装没装；
 * 未安装或关闭压缩时为 undefined。
 */
export let sharp
if (config.imageLength)
  try {
    sharp = (await import("sharp")).default
  } catch (err) {
    log("error", ["sharp 导入错误，图片压缩关闭", err], "QQBot-Plugin")
  }

/** miao 的插件加载器，延迟导入避免插件加载期的循环依赖 */
let pluginsLoader = null
function getPluginsLoader() {
  pluginsLoader ||= import("../../../../lib/plugins/loader.js").then(m => m.default)
  return pluginsLoader
}

const LOG_LEVELS = ["trace", "debug", "info", "mark", "warn", "error", "fatal"]

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

function logValue(data) {
  if (typeof data === "string") return data
  if (data instanceof Error) return data.stack || String(data)
  if (Buffer.isBuffer(data)) return `<Buffer ${data.length}>`
  try {
    return util.inspect(data, {
      depth: 4,
      breakLength: 120,
      maxArrayLength: 50,
      maxStringLength: 1000,
    })
  } catch (err) {
    return String(data)
  }
}

/** 统一日志：直接调用 miao 的全局 logger */
function log(level, msg, id) {
  if (!LOG_LEVELS.includes(level)) level = "info"
  const args = []
  if (id !== false && id !== undefined && id !== null && id !== "")
    args.push(logger.blue?.(`[${id}]`) ?? `[${id}]`)
  for (const i of Array.isArray(msg) ? msg : [msg]) args.push(logValue(i))
  try {
    ;(logger[level] || logger.info)(...args)
  } catch (err) {
    logger.error(...args)
  }
}

/* ------------------------------ 持久化 Map ------------------------------ */

const MAP_TAG = "__qqbot_map__"
const mapCache = new Map()

function encodeMapValue(v) {
  if (v instanceof Map) return { [MAP_TAG]: [...v].map(([k, val]) => [k, encodeMapValue(val)]) }
  if (Array.isArray(v)) return v.map(encodeMapValue)
  if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
    const o = {}
    for (const k in v) o[k] = encodeMapValue(v[k])
    return o
  }
  return v
}

function decodeMapValue(v) {
  if (Array.isArray(v)) return v.map(decodeMapValue)
  if (v && typeof v === "object") {
    if (Array.isArray(v[MAP_TAG])) {
      const map = new Map()
      for (const [k, val] of v[MAP_TAG]) map.set(k, decodeMapValue(val))
      return map
    }
    const o = {}
    for (const k in v) o[k] = decodeMapValue(v[k])
    return o
  }
  return v
}

function scheduleSave(store) {
  if (store.timer) clearTimeout(store.timer)
  store.timer = setTimeout(() => {
    store.timer = null
    saveMap(store)
  }, 1000)
  store.timer.unref?.()
}

async function saveMap(store) {
  try {
    await fs.mkdir(path.dirname(store.file), { recursive: true })
    const obj = {}
    for (const [k, v] of store.map) obj[k] = encodeMapValue(v)
    await fs.writeFile(store.file, JSON.stringify(obj), "utf8")
  } catch (err) {
    logger.error("[QQBot][Map] 保存失败", store.file, err)
  }
}

/** 让 set/delete 触发落盘；嵌套 Map（如 gml）同样接管 */
function wrapMap(map, store) {
  if (map.__qqbotWrapped) return map
  Object.defineProperty(map, "__qqbotWrapped", { value: true, enumerable: false })
  const rawSet = map.set.bind(map)
  const rawDelete = map.delete.bind(map)
  map.set = (key, value) => {
    if (value instanceof Map) wrapMap(value, store)
    rawSet(key, value)
    scheduleSave(store)
    return map
  }
  map.delete = key => {
    const ret = rawDelete(key)
    scheduleSave(store)
    return ret
  }
  return map
}

function wrapNested(value, store, depth = 0) {
  if (depth > 4) return
  if (value instanceof Map) {
    wrapMap(value, store)
    for (const [, v] of value) wrapNested(v, store, depth + 1)
  }
}

/**
 * 好友 / 群 / 群成员数据的持久化 Map
 *
 * miao 的 icqq 自带 Bot.fl / Bot.gl，但 QQBot 账号不是 icqq 登录的，没有现成落盘，
 * 因此这里自己存 `${dir}.json`（路径与旧版一致：data/QQBot/<id>/Friend.json）。
 */
async function getMap(dir) {
  const file = `${dir}.json`
  const cached = mapCache.get(file)
  if (cached) return cached.map

  const store = { file, map: new Map(), timer: null }
  mapCache.set(file, store)

  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8"))
    for (const k in raw) store.map.set(k, decodeMapValue(raw[k]))
  } catch (err) {
    if (err?.code !== "ENOENT") logger.debug("[QQBot][Map] 读取失败", file, err)
  }

  wrapMap(store.map, store)
  for (const [, v] of store.map) wrapNested(v, store)
  return store.map
}

/* ------------------------------ 文件 / 命令 ------------------------------ */

async function fsStat(p, opts) {
  try {
    return await fs.stat(p, opts)
  } catch (err) {
    return false
  }
}

async function mkdir(dir, opts = {}) {
  try {
    await fs.mkdir(dir, { recursive: true, ...opts })
    return true
  } catch (err) {
    log("error", ["创建", dir, "错误", err])
    return false
  }
}

async function rm(file, opts = {}) {
  try {
    await fs.rm(file, { force: true, recursive: true, ...opts })
    return true
  } catch (err) {
    log("error", ["删除", file, "错误", err])
    return false
  }
}

function sleep(time, promise) {
  if (promise) return Promise.race([promise, delay(time)])
  return delay(time)
}

function exec(cmd, opts = {}) {
  return new Promise(resolve => {
    childExec(cmd, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        log("error", ["执行命令错误", toStr(cmd), err.message || err])
        return resolve(String(stderr || ""))
      }
      resolve(String(stdout || "").trim())
    })
  })
}

/**
 * 取文件内容
 * - opts.http 为真时，http(s) 地址原样返回
 * - opts.file 为真时，本地文件返回 file:// 绝对路径
 */
async function toBuffer(data, opts = {}) {
  /** Uint8Array / ArrayBuffer 也要按二进制处理，否则会被 toStr JSON 成一坨数字 */
  const binary = toBinary(data)
  if (binary) data = binary
  else {
    data = toStr(data)
    if (data.startsWith("base64://")) {
      data = Buffer.from(data.replace("base64://", ""), "base64")
    } else if (/^data:[^/]+\/[^;]+;base64,/.test(data)) {
      data = Buffer.from(data.replace(/^data:[^/]+\/[^;]+;base64,/, ""), "base64")
    } else if (/^https?:\/\//.test(data)) {
      if (opts.http) return data
      const res = await fetch(data)
      data = Buffer.from(await res.arrayBuffer())
    } else {
      const file = data.replace(/^file:\/\//, "")
      if (await fsStat(file)) {
        if (opts.file) return `file://${path.resolve(file)}`
        data = await fs.readFile(file)
      }
    }
  }

  if (Buffer.isBuffer(data) && typeof opts.size === "number" && data.length > opts.size) {
    const file = path.join(
      "temp",
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    await fs.writeFile(file, data)
    setTimeout(() => rm(file), 60000).unref?.()
    return `file://${path.resolve(file)}`
  }
  return data
}

/* --------------------------- 内置 WebHook 服务 --------------------------- */

function addResHelpers(res) {
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.send = body => {
    if (body === undefined || body === null) return res.end()
    if (typeof body === "object") {
      if (!res.getHeader("Content-Type"))
        res.setHeader("Content-Type", "application/json; charset=utf-8")
      return res.end(JSON.stringify(body))
    }
    return res.end(String(body))
  }
  res.json = body => {
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify(body))
  }
  res.sendStatus = code => {
    res.statusCode = code
    res.end(String(code))
  }
  return res
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function detectContentType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg"
  if (
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP")
  )
    return buffer.subarray(0, 4).toString() === "RIFF" ? "image/webp" : "image/png"
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return "image/gif"
  if (buffer.subarray(0, 2).toString() === "BM") return "image/bmp"
  return "application/octet-stream"
}

function extensionFromContentType(type) {
  return (
    {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
    }[type] || ""
  )
}

async function contentType(name, file) {
  const ext = path.extname(name).toLowerCase()
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".silk": "audio/silk",
  }
  if (map[ext]) return map[ext]

  const handle = await fs.open(file, "r")
  try {
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return detectContentType(header.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/**
 * 内置 WebHook / 静态文件服务
 *
 * miao 没有 express，这里用 node:http 提供 WebHook 回调与 markdown 图片直链，
 * 端口见 plugins/QQBot-Plugin/config/config/cfg.yaml 里的 webhookPort，链路为 /QQBot 与 /QQBot/File/<name>。
 */
const webhook = {
  routes: new Map(),
  files: new Map(),
  server: null,
  initialized: false,
  warnedAccounts: new Set(),

  restartNotice(account) {
    if (!this.initialized || this.server || !account.webhook) return ""
    return "HTTP 服务未启动，WebHook 账号需要重启 Yunzai 后才能接入，请确认已配置有效的 webhookPort 和公网反向代理"
  },

  warnPendingAccounts() {
    const pending = new Set()
    for (const account of getAccounts(config)) {
      const notice = this.restartNotice(account)
      if (!notice) continue
      pending.add(account.appid)
      if (!this.warnedAccounts.has(account.appid))
        logger.warn(`[QQBot] 账号 ${account.uin}（AppID ${account.appid}）：${notice}`)
    }
    this.warnedAccounts = pending
  },

  use(route, handler) {
    this.routes.set(route, handler)
    return this
  },

  /** 只在插件初始化时决定是否监听，配置热更新不再临时拉起 HTTP 服务。 */
  init() {
    if (this.initialized) return this.server
    this.initialized = true
    if (!getAccounts(config).some(account => account.webhook)) return null
    const port = Number(config.webhookPort) || 0
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      logger.warn(
        `[QQBot] 未配置有效的 webhookPort，WebHook 模式不可用（请修改 ${CFG_FILE} 后重启 Yunzai）`,
      )
      return null
    }

    this.server = http.createServer(async (req, res) => {
      addResHelpers(res)
      req.res = res
      const url = (req.url || "").split("?")[0]
      try {
        if (req.method === "POST") {
          const body = await readBody(req)
          try {
            req.body = body.length ? JSON.parse(body.toString("utf8")) : {}
          } catch (err) {
            req.body = {}
          }
        }

        if (url.startsWith("/QQBot/File/")) return await this.serveFile(req, res, url)

        const handler = this.routes.get(url)
        if (handler) {
          await handler(req, res)
          /** 处理器未响应时兜底结束，避免请求悬挂 */
          if (!res.writableEnded) res.end()
          return
        }

        res.statusCode = 404
        res.end()
      } catch (err) {
        logger.error("[QQBot] WebHook 请求处理错误", err)
        try {
          res.statusCode = 500
          res.end()
        } catch (e) {}
      }
    })

    this.server.on("error", err => {
      logger.error(`[QQBot] WebHook 服务启动失败（端口 ${port}）`, err.message || err)
      this.server = null
    })
    this.server.listen(port, () =>
      logger.mark(`[QQBot] WebHook 服务已启动，路径 /QQBot，端口 ${port}`),
    )
    return this.server
  },

  async serveFile(req, res, url) {
    const name = decodeURIComponent(url.replace(/^\/QQBot\/File\//, ""))
    let file = this.files.get(name)
    if (!file) file = path.join("data", "QQBot", "File", name)
    const stat = await fsStat(file)
    if (!stat) {
      res.statusCode = 404
      return res.end()
    }
    res.setHeader("Content-Type", await contentType(name, file))
    res.setHeader("Content-Length", stat.size)
    createReadStream(file).pipe(res)
  },
}

configEvents.on("change", () => webhook.warnPendingAccounts())

let warnedPublicUrl = false
/** 只提示一次：公网直链不可用时 markdown 内嵌不了图片 */
function warnNoPublicUrl(hasUrl) {
  if (warnedPublicUrl) return
  warnedPublicUrl = true
  logger.warn(
    hasUrl
      ? "[QQBot] 配置了 url 但内置 HTTP 文件服务未启动，图片直链不可访问；" +
          "图片已改为普通图片消息发送。如需 markdown 内嵌请配置 WebHook 账号与 webhookPort 后重启 Yunzai"
      : `[QQBot] 未配置 ${CFG_FILE}: url（公网地址），markdown 里无法内嵌图片；` +
          "图片已改为普通图片消息发送。如需 markdown 内嵌请填写公网地址、配置 WebHook 账号与 webhookPort 后重启 Yunzai",
  )
}

/**
 * 把文件转成可被 QQ 拉取的公网直链
 *
 * 配置了公网地址 config.url 时把文件落到 data/QQBot/File 并返回公网直链；
 * 没配置时**不能**把 Buffer / base64 当 URL 返回（会被拼进 markdown，渲染成一堆乱码），
 * 因此 http 链接原样返回，其余返回空串，由调用方改走普通（富媒体）消息发送。
 */
async function fileToUrl(file, opts = {}) {
  const buffer = await toBuffer(file, { http: true })
  if (typeof buffer === "string" && /^https?:\/\//.test(buffer)) return buffer

  const base = String(config.url || "").trim()
  /** 必须有公网地址，且内置文件服务（webhookPort）在跑，直链才可访问 */
  if (!base || !webhook.server?.listening) {
    warnNoPublicUrl(!!base)
    return ""
  }

  const buffer_ = Buffer.isBuffer(buffer) ? buffer : await toBuffer(file)
  if (!Buffer.isBuffer(buffer_)) return ""

  const name =
    opts.name ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${
      typeof file === "string" && !file.startsWith("base64://") && !/^https?:/.test(file)
        ? path.extname(file.replace(/^file:\/\//, ""))
        : extensionFromContentType(detectContentType(buffer_))
    }`

  const dir = path.join("data", "QQBot", "File")
  await mkdir(dir)
  const target = path.join(dir, name)
  await fs.writeFile(target, buffer_)
  webhook.files.set(name, target)

  return `${String(base).replace(/\/+$/, "")}/QQBot/File/${encodeURIComponent(name)}`
}

/* ------------------------------- 事件投递 ------------------------------- */

/**
 * QQBot 账号（Bot[id]）列表
 *
 * miao 的 Bot.uin 是单个 icqq 账号，没有多适配器账号数组，
 * 因此这里直接扫描全局 Bot 上注册的 QQBot 账号对象。
 */
function qqbotIds() {
  const real = globalThis.Bot
  if (!real) return []
  /** miao 约定同 napcat-adapter：Bot[id].adapter 是适配器名字符串 */
  return Object.keys(real).filter(key => real[key]?.adapter === "QQBot")
}

/**
 * 维护全局 Bot.adapter
 *
 * miao 社区约定（napcat-adapter / plugins/system/stdin.js）：
 * Bot.adapter 是「在线适配器账号」的数组，元素是 uin 而不是适配器对象，
 * 这样 yenai 的 `Bot.adapter.includes(e.self_id)`、快递订阅等才能识别本适配器的账号。
 */
function markAdapterId(id, online) {
  const real = globalThis.Bot
  if (!real) return
  if (!Array.isArray(real.adapter)) real.adapter = []
  const index = real.adapter.indexOf(id)
  if (online) {
    if (index < 0) real.adapter.push(id)
    const hasUin = real.uin !== undefined && real.uin !== null && real.uin !== ""
    if (!hasUin || Array.isArray(real.uin)) {
      const hasOrgUin = orgUin !== undefined && orgUin !== null && orgUin !== "" && !Array.isArray(orgUin)
      real.uin = hasOrgUin ? orgUin : id
    }
  } else if (index >= 0) {
    real.adapter.splice(index, 1)
  }
}

function masterList() {
  const list = [...(cfg.masterQQ || [])]
  if (Array.isArray(config.master)) list.push(...config.master)
  return list.map(String)
}

/**
 * 解析主人身份：
 * - 普通 QQ 号（前缀已被剥掉）直接匹配 miao 的 masterQQ
 * - 官方 Bot 的 user_id 是 openid，只能靠 #QQBot绑定用户 的绑定关系还原
 */
function isMasterUser(rawUserId, plainUserId) {
  const masters = masterList()
  if (!masters.length) return false
  const candidates = []
  const bind = adapter?.bind_user?.[rawUserId]
  if (bind) candidates.push(String(bind))
  const cached = cachedFriend(rawUserId)
  if (cached?.real_id) candidates.push(String(cached.real_id))
  if (plainUserId) candidates.push(String(plainUserId))
  return candidates.some(id => masters.includes(id) || masters.includes(String(Number(id))))
}

function cachedFriend(rawUserId) {
  try {
    const real = globalThis.Bot
    for (const id of qqbotIds()) {
      const info = real[id]?.fl?.get?.(rawUserId)
      if (info) return info
    }
  } catch (err) {}
  return undefined
}

/** 把适配器的内部 data 转成 miao 插件能吃的 icqq 风格事件 */
function buildMiaoEvent(data) {
  if (!adapter) return null
  const sep = adapter.sep
  const selfId = String(data.self_id ?? "")
  const prefix = `${selfId}${sep}`
  const strip = value =>
    typeof value === "string" && prefix.length > 1 && value.startsWith(prefix)
      ? value.slice(prefix.length)
      : value

  const rawUserId =
    data.sender?.user_id ?? (typeof data.user_id === "string" ? data.user_id : undefined)
  const rawGroupId = typeof data.group_id === "string" ? data.group_id : undefined
  const plainUserId = strip(rawUserId)
  const plainGroupId = strip(rawGroupId)

  /** at 段里的 qq 同样去掉实例前缀，miao 插件按裸 ID 比对 */
  const message = (data.message || []).map(i =>
    i?.type === "at" ? { ...i, qq: strip(i.qq) } : i,
  )

  const e = {
    raw: data.raw,
    bot: data.bot,
    self_id: data.self_id,
    post_type: data.post_type || "message",
    message_type: data.message_type,
    sub_type: data.sub_type,
    notice_type: data.notice_type,
    message_id: data.message_id,
    time: data.time,
    timestamp: data.time,
    message,
    raw_message: data.raw_message,
    user_id: plainUserId,
    sender: { ...(data.sender || {}), user_id: plainUserId },
    qqbot: true,
  }

  if (rawGroupId) e.group_id = plainGroupId
  if (data.raw?.message_type === "guild") e.detail_type = "guild"
  /** 适配器标识（napcat-adapter 同样会给事件挂 e.adapter），供插件区分平台 */
  e.adapter = adapter.id

  try {
    const sendFile = (file, name) =>
      data.reply({ type: "file", file, ...(name ? { name } : {}) })

    if (rawGroupId) {
      e.group = adapter.pickGroup(data.self_id, rawGroupId)
      if (e.message_type === "group" && typeof data.reply === "function")
        e.group.sendFile = sendFile
      e.group_name = e.group?.name
      if (rawUserId) e.member = adapter.pickMember(data.self_id, rawGroupId, rawUserId)
    }
    if (rawUserId && e.message_type === "private") {
      e.friend = adapter.pickFriend(data.self_id, rawUserId)
      if (data.sub_type === "friend" && typeof data.reply === "function")
        e.friend.sendFile = sendFile
    }
  } catch (err) {
    log("debug", ["构造场景对象失败", err], data.self_id)
  }

  if (isMasterUser(rawUserId, plainUserId)) e.isMaster = true
  /**
   * 群里 @ 了机器人
   *
   * 不再往 message 里塞一个「机器人自己的 at 段」——那会被插件转发/回显到回复里，
   * 变成适配器凭空多加的 @。直接把 atBot 打在事件上即可（miao 的 dealMsg 只会置 true，不会清掉）。
   */
  if (data._at) e.atBot = true
  /** 透传 reply 第 3 个参数（keyboard / button / markdown 等 QQ 官方扩展） */
  if (typeof data.reply === "function") installReplyExtra(e, data.reply)
  return e
}

/**
 * 透传 reply 的第 3 个参数
 *
 * miao 的 PluginsLoader.reply 只把 (msg, quote) 交给适配器，插件用
 * `e.reply(msg, quote, { keyboard / button / markdown })` 传的 QQ 官方扩展会被丢掉。
 *
 * 这里只在事件自己的 reply 上包一层：
 *   1. 核心先读 e.reply（getter 给出适配器原始 reply）存进 e.replyNew；
 *   2. 核心再回写包装后的 e.reply，落入 setter，被我们记下来；
 *   3. 调用时若带了第 3 个参数，才临时把 e.replyNew 换成带参版本，核心的
 *      at / recallMsg / 计数逻辑照旧执行，其它适配器完全不受影响。
 */
function installReplyExtra(e, rawReply) {
  let coreReply = null
  Object.defineProperty(e, "reply", {
    configurable: true,
    enumerable: true,
    get() {
      return coreReply || rawReply
    },
    set(fn) {
      coreReply = async (msg, quote, extra) => {
        if (!extra || typeof extra !== "object" || !Object.keys(extra).length)
          return fn(msg, quote, extra)
        const keep = e.replyNew
        e.replyNew = (m, q) => rawReply(m, q, extra)
        try {
          return await fn(msg, quote, extra)
        } finally {
          e.replyNew = keep
        }
      }
    },
  })
}

/**
 * 事件投递
 * - `connect.<id>` 之类照旧走全局 Bot 的 EventEmitter
 * - 消息事件按 napcat-adapter 的做法 emit 到全局 Bot，由 miao 的
 *   lib/events/message.js 监听后交给插件加载器（无监听者时退回直接 deal）
 */
async function dispatch(event, data) {
  if (typeof event === "string" && event.startsWith("connect.")) {
    globalThis.Bot?.emit?.(event, data)
    return
  }
  if (!data || typeof data !== "object") return
  if (data.post_type !== "message") return

  const e = buildMiaoEvent(data)
  if (!e) return
  warnUnreachable(e)

  const real = globalThis.Bot
  /**
   * 与 napcat-adapter 一致：把事件 emit 到全局 Bot（icqq 客户端）上，
   * miao 的 lib/events/message.js 监听到 message 后会调用 PluginsLoader.deal(e)；
   * 这样其它 `Bot.on("message" / "message.group")` 的插件也能收到 QQBot 消息。
   * 没有监听者时（例如控制台模式）退回直接 deal，避免消息丢失。
   */
  if (typeof real?.emit === "function" && real.listenerCount?.("message") > 0) {
    real.emit("message", e)
    if (e.message_type) real.emit(`message.${e.message_type}`, e)
    return
  }

  try {
    const loader = await getPluginsLoader()
    await loader.deal(e)
  } catch (err) {
    log("error", ["插件事件处理错误", err], e.self_id)
  }
}

/** 被 other.yaml 白名单静默拦截时给出一次提示，避免"机器人没反应"无从排查 */
const warned = new Set()
function warnUnreachable(e) {
  try {
    const other = cfg.getOther?.() || {}
    const key = `${e.self_id}:${e.group_id ?? e.user_id}`
    if (warned.has(key)) return

    if (e.group_id) {
      if (
        other.whiteGroup?.length &&
        !other.whiteGroup.find(a => a == `${e.self_id}:${e.group_id}` || a == e.group_id)
      ) {
        warned.add(key)
        log(
          "warn",
          [
            `群 ${e.self_id}:${e.group_id} 不在 config/config/other.yaml 的 whiteGroup 中，消息不会触发任何插件；` +
              `如需启用请把上面这个 id 加进 whiteGroup`,
          ],
          e.self_id,
        )
      }
      return
    }

    const uid = Number(e.user_id) || String(e.user_id)
    if (other.whiteQQ?.length && !other.whiteQQ.includes(uid)) {
      warned.add(key)
      log("warn", [`用户 ${uid} 不在 config/config/other.yaml 的 whiteQQ 中，消息不会触发任何插件`], e.self_id)
    }
  } catch (err) {}
}

/**
 * 群聊 / 单聊消息事件（两者在网关侧是同一个 bit）
 *
 * 额外申请 INTERACTION：消息按钮（keyboard）里 action.type=1 的「回调按钮」点击后，
 * 平台靠这个 intent 把 INTERACTION_CREATE 推给机器人；不申请的话事件根本到不了本地，
 * 用户点完按钮（二次确认之后）客户端只会提示“请求第三方失败”。
 */
const GROUP_INTENTS = ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "INTERACTION"]
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
const OPTIONAL_INTENTS = ["INTERACTION", "MESSAGE_AUDIT", "GUILD_MEMBERS", "PUBLIC_GUILD_MESSAGES"]

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

/** 发送模式：auto（默认，只有显式 markdown / 按钮 才走 markdown）/ markdown（强制）/ text（连 markdown 段也不走） */
const SEND_MODES = ["markdown", "text", "auto"]

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
  getPluginsLoader,
  LOG_LEVELS,
  circularReplacer,
  toStr,
  logValue,
  log,
  MAP_TAG,
  mapCache,
  encodeMapValue,
  decodeMapValue,
  scheduleSave,
  saveMap,
  wrapMap,
  wrapNested,
  getMap,
  fsStat,
  mkdir,
  rm,
  sleep,
  exec,
  toBuffer,
  addResHelpers,
  readBody,
  detectContentType,
  extensionFromContentType,
  contentType,
  webhook,
  warnedPublicUrl,
  warnNoPublicUrl,
  fileToUrl,
  qqbotIds,
  markAdapterId,
  masterList,
  isMasterUser,
  cachedFriend,
  buildMiaoEvent,
  installReplyExtra,
  dispatch,
  warned,
  warnUnreachable,
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
  toBinary,
  toSegment,
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
