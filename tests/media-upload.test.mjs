import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import SDK from "qq-official-bot"
import "../adapter/sdk.js"
import { uploadMedia, uploadTarget } from "../lib/utils/media-upload.js"

const hash = (type, bytes) => createHash(type).update(bytes).digest("hex")
function botFixture(handler) {
  const calls = []
  const bot = { uin: "10001", gl: new Map([["GROUP", {}]]), fl: new Map([["USER", {}]]),
    sdk: { fileProcessor: { async uploadForMessage(payload, options) {
      calls.push({ payload, options })
      return handler ? handler(payload, options, calls.length) : {
        file_info: `info-${calls.length}`, raw_url: `https://cos.example.com/${calls.length}`, ttl: 60,
      }
    } } },
  }
  return { bot, calls }
}

for (const base of [0, 1]) test(`真实 SDK 按 ${base} 起始序号上传，PUT/完成通知/合并与字节哈希一致`, async t => {
  const bytes = Buffer.alloc(10_002_450, 7)
  bytes[10_002_432] = 9
  const blockSize = 5 * 1024 * 1024
  const received = [], finished = [], requests = []
  let putAttempts = 0, finishAttempts = 0
  const server = http.createServer(async (req, res) => {
    const buffers = []
    for await (const chunk of req) buffers.push(chunk)
    if (++putAttempts === 1) { res.statusCode = 503; res.end(); return }
    received.push({ index: Number(req.url.slice(1)), bytes: Buffer.concat(buffers) })
    res.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise(resolve => server.close(resolve)))
  const processor = new SDK.FileProcessor({ async post(url, payload) {
    requests.push({ url, payload })
    if (url.endsWith("upload_prepare")) return { data: {
      upload_id: "upload", block_size: String(blockSize),
      parts: [base + 1, base].map(index => ({ index, presigned_url: `http://127.0.0.1:${server.address().port}/${index}` })),
      upload_config: { concurrency: 1, retry_timeout: 2, retry_delay: 0.001 },
    } }
    if (url.endsWith("upload_part_finish")) {
      if (++finishAttempts === 1) throw new Error("模拟完成通知失败")
      finished.push(payload)
      return { data: {} }
    }
    assert.equal(url, "/v2/users/USER/files")
    assert.deepEqual(payload, { file_type: 1, file_name: "photo.png", srv_send_msg: false, upload_id: "upload" })
    return { data: { file_info: "info", raw_url: "https://cos.example.com/photo", ttl: 60 } }
  } })
  const info = await processor.uploadForMessage({ file: bytes, file_type: 1, file_name: "photo.png" }, { targetType: "user", targetId: "USER", sendMessage: false })
  assert.equal(info.file_info, "info")
  assert.equal(info.raw_url, "https://cos.example.com/photo")
  assert.equal(requests[0].payload.md5_10m, hash("md5", bytes.subarray(0, 10_002_432)))
  assert.equal(requests[0].payload.md5, hash("md5", bytes))
  assert.equal(requests[0].payload.sha1, hash("sha1", bytes))
  assert.equal(putAttempts, 3)
  assert.equal(received.length, 2)
  for (const part of received) {
    const chunk = bytes.subarray((part.index - base) * blockSize, (part.index - base + 1) * blockSize)
    assert.ok(part.bytes.equals(chunk))
    const notification = finished.find(item => item.part_index === part.index)
    assert.equal(notification.block_size, String(chunk.length))
    assert.equal(notification.md5, hash("md5", chunk))
  }
})

test("分片秒传无 parts 时通过 upload_id 合并，不上传空分片", async () => {
  const paths = []
  const processor = new SDK.FileProcessor({ async post(url) {
    paths.push(url)
    return { data: url.endsWith("upload_prepare") ? { upload_id: "existing", parts: [] } : { file_info: "ready", ttl: 0 } }
  } })
  const info = await processor.uploadForMessage({ file: Buffer.from("image") }, { targetType: "group", targetId: "GROUP" })
  assert.equal(info.file_info, "ready")
  assert.deepEqual(paths, ["/v2/groups/GROUP/upload_prepare", "/v2/groups/GROUP/files"])
})

test("非法分片序号、分片数量或缺少预上传信息不会 PUT 或合并", async () => {
  for (const prepared of [
    {}, { upload_id: "x" },
    { upload_id: "x", parts: [{ index: 2 }] },
    { upload_id: "x", parts: [{ index: 0 }, { index: 0 }] },
    { upload_id: "x", block_size: 1, parts: [{ index: 0 }] },
  ]) {
    const paths = []
    const processor = new SDK.FileProcessor({ async post(url) { paths.push(url); return { data: prepared } } })
    await assert.rejects(processor.uploadForMessage({ file: Buffer.from("abc") }, { targetType: "group", targetId: "GROUP" }))
    assert.equal(paths.length, 1)
  }
})

test("并发相同上传合并请求，缓存到期重新上传，ttl=0 长期复用", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 })
  const { bot, calls } = botFixture()
  const bytes = Buffer.from("image")
  const infos = await Promise.all(Array.from({ length: 4 }, () => uploadMedia(bot, bytes)))
  assert.equal(calls.length, 1)
  assert.ok(infos.every(info => info.file_info === "info-1"))
  infos[0].file_info = "changed"
  assert.equal((await uploadMedia(bot, bytes)).file_info, "info-1")
  t.mock.timers.setTime(1_060_000)
  assert.equal((await uploadMedia(bot, bytes)).file_info, "info-2")
  const eternal = botFixture(() => ({ file_info: "eternal", ttl: 0 }))
  await uploadMedia(eternal.bot, bytes)
  t.mock.timers.setTime(9_000_000)
  await uploadMedia(eternal.bot, bytes)
  assert.equal(eternal.calls.length, 1)
})

test("不同账号、目标、媒体类型、文件名和内容分别上传", async () => {
  const { bot, calls } = botFixture()
  const bytes = Buffer.from("image")
  await uploadMedia(bot, bytes)
  await uploadMedia(bot, bytes, { targetType: "user", targetId: "USER" })
  await uploadMedia(bot, bytes, { targetType: "group", targetId: "OTHER" })
  await uploadMedia(bot, bytes, { fileType: 2 })
  await uploadMedia(bot, bytes, { fileName: "other.png" })
  await uploadMedia(bot, Buffer.from("other"))
  assert.equal(calls.length, 6)
  const other = botFixture()
  await uploadMedia(other.bot, bytes)
  assert.equal(other.calls.length, 1)
  assert.ok(calls.every(call => call.options.sendMessage === false))
})

test("失败不会留下待处理缓存，缺少 raw_url 不阻止普通 file_info 消息", async () => {
  const { bot, calls } = botFixture((_payload, _opts, n) => {
    if (n === 1) throw new Error("上传失败")
    return { file_info: "image", ttl: 0 }
  })
  const bytes = Buffer.from("image")
  await assert.rejects(uploadMedia(bot, bytes), /上传失败/)
  assert.equal((await uploadMedia(bot, bytes)).file_info, "image")
  await assert.rejects(uploadMedia(bot, bytes, { requireUrl: true }), /raw_url/)
  assert.equal(calls.length, 3)
  const pending = botFixture(() => ({ file_info: "image", ttl: 60 }))
  const results = await Promise.allSettled([uploadMedia(pending.bot, bytes), uploadMedia(pending.bot, bytes, { requireUrl: true })])
  assert.equal(results[0].status, "fulfilled")
  assert.equal(results[1].status, "rejected")
  assert.equal(pending.calls.length, 1)
  const invalidUrl = botFixture(() => ({ file_info: "image", raw_url: "invalid", ttl: 60 }))
  await uploadMedia(invalidUrl.bot, bytes)
  await assert.rejects(uploadMedia(invalidUrl.bot, bytes, { requireUrl: true }), /raw_url/)
})

test("上传目标剥离账号前缀并排除频道，无目标时给出明确错误", () => {
  const { bot } = botFixture()
  assert.deepEqual(uploadTarget(bot, { group_id: "10001GROUP" }), { targetType: "group", targetId: "GROUP" })
  assert.deepEqual(uploadTarget(bot, { user_id: "10001:USER" }), { targetType: "user", targetId: "USER" })
  bot.gl = new Map([["qg_GUILD-CHANNEL", {}]])
  assert.deepEqual(uploadTarget(bot), { targetType: "user", targetId: "USER" })
  assert.throws(() => uploadTarget(bot, { guild_id: "GUILD", channel_id: "CHANNEL" }), /OpenID/)
  bot.fl.clear()
  assert.throws(() => uploadTarget(bot), /OpenID/)
})
