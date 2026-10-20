import fs from "node:fs/promises"
import path from "node:path"
import { config, CFG_FILE } from "./cfg.js"
import { toBuffer, mkdir, detectContentType, extensionFromContentType } from "./files.js"
import { webhook } from "./webhook.js"
import { qqbotIds } from "./events.js"
import { uploadMedia } from "./media-upload.js"
import { qblog } from "./logger.js"

let warnedPublicUrl = false
/** 只提示一次：官方不可用，且无法使用本地文件服务回退。 */
function warnNoPublicUrl(hasUrl) {
  if (warnedPublicUrl) return
  warnedPublicUrl = true
  qblog.warn(
    hasUrl
      ? "官方文件直链不可用，且内置 HTTP 文件服务未监听端口，无法生成回退直链；" +
          "请配置有效 WebHook 账号与 webhookPort 后重启 Yunzai。Markdown 图片将尝试普通富媒体发送"
      : `官方文件直链不可用，且未配置 ${CFG_FILE}: url（公网地址）或文件服务未监听端口，无法生成回退直链；` +
          "请填写公网地址、配置有效 WebHook 账号与 webhookPort 后重启 Yunzai。Markdown 图片将尝试普通富媒体发送",
  )
}

/** 优先取官方 raw_url；回退失败时返回空 URL，由调用方改发普通富媒体。 */
async function fileToUrlInfo(file, opts = {}) {
  let bots
  if (opts.bot) bots = [opts.bot]
  else if (opts.self_id) bots = [globalThis.Bot?.[opts.self_id]]
  else bots = qqbotIds().map(id => Bot[id])
  for (const bot of bots.filter(bot => bot?.sdk?.fileProcessor)) {
    try {
      const info = await uploadBotFile(bot, file, { ...opts, requireUrl: true })
      return { ...info, url: info.raw_url }
    } catch (err) {
      qblog.warn(`[${bot.uin}] 官方文件直链上传失败，尝试已有公网地址或内置文件服务`, err)
    }
  }
  return fallbackFileUrl(file, opts)
}

/** 官方上传不可用时，已有公网 URL 或正在监听的文件服务才能作为回退。 */
async function fallbackFileUrl(file, opts = {}) {
  const buffer = await toBuffer(file, { http: true })
  if (typeof buffer === "string" && /^https?:\/\//.test(buffer)) return { url: buffer }

  const base = String(config.url || "").trim()
  /** 必须有公网地址，且内置文件服务（webhookPort）在跑，直链才可访问 */
  if (!base || !webhook.server?.listening) {
    warnNoPublicUrl(!!base)
    return { url: "" }
  }

  const localBuffer = Buffer.isBuffer(buffer) ? buffer : await toBuffer(file)
  if (!Buffer.isBuffer(localBuffer)) return { url: "" }

  let suffix
  if (opts.name) suffix = `-${path.basename(opts.name)}`
  else if (typeof file === "string" && !file.startsWith("base64://") && !/^https?:/.test(file))
    suffix = path.extname(file.replace(/^file:\/\//, ""))
  else suffix = extensionFromContentType(detectContentType(localBuffer))
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`

  const dir = path.join("data", "QQBot", "File")
  await mkdir(dir)
  const target = path.join(dir, name)
  await fs.writeFile(target, localBuffer)
  webhook.files.set(name, target)

  return { url: `${String(base).replace(/\/+$/, "")}/QQBot/File/${encodeURIComponent(name)}` }
}

async function fileToUrl(file, opts = {}) {
  return (await fileToUrlInfo(file, opts)).url
}

function mediaFileType(mime, fileName) {
  const ext = path.extname(fileName || "").toLowerCase()
  if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return 1
  if (mime.startsWith("video/") || ext === ".mp4") return 2
  if (mime.startsWith("audio/") || [".silk", ".mp3", ".wav", ".ogg", ".flac"].includes(ext)) return 3
  return 4
}

/** 统一 Buffer、本地路径、file://、Base64、data URL 与公网 URL 的上传入口。 */
async function uploadBotFile(bot, file, opts = {}) {
  const buffer = await toBuffer(file, { http: !opts.requireUrl })
  let fileName = opts.fileName || opts.file_name || opts.name || opts.filename
  if (!fileName && typeof file === "string" && !/^(base64:|data:)/i.test(file)) {
    try {
      fileName = /^https?:\/\//i.test(file)
        ? decodeURIComponent(new URL(file).pathname.split("/").pop())
        : path.basename(file.replace(/^file:\/\//, ""))
    } catch {}
  }
  const mime = Buffer.isBuffer(buffer) ? detectContentType(buffer) : ""
  const fileType = opts.fileType ?? opts.file_type ??
    { image: 1, video: 2, audio: 3, record: 3, file: 4 }[opts.type] ?? mediaFileType(mime, fileName)
  if (!fileName && Buffer.isBuffer(buffer) && mime !== "application/octet-stream")
    fileName = `file${extensionFromContentType(mime)}`
  const uploadOpts = { ...opts, fileType, fileName }
  try {
    return await uploadMedia(bot, buffer, uploadOpts)
  } catch (err) {
    // 获取 raw_url 的调用由 fileToUrlInfo 统一处理回退，URL 转存不提供 raw_url。
    if (opts.requireUrl) throw err
    let local = buffer
    if (typeof buffer === "string") {
      // 平台拉取 URL 失败时，先在本机下载后按官方推荐的分片流程重传。
      try {
        local = await toBuffer(file)
        return await uploadMedia(bot, local, uploadOpts)
      } catch (downloadError) {
        qblog.warn(`[${bot.uin}] 官方 URL 转存及本机分片重传失败`, downloadError)
        if (!Buffer.isBuffer(local)) throw err
      }
    }
    qblog.warn(`[${bot.uin}] 官方富媒体上传失败，尝试内置文件服务直链回退`, err)
    const fallback = await fallbackFileUrl(local, { ...opts, name: fileName })
    if (!fallback.url) throw err
    return uploadMedia(bot, fallback.url, uploadOpts)
  }
}

export {
  warnedPublicUrl,
  warnNoPublicUrl,
  fileToUrl,
  fileToUrlInfo,
  fileToUrl as filetoUrl,
  uploadBotFile,
}
