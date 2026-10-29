import crypto from "node:crypto"
import QRCode from "qrcode"
import { config, configSave } from "./utils/cfg.js"
import { getAccounts, normalizeAccount } from "./utils/accounts.js"
import { qqbot } from "../adapter/index.js"

const CREATE_URL = "https://q.qq.com/lite/create_bind_task"
const POLL_URL = "https://q.qq.com/lite/poll_bind_result"
const SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
const QR_URL = "https://q.qq.com/qqbot/openclaw/connect.html"
const STATUS_TEXT = {
  starting: "正在创建扫码任务",
  waiting: "等待手机 QQ 扫码",
  saving: "扫码成功，正在保存并连接",
  connected: "登录并连接成功",
  saved: "账号已保存，但连接失败",
  failed: "扫码登录失败",
  expired: "二维码已失效",
  canceled: "已取消扫码任务",
}

function abortError() {
  return new Error("操作已取消")
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function decryptBotSecret(cipherBase64, keyBase64) {
  const buffer = Buffer.from(cipherBase64, "base64")
  if (buffer.length < 29) throw new Error("加密 Secret 格式无效")
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), buffer.subarray(0, 12))
  decipher.setAuthTag(buffer.subarray(-16))
  return decipher.update(buffer.subarray(12, -16), undefined, "utf8") + decipher.final("utf8")
}

export class QrLoginService {
  constructor(options = {}) {
    this.config = options.config || config
    this.configSave = options.configSave || configSave
    this.connect = options.connect || (account => qqbot.connect(account))
    this.getBot = options.getBot || (() => globalThis.Bot)
    this.fetch = options.fetch || globalThis.fetch
    this.now = options.now || Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000
    this.taskTtlMs = options.taskTtlMs ?? 300000
  }

  active() {
    return this.task && ["starting", "waiting", "saving"].includes(this.task.status)
  }

  snapshot() {
    const task = this.task
    if (!task) return { status: "idle", statusText: "尚未创建扫码任务" }
    return {
      id: task.id,
      status: task.status,
      statusText: STATUS_TEXT[task.status] || task.status,
      qrUrl: task.qrUrl,
      expiresAt: task.expiresAt ? new Date(task.expiresAt).toISOString() : "",
      appid: task.appid || "",
      uin: task.uin || "",
      connected: task.status === "connected",
      saved: ["connected", "saved"].includes(task.status),
      error: task.error || "",
    }
  }

  async image() {
    const task = this.snapshot()
    if (!task.qrUrl) return { src: "", empty: task.statusText }
    return {
      src: await QRCode.toDataURL(task.qrUrl, { type: "image/png", width: 320, margin: 1 }),
      href: task.qrUrl,
      alt: "使用手机 QQ 扫码绑定机器人",
    }
  }

  async start() {
    if (this.active()) return this.snapshot()
    if (this.starting) return this.starting
    this.starting = this.create().finally(() => { this.starting = null })
    return this.starting
  }

  async create() {
    const controller = new AbortController()
    this.task = {
      id: "",
      key: crypto.randomBytes(32).toString("base64"),
      controller,
      status: "starting",
      qrUrl: "",
      expiresAt: 0,
      appid: "",
      uin: "",
      error: "",
    }
    const task = this.task
    try {
      const data = await this.request(CREATE_URL, { key: this.task.key }, controller.signal)
      if (this.task !== task || task.status === "canceled") return this.snapshot()
      if (!data?.task_id) throw new Error("创建扫码任务未返回 task_id")
      const taskId = String(data.task_id)
      this.task.id = taskId
      this.task.qrUrl = `${QR_URL}?task_id=${encodeURIComponent(taskId)}&_wv=2`
      this.task.expiresAt = this.now() + this.taskTtlMs
      this.task.status = "waiting"
      this.poll().catch(() => {})
      return this.snapshot()
    } catch (error) {
      if (this.task.status !== "canceled") {
        this.task.status = "failed"
        this.task.error = this.errorText(error)
      }
      this.clearSensitive()
      return this.snapshot()
    }
  }

  async request(url, body, signal, portal = true) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const response = await this.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Elia-Yunzai-QQBot-Plugin/1.0" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (text.length > 65536) throw new Error("门户响应过大")
      if (!response.ok) throw new Error(`门户请求失败（HTTP ${response.status}）`)
      let json
      try { json = JSON.parse(text) } catch { throw new Error("门户响应不是有效 JSON") }
      if (portal && json.retcode !== 0) throw new Error(json.msg || `门户请求失败（retcode ${json.retcode}）`)
      return json.data
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }

  async poll() {
    const task = this.task
    try {
      while (this.task === task && task.status === "waiting") {
        if (this.now() >= task.expiresAt) {
          task.status = "expired"
          this.clearSensitive()
          return
        }
        await sleep(this.pollIntervalMs, task.controller.signal)
        try {
          const data = await this.request(POLL_URL, { task_id: task.id }, task.controller.signal)
          if (data?.status === 2) {
            await this.complete(data)
            return
          }
          if (data?.status === 3) {
            task.status = "expired"
            this.clearSensitive()
            return
          }
        } catch (error) {
          if (task.controller.signal.aborted) throw error
        }
      }
    } catch (error) {
      if (this.task === task && task.status !== "canceled") {
        task.status = "failed"
        task.error = this.errorText(error)
        this.clearSensitive()
      }
    }
  }

  cancel() {
    if (!this.active()) return this.snapshot()
    this.task.controller.abort()
    this.task.status = "canceled"
    this.clearSensitive()
    return this.snapshot()
  }

  async complete(data) {
    const task = this.task
    task.status = "saving"
    try {
      if (!data.bot_appid || !data.bot_encrypt_secret) throw new Error("扫码结果缺少 AppID 或加密 Secret")
      const appid = String(data.bot_appid)
      const secret = decryptBotSecret(data.bot_encrypt_secret, task.key)
      task.appid = appid
      task.uin = await this.robotUin(appid, task.controller.signal)
      const account = await this.saveAccount(appid, task.uin, secret)
      const connected = await this.connect(account)
      task.status = connected ? "connected" : "saved"
      if (!connected) task.error = "账号配置已保存，但连接失败；请检查 Intents、账号权限和网络后重试"
    } catch (error) {
      task.status = "failed"
      task.error = this.errorText(error)
    } finally {
      this.clearSensitive()
    }
  }

  async robotUin(appid, signal) {
    try {
      const data = await this.request(`${SHARE_INFO_URL}?bkn=508459323&robot_appid=${encodeURIComponent(appid)}`, undefined, signal, false)
      return String(data?.robot_data?.robot_uin || appid)
    } catch {
      return appid
    }
  }

  async saveAccount(appid, uin, secret) {
    const accounts = getAccounts(this.config)
    const existing = accounts.find(account => account.appid === appid) || accounts.find(account => account.uin === uin)
    const account = normalizeAccount({
      ...existing,
      uin,
      appid,
      secret,
      group: existing?.group ?? true,
      guild: existing?.guild ?? false,
      webhook: existing?.webhook ?? false,
    })
    this.config.accounts = [...accounts.filter(account => account.appid !== appid && account.uin !== existing?.uin), account]
    if (Array.isArray(this.config.token)) {
      this.config.token = this.config.token.filter(item => {
        const old = normalizeAccount(item)
        return old.appid !== appid && old.uin !== existing?.uin && old.uin !== uin
      })
    }
    await this.configSave.flush()
    if (existing?.uin) await this.getBot()?.[existing.uin]?.logout?.()
    return account
  }

  errorText(error) {
    const task = this.task
    let text = String(error?.message || error || "扫码登录失败").slice(0, 300)
    for (const sensitive of [task?.key]) if (sensitive) text = text.replaceAll(sensitive, "[已隐藏]")
    return text
  }

  clearSensitive() {
    if (this.task) this.task.key = null
  }
}

export function createQrLoginService(options) {
  return new QrLoginService(options)
}
