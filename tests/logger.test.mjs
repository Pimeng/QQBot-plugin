import assert from "node:assert/strict"
import test from "node:test"
import { qblog } from "../lib/utils/logger.js"
import { createSdkLogger } from "../adapter/sdk-logger.js"

function useLogger(t, logger) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "logger")
  globalThis.logger = logger
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "logger", previous)
    else delete globalThis.logger
  })
}

test("日志保留宿主 this、原始 Error 和对象，缺失等级回退 info", t => {
  const calls = []
  const host = {
    info(...args) {
      assert.equal(this, host)
      calls.push(args)
    },
  }
  useLogger(t, host)
  const error = new Error("上传失败")
  const details = { file: Buffer.from("image"), target: "GROUP" }
  qblog.info("发送消息", details)
  qblog.error("上传失败", error)
  assert.deepEqual(calls[0].slice(0, 2), ["[QQBot]", "发送消息"])
  assert.equal(calls[0][2], details)
  assert.equal(calls[1][2], error)
})

test("SDK 只记录一次完整事件包，WebSocket 与 WebHook 均保留未知事件", t => {
  const logs = []
  useLogger(t, { debug: (...args) => logs.push(args.join(" ")) })
  const packet = { t: "UNKNOWN_EVENT", d: { content: "x".repeat(1500), entries: Array.from({ length: 70 }, (_, i) => i) } }
  const ws = createSdkLogger({ uin: "WS", webhook: false })
  ws.debug(`[WebSocketReceiver] 收到消息: ${JSON.stringify(packet)}`)
  ws.debug(packet.t, packet)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes("[WS] 收到事件包 [WebSocket]"))
  assert.ok(logs[0].includes(packet.d.content))

  const webhook = createSdkLogger({ uin: "HOOK", webhook: true })
  webhook.debug(packet.t, packet)
  assert.equal(logs.length, 2)
  assert.ok(logs[1].includes("[HOOK] 收到事件包 [UNKNOWN_EVENT]"))
  assert.ok(logs[1].includes(packet.d.content))
  assert.ok(logs[1].includes("69"))
})

test("SDK 过滤重复消息与连接提示，连接错误仍输出", t => {
  const logs = []
  useLogger(t, { info: (...args) => logs.push(args) })
  const sdkLogger = createSdkLogger({ uin: "BOT" })
  sdkLogger.info("recv from Group: hello")
  sdkLogger.info("WebSocket连接已建立")
  assert.equal(logs.length, 0)
  sdkLogger.error("[WebSocketReceiver] 连接关闭：连接失败")
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes("[BOT]"))
})
