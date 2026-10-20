import assert from "node:assert/strict"
import test from "node:test"
import process from "node:process"
import { createBot } from "../adapter/sdk.js"

test("SDK 多账号和重试构造不积累进程异常监听，保留宿主监听器", t => {
  const events = ["uncaughtException", "unhandledRejection"]
  const hostListeners = new Map(events.map(name => [name, () => {}]))
  for (const [name, listener] of hostListeners) process.on(name, listener)
  t.after(() => {
    for (const [name, listener] of hostListeners) process.removeListener(name, listener)
  })
  const before = new Map(events.map(name => [name, process.listeners(name)]))

  for (let attempt = 0; attempt < 12; attempt++) {
    const sdk = createBot({ appid: `test-${attempt}`, secret: "test-secret", intents: [] })
    assert.equal(typeof sdk.start, "function")
    assert.equal(typeof sdk.getSelfInfo, "function")
    for (const name of events)
      assert.deepEqual(process.listeners(name), before.get(name), `${name} 的监听器应保持不变`)
  }
})
