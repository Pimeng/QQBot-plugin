import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"
import { contactMap } from "../lib/contact-map.js"
import { incomingFixture, incomingSelf, incomingGroup, incomingUser, incomingBase } from "./helpers/qqbot-fixture.mjs"

class Host extends EventEmitter {
  #online
  constructor(online = false) {
    super()
    this.#online = online
    this.uin = online ? 12345 : 88888
    this[this.uin] = this
    this.adapter = []
    this.gl = new Map()
    this.fl = new Map()
    this.gml = new Map()
    this.calls = []
  }
  isOnline() { return this.#online }
  setOnline(online) { this.#online = online }
  getVideoUrl() { throw new Error("不应调用离线 icqq 协议") }
  pickGroup(id, strict) {
    this.#online
    this.calls.push(["group", id, strict])
    return { bot: this, group_id: id, sendMsg: message => [this.uin, id, message], pickMember: uid => ({ bot: this, group_id: id, user_id: uid }) }
  }
  pickFriend(id, strict) {
    this.#online
    this.calls.push(["friend", id, strict])
    return { bot: this, user_id: id, sendMsg: message => [this.uin, id, message] }
  }
}

async function fixture(online = false) {
  const host = new Host(online)
  const logs = []
  const context = createContext({ Bot: host, Map, Set, WeakMap })
  const modules = new Map()
  const common = new SyntheticModule(["log"], function () { this.setExport("log", (...args) => logs.push(args)) }, { context })
  const adapter = new SyntheticModule(["qqbot"], function () { this.setExport("qqbot", { sep: ":" }) }, { context })
  for (const name of ["uin", "bot"]) modules.set(name, new SourceTextModule(
    await readFile(new URL(`../lib/${name}.js`, import.meta.url), "utf8"),
    { context, identifier: name },
  ))
  await modules.get("bot").link(specifier => specifier === "./uin.js" ? modules.get("uin") :
    specifier === "./utils/common.js" ? common : adapter)
  await modules.get("bot").evaluate()
  function account(id) {
    const calls = []
    const bot = {
      adapter: "QQBot", uin: id, nickname: `Bot ${id}`, version: { name: "QQBot" }, stat: { start_time: 42 },
      gl: new Map(), fl: new Map(), gml: new Map(), calls,
      pickGroup(gid, strict) {
        assert.equal(this, bot)
        calls.push(["group", gid, strict])
        return { bot, group_id: gid, sendMsg: (...args) => [id, gid, ...args], getInfo: (...args) => [id, gid, ...args],
          getMemberMap: (...args) => [id, gid, ...args], pickMember: uid => ({ bot, group_id: gid, user_id: uid }) }
      },
      pickFriend(uid, strict) {
        assert.equal(this, bot)
        calls.push(["friend", uid, strict])
        return { bot, user_id: uid, sendMsg: (...args) => [id, uid, ...args] }
      },
      pickMember(gid, uid, strict) {
        assert.equal(this, bot)
        calls.push(["member", gid, uid, strict])
        return { bot, group_id: gid, user_id: uid, getInfo: (...args) => [id, gid, uid, ...args] }
      },
      makeForwardMsg(nodes) { assert.equal(this, bot); return [id, nodes] },
      customMethod() { assert.equal(this, bot); return this.uin },
      messageCache: new Map(),
      getMsg(mid) { assert.equal(this, bot); return [id, mid] },
      getChatHistory(mid, count) { assert.equal(this, bot); return [id, mid, count] },
    }
    context.Bot[id] = bot
    context.Bot.adapter.push(id)
    return bot
  }
  return { host, bot: context.Bot, account, logs }
}

test("只有 QQBot 时全局账号、资料、实际方法与事件总线可用", async () => {
  const f = await fixture()
  assert.equal(f.bot.uin, 88888)
  assert.equal(f.bot.isOnline(), false)
  const first = f.account("10001")
  assert.equal(f.bot.uin, "10001")
  assert.equal(f.bot[f.bot.uin], first)
  assert.equal(f.bot.isOnline(), true)
  assert.equal(f.bot.nickname, first.nickname)
  assert.equal(f.bot.stat, first.stat)
  assert.equal(f.bot.customMethod(), "10001")
  assert.deepEqual(f.bot.makeForwardMsg(["hello"]), ["10001", ["hello"]])
  assert.equal(f.bot.customMethod, f.bot.customMethod)
  const second = f.account("10000")
  assert.equal(f.bot.uin, first.uin)
  const events = []
  f.bot.on("message", event => events.push(event))
  f.bot.emit("message", "收到")
  assert.deepEqual(events, ["收到"])
  assert.equal(f.host.listenerCount("message"), 1)
  assert.equal(f.bot.listenerCount("message"), 1)
  assert.ok(f.bot.adapter.includes(first.uin))
  f.bot.adapter.splice(0, 1)
  assert.equal(f.bot.uin, second.uin)
  f.bot.adapter.splice(0, 1)
  assert.equal(f.bot.uin, 88888)
  assert.equal(f.bot.isOnline(), false)
})

test("仅 QQBot 的缺失方法明确报不支持，宿主字段和插件扩展仍可用", async () => {
  const f = await fixture()
  f.host.pluginExtension = function () { assert.equal(this, f.host); return "插件扩展" }
  const account = f.account("10001")
  await assert.rejects(f.bot.getVideoUrl("file"), /QQBot 官方接口不支持 Bot.getVideoUrl/)
  assert.equal(f.bot.pluginExtension(), "插件扩展")
  assert.equal(f.bot.constructor, Host)
  f.bot.newExtension = () => "新插件扩展"
  assert.equal(f.bot.newExtension(), "新插件扩展")
  // 账号后来补齐接口后，直接使用真实账号实现。
  account.getVideoUrl = file => `https://example.invalid/${file}`
  assert.equal(f.bot.getVideoUrl("file"), "https://example.invalid/file")
  delete account.getVideoUrl
  f.host.setOnline(true)
  assert.throws(() => f.bot.getVideoUrl("file"), /不应调用离线 icqq 协议/)
})

test("实时聚合缓存保留宿主键、裸 openid、实例键与所属账号", async () => {
  const f = await fixture(true)
  const group = { group_name: "官方群" }, friend = { nickname: "好友" }
  const first = f.account("10001")
  f.host.gl.set(123, { group_name: "icqq 群", uin: f.host.uin })
  first.gl.set("10001:GROUP", group)
  first.fl.set("10001:USER", friend)
  const gl = f.bot.gl, fl = f.bot.fl
  assert.equal(gl instanceof Map, true)
  assert.equal(gl.size, 2)
  assert.equal(gl.get("123").group_name, "icqq 群")
  assert.equal(gl.get("GROUP").uin, first.uin)
  assert.equal(gl.get("10001:GROUP").group_name, "官方群")
  assert.equal(fl.get("USER").nickname, "好友")
  assert.equal(fl.get("USER").uin, first.uin)
  assert.equal(gl.get("GROUP"), gl.get("GROUP"))
  assert.deepEqual({ ...gl.get("GROUP") }, { group_name: "官方群", uin: first.uin })
  gl.get("GROUP").group_name = "更新群名"
  assert.equal(group.group_name, "更新群名")
  first.gl.set("10001:NEXT", { group_name: "新群" })
  assert.equal(gl.size, 3)
  assert.deepEqual([...gl.keys()], [123, "GROUP", "NEXT"])
  const seen = []
  gl.forEach((value, key, map) => { assert.equal(map, gl); seen.push([key, value.uin]) })
  assert.deepEqual(seen, [[123, 12345], ["GROUP", "10001"], ["NEXT", "10001"]])
  assert.equal(gl.delete("NEXT"), true)
  assert.equal(first.gl.has("10001:NEXT"), false)
  f.bot.adapter.splice(0, 1)
  assert.equal(gl.has("GROUP"), false)
  assert.equal(gl.size, 1)
})

test("跨账号 pick 与全局调用按缓存和实例前缀路由，保留 strict 与宿主 this", async () => {
  const f = await fixture(true)
  const first = f.account("10001"), second = f.account("10002")
  f.host.gl.set(123, { group_name: "icqq 群" })
  first.gl.set("10001:SHARED", { group_name: "第一群" })
  second.gl.set("10002:SHARED", { group_name: "第二群" })
  second.gl.set("10002:OTHER", {})
  second.fl.set("10002:USER", {})
  assert.equal(f.bot.pickGroup("123").bot, f.host)
  assert.equal(f.host.calls.at(-1)[1], 123)
  assert.equal(f.bot.pickGroup("999").bot, f.host)
  assert.equal(f.bot.pickGroup("SHARED").bot, first)
  assert.equal(f.bot.pickGroup("10002:SHARED", true).bot, second)
  assert.deepEqual(second.calls.at(-1), ["group", "10002:SHARED", true])
  assert.equal(f.bot.pickFriend("USER").bot, second)
  assert.equal(f.bot.pickUser("USER").bot, second)
  assert.equal(f.bot.pickMember("OTHER", "USER", true).bot, second)
  assert.deepEqual(second.calls.at(-1), ["member", "10002:OTHER", "USER", true])
  assert.deepEqual(f.bot.sendGroupMsg("OTHER", "正文"), ["10002", "10002:OTHER", "正文"])
  assert.deepEqual(f.bot.sendPrivateMsg("USER", "正文"), ["10002", "10002:USER", "正文"])
  assert.deepEqual(f.bot.getGroupMemberInfo("OTHER", "USER", true), ["10002", "10002:OTHER", "USER", true])
  assert.deepEqual(f.bot.getGroupMemberList("OTHER", true), ["10002", "10002:OTHER", true])
  assert.equal(f.bot.gl.get("SHARED").uin, first.uin)
  assert.equal(f.bot.gl.get("10002:SHARED").uin, second.uin)
  assert.equal(f.bot.gl.size, 4)
  assert.throws(() => f.bot.pickGroup("MISSING", true), /找不到群/)
  assert.throws(() => f.bot.pickFriend("MISSING", true), /找不到好友/)
  assert.equal(f.bot.pickGroup("MISSING"), undefined)
})

test("单账号允许未缓存的主动目标，多账号要求明确前缀或已有缓存", async () => {
  const f = await fixture()
  const first = f.account("10001")
  assert.equal(f.bot.pickGroup("NEW").bot, first)
  assert.equal(f.bot.pickFriend("NEW").bot, first)
  f.account("10002")
  assert.equal(f.bot.pickGroup("NEW"), undefined)
  assert.equal(f.bot.pickGroup("10001:NEW").bot, first)
  assert.throws(() => f.bot.pickGroup("10001:NEW", true), /找不到群/)
})

test("代理可枚举原有和新账号，移除原客户端上的账号后不会残留", async () => {
  const f = await fixture()
  const first = f.account("10001")
  f.host[first.uin] = first
  delete f.bot[first.uin]
  assert.equal(f.bot[first.uin], first)
  assert.equal(Object.keys(f.bot).filter(id => id === first.uin).length, 1)
  delete f.bot[first.uin]
  assert.equal(f.bot[first.uin], undefined)
  assert.equal(f.bot.isOnline(), false)
  assert.ok("pickGroup" in f.bot)
  assert.ok("on" in f.bot)
})

test("全局历史方法查实际消息归属，未知消息不会落到离线 icqq", async () => {
  const f = await fixture()
  const first = f.account("10001"), second = f.account("10002")
  first.messageCache.set(JSON.stringify(["group", "GROUP", "first"]), { message_id: "first" })
  second.messageCache.set(JSON.stringify(["group", "OTHER", "second"]), { message_id: "second" })
  assert.deepEqual(await f.bot.getMsg("second"), [second.uin, "second"])
  assert.deepEqual(await f.bot.getChatHistory("first", 3), [first.uin, "first", 3])
  await assert.rejects(f.bot.getMsg("missing"), /未缓存或已过期/)
  // 已退出的账号仍允许取先前收到的本地历史。
  f.bot.adapter.splice(1, 1)
  assert.deepEqual(await f.bot.getMsg("second"), [second.uin, "second"])
  first.gl.set("10001:GROUP", {})
  first.fl.set("10001:USER", {})
  first.pickGroup = gid => ({ getChatHistory: (...args) => [first.uin, gid, ...args] })
  first.pickFriend = uid => ({ getChatHistory: (...args) => [first.uin, uid, ...args] })
  assert.deepEqual(f.bot.getGroupMsgHistory("GROUP", "first", 2), [first.uin, "10001:GROUP", "first", 2])
  assert.deepEqual(f.bot.getFriendMsgHistory("USER", 0, 4), [first.uin, "10001:USER", 0, 4])
})

test("账号缓存接受裸 ID 和实例 ID，迭代、资料和 size 只显示一份", () => {
  const rawInfo = { group_id: "10001:GROUP", owner_id: "10001:USER", group_name: "群" }
  const raw = new Map([["10001:GROUP", rawInfo], ["qg_GUILD-CHANNEL", { group_id: "qg_GUILD-CHANNEL" }]])
  const map = contactMap(raw, "10001", ":")
  assert.equal(contactMap(raw, "10001", ":"), map)
  assert.equal(map.get("GROUP"), map.get("10001:GROUP"))
  assert.equal(map.get("GROUP").group_id, "GROUP")
  assert.equal(map.get("GROUP").owner_id, "USER")
  assert.equal(map.has("GROUP"), true)
  assert.equal(map.has("10001:GROUP"), true)
  assert.deepEqual([...map.keys()], ["GROUP", "qg_GUILD-CHANNEL"])
  assert.equal(map.size, raw.size)
  assert.equal(map.get("qg_GUILD-CHANNEL").group_id, "qg_GUILD-CHANNEL")
  assert.equal(rawInfo.group_id, "10001:GROUP")
  assert.deepEqual({ ...map.get("GROUP") }, { group_id: "GROUP", owner_id: "USER", group_name: "群" })
  map.get("GROUP").group_name = "新群名"
  assert.equal(rawInfo.group_name, "新群名")
  const next = { group_id: "10001:GROUP", group_name: "再次更新" }
  assert.equal(map.set("GROUP", next), map)
  assert.equal(raw.get("10001:GROUP"), next)
  assert.equal(raw.has("GROUP"), false)
  const seen = []
  map.forEach((value, key, current) => { assert.equal(current, map); seen.push([key, value.group_id]) })
  assert.deepEqual(seen, [["GROUP", "GROUP"], ["qg_GUILD-CHANNEL", "qg_GUILD-CHANNEL"]])
  assert.equal(map.delete("GROUP"), true)
  assert.equal(raw.has("10001:GROUP"), false)
})

test("嵌套成员缓存与新增 Map 实时互通，保留持久化写入钩子", () => {
  const member = { group_id: "10001:GROUP", user_id: "10001:USER", nickname: "Alice" }
  const members = new Map([["10001:USER", member]])
  const raw = new Map([["10001:GROUP", members]])
  const changes = []
  const originalSet = raw.set.bind(raw), originalDelete = raw.delete.bind(raw)
  raw.set = (key, value) => { changes.push(["set", key]); return originalSet(key, value) }
  raw.delete = key => { changes.push(["delete", key]); return originalDelete(key) }
  const map = contactMap(raw, "10001", ":", true)
  const group = map.get("GROUP")
  assert.equal(group instanceof Map, true)
  assert.equal(map.get("10001:GROUP"), group)
  assert.deepEqual([...group.keys()], ["USER"])
  assert.equal(group.get("USER").group_id, "GROUP")
  assert.equal(group.get("USER").user_id, "USER")
  group.set("USER", { ...member, nickname: "Bob" })
  assert.equal(members.get("10001:USER").nickname, "Bob")
  members.set("10001:NEXT", { user_id: "10001:NEXT" })
  assert.equal(group.has("NEXT"), true)
  assert.equal(group.size, 2)
  map.set("GROUP", group)
  assert.equal(raw.get("10001:GROUP"), members)
  assert.ok(changes.some(([action, key]) => action === "set" && key === "10001:GROUP"))
  map.set("NEW", new Map([["10001:FRESH", { user_id: "10001:FRESH" }]]))
  assert.equal(map.get("10001:NEW").get("FRESH").user_id, "FRESH")
  map.clear()
  assert.equal(raw.size, 0)
  assert.ok(changes.some(([action]) => action === "delete"))
})

test("成员 Map 支持自定义分隔符且不会把重复别名重复计数", () => {
  const raw = new Map([["10001USER", { user_id: "10001USER" }], ["USER", { nickname: "同一人" }]])
  const map = contactMap(raw, "10001", "")
  assert.equal(map.size, 1)
  assert.deepEqual([...map.keys()], ["USER"])
  map.set("USER", { user_id: "10001USER", nickname: "更新" })
  assert.equal(raw.size, 1)
  assert.equal(map.get("10001USER").nickname, "更新")
  assert.equal(map.delete("10001USER"), true)
  assert.equal(map.size, 0)
})

test("真实入站消息经过账号 Map 与全局代理后仍可按事件裸 ID 查成员、取历史和发送", async t => {
  const f = await incomingFixture(t)
  f.bot.uin = 88888
  f.bot[88888] = f.bot
  f.bot.isOnline = () => false
  f.bot.adapter = [incomingSelf]
  f.account.adapter = "QQBot"
  f.account.fl = contactMap(f.account.fl, incomingSelf, ":")
  f.account.gl = contactMap(f.account.gl, incomingSelf, ":")
  f.account.gml = contactMap(f.account.gml, incomingSelf, ":", true)
  await f.load("lib/bot.js")
  const bot = f.getBot()
  await f.receive("C2C_MESSAGE_CREATE", { id: "private-flow", content: "私信正文", timestamp: incomingBase.timestamp,
    author: { user_openid: incomingUser, username: "Alice" } })
  const e = await f.receive("GROUP_MESSAGE_CREATE", { ...incomingBase, content: "缓存正文" })
  assert.equal(bot.uin, incomingSelf)
  assert.equal(bot[bot.uin], e.bot)
  assert.ok(e.bot.fl.has(e.user_id), JSON.stringify({ uid: e.user_id, keys: [...e.bot.fl.keys()] }))
  assert.equal(e.bot.fl.get(e.user_id).nickname, "Alice")
  assert.equal(e.bot.gml.get(e.group_id).get(e.user_id).nickname, "Alice")
  assert.equal(e.bot.gml.get(e.group_id).get(e.user_id).user_id, incomingUser)
  assert.equal(bot.gl.get(e.group_id).uin, incomingSelf)
  assert.equal(bot.gl.get(e.group_id).group_id, incomingGroup)
  assert.equal(bot.pickGroup(e.group_id).group_id, incomingGroup)
  assert.equal(bot.pickMember(e.group_id, e.user_id).nickname, "Alice")
  const history = await bot.pickGroup(e.group_id).getChatHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].message_id, e.message_id)
  assert.equal(history[0].raw_message, "缓存正文")
  assert.equal((await bot.getMsg(e.message_id)).bot, f.account)
  assert.equal((await bot.getMsg(e)).bot, f.account)
  assert.equal((await bot.getChatHistory(e.message_id, 20))[0].group_id, incomingGroup)
  assert.equal((await bot.getGroupMsgHistory(e.group_id, 0, 20))[0].message_id, e.message_id)
  const sent = []
  f.adapter.sendGroupMsg = async (context, message, active) => {
    sent.push([context.self_id, context.group_id, message, active])
    return { message_id: "sent" }
  }
  await bot.sendGroupMsg(e.group_id, "主动正文")
  assert.deepEqual(sent, [[incomingSelf, incomingGroup, "主动正文", true]])
})
