import { config, CFG_FILE } from "../lib/utils/cfg.js"
import { getAccounts, normalizeAccount } from "../lib/utils/accounts.js"
import {
  createBot,
  login as sdkLogin,
  logout as sdkLogout,
  normalizeEvent,
} from "./sdk.js"
import {
  dispatch,
  GROUP_INTENTS,
  GUILD_MESSAGE_INTENTS,
  log,
  markAdapterId,
  OPTIONAL_INTENTS,
  sleep,
  webhook,
} from "../lib/utils/common.js"

export default class AdapterLifecycle {
  /**
   * 生成 intents
   *
   * 默认只申请群聊事件。频道和按钮交互等能力需要在 QQ 开放平台单独授权。
   */
  makeIntents(account) {
    if (Array.isArray(config.intents) && config.intents.length) return [...config.intents]
    if (account.group) return [...GROUP_INTENTS]
    if (account.guild) return [...GUILD_MESSAGE_INTENTS]
    return []
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
    push(wanted.filter(i => !OPTIONAL_INTENTS.includes(i)))

    if (!explicit && account.guild && !wanted.some(i => GUILD_MESSAGE_INTENTS.includes(i))) {
      push([...GUILD_MESSAGE_INTENTS])
      push(GUILD_MESSAGE_INTENTS.filter(i => !OPTIONAL_INTENTS.includes(i)))
    }

    if (!explicit && account.group) push(["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"])
    return candidates
  }

  /** 连接一个账号，intents 被拒绝时自动尝试更保守的组合。 */
  async connect(entry) {
    const account = normalizeAccount(entry)
    const id = account.uin
    const restartNotice = webhook.restartNotice(account)
    if (restartNotice) {
      log("warn", restartNotice, id)
      return false
    }
    delete this.activeIntents[id]

    const explicit = Array.isArray(config.intents) && config.intents.length > 0
    const wanted = this.makeIntents(account)
    const queue = this.buildIntentQueue(account, explicit)

    let lastError = null
    for (let i = 0; i < queue.length; i++) {
      const { list } = queue[i]
      const ret = await this.connectOnce(id, account, list)
      if (ret.ok) {
        this.activeIntents[id] = [...list]
        if (Bot[id]?.info) Bot[id].info.intents = [...list]
        if (Bot[id]) Bot[id].interaction = list.includes("INTERACTION")
        const dropped = wanted.filter(x => !list.includes(x))
        if (dropped.length)
          log(
            "warn",
            [
              `以下 intents 申请被平台拒绝，已自动降级连接：${dropped.join(" | ")}`,
              dropped.includes("INTERACTION")
                ? "没有 INTERACTION 就收不到按钮点击事件（INTERACTION_CREATE）：「回调按钮」可能无法使用。请到 QQ 开放平台为该机器人开启按钮交互能力。"
                : "请在 QQ 开放平台确认该机器人已开启对应能力。",
              `当前生效 intents：${list.join(" | ")}`,
            ],
            id,
          )
        else if (i > 0) log("warn", [`已改用兜底 intents：${list.join(" | ")}`], id)
        return true
      }
      if (!ret.intentError) return false
      lastError = ret.error
    }

    log(
      "error",
      [
        `intents 被拒绝（${lastError}），最后一次申请：${queue[queue.length - 1].list.join(" | ") || "（空）"}`,
        "4013/4014 说明其中有 intent 未被该机器人授权：请到 QQ 开放平台确认已开启对应能力，" +
          `或在 ${CFG_FILE} 的 intents 里只保留已授权的项。` +
          "可用项：群消息 GROUP_AT_MESSAGE_CREATE、C2C_MESSAGE_CREATE；" +
          "频道 GUILDS、GUILD_MESSAGES、PUBLIC_GUILD_MESSAGES、GUILD_MESSAGE_REACTIONS、DIRECT_MESSAGE、GUILD_MEMBERS；" +
          "按钮交互 INTERACTION；消息审核 MESSAGE_AUDIT（后两者需单独申请）",
      ],
      id,
    )
    return false
  }

  /** 单次连接尝试，intents 由 connect() 决定。 */
  async connectOnce(id, account, intents) {
    const opts = {
      ...config.bot,
      appid: account.appid,
      secret: account.secret,
      intents,
    }
    log("info", [`申请 intents：${intents.join(" | ") || "（空）"}`], id)

    Bot[id] = {
      adapter: this.id,
      sdk: createBot(opts),
      login: () => sdkLogin(Bot[id].sdk, opts.connectTimeout || 30000),
      logout() {
        markAdapterId(id, false)
        return sdkLogout(this.sdk)
      },

      uin: id,
      info: {
        id,
        ...opts,
        avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`,
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
      stat: { start_time: Date.now() / 1000 },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() {
        return this.gl
      },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),

      callback: {},
    }

    const silentSdkLogs = [
      "等待断线重连中",
      "重新连接中，尝试次数",
      "连接成功",
      "[WebSocketReceiver] 连接关闭：",
      "[WebSocketReceiver] 连接断开，第",
      "[WebSocketReceiver] 等待 ",
      "WebSocket连接已建立",
    ]
    Bot[id].sdk.logger = {}
    for (const level of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
      Bot[id].sdk.logger[level] = (...args) => {
        const head = String(args[0] ?? "")
        if (head.startsWith("recv from")) return
        if (level !== "error" && level !== "fatal" && silentSdkLogs.some(p => head.includes(p))) return
        return log(level, args, id)
      }

    let readyCount = 0
    Bot[id].sdk.sessionManager.receiver?.on("ready", () => {
      readyCount += 1
      if (readyCount > 1) log("mark", "自动重连成功", id)
    })

    try {
      if (account.webhook) {
        await Bot[id].sdk.sessionManager.getAccessToken()
        Bot[id].login = () => (this.appid[opts.appid] = Bot[id])
        Bot[id].logout = () => {
          markAdapterId(id, false)
          return delete this.appid[opts.appid]
        }
      }

      await Bot[id].login()
      Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
    } catch (err) {
      const msg = err?.message || String(err)
      const intentError = /^40(13|14)\b/.test(msg)
      log("error", [`${this.name}(${this.id}) ${this.version} 连接失败：${msg}`], id)

      if (/^491[45]\b/.test(msg))
        log("error", ["4914/4915：机器人已下架或封禁，请到 QQ 开放平台处理"], id)

      try {
        await Bot[id].sdk.stop()
      } catch (e) {}
      delete Bot[id]
      markAdapterId(id, false)
      if (account.webhook) delete this.appid[opts.appid]
      return { ok: false, intentError, error: msg }
    }

    Bot[id].sdk.on("message", event => this.makeMessage(id, normalizeEvent(event)))
    Bot[id].sdk.on("notice", event => this.makeNotice(id, normalizeEvent(event)))

    markAdapterId(id, true)
    log("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    dispatch(`connect.${id}`, { self_id: id })
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
    log("debug", ["QQBot 签名生成", { plain_token, signature }], id)
    req.res.send({ plain_token, signature })
  }

  makeWebHook(req) {
    const appid = req.headers["x-bot-appid"]
    if (!(appid in this.appid)) return log("warn", "找不到对应 QQBot", appid)
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
    this.load().catch(err => log("error", ["QQBot 适配器启动错误", err]))
  }

  async load() {
    webhook.use(`/${this.name}`, this.makeWebHook.bind(this))
    for (const account of getAccounts(config)) await sleep(5000, this.connect(account))
  }
}
