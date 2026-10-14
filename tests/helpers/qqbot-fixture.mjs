import { readFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"
import { EventEmitter } from "node:events"
import lodash from "lodash"
import YAML from "yaml"

const root = fileURLToPath(new URL("../../", import.meta.url))

/** 读取真实插件源码，隔离宿主、配置文件和 SDK；HTTP 使用真实的临时本机端口。 */
export async function fixture(t, initial = {}) {
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
    Buffer, URL, AbortSignal, setTimeout, clearTimeout, fetch, console,
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

export const incomingSelf = "114514"
export const incomingUser = "A".repeat(32)
export const incomingGroup = "B".repeat(32)
export const mentionedUser = "C".repeat(32)
export const incomingBase = {
  id: "mock-official-message", group_openid: incomingGroup, group_id: incomingGroup,
  author: { id: incomingUser, member_openid: incomingUser, username: "Alice", member_role: "owner" },
  content: "", message_type: 0, timestamp: "2024-01-02T03:04:05.678+08:00",
}

/** 真实 SDK 网关解析 → 适配器 → 宿主 message 监听器；不连接真实账号。 */
export async function incomingFixture(t, sep = ":", groupInfo = { group_name: "Demo Group" }) {
  const f = await fixture(t, null)
  const bot = new EventEmitter()
  const account = bot[incomingSelf] = {
    uin: incomingSelf, nickname: "DemoBot", info: { appid: "mock-app" },
    fl: new Map(), gml: new Map(), gl: new Map([[`${incomingSelf}${sep}${incomingGroup}`, groupInfo]]),
  }
  f.setBot(bot)
  const AdapterEvents = (await f.load("adapter/events.js")).namespace.default
  const adapter = new AdapterEvents()
  Object.assign(adapter, { id: "QQBot", sep, toQRCodeRegExp: false, interactionWarned: {}, activeIntents: {} })
  f.bindAdapter(adapter)
  const sdkModule = (await f.load("adapter/sdk.js")).namespace
  const processListeners = new Map(["uncaughtException", "unhandledRejection"].map(name => [name, process.listeners(name)]))
  const sdk = sdkModule.createBot({ appid: "mock-app", secret: "mock-secret", intents: [] })
  // SDK 每次构造 Bot 都会添加进程监听器，隔离用例结束后仅清理本次新增项。
  const addedListeners = [...processListeners].flatMap(([name, previous]) => process.listeners(name)
    .filter(listener => !previous.includes(listener)).map(listener => [name, listener]))
  t.after(() => addedListeners.forEach(([name, listener]) => process.removeListener(name, listener)))
  sdk.logger = { info() {}, debug() {}, warn() {} }
  account.sdk = sdk
  Object.assign(account, adapter.accountMethods(incomingSelf), {
    pickGroup: group => adapter.pickGroup(incomingSelf, group),
    pickFriend: user => adapter.pickFriend(incomingSelf, user),
    pickMember: (group, user) => adapter.pickMember(incomingSelf, group, user),
  })
  const captured = []
  bot.on("message", event => captured.push(event))
  async function receive(type, payload) {
    const parsed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SDK 未投递消息")), 1000)
      sdk.once("message", event => { clearTimeout(timer); resolve(event) })
      sdk.dispatchEvent(type, { op: 0, t: type, id: "mock-event", d: payload })
    })
    await adapter.makeMessage(incomingSelf, sdkModule.normalizeEvent(parsed))
    return captured.at(-1)
  }
  async function notify(type, payload) {
    const parsed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SDK 未投递通知")), 1000)
      sdk.once("notice", event => { clearTimeout(timer); resolve(event) })
      sdk.dispatchEvent(type, { op: 0, t: type, id: "mock-notice", d: payload })
    })
    await adapter.makeNotice(incomingSelf, sdkModule.normalizeEvent(parsed))
  }
  return { ...f, sdkModule, sdk, bot, adapter, account, receive, notify, captured }
}
