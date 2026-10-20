import http from "node:http"
import { createReadStream } from "node:fs"
import path from "node:path"
import { config, configEvents, CFG_FILE } from "./cfg.js"
import { getAccounts } from "./accounts.js"
import { fsStat, contentType } from "./files.js"
import { qblog } from "./logger.js"

function addResHelpers(res) {
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.send = body => {
    if (body === undefined || body === null) return res.end()
    if (typeof body === "object") {
      if (!res.getHeader("Content-Type"))
        res.setHeader("Content-Type", "application/json; charset=utf-8")
      return res.end(JSON.stringify(body))
    }
    return res.end(String(body))
  }
  res.json = body => {
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify(body))
  }
  res.sendStatus = code => {
    res.statusCode = code
    res.end(String(code))
  }
  return res
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

/**
 * 内置 WebHook / 静态文件服务
 *
 * miao 没有 express，这里用 node:http 提供 WebHook 回调与 markdown 图片直链，
 * 端口见 plugins/QQBot-Plugin/config/config/cfg.yaml 里的 webhookPort，链路为 /QQBot 与 /QQBot/File/<name>。
 */
const webhook = {
  routes: new Map(),
  files: new Map(),
  server: null,
  initialized: false,
  warnedAccounts: new Set(),

  restartNotice(account) {
    if (!this.initialized || this.server || !account.webhook) return ""
    return "HTTP 服务未启动，WebHook 账号需要重启 Yunzai 后才能接入，请确认已配置有效的 webhookPort 和公网反向代理"
  },

  warnPendingAccounts() {
    const pending = new Set()
    for (const account of getAccounts(config)) {
      const notice = this.restartNotice(account)
      if (!notice) continue
      pending.add(account.appid)
      if (!this.warnedAccounts.has(account.appid))
        qblog.warn(`账号 ${account.uin}（AppID ${account.appid}）：${notice}`)
    }
    this.warnedAccounts = pending
  },

  use(route, handler) {
    this.routes.set(route, handler)
    return this
  },

  /** 只在插件初始化时决定是否监听，配置热更新不再临时拉起 HTTP 服务。 */
  init() {
    if (this.initialized) return this.server
    this.initialized = true
    if (!getAccounts(config).some(account => account.webhook)) return null
    const port = Number(config.webhookPort) || 0
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      qblog.warn(
        `未配置有效的 webhookPort，WebHook 模式不可用（请修改 ${CFG_FILE} 后重启 Yunzai）`,
      )
      return null
    }

    this.server = http.createServer(async (req, res) => {
      addResHelpers(res)
      req.res = res
      const url = (req.url || "").split("?")[0]
      try {
        if (req.method === "POST") {
          const body = await readBody(req)
          try {
            req.body = body.length ? JSON.parse(body.toString("utf8")) : {}
          } catch (err) {
            req.body = {}
          }
        }

        if (url.startsWith("/QQBot/File/")) return await this.serveFile(req, res, url)

        const handler = this.routes.get(url)
        if (handler) {
          await handler(req, res)
          /** 处理器未响应时兜底结束，避免请求悬挂 */
          if (!res.writableEnded) res.end()
          return
        }

        res.statusCode = 404
        res.end()
      } catch (err) {
        qblog.error("WebHook 请求处理错误", err)
        try {
          res.statusCode = 500
          res.end()
        } catch (e) {}
      }
    })

    this.server.on("error", err => {
      qblog.error(`WebHook 服务启动失败（端口 ${port}）`, err.message || err)
      this.server = null
    })
    this.server.listen(port, () =>
      qblog.mark(`WebHook 服务已启动，路径 /QQBot，端口 ${port}`),
    )
    return this.server
  },

  async serveFile(req, res, url) {
    const name = decodeURIComponent(url.replace(/^\/QQBot\/File\//, ""))
    let file = this.files.get(name)
    if (!file) file = path.join("data", "QQBot", "File", name)
    const stat = await fsStat(file)
    if (!stat) {
      res.statusCode = 404
      return res.end()
    }
    res.setHeader("Content-Type", await contentType(name, file))
    res.setHeader("Content-Length", stat.size)
    createReadStream(file).pipe(res)
  },
}

configEvents.on("change", () => webhook.warnPendingAccounts())

export {
  addResHelpers,
  readBody,
  webhook,
}
