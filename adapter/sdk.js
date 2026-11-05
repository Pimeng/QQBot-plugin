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
import process from "node:process"
import { normalizeReceivedSegment, prepareReceivedPayload, receivedMessageText } from "./message/received.js"
import { unixTime } from "./compat.js"

export const SDK_NAME = "qq-official-bot"
export const SDK_VERSION = "1.3.0"

export const { Bot, resolveGatewayEvent, getFileBase64, Intends, ReceiverMode } = SDK

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

async function putChunk(url, chunk, timeoutMs) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(chunk.length),
    },
    body: chunk,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`富媒体分片上传失败：HTTP ${res.status}`)
}

async function uploadByChunksFixed(buffer, options) {
  if (!buffer?.length) throw new Error("缺少可上传的文件数据")
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
  if (!prepared.upload_id || !Array.isArray(prepared.parts) || indexes.length !== parts.length)
    throw new Error("富媒体预上传响应缺少 upload_id 或 parts")
  // 秒传时无需 PUT 分片，仍通过 files 合并取得 file_info/raw_url。
  if (!parts.length) return this.completeUpload(options, prepared.upload_id, fileName)
  const sortedIndexes = [...indexes].sort((a, b) => a - b)
  if (![0, 1].includes(sortedIndexes[0]) || sortedIndexes.some((n, i) => n !== sortedIndexes[0] + i))
    throw new Error("富媒体预上传返回了不连续或重复的分片序号")

  const indexBase = indexes.includes(0) ? 0 : Math.min(...indexes)
  const blockSize = toPositiveNumber(prepared.block_size, 5 * 1024 * 1024)
  const uploadConfig = prepared.upload_config || {}
  const timeoutMs = toPositiveNumber(uploadConfig.retry_timeout, 300) * 1000
  const delayMs = toPositiveNumber(uploadConfig.retry_delay, 1) * 1000
  if (parts.length !== Math.ceil(buffer.length / blockSize))
    throw new Error("富媒体预上传分片数量与文件大小不匹配")

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

    await withRetry(() => putChunk(part.presigned_url, chunk, Math.max(5000, Math.min(timeoutMs, 120000))), timeoutMs, delayMs)
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
 * opts 沿用我们原有配置：`{ appid, secret, intents, sandbox, timeout, maxRetry, retryDelay, connectTimeout }`
 *
 * 注意：v1 时代的 Bot Token 已作废，取凭证只认 appid + secret
 * （POST /app/getAppAccessToken 换 access_token），所以这里不再透传 token。
 */
export function createBot(opts = {}) {
  const config = {
    appid: opts.appid,
    secret: opts.secret,
    intents: mapIntents(opts.intents),
    /** 1.3.0 必须显式指定，否则 ReceiverFactory 直接抛 Unknown receiver mode */
    mode: ReceiverMode.WEBSOCKET,
    timeout: opts.timeout,
    maxRetry: opts.maxRetry,
    reconnectDelay: opts.retryDelay,
    // SDK 默认删除 mentions 里的所有 @，包括 @ 他人；由适配器保留并规范消息段。
    removeAt: false,
  }
  if (opts.sandbox) config.apiBaseUrl = SANDBOX_API_BASE

  // SDK 在每次构造时添加全局异常监听器，只用于 debug 日志。账号重连和
  // intents 降级会反复构造实例，保留这些闭包会泄漏实例并重复记录宿主异常。
  // 构造是同步的，仅移除本次新增的监听器，保留宿主和其它适配器已有监听。
  const processEvents = ["uncaughtException", "unhandledRejection"]
  const existingListeners = new Map(processEvents.map(name => [name, new Set(process.listeners(name))]))
  let sdk
  try {
    sdk = new Bot(config)
  } finally {
    for (const name of processEvents)
      for (const listener of process.listeners(name))
        if (!existingListeners.get(name).has(listener)) process.removeListener(name, listener)
  }
  // 1.3.0 的这两个方法仍直接抛 UnsupportedMethodError。按上游 GroupService
  // 的 /members 接口补齐，只在插件显式刷新时请求，不在每条入站消息上拉取。
  const pendingMembers = new Map()
  sdk.getGroupMemberInfo = async (groupId, userId) => {
    const { data } = await sdk.request.get(`/v2/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`)
    return data
  }
  sdk.getGroupMemberList = groupId => {
    if (pendingMembers.has(groupId)) return pendingMembers.get(groupId)
    const promise = (async () => {
      const members = new Map(), cursors = new Set()
      let cursor = ""
      for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
        const { data } = await sdk.request.get(`/v2/groups/${encodeURIComponent(groupId)}/members`, { params: { cursor } })
        if (!Array.isArray(data?.members)) throw new Error("QQBot 群成员响应缺少 members 数组")
        for (const member of data.members) if (member?.member_openid) members.set(member.member_openid, member)
        const next = data.next_cursor || ""
        if (!next) return [...members.values()]
        if (typeof next !== "string" || cursors.has(next)) throw new Error("QQBot 群成员分页游标无效或重复")
        cursors.add(next)
        cursor = next
      }
      throw new Error("QQBot 群成员分页超出上限")
    })()
    pendingMembers.set(groupId, promise)
    promise.then(() => pendingMembers.delete(groupId), () => pendingMembers.delete(groupId))
    return promise
  }
  const rawProcessPayload = sdk.processPayload.bind(sdk)
  sdk.processPayload = (id, name, payload) => {
    const type = payload?.message_type
    const isMessage = ["message.group", "message.group.at", "message.private.friend", "message.private.direct", "message.guild"].includes(name)
    // 1.3.0 的频道按钮 parser 误写为 resoloved；输入兼容别名保留真实 resolved。
    const input = name === "notice.guild.action" && payload?.data?.resolved
      ? { ...payload, data: { ...payload.data, resoloved: payload.data.resolved } } : payload
    const parsed = rawProcessPayload(id, name, isMessage ? prepareReceivedPayload(input) : input)
    if (parsed) {
      parsed._eventName = name
      if (name.startsWith("notice")) {
        parsed._qqbotTimestamp = payload?.timestamp
        for (const key of [
          "username", "member_role", "guild_id", "channel_id", "roles", "nick",
          "member_openid", "user_openid", "invited_by", "group_name", "op_member_openid", "join_request_id",
        ])
          if (parsed[key] === undefined && payload?.[key] !== undefined) parsed[key] = payload[key]
        if (!parsed.user_name && payload?.user?.username) parsed.user_name = payload.user.username
        if (payload?.user?.avatar) parsed.avatar = payload.user.avatar
        if (typeof payload?.bot === "boolean") parsed.is_bot = payload.bot
      }
    }
    if (parsed && Number.isFinite(Number(type))) parsed._qqbotMessageType = Number(type)
    return parsed
  }

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
  if (event.post_type === "notice") event.time = unixTime(event._qqbotTimestamp) ?? unixTime(event.time)

  const scene = readSceneExt(event)
  if (!event.msg_idx && scene.msg_idx) event.msg_idx = scene.msg_idx
  if (!event.ref_msg_idx && scene.ref_msg_idx) event.ref_msg_idx = scene.ref_msg_idx
  const { auth_token: _authToken, ...sceneExt } = scene
  if (Object.keys(sceneExt).length) event.scene_ext = sceneExt

  const sender = event.sender
  if (sender && typeof sender === "object") {
    if (event.author?.member_role !== undefined && sender.member_role === undefined) sender.member_role = event.author.member_role
    if (!sender.nickname) sender.nickname = sender.user_name || event.author?.username || sender.user_id
    if (sender.card === undefined) sender.card = event.member?.nick || ""
    const roles = Array.isArray(event.member?.roles) ? event.member.roles.map(String) : []
    if (event.message_type === "guild" && roles.length) {
      sender.roles = roles
      sender.role = guildRole(roles)
    } else {
      const role = sender.member_role || sender.role || sender.permissions?.find(value => ["owner", "admin", "member"].includes(value))
      if (["group", "guild"].includes(event.message_type))
        sender.role = ["owner", "admin"].includes(role) ? role : "member"
    }
    applyAuthorFields(event, sender)
  }
  if (!event.user_name && sender?.nickname) event.user_name = sender.nickname

  if (Array.isArray(event.message))
    event.message = event.message.map(item => normalizeReceivedSegment(item, event.mentions))

  appendRichMessageText(event)
  appendParallelMessage(event)
  appendElementMessage(event)
  normalizeQuotedEvent(event)
  appendVoiceTranscripts(event)
  if (Array.isArray(event.message)) event.raw_message = receivedMessageText(event.message)

  return event
}

/** message_scene.ext 是 key=value 数组，这里只取引用和去重需要的索引。 */
function readSceneExt(event) {
  const out = {}
  const ext = event?.message_scene?.ext
  if (!Array.isArray(ext)) return out
  for (const line of ext) {
    if (typeof line !== "string") continue
    const index = line.indexOf("=")
    if (index <= 0) continue
    out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

/** 频道成员角色使用官方数字角色组：4=频道主，2/5=管理员。 */
function guildRole(roles) {
  if (roles.includes("4")) return "owner"
  if (roles.some(role => role === "2" || role === "5")) return "admin"
  return "member"
}

/** 把 SDK sender 没带上的官方用户字段补进发送者缓存。 */
function applyAuthorFields(event, sender) {
  const author = event.author
  if (!author || typeof author !== "object") return
  for (const key of ["union_openid", "union_user_account"])
    if (author[key] && sender[key] === undefined) sender[key] = author[key]
  if (author.bot !== undefined) {
    if (sender.bot === undefined) sender.bot = Boolean(author.bot)
    if (sender.is_bot === undefined) sender.is_bot = Boolean(author.bot)
  }
}

/** 卡片或频道嵌入内容没有正文时，补一段可读文字，避免消息为空。 */
function appendRichMessageText(event) {
  if (!Array.isArray(event.message) || receivedMessageText(event.message).trim()) return event
  const text = [richText(event.ark_data), ...(Array.isArray(event.embeds) ? event.embeds.map(richText) : [])]
    .find(value => value && value.trim())
  if (text) event.message.push({ type: "text", text })
  return event
}

function richText(value) {
  if (!value || typeof value !== "object") return ""
  const fields = value.fields && typeof value.fields === "object" ? value.fields : value
  return [value.prompt, fields.title, fields.desc, fields.content]
    .find(item => typeof item === "string" && item.trim())?.trim() || ""
}

/** 递归读取引用元素正文：103 引用、102 聊天记录和 3 卡片都可能嵌套。 */
function elementText(element, depth = 0) {
  if (!element || typeof element !== "object" || depth > 4) return ""
  const parts = []
  if (typeof element.content === "string" && element.content.trim()) parts.push(element.content.trim())
  const card = richText(element.ark_data)
  if (card) parts.push(card)
  for (const item of Array.isArray(element.attachments) ? element.attachments : []) {
    if (typeof item?.asr_refer_text === "string" && item.asr_refer_text.trim())
      parts.push(item.asr_refer_text.trim())
  }
  for (const child of Array.isArray(element.msg_elements) ? element.msg_elements : []) {
    const text = elementText(child, depth + 1)
    if (text) parts.push(text)
  }
  return parts.join("\n")
}

/** 递归收集引用元素里的附件，按 URL 去重，避免嵌套元素重复。 */
function elementAttachments(element, output = [], depth = 0) {
  if (!element || typeof element !== "object" || depth > 4) return output
  for (const item of Array.isArray(element.attachments) ? element.attachments : []) {
    if (!item || typeof item !== "object") continue
    if (output.some(existing => existing === item || item.url && existing.url === item.url)) continue
    output.push(item)
  }
  for (const child of Array.isArray(element.msg_elements) ? element.msg_elements : [])
    elementAttachments(child, output, depth + 1)
  return output
}

/** 单个官方附件转成标准消息段；没有可下载地址时返回 undefined。 */
function attachmentSegment(item) {
  if (!item || typeof item !== "object") return undefined
  const mime = String(item.content_type || "").toLowerCase()
  const kind = mime === "voice" ? "audio" : mime.split("/")[0]
  const type = kind === "audio" ? "record" : ["image", "video"].includes(kind) ? kind : "file"
  let url = String(item.url ?? "")
  if (url.startsWith("//")) url = `https:${url}`
  // SDK 会把缺失地址补成 "https://"；无法下载的附件只保留摘要。
  if (!/^https?:\/\//i.test(url)) return undefined
  const name = item.filename || item.name
  const segment = { ...item, type, url, file: url, ...(name ? { name } : {}) }
  delete segment.content_type
  delete segment.filename
  return segment
}

/** 引用元素按顺序展开成可读文本和附件段。 */
function elementSegments(element, depth = 0, output = []) {
  if (!element || typeof element !== "object" || depth > 4) return output
  const text = elementText(element)
  if (text) output.push({ type: "text", text })
  const attachments = elementAttachments(element)
  for (const item of attachments) {
    const segment = attachmentSegment(item)
    if (segment) output.push(normalizeReceivedSegment(segment, []))
  }
  return output
}

/** 聊天记录元素展开成 icqq 风格的 node 段，并保留每个节点的作者。 */
function chatRecordNodes(element, depth = 0) {
  if (!element || typeof element !== "object" || depth > 4) return []
  const children = Array.isArray(element.msg_elements) ? element.msg_elements : []
  if (children.length)
    return children.flatMap(child => {
      const nested = chatRecordNodes(child, depth + 1)
      if (nested.length) return nested
      const node = singleChatRecordNode(child)
      return node ? [node] : []
    })
  const node = singleChatRecordNode(element)
  return node ? [node] : []
}

function singleChatRecordNode(element) {
  const message = elementSegments(element)
  if (!message.length) return undefined
  const author = element.author && typeof element.author === "object" ? element.author : {}
  return {
    user_id: String(author.id || author.member_openid || author.user_openid || ""),
    nickname: author.username || author.nickname || "",
    message,
  }
}

/**
 * 引用消息里的附件转换成消息段。
 *
 * 引用事件 103 的 msg_elements[0].attachments 不属于当前消息，SDK 不会解析，
 * 因此这里按附件类型补成 image / record / video / file 段，让图片理解等插件
 * 能直接拿到被引用图片的 URL。重复规范化时按 URL 去重。
 */
function quotedAttachmentSegments(event, attachments) {
  if (!Array.isArray(attachments)) return []
  const seen = new Set()
  for (const segment of event.message || [])
    for (const value of [segment?.url, segment?.file])
      if (typeof value === "string" && value) seen.add(value)

  const segments = []
  for (const item of attachments.slice(0, 10)) {
    const segment = attachmentSegment(item)
    if (!segment) continue
    const url = segment.url
    if (seen.has(url)) continue
    seen.add(url)
    segments.push(normalizeReceivedSegment(segment, event.mentions))
  }
  return segments
}

/** 把 parallel_message.msg_nodes 转成标准消息段。 */
function parallelMessageSegments(event) {
  const nodes = event?.parallel_message?.msg_nodes
  if (!Array.isArray(nodes)) return []
  const seenText = new Set()
  const seenUrl = new Set()
  for (const segment of event.message || []) {
    if (segment?.type === "text") seenText.add(String(segment.text || "").trim())
    for (const value of [segment?.url, segment?.file])
      if (typeof value === "string" && value) seenUrl.add(value)
  }

  const segments = []
  for (const node of nodes.slice(0, 10)) {
    if (!node || typeof node !== "object") continue
    const attachments = elementAttachments(node)
    const text = elementText(node)
    if (text && !(attachments.length && /^\[(图片|视频|语音|文件|附件)\]$/.test(text)) && !seenText.has(text)) {
      seenText.add(text)
      segments.push({ type: "text", text })
    }
    for (const item of attachments) {
      const segment = attachmentSegment(item)
      if (!segment) continue
      if (seenUrl.has(segment.url)) continue
      seenUrl.add(segment.url)
      segments.push(normalizeReceivedSegment(segment, event.mentions))
    }
  }
  return segments
}

/** 普通消息里的并行消息直接追加；引用事件的并行内容只作为摘要来源。 */
function appendParallelMessage(event) {
  if (!Array.isArray(event.message)) return
  const segments = parallelMessageSegments(event)
  if (!segments.length) return
  event.parallel_segments = segments
  if (Number(event._qqbotMessageType ?? event.message_type) !== 103) event.message.push(...segments)
}

/** 顶层 101/102/3 等消息元素展开为文本、附件或聊天记录 node。 */
function appendElementMessage(event) {
  const elements = Array.isArray(event.msg_elements) ? event.msg_elements : []
  if (!elements.length) return
  const type = Number(event._qqbotMessageType ?? event.message_type)
  if (type === 103 || !Array.isArray(event.message)) return
  for (const element of elements) {
    const nodes = type === 101 || type === 102 ? chatRecordNodes(element) : []
    if (nodes.length) {
      event.message.push(...nodes.map(data => ({ type: "node", data })))
      continue
    }
    event.message.push(...elementSegments(element))
  }
}

/** 语音 ASR 文本追加为正文段，保留原 record 段用于播放和下载。 */
function appendVoiceTranscripts(event) {
  if (!Array.isArray(event.message) || !event.message.length) return
  const seen = new Set(event.message.filter(item => item?.type === "text")
    .map(item => String(item.text || "").trim()).filter(Boolean))
  // 原地插入，保留 event.message 的数组身份和已有消息段顺序。
  for (let index = event.message.length - 1; index >= 0; index--) {
    const item = event.message[index]
    if (item?.type !== "record") continue
    const text = typeof item.asr_refer_text === "string" ? item.asr_refer_text.trim() : ""
    if (!text || seen.has(text)) continue
    seen.add(text)
    event.message.splice(index + 1, 0, { type: "text", text, _voiceText: true })
  }
}

/** QQ 引用事件 103 将被引用内容放在 msg_elements[0]，SDK 1.3.0 未解析。 */
export function normalizeQuotedEvent(event) {
  const reference = event.message_reference || event.source
  const quoted = Number(event._qqbotMessageType ?? event.message_type) === 103 && Array.isArray(event.msg_elements)
    ? event.msg_elements[0] : undefined
  if (!reference && !quoted) return event
  const nested = reference?.message || reference?.referenced_message || reference?.source_message
  const parallelText = (event.parallel_segments || [])
    .filter(item => item?.type === "text").map(item => item.text).join("\n")
  const content = [reference?.raw_message, reference?.content, elementText(nested), elementText(quoted), parallelText]
    .find(value => typeof value === "string" && value.trim())
  const attachments = elementAttachments(nested, elementAttachments(quoted, elementAttachments(reference)))
  const attachmentSummary = attachments.slice(0, 10).map(item => {
    const mime = String(item?.content_type || "")
    return mime.startsWith("image") ? "[图片]" : mime.startsWith("audio") || mime === "voice" ? "[语音]" : mime.startsWith("video") ? "[视频]" : "[附件]"
  }).join("")
  const parallelSummary = (event.parallel_segments || []).map(item => {
    switch (item?.type) {
      case "image": return "[图片]"
      case "record": return "[语音]"
      case "video": return "[视频]"
      case "file": return "[附件]"
      default: return ""
    }
  }).join("")
  const summary = content?.trim().slice(0, 500) || attachmentSummary || parallelSummary
  // msg_idx 不是 OpenAPI 消息 ID；只在同一会话内用精确索引关联本地已收消息，
  // 不按文本相同猜测，也不会把索引伪装成 message_id。
  const messageId = reference?.message_id ?? reference?.id ?? quoted?.message_id ?? ""
  const refIdx = event.ref_msg_idx || quoted?.msg_idx
  event.source = {
    message_id: typeof messageId === "string" ? messageId.slice(0, 200) : "",
    ...(summary ? { raw_message: summary } : {}),
    ...(quoted?.msg_idx ? { msg_idx: String(quoted.msg_idx).slice(0, 200) } : {}),
    ...(refIdx ? { ref_msg_idx: String(refIdx).slice(0, 200) } : {}),
    ...(event.parallel_segments?.length ? { parallel_segments: event.parallel_segments } : {}),
  }
  for (const key of ["seq", "rand", "user_id", "time"])
    if (reference?.[key] !== undefined) event.source[key] = reference[key]
  const author = quoted?.author
  if (author && typeof author === "object") {
    if (author.id) event.source.user_id = String(author.id).slice(0, 200)
    if (author.username) event.source.nickname = author.username
    if (author.union_openid) event.source.union_openid = author.union_openid
    if (author.union_user_account) event.source.union_user_account = author.union_user_account
  }
  const quotedNodes = chatRecordNodes(quoted)
  if (quotedNodes.length && (quotedNodes.length > 1 || Array.isArray(quoted?.msg_elements) || Number(quoted?.message_type) === 102))
    event.source.nodes = quotedNodes
  if (!Array.isArray(event.message)) event.message = []
  const quotedSegments = quotedAttachmentSegments(event, attachments)
  if (!event.message.some(segment => segment?.type === "reply")) event.message.unshift({ type: "reply", id: event.source.message_id, ...(summary ? { text: summary } : {}) })
  if (quotedSegments.length) {
    // 引用卡片之后、正文之前插入被引用消息的附件。
    const replyIndex = event.message.findIndex(segment => segment?.type === "reply")
    event.message.splice((replyIndex < 0 ? 0 : replyIndex) + 1, 0, ...quotedSegments)
  }
  return event
}
