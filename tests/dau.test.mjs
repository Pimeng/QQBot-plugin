import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Dau, localDateKey, plainPeerId, shiftDateKey } from "../lib/dau.js"

async function tempDau(t, id = "10000", options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-dau-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let now = new Date(2026, 0, 31, 23, 59)
  const config = { dau: { enabled: true, retentionDays: 3 } }
  const dau = new Dau(id, {
    config,
    file: path.join(dir, "DAU.json"),
    now: () => now,
    saveDelay: 3600000,
    logger: { warn() {} },
    ...options,
  })
  await dau.init()
  return { dau, config, setNow: value => { now = value } }
}

test("DAU 真实收发、日活与群事件分别计数并去除重复上行", async t => {
  const { dau } = await tempDau(t)
  const message = {
    message_id: "message-1", seq: 1, user_id: "10000:user-a", group_id: "10000:group-a",
  }
  assert.equal(dau.recordReceive(message), true)
  assert.equal(dau.recordReceive(message), false)
  dau.recordReceive({ ...message, message_id: "message-2", user_id: "user-b" })
  dau.recordSend(3)
  dau.recordGroupEvent("member.increase", { group_id: "group-a", user_id: "user-c" })
  dau.recordGroupEvent("member.decrease", { group_id: "group-a", user_id: "user-c" })
  dau.recordGroupEvent("increase", { group_id: "group-b" })
  dau.recordGroupEvent("decrease", { group_id: "group-b" })
  assert.deepEqual(dau.stats(), {
    time: "2026-01-31", receive_msg_count: 2, send_msg_count: 3,
    member_increase_count: 1, member_decrease_count: 1,
    group_increase_count: 1, group_decrease_count: 1,
    user_count: 2, group_count: 1,
  })
  assert.equal(dau.userStats().newUsers, 3)
  assert.equal(dau.userStats().newGroups, 2)
  assert.match(dau.report(), /最近1天平均/)
  assert.match(dau.report(), /成员入群次数：1/)
})

test("DAU 日切、昨日留存和保留期清理不依赖定时任务", async t => {
  const { dau, setNow } = await tempDau(t)
  dau.recordReceive({ message_id: "old", user_id: "old-user", group_id: "old-group" })
  setNow(new Date(2026, 1, 1, 0, 1))
  dau.recordReceive({ message_id: "new-1", user_id: "old-user", group_id: "new-group" })
  dau.recordReceive({ message_id: "new-2", user_id: "new-user", group_id: "new-group" })
  assert.equal(dau.userStats().sharedUsers, 1)
  assert.equal(dau.userStats().lostUsers, 0)
  setNow(new Date(2026, 1, 4, 8, 0))
  dau.recordSend(1)
  assert.deepEqual(Object.keys(dau.data.days).sort(), ["2026-02-04"])
  assert.equal(dau.recentStats(30).length, 1)
})

test("DAU 落盘后可由同账号新实例恢复，账号文件互相隔离", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-dau-restore-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const options = { config: { dau: { enabled: true } }, saveDelay: 3600000, logger: { warn() {} } }
  const first = await new Dau("one", { ...options, file: path.join(dir, "one.json") }).init()
  const second = await new Dau("two", { ...options, file: path.join(dir, "two.json") }).init()
  first.recordReceive({ message_id: "one-message", user_id: "one-user" })
  second.recordReceive({ message_id: "two-message", user_id: "two-user" })
  await Promise.all([first.flush(), second.flush()])
  const restored = await new Dau("one", { ...options, file: path.join(dir, "one.json") }).init()
  assert.equal(restored.stats().receive_msg_count, 1)
  assert.equal(restored.stats().user_count, 1)
  assert.equal(restored.userStats().knownUsers, 1)
  assert.equal(second.userStats().knownUsers, 1)
})

test("DAU 损坏数据与关闭开关不影响调用，写入合并不丢统计", async t => {
  const { dau, config } = await tempDau(t)
  await fs.writeFile(dau.file, "not-json")
  const restored = await new Dau("10000", {
    config, file: dau.file, saveDelay: 3600000, logger: { warn() {} },
  }).init()
  assert.equal(restored.stats().receive_msg_count, 0)
  config.dau.enabled = false
  assert.equal(dau.recordReceive({ message_id: "disabled" }), false)
  assert.equal(dau.recordSend(2), false)
  config.dau.enabled = true
  dau.recordSend(1)
  const saving = dau.flush()
  dau.recordSend(2)
  await saving
  await dau.flush()
  assert.equal(JSON.parse(await fs.readFile(dau.file, "utf8")).days["2026-01-31"].send_msg_count, 3)
})

test("DAU 日期和账号前缀处理保持本地自然日与裸 OpenID", () => {
  assert.equal(plainPeerId("10000:openid", "10000"), "openid")
  assert.equal(plainPeerId(`10000${String.fromCharCode(0xf03a)}openid`, "10000"), "openid")
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28")
  assert.equal(localDateKey(new Date(2026, 0, 2, 3, 4)), "2026-01-02")
})
