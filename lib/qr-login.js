import crypto from "node:crypto"
import QRCode from "qrcode"
import { config, configSave } from "./utils/cfg.js"
import { getAccounts, normalizeAccount } from "./utils/accounts.js"
import { accountDiag, createDiag, describeError } from "./utils/diagnostics.js"
import { qqbot } from "../adapter/index.js"

const log = createDiag("扫码登录")
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
    if (!task) return { status: "idle", statusText: "尚未创建扫码任务", diagnosticLog: "data/QQBot/diagnostics.log" }
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
      /** 排查连接问题时把这行路径对应的文件发出来即可 */
      diagnosticLog: "data/QQBot/diagnostics.log",
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
    log.info("创建扫码绑定任务", { url: CREATE_URL, keyLength: task.key.length })
    try {
      const data = await this.request(CREATE_URL, { key: this.task.key }, controller.signal)
      if (this.task !== task || task.status === "canceled") {
        log.info("扫码任务在创建过程中被取消")
        return this.snapshot()
      }
      if (!data?.task_id) throw new Error("创建扫码任务未返回 task_id")
      const taskId = String(data.task_id)
      this.task.id = taskId
      this.task.qrUrl = `${QR_URL}?task_id=${encodeURIComponent(taskId)}&_wv=2`
      this.task.expiresAt = this.now() + this.taskTtlMs
      this.task.status = "waiting"
      log.info("扫码任务已创建，等待手机扫码", {
        taskId,
        qrUrl: this.task.qrUrl,
        expiresAt: new Date(this.task.expiresAt).toISOString(),
        ttlMs: this.taskTtlMs,
      })
      this.poll().catch(() => {})
      return this.snapshot()
    } catch (error) {
      if (this.task.status !== "canceled") {
        this.task.status = "failed"
        this.task.error = this.errorText(error)
        log.error("创建扫码任务失败", describeError(error, { status: this.task.status }))
      }
      this.clearSensitive()
      return this.snapshot()
    }
  }

  async request(url, body, signal, portal = true) {
    const started = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    let text = ""
    try {
      const response = await this.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Elia-Yunzai-QQBot-Plugin/1.0" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      text = await response.text()
      if (text.length > 65536) throw new Error("门户响应过大")
      if (!response.ok)
        throw new Error(`门户请求失败（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ""}`)
      let json
      try { json = JSON.parse(text) } catch { throw new Error(`门户响应不是有效 JSON：${text.slice(0, 200)}`) }
      log.debug("门户请求完成", {
        method: body === undefined ? "GET" : "POST",
        url,
        status: response.status,
        retcode: json.retcode,
        msg: json.msg,
        dataKeys: json.data && typeof json.data === "object" ? Object.keys(json.data) : [],
        elapsedMs: Date.now() - started,
      })
      if (portal && json.retcode !== 0)
        throw new Error(json.msg || `门户请求失败（retcode ${json.retcode}）`)
      return json.data
    } catch (error) {
      if (signal?.aborted) log.debug("门户请求已取消", { url })
      else
        log.error("门户请求失败", describeError(error, {
          method: body === undefined ? "GET" : "POST",
          url,
          timedOut,
          timeoutMs: this.requestTimeoutMs,
          elapsedMs: Date.now() - started,
          bodyLength: text.length,
        }))
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }

  async poll() {
    const task = this.task
    let lastStatus
    try {
      while (this.task === task && task.status === "waiting") {
        if (this.now() >= task.expiresAt) {
          task.status = "expired"
          log.warn("扫码任务已过期", { taskId: task.id, expiresAt: new Date(task.expiresAt).toISOString() })
          this.clearSensitive()
          return
        }
        await sleep(this.pollIntervalMs, task.controller.signal)
        try {
          const data = await this.request(POLL_URL, { task_id: task.id }, task.controller.signal)
          const status = Number(data?.status)
          if (status !== lastStatus) {
            lastStatus = status
            log.info("扫码轮询状态变化", { taskId: task.id, status, dataKeys: data && typeof data === "object" ? Object.keys(data) : [] })
          }
          if (status === 2) {
            await this.complete(data)
            return
          }
          if (status === 3) {
            task.status = "expired"
            log.warn("扫码任务已被平台标记为过期", { taskId: task.id })
            this.clearSensitive()
            return
          }
        } catch (error) {
          if (task.controller.signal.aborted) throw error
          log.debug("本次轮询失败，等待下一轮", describeError(error, { taskId: task.id }))
        }
      }
    } catch (error) {
      if (this.task === task && task.status !== "canceled") {
        task.status = "failed"
        task.error = this.errorText(error)
        log.error("扫码轮询终止", describeError(error, { taskId: task.id, status: task.status }))
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
    let secret = ""
    log.info("扫码成功，开始保存账号并连接", {
      appid: String(data?.bot_appid ?? ""),
      hasEncryptedSecret: Boolean(data?.bot_encrypt_secret),
    })
    try {
      if (!data.bot_appid || !data.bot_encrypt_secret) throw new Error("扫码结果缺少 AppID 或加密 Secret")
      const appid = String(data.bot_appid)
      secret = decryptBotSecret(data.bot_encrypt_secret, task.key)
      log.debug("机器人 Secret 解密成功", {
        appid,
        secretLength: secret.length,
        hasWhitespace: /\s/.test(secret),
        looksMasked: /^[*•]+$/.test(secret),
      })
      task.appid = appid
      task.uin = await this.robotUin(appid, task.controller.signal)
      const account = await this.saveAccount(appid, task.uin, secret)
      log.info("账号配置已保存，开始连接", accountDiag(account))
      const started = Date.now()
      const connected = await this.connect(account)
      const elapsedMs = Date.now() - started
      if (connected) {
        task.status = "connected"
        log.info("扫码账号连接成功", { ...accountDiag(account), elapsedMs })
      } else {
        const failure = this.connectFailure(account)
        task.status = "saved"
        task.error = `账号配置已保存，但连接失败：${failure}（连接诊断日志见 data/QQBot/diagnostics.log）`
        log.error("账号已保存但连接失败", {
          ...accountDiag(account),
          elapsedMs,
          failure,
          hint: "扫码只是拿到 AppID / Secret，连不上通常是 Secret 失效、intents 未授权、网络或平台侧限制；请看上方 [诊断/连接] 日志",
        })
      }
    } catch (error) {
      task.status = "failed"
      task.error = this.errorText(error, [secret])
      log.error("扫码登录失败", describeError(error, { appid: task.appid, uin: task.uin, status: task.status }))
    } finally {
      this.clearSensitive()
    }
  }

  /** 连接失败时把适配器记录的最后一处错误带回面板，避免只剩一句“连接失败” */
  connectFailure(account) {
    const failure = qqbot?.lastConnectError?.(account.uin) || qqbot?.connectErrors?.[account.uin]
    const message = String(failure?.message || "未返回具体原因").trim()
    return message.slice(0, 200)
  }

  async robotUin(appid, signal) {
    try {
      const data = await this.request(`${SHARE_INFO_URL}?bkn=508459323&robot_appid=${encodeURIComponent(appid)}`, undefined, signal, false)
      const uin = String(data?.robot_data?.robot_uin || appid)
      if (data?.robot_data?.robot_uin)
        log.info("机器人标识解析成功", { appid, uin })
      else
        log.warn("共享信息未返回 robot_uin，改用 AppID 作为账号标识", {
          appid,
          responseKeys: data && typeof data === "object" ? Object.keys(data) : [],
        })
      return uin
    } catch (error) {
      log.warn("共享信息查询失败，回退 AppID 作为账号标识", describeError(error, { appid }))
      return appid
    }
  }

  async saveAccount(appid, uin, secret) {
    const accounts = getAccounts(this.config)
    const existing = accounts.find(account => account.appid === appid) || accounts.find(account => account.uin === uin)
    log.debug("准备写入账号配置", {
      appid,
      uin,
      accountsBefore: accounts.length,
      existing: existing ? accountDiag(existing) : null,
      replacesUin: existing?.uin || "",
    })
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
    log.info("账号配置写入完成", { uin, appid, accountsAfter: this.config.accounts.length })
    if (existing?.uin) {
      log.debug("退出同 AppID 的旧连接", { uin: existing.uin, appid })
      await this.getBot()?.[existing.uin]?.logout?.()
    }
    return account
  }

  errorText(error, extraSensitive = []) {
    const task = this.task
    let text = String(error?.message || error || "扫码登录失败").slice(0, 300)
    for (const sensitive of [task?.key, ...extraSensitive]) if (sensitive) text = text.replaceAll(sensitive, "[已隐藏]")
    return text
  }

  clearSensitive() {
    if (this.task) this.task.key = null
  }
}

export function createQrLoginService(options) {
  return new QrLoginService(options)
}
