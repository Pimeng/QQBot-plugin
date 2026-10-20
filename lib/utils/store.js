import fs from "node:fs/promises"
import path from "node:path"
import { qblog } from "./logger.js"

const MAP_TAG = "__qqbot_map__"
const mapCache = new Map()

function encodeMapValue(v) {
  if (v instanceof Map) return { [MAP_TAG]: [...v].map(([k, val]) => [k, encodeMapValue(val)]) }
  if (Array.isArray(v)) return v.map(encodeMapValue)
  if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
    const o = {}
    for (const k in v) o[k] = encodeMapValue(v[k])
    return o
  }
  return v
}

function decodeMapValue(v) {
  if (Array.isArray(v)) return v.map(decodeMapValue)
  if (v && typeof v === "object") {
    if (Array.isArray(v[MAP_TAG])) {
      const map = new Map()
      for (const [k, val] of v[MAP_TAG]) map.set(k, decodeMapValue(val))
      return map
    }
    const o = {}
    for (const k in v) o[k] = decodeMapValue(v[k])
    return o
  }
  return v
}

function scheduleSave(store) {
  if (store.timer) clearTimeout(store.timer)
  store.timer = setTimeout(() => {
    store.timer = null
    saveMap(store)
  }, 1000)
  store.timer.unref?.()
}

async function saveMap(store) {
  try {
    await fs.mkdir(path.dirname(store.file), { recursive: true })
    const obj = {}
    for (const [k, v] of store.map) obj[k] = encodeMapValue(v)
    await fs.writeFile(store.file, JSON.stringify(obj), "utf8")
  } catch (err) {
    qblog.error("Map 保存失败", store.file, err)
  }
}

/** 让 set/delete 触发落盘；嵌套 Map（如 gml）同样接管 */
function wrapMap(map, store) {
  if (map.__qqbotWrapped) return map
  Object.defineProperty(map, "__qqbotWrapped", { value: true, enumerable: false })
  const rawSet = map.set.bind(map)
  const rawDelete = map.delete.bind(map)
  map.set = (key, value) => {
    if (value instanceof Map) wrapMap(value, store)
    rawSet(key, value)
    scheduleSave(store)
    return map
  }
  map.delete = key => {
    const ret = rawDelete(key)
    scheduleSave(store)
    return ret
  }
  return map
}

function wrapNested(value, store, depth = 0) {
  if (depth > 4) return
  if (value instanceof Map) {
    wrapMap(value, store)
    for (const [, v] of value) wrapNested(v, store, depth + 1)
  }
}

/**
 * 好友 / 群 / 群成员数据的持久化 Map
 *
 * miao 的 icqq 自带 Bot.fl / Bot.gl，但 QQBot 账号不是 icqq 登录的，没有现成落盘，
 * 因此这里自己存 `${dir}.json`（路径与旧版一致：data/QQBot/<id>/Friend.json）。
 */
async function getMap(dir) {
  const file = `${dir}.json`
  const cached = mapCache.get(file)
  if (cached) return cached.map

  const store = { file, map: new Map(), timer: null }
  mapCache.set(file, store)

  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8"))
    for (const k in raw) store.map.set(k, decodeMapValue(raw[k]))
  } catch (err) {
    if (err?.code !== "ENOENT") qblog.debug("Map 读取失败", file, err)
  }

  wrapMap(store.map, store)
  for (const [, v] of store.map) wrapNested(v, store)
  return store.map
}

export {
  MAP_TAG,
  mapCache,
  encodeMapValue,
  decodeMapValue,
  scheduleSave,
  saveMap,
  wrapMap,
  wrapNested,
  getMap,
}
