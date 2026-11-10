import { config, CFG_FILE } from "../lib/utils/cfg.js"
import { EventEmitter } from "node:events"
import { contactMap } from "../lib/contact-map.js"
import { getAccounts, normalizeAccount } from "../lib/utils/accounts.js"
import { qblog } from "../lib/utils/logger.js"
import { createSdkLogger } from "./sdk-logger.js"
import {
  createBot,
  login as sdkLogin,
  logout as sdkLogout,
  normalizeEvent,
} from "./sdk.js"
import { dispatch, markAdapterId } from "../lib/utils/events.js"
import { GROUP_INTENTS, GUILD_MESSAGE_INTENTS, OPTIONAL_INTENTS } from "../lib/utils/message.js"
import {
  accountDiag,
  createDiag,
  describeCloseCode,
  describeError,
  describeErrorHint,
} from "../lib/utils/diagnostics.js"
import { sleep } from "../lib/utils/files.js"
import { webhook } from "../lib/utils/webhook.js"
import { Dau } from "../lib/dau.js"

const log = createDiag("连接")
const PHASE_TEXT = {
  webhook: "WebHook 初始化",
  token: "获取 access_token",
  login: "登录 / WebSocket 握手",
  selfinfo: "获取机器人资料（/users/@me）",
}

/** 账号监听拿到与全局 Bot 相同的 Yunzai 事件，SDK 的原始事件保持在 sdk 上。 */
export function accountEvents(bot) {
  const events = new EventEmitter()
  for (const method of ["on", "once", "off", "addListener", "removeListener", "removeAllListeners", "prependListener", "prependOnceListener", "setMaxListeners"])
    bot[method] = (...args) => { events[method](...args); return bot }
  for (const method of ["emit", "listeners", "rawListeners", "listenerCount", "eventNames", "getMaxListeners"])
    bot[method] = (...args) => events[method](...args)
  return bot
}

export default class AdapterLifecycle {
  /**
   * 生成 intents
   *
   * 默认只申请群聊事件。频道和按钮交互等能力需要在 QQ 开放平台单独授权。
   */
  makeIntents(account) {
    if (Array.isArray(config.intents) && config.intents.length) return [...config.intents]
    return [...new Set([...(account.group ? GROUP_INTENTS : []), ...(account.guild ? GUILD_MESSAGE_INTENTS : [])])]
  }

  /** 按能力从多到少构造重试用的 intents 组合。 */
  buildIntentQueue(account, explicit) {
    const wanted = this.makeIntents(account)
    const candidates = []
    const push = list => {
      const unique = [...new Set(list.filter(Boolean))]
      const key = [...unique].sort().join("|")
      if (!unique.length || candidates.some(i => i.key === key)) return
      candidates.push({ list: unique, key })
    }

    push(wanted)
    /** 逐个摘掉可选 intent，尽量保留 INTERACTION 等已授权能力。 */
    let current = [...wanted]
    for (const optional of OPTIONAL_INTENTS.filter(item => wanted.includes(item))) {
      current = current.filter(item => item !== optional)
      push(current)
    }

    if (!explicit && account.guild) {
      push([...GUILD_MESSAGE_INTENTS])
      push(GUILD_MESSAGE_INTENTS.filter(i => !OPTIONAL_INTENTS.includes(i)))
    }

    if (!explicit && account.group) push(["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"])
    if (!candidates.length) candidates.push({ list: [], key: "" })
    return candidates
  }

  /** 连接一个账号，intents 被拒绝时自动尝试更保守的组合。 */
  async connect(entry) {
    this.connectErrors ||= {}
    const account = normalizeAccount(entry)
    const id = account.uin
    log.info(`账号开始连接：${id}`, accountDiag(account))
    const restartNotice = webhook.restartNotice(account)
    if (restartNotice) {
      qblog.warn(`[${id}] ${restartNotice}`)
      this.connectErrors[id] = { message: restartNotice, phase: "webhook", intents: [], at: Date.now() }
      return false
    }
    delete this.activeIntents[id]

    const explicit = Array.isArray(config.intents) && config.intents.length > 0
    const wanted = this.makeIntents(account)
    const queue = this.buildIntentQueue(account, explicit)
    log.info(`[${id}] intents 规划完成`, {
      explicit,
      wanted,
      combinations: queue.map(({ list }) => list),
    })

    let lastError = null
    for (let i = 0; i < queue.length; i++) {
      const { list } = queue[i]
      log.info(`[${id}] 第 ${i + 1}/${queue.length} 次连接尝试`, { intents: list })
      let ret
      try {
        ret = await this.connectOnce(id, account, list)
      } catch (err) {
        qblog.error(`[${id}] 账号初始化失败`, err)
        log.error(`[${id}] 账号初始化异常`, describeError(err, { attempt: i + 1, intents: list }))
        this.connectErrors[id] = {
          message: err?.message || String(err), phase: "create", intents: list, at: Date.now(),
        }
        return false
      }
      if (ret.ok) {
        delete this.connectErrors[id]
        this.activeIntents[id] = [...list]
        if (Bot[id]?.info) Bot[id].info.intents = [...list]
        if (Bot[id]) Bot[id].interaction = list.includes("INTERACTION")
        const dropped = wanted.filter(x => !list.includes(x))
        if (dropped.length)
          qblog.warn(
            `[${id}] 以下 intents 申请被平台拒绝，已自动降级连接：${dropped.join(" | ")}`,
            dropped.includes("INTERACTION")
              ? "没有 INTERACTION 就收不到按钮点击事件（INTERACTION_CREATE）：「回调按钮」可能无法使用。请到 QQ 开放平台为该机器人开启按钮交互能力。"
              : "请在 QQ 开放平台确认该机器人已开启对应能力。",
            `当前生效 intents：${list.join(" | ")}`,
          )
        else if (i > 0) qblog.warn(`[${id}] 已改用兜底 intents：${list.join(" | ")}`)
        log.info(`[${id}] 连接成功`, {
          intents: list,
          dropped,
          nickname: Bot[id]?.nickname || "",
          online: Bot[id]?.online === true,
          attempts: i + 1,
        })
        return true
      }
      if (!ret.intentError) {
        const message = ret.error || "未知错误"
        const hint = ret.hint || describeErrorHint({ message })
        this.connectErrors[id] = { message, phase: ret.phase || "login", intents: list, at: Date.now() }
        log.error(`[${id}] 连接失败，不再重试`, {
          phase: ret.phase || "login",
          message,
          intents: list,
          hint,
        })
        return false
      }
      lastError = ret.error
      log.warn(`[${id}] intents 组合被平台拒绝，继续降级重试`, {
        intents: list,
        error: ret.error,
        hint: describeErrorHint({ message: ret.error }),
      })
    }

    this.connectErrors[id] = {
      message: String(lastError ?? "intents 全部被拒绝"),
      phase: "intents",
      intents: queue.at(-1)?.list || [],
      at: Date.now(),
    }
    qblog.error(
      `[${id}] intents 被拒绝（${lastError}），最后一次申请：${queue[queue.length - 1].list.join(" | ") || "（空）"}`,
      "4013/4014 说明其中有 intent 未被该机器人授权：请到 QQ 开放平台确认已开启对应能力，" +
        `或在 ${CFG_FILE} 的 intents 里只保留已授权的项。` +
        "可用项：群消息 GROUP_AT_MESSAGE_CREATE、C2C_MESSAGE_CREATE、群成员 GROUP_MEMBER；" +
        "频道 GUILDS、GUILD_MESSAGES、PUBLIC_GUILD_MESSAGES、GUILD_MESSAGE_REACTIONS、DIRECT_MESSAGE、GUILD_MEMBERS；" +
        "按钮交互 INTERACTION；消息审核 MESSAGE_AUDIT（后两者需单独申请）",
    )
    log.error(`[${id}] 所有 intents 组合都被拒绝`, {
      lastError,
      attempts: queue.length,
      attempted: queue.map(({ list }) => list),
    })
    return false
  }

  /** 最近一次连接失败的信息，供扫码登录等调用方展示具体原因 */
  lastConnectError(id) {
    return this.connectErrors?.[id]
  }

  /** 单次连接尝试，intents 由 connect() 决定。 */
  async connectOnce(id, account, intents) {
    const opts = {
      ...config.bot,
      appid: account.appid,
      secret: account.secret,
      intents,
    }
    const startedAt = Date.now()
    const connectTimeout = opts.connectTimeout || 30000
    log.info(`[${id}] 创建连接`, {
      ...accountDiag(account),
      intents,
      webhook: account.webhook === true,
      sandbox: Boolean(config.bot?.sandbox),
      apiBaseUrl: config.bot?.sandbox ? "https://sandbox.api.sgroup.qq.com" : "默认（https://api.bot.qq.com）",
      requestTimeout: opts.timeout,
      connectTimeout,
      maxRetry: opts.maxRetry,
      retryDelay: opts.retryDelay,
    })
    qblog.info(`[${id}] 申请 intents：${intents.join(" | ") || "（空）"}`)

    Bot[id] = accountEvents({
      adapter: this.id,
      sdk: createBot(opts),
      async login() {
        if (Bot[id] !== this) throw new Error("QQBot 账号连接已被替换")
        await sdkLogin(this.sdk, opts.connectTimeout || 30000)
        if (Bot[id] === this && this.online) markAdapterId(id, true)
      },
      logout() {
        this.online = false
        if (Bot[id] === this) markAdapterId(id, false)
        return sdkLogout(this.sdk)
      },

      uin: id,
      online: false,
      isOnline() { return this.online },
      info: {
        id,
        ...opts,
        avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`,
      },
      get nickname() {
        return this.info.username
      },
      get avatar() {
        return this.info.avatar
      },

      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: { start_time: Date.now() / 1000, recv_msg_cnt: 0, sent_msg_cnt: 0 },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      fl: contactMap(await this.getFriendMap(id), id, this.sep),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      ...this.accountMethods(id),
      getGroupMap() {
        return this.gl
      },
      gl: contactMap(await this.getGroupMap(id), id, this.sep),
      gml: contactMap(await this.getMemberMap(id), id, this.sep, true),
      messageCache: await this.getMessageMap(id),
      dau: await new Dau(id, { config }).init(),

      uploadImage: (file, opts) => this.uploadImage(id, file, opts),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, opts),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, opts),

      callback: {},
    })

    const bot = Bot[id]
    bot.sdk.logger = createSdkLogger(account)
    // 在连接之前监听，避免 ready 到 getSelfInfo 完成之间收到的消息丢失。
    const handle = (name, make) => event => {
      if (Bot[id] !== bot) return
      Promise.resolve().then(() => make.call(this, id, normalizeEvent(event)))
        .catch(err => qblog.error(`[${id}] 处理${name}失败`, err))
    }
    bot.sdk.on("message", handle("消息", this.makeMessage))
    bot.sdk.on("notice", handle("通知", this.makeNotice))
    let readyCount = 0
    const receiver = bot.sdk.sessionManager?.receiver
    receiver?.on("ready", () => {
      if (Bot[id] !== bot) return
      bot.online = true
      markAdapterId(id, true)
      readyCount += 1
      log.info(`[${id}] 网关握手完成（ready）`, {
        readyCount,
        elapsedMs: Date.now() - startedAt,
        wsReadyState: receiver?.handler?.ws?.readyState,
      })
      if (readyCount > 1) qblog.mark(`[${id}] 自动重连成功`)
    })
    receiver?.on("close", (code, reason) => {
      if (Bot[id] !== bot) return
      bot.online = false
      markAdapterId(id, false)
      const closeReason = Buffer.isBuffer(reason) ? reason.toString() : String(reason ?? "")
      log.warn(`[${id}] 网关连接关闭`, {
        code,
        reason: closeReason,
        hint: describeCloseCode(code),
        readyCount,
        online: bot.online,
        elapsedMs: Date.now() - startedAt,
      })
    })
    receiver?.on("error", error => {
      log.error(`[${id}] 网关错误`, describeError(error, {
        readyCount,
        elapsedMs: Date.now() - startedAt,
        wsReadyState: receiver?.handler?.ws?.readyState,
      }))
    })
    // 断线重连由 SDK 内部完成，次数用尽后它只会 emit 这个事件，账号会静默离线。
    bot.sdk.sessionManager?.on?.("max_retry_reached", () => {
      if (Bot[id] !== bot) return
      bot.online = false
      markAdapterId(id, false)
      log.error(`[${id}] 自动重连次数已用尽，账号已离线`, {
        retryDelay: opts.retryDelay,
        maxRetry: opts.maxRetry,
        hint: "SDK 的重连次数由 bot.maxRetry 控制；长时间断网后需要重启 Yunzai 或调大该值才能恢复",
      })
    })

    let phase = account.webhook ? "webhook" : "login"
    try {
      if (account.webhook) {
        phase = "token"
        log.info(`[${id}] WebHook 模式：只获取 access_token，不建立 WebSocket`)
        await bot.sdk.sessionManager.getAccessToken()
        log.info(`[${id}] WebHook access_token 获取成功`, { elapsedMs: Date.now() - startedAt })
        if (Bot[id] !== bot) {
          await sdkLogout(bot.sdk)
          log.warn(`[${id}] 账号连接已被新的连接替换，放弃当前 WebHook 连接`)
          return { ok: false, intentError: false, error: "QQBot 账号连接已被替换", phase }
        }
        bot.login = () => {
          if (Bot[id] !== bot) throw new Error("QQBot 账号连接已被替换")
          bot.online = true
          markAdapterId(id, true)
          return (this.appid[opts.appid] = bot)
        }
        bot.logout = () => {
          bot.online = false
          if (Bot[id] === bot) markAdapterId(id, false)
          if (this.appid[opts.appid] === bot) return delete this.appid[opts.appid]
          return false
        }
      }

      phase = "login"
      await bot.login()
      if (account.webhook) log.info(`[${id}] WebHook 账号已上线`, { elapsedMs: Date.now() - startedAt })
      phase = "selfinfo"
      log.debug(`[${id}] 获取机器人资料`, { url: "/users/@me" })
      const self = await bot.sdk.getSelfInfo()
      Object.assign(bot.info, self)
      log.info(`[${id}] 机器人资料获取成功`, {
        username: self?.username,
        id: self?.id,
        appid: self?.appid,
        elapsedMs: Date.now() - startedAt,
      })
      if (Bot[id] !== bot) {
        await sdkLogout(bot.sdk)
        log.warn(`[${id}] 账号连接已被新的连接替换，放弃当前连接`)
        return { ok: false, intentError: false, error: "QQBot 账号连接已被替换", phase }
      }
    } catch (err) {
      const msg = err?.message || String(err)
      const intentError = /^40(13|14)\b/.test(msg) || /\b40(13|14)\b/.test(msg)
      const hint = describeErrorHint(err)
      log.error(`[${id}] 连接失败（阶段：${PHASE_TEXT[phase] || phase}）`, describeError(err, {
        phase,
        intents,
        elapsedMs: Date.now() - startedAt,
        online: bot.online,
        readyCount,
        hint,
      }))
      qblog.error(`[${id}] ${this.name}(${this.id}) ${this.version} 连接失败：${msg}`)
      if (hint) log.warn(`[${id}] 排查提示`, { hint })

      if (/^491[45]\b/.test(msg))
        qblog.error(`[${id}] 4914/4915：机器人已下架或封禁，请到 QQ 开放平台处理`)

      try {
        await bot.sdk.stop()
      } catch (e) {}
      if (Bot[id] === bot) {
        delete Bot[id]
        markAdapterId(id, false)
      }
      if (account.webhook && this.appid[opts.appid] === bot) delete this.appid[opts.appid]
      return { ok: false, intentError, error: msg, phase, hint }
    }

    if (bot.online) {
      markAdapterId(id, true)
      qblog.mark(`[${id}] ${this.name}(${this.id}) ${this.version} ${bot.nickname} 已连接`)
      log.info(`[${id}] 账号连接流程完成`, {
        nickname: bot.nickname,
        online: true,
        elapsedMs: Date.now() - startedAt,
        readyCount,
      })
      dispatch(`connect.${id}`, { self_id: id })
    } else {
      log.warn(`[${id}] 连接流程结束，但账号当前不在线`, {
        online: false,
        elapsedMs: Date.now() - startedAt,
        readyCount,
        hint: "通常表示 ready 之后立刻被网关关闭，请检查上面的 close / error 日志",
      })
    }
    return { ok: true }
  }

  async makeWebHookSign(id, req, secret) {
    const { sign } = (await import("tweetnacl")).default
    const { plain_token, event_ts } = req.body.d
    while (secret.length < 32) secret = secret.repeat(2).slice(0, 32)
    const signature = Buffer.from(
      sign.detached(
        Buffer.from(`${event_ts}${plain_token}`),
        sign.keyPair.fromSeed(Buffer.from(secret)).secretKey,
      ),
    ).toString("hex")
    qblog.debug(`[${id}] 签名生成`, { plain_token, signature })
    req.res.send({ plain_token, signature })
  }

  makeWebHook(req) {
    const appid = req.headers["x-bot-appid"]
    if (!(appid in this.appid)) return qblog.warn(`[${appid}] 找不到对应 QQBot`)
    if ("plain_token" in req.body?.d)
      return this.makeWebHookSign(this.appid[appid].uin, req, this.appid[appid].info.secret)
    if ("t" in req.body) this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
    req.res.sendStatus(200)
  }

  /** 启动适配器（幂等）。 */
  async init() {
    if (this.started) return
    this.started = true

    webhook.init()
    this.load().catch(err => qblog.error("适配器启动错误", err))
  }

  async load() {
    webhook.use(`/${this.name}`, this.makeWebHook.bind(this))
    for (const account of getAccounts(config)) await sleep(5000, this.connect(account))
  }
}
