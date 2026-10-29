import fs from "node:fs/promises"
import path from "node:path"
import { qblog } from "./utils/logger.js"

const COUNT_FIELDS = [
  "receive_msg_count",
  "send_msg_count",
  "member_increase_count",
  "member_decrease_count",
  "group_increase_count",
  "group_decrease_count",
]

function emptyDay() {
  return { ...Object.fromEntries(COUNT_FIELDS.map(key => [key, 0])), users: {}, groups: {} }
}

function validId(value) {
  return value !== undefined && value !== null && value !== "" ? String(value) : ""
}

export function plainPeerId(value, selfId) {
  const id = validId(value)
  const prefix = `${selfId}:`
  const windowsPrefix = `${selfId}${String.fromCharCode(0xf03a)}`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.startsWith(windowsPrefix) ? id.slice(windowsPrefix.length) : id
}

export function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new RangeError("DAU 日期无效")
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function shiftDateKey(key, offset) {
  const [year, month, day] = key.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + offset)
  return localDateKey(date)
}

function count(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function idCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id]) => id).map(([id, value]) => [id, count(value)]))
}

function normalizeDay(value) {
  const day = emptyDay()
  for (const key of COUNT_FIELDS) day[key] = count(value?.[key])
  day.users = idCounts(value?.users)
  day.groups = idCounts(value?.groups)
  return day
}

function normalizeIndex(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id, date]) => id && /^\d{4}-\d{2}-\d{2}$/.test(date)))
}

function average(records) {
  const result = Object.fromEntries([...COUNT_FIELDS, "user_count", "group_count"].map(key => [key, 0]))
  if (!records.length) return result
  for (const key of Object.keys(result))
    result[key] = Math.floor(records.reduce((total, record) => total + record[key], 0) / records.length)
  return result
}

function statLines(stats) {
  return [
    `上行消息量：${stats.receive_msg_count}`,
    `下行消息量：${stats.send_msg_count}`,
    `上行消息人数：${stats.user_count}`,
    `上行消息群数：${stats.group_count}`,
    `成员入群次数：${stats.member_increase_count}`,
    `成员退群次数：${stats.member_decrease_count}`,
    `机器人新增群数：${stats.group_increase_count}`,
    `机器人减少群数：${stats.group_decrease_count}`,
  ]
}

export class Dau {
  constructor(id, options = {}) {
    this.id = String(id)
    this.config = options.config || {}
    this.file = options.file || path.join("data", "QQBot", this.id, "DAU.json")
    this.now = options.now || (() => new Date())
    this.logger = options.logger || qblog
    this.data = { version: 1, days: {}, seenUsers: {}, seenGroups: {} }
    this.recentMessages = new Map()
    this.saveDelay = options.saveDelay ?? 500
    this.loaded = false
  }

  get enabled() {
    return this.config.dau?.enabled !== false
  }

  get retentionDays() {
    const value = Number(this.config.dau?.retentionDays ?? 62)
    return Number.isSafeInteger(value) && value >= 2 && value <= 3650 ? value : 62
  }

  today() {
    return localDateKey(this.now())
  }

  async init() {
    if (this.loaded) return this
    this.loaded = true
    try {
      const stored = JSON.parse(await fs.readFile(this.file, "utf8"))
      if (stored && typeof stored === "object") {
        for (const [date, value] of Object.entries(stored.days || {}))
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) this.data.days[date] = normalizeDay(value)
        this.data.seenUsers = normalizeIndex(stored.seenUsers)
        this.data.seenGroups = normalizeIndex(stored.seenGroups)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.logger.warn(`[${this.id}] DAU 数据读取失败，将使用空统计`, error?.message || error)
    }
    this.prune()
    return this
  }

  day(date = this.today()) {
    return this.data.days[date] ||= emptyDay()
  }

  touch(index, id, date) {
    if (id && !this.data[index][id]) this.data[index][id] = date
  }

  rememberMessage(key) {
    if (!key) return true
    if (this.recentMessages.has(key)) return false
    this.recentMessages.set(key, Date.now())
    while (this.recentMessages.size > 2048) this.recentMessages.delete(this.recentMessages.keys().next().value)
    return true
  }

  recordReceive(data) {
    if (!this.enabled || !data?.message_id) return false
    const key = `${data.message_id}:${data.seq ?? ""}`
    if (!this.rememberMessage(key)) return false
    const date = this.today()
    const day = this.day(date)
    day.receive_msg_count++
    const userId = plainPeerId(data.user_id ?? data.sender?.user_id, this.id)
    const groupId = plainPeerId(data.group_id, this.id)
    if (userId) {
      day.users[userId] = (day.users[userId] || 0) + 1
      this.touch("seenUsers", userId, date)
    }
    if (groupId) {
      day.groups[groupId] = (day.groups[groupId] || 0) + 1
      this.touch("seenGroups", groupId, date)
    }
    this.prune(date)
    this.scheduleSave()
    return true
  }

  recordSend(amount) {
    const sent = count(amount)
    if (!this.enabled || !sent) return false
    const date = this.today()
    this.day(date).send_msg_count += sent
    this.prune(date)
    this.scheduleSave()
    return true
  }

  recordGroupEvent(type, data = {}) {
    const field = {
      "member.increase": "member_increase_count",
      "member.decrease": "member_decrease_count",
      increase: "group_increase_count",
      decrease: "group_decrease_count",
    }[type]
    if (!this.enabled || !field) return false
    const date = this.today()
    this.day(date)[field]++
    const groupId = plainPeerId(data.group_id, this.id)
    const userId = plainPeerId(data.user_id, this.id)
    if (type === "increase" || type === "member.increase") {
      this.touch("seenGroups", groupId, date)
      this.touch("seenUsers", userId, date)
    }
    this.prune(date)
    this.scheduleSave()
    return true
  }

  stats(date = this.today()) {
    const day = normalizeDay(this.data.days[date])
    return {
      time: date,
      ...Object.fromEntries(COUNT_FIELDS.map(key => [key, day[key]])),
      user_count: Object.keys(day.users).length,
      group_count: Object.keys(day.groups).length,
    }
  }

  recentStats(days = 30) {
    const today = this.today()
    return this.data.days && Object.keys(this.data.days)
      .filter(date => date <= today && date >= shiftDateKey(today, 1 - days))
      .sort().map(date => this.stats(date))
  }

  report() {
    const today = this.today()
    const yesterday = shiftDateKey(today, -1)
    const recent = this.recentStats(30)
    return [
      today, ...statLines(this.stats(today)), "",
      yesterday, ...statLines(this.stats(yesterday)), "",
      `最近${recent.length}天平均`, ...statLines(average(recent)),
    ].join("\n")
  }

  userStats() {
    const today = this.today()
    const yesterday = shiftDateKey(today, -1)
    const todayUsers = new Set(Object.keys(this.data.days[today]?.users || {}))
    const yesterdayUsers = new Set(Object.keys(this.data.days[yesterday]?.users || {}))
    const shared = [...todayUsers].filter(id => yesterdayUsers.has(id)).length
    return {
      knownUsers: Object.keys(this.data.seenUsers).length,
      knownGroups: Object.keys(this.data.seenGroups).length,
      newUsers: Object.values(this.data.seenUsers).filter(date => date === today).length,
      newGroups: Object.values(this.data.seenGroups).filter(date => date === today).length,
      sharedUsers: shared,
      lostUsers: yesterdayUsers.size - shared,
    }
  }

  userReport() {
    const stats = this.userStats()
    return [
      `机器人：${this.id}`,
      `累计已见用户：${stats.knownUsers}`,
      `累计已见群聊：${stats.knownGroups}`,
      `今日新增用户：${stats.newUsers}`,
      `今日新增群聊：${stats.newGroups}`,
      `昨日到今日重合用户：${stats.sharedUsers}`,
      `昨日活跃今日未活跃：${stats.lostUsers}`,
    ].join("\n")
  }

  prune(today = this.today()) {
    const oldest = shiftDateKey(today, 1 - this.retentionDays)
    for (const date of Object.keys(this.data.days)) if (date < oldest) delete this.data.days[date]
  }

  scheduleSave() {
    this.dirty = true
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush() }, this.saveDelay)
    this.saveTimer.unref?.()
  }

  async flush() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.saving) {
      await this.saving
      if (!this.dirty) return
    }
    this.dirty = false
    const snapshot = JSON.stringify(this.data)
    this.saving = (async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        await fs.writeFile(this.file, snapshot, "utf8")
      } catch (error) {
        this.logger.warn(`[${this.id}] DAU 数据保存失败`, error?.message || error)
      }
    })()
    try { await this.saving } finally { this.saving = null }
    if (this.dirty) return this.flush()
  }
}

export default Dau
