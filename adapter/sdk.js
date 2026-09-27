/**
 * QQ 官方 SDK 适配层
 *
 * 把 `qq-official-bot@1.3.0` 的差异集中在这里，index.js 只调本文件的接口：
 *   - 配置：1.3.0 必须显式给 `mode`，`sandbox` 要映射成 `apiBaseUrl`，
 *     群/单聊 intent 名要映射成 `GROUP_AND_C2C_EVENT`；
 *   - 消息段：1.3.0 收发都是 `{type, data:{...}}`，这里做双向转换；
 *   - 事件：补齐 `group_id`（网关给的是 `group_openid`）、`user_name`、`sender.card`，
 *     并用 `_eventName` 标注真实事件名（`message.group.at`）以便识别"被@"；
 *   - 连接：1.3.0 的 `start()` 在 receiver ready 时 resolve，致命关闭码要主动 reject。
 *
 * 换成其它 SDK 时只改这个文件。
 */

import SDK from "qq-official-bot"

export const SDK_NAME = "qq-official-bot"
export const SDK_VERSION = "1.3.0"

export const { Bot, QQEvent, getFileBase64, Intends, ReceiverMode } = SDK

const { FileProcessor, md5, sha1, md5_10m } = SDK

/* ------------------------------------------------------------------ *
 * 修复 SDK 分片上传的「分片序号基数」问题
 *
 * 实测平台 upload_prepare 返回的分片序号是 1 起始（parts[0].index === 1），
 * 而 qq-official-bot@1.3.0 的 FileProcessor.uploadByChunks 用
 * `part.index * blockSize` 算偏移，首片就会越界 → 上传空分片 →
 * 合并报 `850019 不支持的文件格式`。
 *
 * 这里按序号基数归一化偏移，`upload_part_finish` 仍回传平台原始序号。
 * 只 patch 原型，SDK 其余行为（构建消息、内容/引用/键盘）完全不变。
 * ------------------------------------------------------------------ */

const DEFAULT_FILE_NAMES = { 1: "image.png", 2: "video.mp4", 3: "audio.silk", 4: "file.bin" }

function toPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0
  const count = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < items.length) await worker(items[cursor++])
    }),
  )
}

async function withRetry(task, timeoutMs, delayMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() <= deadline) {
    try {
      return await task()
    } catch (err) {
      lastError = err
      if (Date.now() + delayMs > deadline) break
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function putChunk(url, chunk) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(chunk.length),
    },
    body: chunk,
  })
  if (!res.ok) throw new Error(`富媒体分片上传失败：HTTP ${res.status}`)
}

async function uploadByChunksFixed(buffer, options) {
  options = this.withFileType(options)
  const fileName = options.fileName || DEFAULT_FILE_NAMES[options.fileType]
  const prepared = await this.prepareUpload(options.targetType, options.targetId, {
    file_type: options.fileType,
    file_size: String(buffer.length),
    file_name: fileName,
    md5: md5(buffer),
    sha1: sha1(buffer),
    md5_10m: md5_10m(buffer),
  })

  const parts = Array.isArray(prepared.parts) ? prepared.parts : []
  const indexes = parts.map(part => Number(part?.index)).filter(Number.isInteger)
  if (!prepared.upload_id || !parts.length || indexes.length !== parts.length)
    throw new Error("富媒体预上传响应缺少 upload_id 或 parts")

  const indexBase = indexes.includes(0) ? 0 : Math.min(...indexes)
  const blockSize = toPositiveNumber(prepared.block_size, 5 * 1024 * 1024)
  const uploadConfig = prepared.upload_config || {}
  const timeoutMs = toPositiveNumber(uploadConfig.retry_timeout, 300) * 1000
  const delayMs = toPositiveNumber(uploadConfig.retry_delay, 1) * 1000

  await runWithConcurrency(parts, toPositiveNumber(uploadConfig.concurrency, 1), async part => {
    if (!part?.presigned_url) throw new Error("富媒体预上传返回了无效分片")
    const partIndex = Number(part.index)
    const partSize = toPositiveNumber(part.block_size, blockSize)
    const start = (partIndex - indexBase) * blockSize
    const end = Math.min(start + partSize, buffer.length)
    const chunk = buffer.subarray(start, end)
    if (!chunk.length)
      throw new Error(
        `富媒体分片 ${partIndex} 超出文件范围（base=${indexBase}, size=${buffer.length}, block=${blockSize}）`,
      )

    await withRetry(() => putChunk(part.presigned_url, chunk), timeoutMs, delayMs)
    await withRetry(
      () =>
        this.finishUploadPart(options.targetType, options.targetId, {
          upload_id: prepared.upload_id,
          part_index: partIndex,
          block_size: String(chunk.length),
          md5: md5(chunk),
        }),
      timeoutMs,
      delayMs,
    )
  })

  return this.completeUpload(options, prepared.upload_id, fileName)
}

FileProcessor.prototype.uploadByChunks = uploadByChunksFixed

/** 沙箱环境 HTTP 域名 */
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com"

/** 我们内部的 intent 名 → 1.3.0 的 Intends 键 */
const INTENT_ALIASES = {
  GROUP_AT_MESSAGE_CREATE: "GROUP_AND_C2C_EVENT",
  C2C_MESSAGE_CREATE: "GROUP_AND_C2C_EVENT",
}

/** 握手阶段的致命关闭码：重试无意义 */
export const FATAL_CLOSE_CODES = [4001, 4002, 4007, 4010, 4011, 4012, 4013, 4014, 4914, 4915]

/** 把内部 intent 名映射成 1.3.0 的 Intends 键（群/单聊合并成一个 bit） */
export function mapIntents(intents = []) {
  const out = []
  for (const name of intents) {
    const mapped = INTENT_ALIASES[name] || name
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

/**
 * 出站：扁平段 `{type, text}` → `{type, data:{text}}`
 * 已经是 `data` 形状的段原样返回。
 */
export function adaptSendableForSDK(msg) {
  if (msg === null || msg === undefined) return msg
  if (typeof msg === "string") return msg
  if (Array.isArray(msg)) return msg.map(adaptSendableForSDK)
  if (typeof msg !== "object") return msg
  if (msg.data && typeof msg.data === "object") return msg
  const { type, ...rest } = msg
  return { type, data: rest }
}

/** 入站：`{type, data:{text}}` → `{type, text}` */
export function flattenReceivedMessage(msg) {
  if (!Array.isArray(msg)) return msg
  return msg.map(item => {
    if (!item || typeof item !== "object") return item
    if (item.data && typeof item.data === "object" && !item.text && !item.qq && !item.url && !item.file)
      return { type: item.type, ...item.data }
    return item
  })
}

/**
 * 创建 SDK 实例
 *
 * opts 沿用我们原有配置：`{ appid, token, secret, intents, sandbox, timeout, maxRetry, retryDelay, connectTimeout }`
 */
export function createBot(opts = {}) {
  const config = {
    appid: opts.appid,
    secret: opts.secret,
    token: opts.token,
    intents: mapIntents(opts.intents),
    /** 1.3.0 必须显式指定，否则 ReceiverFactory 直接抛 Unknown receiver mode */
    mode: ReceiverMode.WEBSOCKET,
    timeout: opts.timeout,
    maxRetry: opts.maxRetry,
    reconnectDelay: opts.retryDelay,
  }
  if (opts.sandbox) config.apiBaseUrl = SANDBOX_API_BASE

  const sdk = new Bot(config)

  /**
   * 标注真实事件名
   *
   * 1.3.0 的 Client.em 会按 `message` → `message.group` → `message.group.at` 逐级 emit，
   * 但 payload 上的 `message_type` 只是 `group`，无法区分"群里随便说"和"@了机器人"。
   * 这里把解析后的事件名记到 `_eventName`，供 makeMessage 判断是否补 @ 段。
   */
  const rawEm = sdk.em.bind(sdk)
  sdk.em = (event, payload) => {
    if (payload && typeof payload === "object") payload._eventName = event
    return rawEm(event, payload)
  }
  return sdk
}

/**
 * 登录
 *
 * 1.3.0 的 `start()` 在 receiver ready 时 resolve；错误会走 receiver 的
 * `error` / `close` 事件（致命关闭码不会自动重连），所以这里主动监听并 reject。
 */
export function login(sdk, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const receiver = sdk?.sessionManager?.receiver
    if (!receiver) return reject(new Error("SDK receiver 未初始化"))

    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      receiver.off("ready", onReady)
      receiver.off("close", onClose)
      fn(arg)
    }
    const onReady = () => done(resolve)
    const onClose = (code, reason) => {
      if (FATAL_CLOSE_CODES.includes(Number(code)))
        done(reject, new Error(`${code} ${reason || ""}`.trim()))
    }

    const timer = setTimeout(
      () => done(reject, new Error(`连接超时（${timeoutMs}ms）`)),
      timeoutMs,
    )
    receiver.on("ready", onReady)
    receiver.on("close", onClose)
    sdk.start().catch(err => done(reject, err))
  })
}

/** 退出 */
export function logout(sdk) {
  return Promise.resolve(sdk?.stop?.()).catch(() => {})
}

/**
 * 把 1.3.0 的事件补齐成我们内部一直使用的形状
 *   - `group_id`：网关消息事件给的是 `group_openid`
 *   - `user_name` / `sender.card` / `sender.nickname`：1.3.0 只有 `sender.user_name`
 *   - `message`：段形状拍平成扁平结构
 */
export function normalizeEvent(event) {
  if (!event || typeof event !== "object") return event

  if (event.group_id === undefined && event.group_openid !== undefined)
    event.group_id = event.group_openid

  const sender = event.sender
  if (sender && typeof sender === "object") {
    if (sender.nickname === undefined) sender.nickname = sender.user_name
    if (sender.card === undefined) sender.card = sender.user_name
  }
  if (event.user_name === undefined && sender?.user_name !== undefined)
    event.user_name = sender.user_name

  if (Array.isArray(event.message) && event.message.some(i => i && typeof i === "object" && i.data))
    event.message = flattenReceivedMessage(event.message)

  return event
}
