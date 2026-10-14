/** QQ 入站消息转换成 Yunzai / NapCat 使用的扁平消息段。 */
const AT_TOKEN = /(?:<|\\u003c|&lt;)@!?([^\s<>]+?)(?:>|\\u003e|&gt;)/gi

/** 保留 @；补齐 SDK 只支持 <@!id> 且依赖 mentions 的解析输入。 */
export function prepareReceivedPayload(payload) {
  const mentions = Array.isArray(payload.mentions) ? [...payload.mentions] : []
  const content = String(payload.content ?? "").replace(AT_TOKEN, (_token, id) => {
    if (id === "everyone" || id === "all") return "<@everyone>"
    if (!mentions.some(item => item.id === id)) mentions.push({ id })
    return `<@!${id}>`
  })
  const author = payload.author && {
    ...payload.author,
    id: payload.author.id || payload.author.member_openid || payload.author.user_openid,
  }
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.map(item => {
    const mime = String(item.content_type || "file").toLowerCase()
    const type = mime.split("/")[0]
    let url = String(item.url ?? "")
    if (url.startsWith("//")) url = `https:${url}`
    return { ...item, mime, url, content_type: ["image", "video", "audio"].includes(type) ? mime : "file" }
  }) : undefined
  return { ...payload, author, mentions, content, ...(attachments ? { attachments } : {}) }
}

export function isAtSelf(event) {
  return event._eventName === "message.group.at" || event.mentions?.some(item =>
    item.is_you === true || item.is_you === "true",
  ) === true
}

export function normalizeReceivedSegment(item, mentions = []) {
  if (!item || typeof item !== "object") return item
  const { data, ...fields } = item
  const segment = data && typeof data === "object" ? { ...data, ...fields } : { ...item }
  if (segment.type === "at") {
    const mention = mentions.find(value => value.id === segment.user_id || value.member_openid === segment.user_id) || {}
    const target = segment.member_openid || mention.member_openid || segment.user_id || segment.qq || segment.id
    const isAll = target === "all" || target === "everyone" || segment.scope === "all" || mention.scope === "all"
    const name = segment.username || mention.username || segment.name
    return {
      ...mention, ...segment,
      user_id: isAll ? "all" : target,
      qq: isAll ? "all" : target,
      ...(segment.id || mention.id ? { id: isAll ? "all" : target } : {}),
      is_you: segment.is_you === true || segment.is_you === "true" || mention.is_you === true || mention.is_you === "true",
      ...(name ? { name } : {}),
      text: isAll ? "@全体成员" : segment.text || `@${name || target || "用户"}`,
    }
  }
  if (segment.type === "audio") segment.type = "record"
  if (["image", "record", "video", "file"].includes(segment.type)) {
    // SDK 会把空附件地址补成 https://，不能把它作为可下载链接交给插件。
    if (segment.url === "https://") delete segment.url
    if (segment.file === undefined && segment.url) segment.file = segment.url
    const name = segment.name || segment.filename || segment.file_name
    if (name) segment.name = name
    if (segment.type === "file") {
      // 官方附件常没有 file_id；URL 只作为当前附件的下载句柄，不能用于 NapCat 文件 API。
      segment.fid = segment.fid || segment.file_id || segment.id || segment.url || ""
      const size = Number(segment.size ?? segment.file_size)
      if (Number.isFinite(size) && size >= 0) segment.size = segment.file_size = size
    }
  }
  return segment
}

/** 与 NapCat 的 raw_message 一样使用可读摘要，完整 URL 留在媒体段里。 */
export function receivedMessageText(message = []) {
  return message.map(item => {
    switch (item?.type) {
      case "text": return item.text || ""
      case "at": return item.text || `@${item.name || item.qq || item.user_id || "用户"}`
      case "image": return "[图片]"
      case "record": return "[语音]"
      case "video": return "[视频]"
      case "file": return "[文件]"
      case "face": return `[表情:${item.id ?? ""}]`
      case "reply": return "[回复]"
      default: return `[${item?.type || "消息"}]`
    }
  }).join("")
}

/** 兼容插件先从 e.file.fid 再从场景对象取下载地址的调用方式。 */
export function receivedFileUrl(message, fid) {
  const file = fid && message.find(item => item?.type === "file" && [item.fid, item.file_id, item.url].includes(fid))
  if (!file?.url) throw new Error("QQBot 当前消息未提供该文件的下载地址")
  return file.url
}
