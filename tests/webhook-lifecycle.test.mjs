// node --experimental-vm-modules --test tests/webhook-lifecycle.test.mjs
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import http from "node:http"
import { once } from "node:events"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"
import test from "node:test"
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
import lodash from "lodash"
import YAML from "yaml"

const root = fileURLToPath(new URL("../", import.meta.url))
const account = { uin: "10001", appid: "20001", secret: "test-secret", webhook: true }

/** 读取真实插件源码，隔离宿主、配置文件和 SDK；HTTP 使用真实的临时本机端口。 */
async function fixture(t, initial = {}) {
  const warnings = []
  const debugLogs = []
  const listenPorts = []
  const files = new Map()
  const cfgFile = "./plugins/QQBot-Plugin/config/config/cfg.yaml"
  files.set("./plugins/QQBot-Plugin/config/defSet/cfg.yaml", YAML.stringify({
    accounts: [], token: [], webhookPort: 0, url: "", imageLength: 0,
  }))
  if (initial !== null) files.set(cfgFile, YAML.stringify(initial))
  let watchChange
  let connections = 0
  const context = createContext({
    Buffer, URL, setTimeout, clearTimeout, fetch, console,
    Bot: {}, plugin: class {},
    logger: {
      warn: (...args) => warnings.push(args.join(" ")),
      info() {}, mark() {}, error() {}, debug: (...args) => debugLogs.push(args.join(" ")), blue: value => value,
    },
  })
  const cache = new Map()
  const overrides = {
    lodash: { default: {
      ...lodash,
      debounce(fn) {
        let pending = false
        const debounced = () => { pending = true }
        debounced.flush = () => {
          if (!pending) return
          pending = false
          return fn()
        }
        return debounced
      },
    } },
    chokidar: { default: { watch: () => ({ on: (_event, handler) => { watchChange = handler } }) } },
    "node:fs": {
      ...await import("node:fs"),
      default: {
        mkdirSync() {}, existsSync: file => files.has(file),
        readFileSync(file) {
          if (!files.has(file)) throw new Error("ENOENT")
          return files.get(file)
        },
        writeFileSync: (file, data) => files.set(file, data),
        copyFileSync: (from, to) => files.set(to, files.get(from)),
      },
    },
    "node:http": { default: {
      createServer(handler) {
        const server = http.createServer(handler)
        const listen = server.listen
        server.listen = (port, callback) => {
          listenPorts.push(port)
          return listen.call(server, 0, "127.0.0.1", callback)
        }
        t.after(() => new Promise(resolve => server.close(resolve)))
        return server
      },
    } },
    hostConfig: { default: {} },
    hostUin: { orgUin: 0 },
    sdk: {
      createBot: () => { throw new Error("此用例不应创建 SDK") },
      login() {}, logout() {}, normalizeEvent: event => event,
    },
    adapter: { qqbot: { connect: async () => { connections++; return true } } },
  }
  async function synthetic(key, values) {
    if (!cache.has(key)) cache.set(key, new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value)
    }, { context, identifier: key }))
    return cache.get(key)
  }
  async function load(relative) {
    const identifier = pathToFileURL(path.resolve(root, relative)).href
    if (!cache.has(identifier)) cache.set(identifier, new SourceTextModule(
      await readFile(fileURLToPath(identifier), "utf8"), { context, identifier },
    ))
    const module = cache.get(identifier)
    if (module.status === "unlinked") await module.link(async (specifier, parent) => {
      if (specifier === "../../../../lib/config/config.js") return synthetic("hostConfig", overrides.hostConfig)
      if (specifier === "../uin.js") return synthetic("hostUin", overrides.hostUin)
      if (specifier === "./sdk.js") return synthetic("sdk", overrides.sdk)
      if (specifier === "../adapter/index.js") return synthetic("adapter", overrides.adapter)
      if (overrides[specifier]) return synthetic(specifier, overrides[specifier])
      if (!specifier.startsWith(".")) return synthetic(specifier, await import(specifier))
      return load(path.relative(root, fileURLToPath(new URL(specifier, parent.identifier))))
    })
    if (module.status === "linked") await module.evaluate()
    return module
  }
  const common = (await load("lib/utils/common.js")).namespace
  const cfg = (await load("lib/utils/cfg.js")).namespace
  const changeFile = data => {
    files.set(cfgFile, YAML.stringify(data))
    watchChange()
    watchChange.flush()
  }
  return { ...common, ...cfg, warnings, debugLogs, listenPorts, files, changeFile, load,
    setBot: bot => { context.Bot = bot },
    connections: () => connections,
  }
}

test("gateway event debug logs preserve the complete packet", async t => {
  const f = await fixture(t, null)
  const packet = {
    t: "UNKNOWN_EVENT",
    d: { nested: { value: "x".repeat(1200) }, entries: Array.from({ length: 60 }, (_, i) => i) },
  }
  f.logEventPacket(packet.t, packet, "10001")
  assert.equal(f.debugLogs.length, 1)
  assert.ok(f.debugLogs[0].includes("收到事件包 [UNKNOWN_EVENT]"))
  assert.ok(f.debugLogs[0].includes("x".repeat(1200)))
  assert.ok(f.debugLogs[0].includes("59"))
})

test("QQBot 消息通过真实 ICQQ TripTrap 投递，缺少 listenerCount 不再绕过面板", async t => {
  const f = await fixture(t, null)
  const hostRequire = createRequire(new URL("../../../package.json", import.meta.url))
  const require = createRequire(hostRequire.resolve("icqq"))
  const { Trapper } = require("triptrap")
  const bot = new Trapper(), captured = []
  bot.on = bot.trap.bind(bot)
  bot.emit = bot.trip.bind(bot)
  assert.equal(typeof bot.listenerCount, "undefined")
  bot.on("message", event => captured.push(event))
  bot.on("message.group", event => captured.push(event))
  f.setBot(bot)
  f.bindAdapter({ id: "QQBot", sep: ":", pickGroup: () => ({}), pickMember: () => ({}) })
  await f.dispatch("message.group", { self_id: "10001", post_type: "message", message_type: "group", group_id: "10001:GROUP", sender: { user_id: "10001:USER", permissions: ["owner"] }, message_id: "mock-received", message: [{ type: "text", text: "mock" }], raw_message: "mock" })
  assert.equal(captured.length, 2)
  assert.equal(captured[0], captured[1])
  assert.equal(captured[0].group_id, "GROUP")
  assert.deepEqual([...captured[0].sender.permissions], ["owner"])
})

test("真实 SDK 引用事件 103 保留引用摘要，正文与引用分开，不虚构 msg_idx 映射", async t => {
  const f = await fixture(t, null)
  const sdkModule = (await f.load("adapter/sdk.js")).namespace
  const sdk = sdkModule.createBot({ appid: "10000", secret: randomBytes(24).toString("hex"), intents: [] })
  const base = { id: "incoming-quote", group_openid: "GROUP", content: "回复正文", author: { id: "USER", member_openid: "USER", username: "Member" }, timestamp: new Date().toISOString(), message_type: 103, msg_elements: [{ content: "被引用的原文", message_type: 0, msg_idx: "different-index" }] }
  const event = sdk.processPayload("event", "message.group", { ...base })
  assert.equal(event.message_type, "group")
  assert.equal(event._qqbotMessageType, 103)
  sdkModule.normalizeEvent(event)
  assert.equal(event.source.raw_message, "被引用的原文")
  assert.equal(event.source.message_id, "")
  assert.equal(event.message[0].type, "reply")
  assert.equal(event.message[1].text, "回复正文")
  sdkModule.normalizeEvent(event)
  assert.equal(event.message.filter(segment => segment.type === "reply").length, 1)
  const bare = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, id: "bare", content: "" }))
  assert.equal(bare.message.length, 1)
  assert.equal(bare.message[0].type, "reply")
  const media = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, content: "", msg_elements: [{ attachments: [{ content_type: "image/png" }] }] }))
  assert.equal(media.source.raw_message, "[图片]")
  const ordinary = sdkModule.normalizeEvent(sdk.processPayload("event", "message.group", { ...base, message_type: 0 }))
  assert.equal(ordinary.source, undefined)
})

test("首次没有用户配置时生成默认配置，不启动 HTTP", async t => {
  const f = await fixture(t, null)
  assert.equal(f.files.size, 2)
  f.webhook.use("/QQBot", () => {})
  f.webhook.init()
  assert.equal(f.webhook.server, null)
  assert.equal(f.listenPorts.length, 0)
  assert.equal(f.warnings.length, 0)
})

for (const [name, accounts] of [
  ["无账号", []],
  ["仅有 WebSocket 账号", [{ ...account, webhook: false }]],
  ["WebHook 账号缺少密钥", [{ ...account, secret: "" }]],
]) test(`${name}时配置了端口和公网地址也不启动 HTTP`, async t => {
  const f = await fixture(t, { accounts, webhookPort: 8080, url: "https://example.com" })
  f.webhook.use("/QQBot", () => {})
  f.webhook.init()
  assert.equal(f.webhook.init(), null)
  assert.equal(await f.fileToUrl(Buffer.from("image")), "")
  assert.equal(f.listenPorts.length, 0)
  assert.equal(await f.fileToUrl("https://example.com/image.png"), "https://example.com/image.png")
})

test("WebHook 账号在启动时监听，HTTP 回调可用且初始化幂等", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.use("/QQBot", req => req.res.send({ ok: req.body.d === "hello" }))
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const response = await fetch(`http://127.0.0.1:${f.webhook.server.address().port}/QQBot`, {
    method: "POST", body: JSON.stringify({ d: "hello" }),
  })
  assert.deepEqual(await response.json(), { ok: true })
  f.webhook.files.set("source.mjs", path.join(root, "tests/webhook-lifecycle.test.mjs"))
  const imageRoute = await fetch(`http://127.0.0.1:${f.webhook.server.address().port}/QQBot/File/source.mjs`)
  assert.equal(imageRoute.status, 200)
  assert.match(await imageRoute.text(), /node --experimental-vm-modules --test/)
  f.webhook.init()
  assert.equal(f.listenPorts.length, 1)
  assert.equal(f.webhook.restartNotice(account), "")
})

test("旧 token 格式的 WebHook 账号仍可在启动时监听", async t => {
  const f = await fixture(t, { token: ["10001:20001:ignored:test-secret:2:0"], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  assert.equal(f.listenPorts.length, 1)
})

test("文件热更新新增 WebHook 账号提示重启，不临时启动或连接", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  f.changeFile({ accounts: [account] })
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  f.changeFile({ accounts: [account] })
  assert.equal(f.warnings.length, 1)
  assert.equal(f.webhook.init(), null)
  const Lifecycle = (await f.load("adapter/lifecycle.js")).namespace.default
  assert.equal(await new Lifecycle().connect(account), false)
  assert.equal(f.listenPorts.length, 0)
})

test("运行中通过指令添加 WebHook 账号会保存并回复重启提示", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  const Plugin = (await f.load("lib/plugin.js")).namespace.QQBotPlugin
  const instance = new Plugin()
  const replies = []
  instance.e = { msg: "#QQBot设置10001:20001:ignored:test-secret:2:0" }
  instance.reply = message => replies.push(message)
  await instance.Token()
  f.configSave.flush()
  assert.equal(f.config.accounts[0].webhook, true)
  assert.match(replies[0], /账号配置已添加.*需要重启 Yunzai 后才能接入/)
  assert.equal(f.connections(), 0)
  assert.equal(f.listenPorts.length, 0)
})

test("运行中通过指令添加 WebSocket 账号仍可直接连接", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  const Plugin = (await f.load("lib/plugin.js")).namespace.QQBotPlugin
  const instance = new Plugin()
  const replies = []
  instance.e = { msg: "#QQBot设置10001:20001:test-secret" }
  instance.reply = message => replies.push(message)
  await instance.Token()
  assert.match(replies[0], /账号已连接/)
  assert.equal(f.connections(), 1)
  assert.equal(f.listenPorts.length, 0)
})

test("面板新增 WebHook 账号保存成功并明确提示重启", async t => {
  const f = await fixture(t, { webhookPort: 8080 })
  f.webhook.init()
  const panel = (await f.load("elia.support.js")).namespace.supportPanel()
  const result = await panel.configInfo.setConfigData({ accounts: [account] }, {
    Result: { ok: (_data, message) => ({ ok: true, message }), error: message => ({ ok: false, message }) },
  })
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /需要重启 Yunzai 后才能接入/)
  assert.equal(f.config.accounts[0].webhook, true)
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  assert.equal(f.listenPorts.length, 0)
})

test("WebHook 账号未启用端口时不启动，后补端口仍需重启", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 0 })
  f.webhook.init()
  assert.equal(f.webhook.server, null)
  f.changeFile({ webhookPort: 8080 })
  assert.match(f.warnings.join("\n"), /需要重启 Yunzai 后才能接入/)
  assert.equal(f.webhook.init(), null)
  assert.equal(f.listenPorts.length, 0)
})

async function panelSave(f, data) {
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const result = await panel.setConfigData(data, {
    Result: { ok: (_data, message) => ({ ok: true, message }), error: message => ({ ok: false, message }) },
  })
  assert.equal(result.ok, true, result.message)
  return result.message
}

test("仅修改实时发送设置时无需重启，部分保存保留原引用回复策略", async t => {
  const f = await fixture(t, { activeMsg: true })
  f.webhook.init()
  const message = await panelSave(f, { sendMode: { default: "text" } })
  assert.equal(message, "配置已保存；本次修改无需重启")
  assert.equal(f.config.activeMsg, true)
})

for (const [field, value, label] of [
  ["intents", ["INTERACTION"], "Intents"],
  ["bot.timeout", 60000, "Bot 连接参数"],
  ["permission", "admin", "管理指令权限"],
  ["toQRCode", false, "链接转二维码规则"],
]) test(`修改${label}时仅提示对应项需要重启`, async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { [field]: value }), `配置已保存；${label}变更需重启 Yunzai 生效`)
})

test("同时修改连接参数和实时设置时分别提示生效方式", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { "bot.timeout": 60000, toCallback: false }),
    "配置已保存；Bot 连接参数变更需重启 Yunzai 生效；其他修改无需重启")
})

test("完整表单原样保存及保留密钥不会误报账号变更", async t => {
  const f = await fixture(t, { accounts: [{ ...account, webhook: false }] })
  f.webhook.init()
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const data = await panel.getConfigData()
  assert.equal(data.accounts[0].AppSecret, "")
  assert.equal(await panelSave(f, data), "配置已保存；配置内容未变化")
  assert.equal(f.config.accounts[0].secret, account.secret)
})

test("修改账号密钥提示重启且提示不包含密钥", async t => {
  const f = await fixture(t, { accounts: [{ ...account, webhook: false }] })
  f.webhook.init()
  const message = await panelSave(f, { accounts: [{ ...account, webhook: false, secret: "new-test-secret" }] })
  assert.equal(message, "配置已保存；账号变更需重启 Yunzai 生效")
  assert.doesNotMatch(message, /test-secret/)
})

test("存在 WebHook 账号但端口为 0 时提示补齐端口", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  const message = await panelSave(f, { accounts: [account] })
  assert.match(message, /WebHook 端口为 0，请配置有效端口并重启 Yunzai 后接入/)
})

test("没有 WebHook 账号且 HTTP 未启动时调整端口无需重启", async t => {
  const f = await fixture(t, {})
  f.webhook.init()
  assert.equal(await panelSave(f, { webhookPort: 8080 }), "配置已保存；本次修改无需重启")
})

test("HTTP 运行中删除最后一个 WebHook 账号提示重启关闭服务", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const message = await panelSave(f, { accounts: [] })
  assert.match(message, /账号变更需重启 Yunzai 生效/)
  assert.match(message, /当前 HTTP 服务仍在运行，重启 Yunzai 后将关闭/)
  assert.equal(f.webhook.server.listening, true)
})

test("HTTP 运行中关闭端口提示端口变更和重启关闭服务", async t => {
  const f = await fixture(t, { accounts: [account], webhookPort: 8080 })
  f.webhook.init()
  await once(f.webhook.server, "listening")
  const message = await panelSave(f, { webhookPort: 0 })
  assert.match(message, /WebHook 端口变更需重启 Yunzai 生效/)
  assert.match(message, /当前 HTTP 服务仍在运行，重启 Yunzai 后将关闭/)
})
