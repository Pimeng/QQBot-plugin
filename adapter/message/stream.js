import { config } from "../../lib/utils/cfg.js"
import { markdownToText, sendModeOf } from "../../lib/utils/message.js"

function markerOptions(marker) {
  if (!marker) return {}
  if (typeof marker.data === "string") return { content: marker.data }
  return marker.data && typeof marker.data === "object" ? marker.data : marker
}

function replySource(data, message) {
  if (data.active) return undefined
  const reply = message.find(item => item?.type === "reply")
  const id = reply?.id ?? reply?.data?.id ?? reply?.event_id ?? reply?.data?.event_id ?? data.message_id
  if (!id) return undefined
  return String(id).startsWith("event_") ? { event_id: String(id).slice(6) } : { id: String(id) }
}

function textContent(item, contentType) {
  if (typeof item === "string" || typeof item === "number") return String(item)
  if (item.type === "text") return String(item.text ?? item.data?.text ?? "")
  const data = item.data && typeof item.data === "object" ? item.data : item
  const content = typeof item.data === "string" ? item.data : data.content ?? data.text ?? ""
  return contentType === "text" ? markdownToText(content) : String(content)
}

export function preparePrivateStream(data, msg) {
  const items = (Array.isArray(msg) ? msg : [msg]).filter(item => item !== undefined && item !== null)
  const marker = items.find(item => item?.type === "stream")
  const requested = marker || data.stream === true || typeof data.stream === "object" || config.stream === true
  if (!requested) return null

  const options = {
    ...(typeof data.stream === "object" ? data.stream : {}),
    ...markerOptions(marker),
  }
  if (options.enabled === false) return null
  const message = items.filter(item => item?.type !== "stream")
  if (message.some(item => typeof item === "object" && !["text", "markdown", "reply"].includes(item.type))) return null

  const contentType = options.contentType || (message.some(item => item?.type === "markdown") ? "markdown" : sendModeOf(data.self_id) === "markdown" ? "markdown" : "text")
  if (!["text", "markdown"].includes(contentType)) return null
  const inputMode = options.inputMode || "replace"
  if (!["append", "replace"].includes(inputMode)) return null

  const generated = message.filter(item => item?.type !== "reply").map(item => textContent(item, contentType)).join("")
  const content = String(options.content ?? options.text ?? generated)
  if (!content) return null

  const chunkSize = Number(options.chunkSize ?? 2)
  const delay = Number(options.delay ?? 100)
  const source = options.source || replySource(data, message)
  return {
    message,
    content,
    chunkSize: Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : 2,
    delay: Number.isFinite(delay) && delay >= 0 ? delay : 100,
    options: {
      inputMode,
      contentType,
      ...(source ? { source } : {}),
      ...(options.msgId ? { msgId: options.msgId } : {}),
      ...(options.eventId ? { eventId: options.eventId } : {}),
      ...(options.msgSeq !== undefined ? { msgSeq: options.msgSeq } : {}),
      ...(options.isWakeup !== undefined ? { isWakeup: options.isWakeup } : {}),
    },
  }
}

export async function* privateStreamChunks(content, chunkSize, delay, inputMode) {
  const text = String(content)
  if (inputMode === "replace") {
    for (let end = chunkSize; end < text.length; end += chunkSize) {
      yield text.slice(0, end)
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    }
    yield text
    return
  }
  for (let start = 0; start < text.length; start += chunkSize) {
    yield text.slice(start, start + chunkSize)
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
  }
}
