import assert from "node:assert/strict"
import test from "node:test"
import crypto from "node:crypto"
import { fixture } from "./helpers/qqbot-fixture.mjs"

const response = (data, portal = true) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(portal ? { retcode: 0, data } : { data }),
})

function encryptSecret(secret, keyBase64) {
  const key = Buffer.from(keyBase64, "base64")
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64")
}

async function waitFor(service, status) {
  for (let index = 0; index < 100; index++) {
    if (service.snapshot().status === status) return service.snapshot()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(service.snapshot().status, status)
}

async function setup(t, options = {}) {
  const f = await fixture(t, {
    accounts: options.accounts || [],
    token: [],
  })
  const { QrLoginService, decryptBotSecret } = (await f.load("lib/qr-login.js")).namespace
  const calls = { create: 0, connect: [], logout: [], flushed: 0, requests: [] }
  const service = new QrLoginService({
    config: f.config,
    configSave: { flush: async () => { calls.flushed++ } },
    connect: async account => { calls.connect.push(account); return options.connected ?? true },
    getBot: () => ({ old: { logout: async () => { calls.logout.push("old") } } }),
    fetch: options.fetch || (async () => { throw new Error("unexpected fetch") }),
    pollIntervalMs: 1,
    requestTimeoutMs: 50,
    taskTtlMs: options.taskTtlMs ?? 100,
    now: options.now,
  })
  return { f, service, calls, decryptBotSecret }
}

test("扫码任务后台完成，保留已有账号能力并脱敏重连", async t => {
  const secret = "new-secret"
  let key
  const { service, calls } = await setup(t, {
    accounts: [{ uin: "old", appid: "100", secret: "old-secret", group: false, guild: true, webhook: true }],
    fetch: async (url, init) => {
      if (url.includes("create_bind_task")) {
        calls.create++
        key = JSON.parse(init.body).key
        return response({ task_id: "task-1" })
      }
      if (url.includes("poll_bind_result")) return response({ status: 2, bot_appid: "100", bot_encrypt_secret: encryptSecret(secret, key) })
      if (url.includes("share_info")) return response({ robot_data: { robot_uin: "4242" }, }, false)
      throw new Error("unexpected url")
    },
  })
  const first = await service.start()
  assert.equal(first.status, "waiting")
  assert.equal((await service.start()).status, "waiting")
  assert.equal(calls.create, 1)
  const result = await waitFor(service, "connected")
  assert.equal(result.uin, "4242")
  assert.equal(result.appid, "100")
  assert.equal(calls.flushed, 1)
  assert.deepEqual(calls.logout, ["old"])
  assert.equal(calls.connect.length, 1)
  assert.equal(calls.connect[0].secret, secret)
  assert.equal(calls.connect[0].group, false)
  assert.equal(calls.connect[0].guild, true)
  assert.equal(calls.connect[0].webhook, true)
  assert.equal((await service.image()).src.startsWith("data:image/png;base64,"), true)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes(key))
})

test("UIN 查询失败回退 AppID，连接失败明确标记已保存", async t => {
  const secret = "saved-secret"
  let key
  const { service, calls, f } = await setup(t, {
    connected: false,
    fetch: async (url, init) => {
      if (url.includes("create_bind_task")) {
        key = JSON.parse(init.body).key
        return response({ task_id: "task-2" })
      }
      if (url.includes("poll_bind_result")) return response({ status: 2, bot_appid: "200", bot_encrypt_secret: encryptSecret(secret, key) })
      throw new Error("share_info unavailable")
    },
  })
  await service.start()
  const result = await waitFor(service, "saved")
  assert.equal(result.uin, "200")
  assert.equal(result.connected, false)
  assert.equal(result.saved, true)
  assert.match(result.error, /连接失败/)
  assert.equal(f.config.accounts[0].appid, "200")
  assert.equal(f.config.accounts[0].group, true)
  assert.equal(f.config.accounts[0].guild, false)
  assert.equal(f.config.accounts[0].webhook, false)
})

test("取消、创建中取消和二维码到期不会启动账号连接", async t => {
  let task = 0
  const { service, calls } = await setup(t, {
    taskTtlMs: 5,
    fetch: async url => {
      if (url.includes("create_bind_task")) return response({ task_id: `task-${++task}` })
      if (url.includes("poll_bind_result")) return response({ status: 1 })
      throw new Error("unexpected")
    },
  })
  await service.start()
  assert.equal(service.cancel().status, "canceled")
  await service.start()
  await waitFor(service, "expired")
  assert.equal(calls.connect.length, 0)

  let release
  const pending = new Promise(resolve => { release = resolve })
  const slow = await setup(t, {
    fetch: url => url.includes("create_bind_task") ? pending : Promise.resolve(response({ status: 1 })),
  })
  const starting = slow.service.start()
  slow.service.cancel()
  release(response({ task_id: "late" }))
  await starting
  assert.equal(slow.service.snapshot().status, "canceled")
  assert.equal(slow.calls.connect.length, 0)
})

test("AES-GCM 解密和门户错误不会泄露敏感数据", async t => {
  const { service, decryptBotSecret } = await setup(t, {
    fetch: async (url, init) => {
      if (url.includes("create_bind_task")) {
        const key = JSON.parse(init.body).key
        return response({ task_id: key })
      }
      return response({ status: 1 })
    },
  })
  const result = await service.start()
  assert.equal(result.status, "waiting")
  const key = result.id
  const encrypted = encryptSecret("round-trip-secret", key)
  assert.equal(decryptBotSecret(encrypted, key), "round-trip-secret")
  assert.throws(() => decryptBotSecret(encrypted, crypto.randomBytes(32).toString("base64")))
  assert.ok(!JSON.stringify(result).includes("round-trip-secret"))
})
