import assert from "node:assert/strict"
import test from "node:test"
import { fixture } from "./helpers/qqbot-fixture.mjs"

test("面板保存 plain-first 与图文顺序，无需重启", async t => {
  const f = await fixture(t, {})
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const result = await panel.setConfigData({
    sendMode: { default: "plain-first" },
    plainImageOrder: { default: "text-first", "10001:GROUP": "image-first" },
    plainImageOrderMaxMedia: 3,
  }, {
    Result: {
      ok: (_data, message) => ({ ok: true, message }),
      error: message => ({ ok: false, message }),
    },
  })
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /无需重启/)
  assert.deepEqual({ ...f.config.sendMode }, { default: "plain-first" })
  assert.deepEqual({ ...f.config.plainImageOrder }, { default: "text-first", "10001:GROUP": "image-first" })
  assert.equal(f.config.plainImageOrderMaxMedia, 3)

  const settings = await panel.getConfigData()
  assert.deepEqual({ ...settings.plainImageOrder }, { default: "text-first", "10001:GROUP": "image-first" })
  assert.equal(settings.plainImageOrderMaxMedia, 3)
  assert.deepEqual({ ...settings.sendMode }, { default: "plain-first" })
})

test("面板拒绝非法的普通消息图文顺序", async t => {
  const f = await fixture(t, {})
  const panel = (await f.load("elia.support.js")).namespace.supportPanel().configInfo
  const result = await panel.setConfigData({
    plainImageOrder: { default: "text" },
  }, {
    Result: {
      ok: (_data, message) => ({ ok: true, message }),
      error: message => ({ ok: false, message }),
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /只能是 auto、text-first 或 image-first/)
})
