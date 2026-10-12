import { createHash } from "node:crypto"

const caches = new WeakMap()

/** 上传目标必须属于当前账号；频道 ID 不能交给群/C2C 富媒体接口。 */
export function uploadTarget(bot, opts = {}) {
  const target = opts._mediaTarget || opts.target
  let type = opts.targetType || target?.target_type || target?.targetType
  let id = opts.targetId || target?.target_id || target?.targetId
  if (!type && opts.group_id && !String(opts.group_id).startsWith("qg_")) {
    type = "group"
    id = opts.group_id
  } else if (!type && opts.user_id && !String(opts.user_id).startsWith("qg_")) {
    type = "user"
    id = opts.user_id
  }
  if (!type && !opts.guild_id && !opts.channel_id) {
    for (const [map, kind] of [[bot.gl, "group"], [bot.fl, "user"]]) {
      id = [...(map?.keys() || [])].find(key => !String(key).startsWith("qg_"))
      if (id) { type = kind; break }
    }
  }
  if (type === "c2c" || type === "private") type = "user"
  if (!["group", "user"].includes(type) || !id)
    throw new Error("QQBot 上传需要群或 C2C OpenID，请指定 targetType/targetId 或使用 pickGroup/pickFriend")
  id = String(id)
  for (const sep of [":", ""]) {
    const prefix = `${bot.uin}${sep}`
    if (id.startsWith(prefix)) id = id.slice(prefix.length)
  }
  return { targetType: type, targetId: id }
}

/** 只上传，不发送。缓存按 SDK 实例、目标、类型、文件名和内容隔离。 */
export async function uploadMedia(bot, file, opts = {}) {
  const sdk = bot.sdk
  if (!sdk?.fileProcessor) throw new Error("QQBot 文件上传服务不可用")
  const target = uploadTarget(bot, opts)
  const fileType = Number(opts.fileType ?? 1)
  if (opts.requireUrl && fileType === 4)
    throw new Error("QQBot 普通文件上传不提供 raw_url，请配置内置文件服务生成直链")
  const fileName = opts.fileName || { 1: "image.png", 2: "video.mp4", 3: "audio.silk", 4: "file.bin" }[fileType]
  if (!Buffer.isBuffer(file) && !(typeof file === "string" && /^https?:\/\//i.test(file)))
    throw new Error("QQBot 缺少可上传的文件数据")
  const hash = Buffer.isBuffer(file) ? createHash("sha256").update(file).digest("hex") : file
  const key = JSON.stringify([target.targetType, target.targetId, fileType, fileName, hash])
  let cache = caches.get(sdk)
  if (!cache) caches.set(sdk, cache = { entries: new Map(), pending: new Map() })
  for (const [key, value] of cache.entries)
    if (value.expires <= Date.now()) cache.entries.delete(key)
  const cached = cache.entries.get(key)
  if (cached && (!opts.requireUrl || /^https?:\/\//i.test(cached.info.raw_url || ""))) return { ...cached.info }
  const result = info => {
    if (opts.requireUrl && !/^https?:\/\//i.test(info.raw_url || ""))
      throw new Error("QQBot 上传未返回 raw_url；官方直链仅支持分片上传的图片、视频和语音")
    return { ...info }
  }
  if (cache.pending.has(key)) return result(await cache.pending.get(key))

  const task = (async () => {
    const payload = { file_type: fileType, file_name: fileName }
    if (Buffer.isBuffer(file)) payload.file = file
    else payload.url = file
    const info = await sdk.fileProcessor.uploadForMessage(payload, { ...target, sendMessage: false })
    if (!info?.file_info) throw new Error("QQBot 富媒体上传未返回 file_info")
    const ttl = Number(info.ttl)
    if (Number.isFinite(ttl) && ttl >= 0 && info.ttl != null) {
      // 提前少量失效，避免缓存凭据在后续发送请求中刚好到期。
      const expires = ttl === 0 ? Infinity : Date.now() + ttl * 1000 - Math.min(5000, ttl * 100)
      if (cache.entries.size >= 128) cache.entries.delete(cache.entries.keys().next().value)
      cache.entries.set(key, { info: { ...info }, expires })
    }
    return info
  })()
  cache.pending.set(key, task)
  try { return result(await task) }
  finally { cache.pending.delete(key) }
}
