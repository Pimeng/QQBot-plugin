import fs from "node:fs/promises"
import path from "node:path"
import { exec as childExec } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { config } from "./cfg.js"
import { toBinary, toStr } from "./message.js"
import { qblog } from "./logger.js"

export let sharp
if (config.imageLength)
  try {
    sharp = (await import("sharp")).default
  } catch (err) {
    qblog.error("sharp 导入错误，图片压缩关闭", err)
  }

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
    qblog.error(`创建目录失败：${dir}`, err)
    return false
  }
}

async function rm(file, opts = {}) {
  try {
    await fs.rm(file, { force: true, recursive: true, ...opts })
    return true
  } catch (err) {
    qblog.error(`删除文件失败：${file}`, err)
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
        qblog.error("执行命令错误", toStr(cmd), err.message || err)
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
      const res = await fetch(data, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`下载文件失败：HTTP ${res.status}`)
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
  if (buffer.subarray(4, 8).toString() === "ftyp") return "video/mp4"
  if (buffer.subarray(0, 9).toString() === "#!SILK_V3" || buffer.subarray(1, 10).toString() === "#!SILK_V3") return "audio/silk"
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE") return "audio/wav"
  if (buffer.subarray(0, 4).toString() === "fLaC") return "audio/flac"
  if (buffer.subarray(0, 4).toString() === "OggS") return "audio/ogg"
  if (buffer.subarray(0, 3).toString() === "ID3") return "audio/mpeg"
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
      "video/mp4": ".mp4",
      "audio/silk": ".silk",
      "audio/wav": ".wav",
      "audio/flac": ".flac",
      "audio/ogg": ".ogg",
      "audio/mpeg": ".mp3",
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

export {
  fsStat,
  mkdir,
  rm,
  sleep,
  exec,
  toBuffer,
  detectContentType,
  extensionFromContentType,
  contentType,
}
