/** 缓存只保存一份；对外允许裸 OpenID 与实例前缀 ID 互相查询。 */
const mapViews = new WeakMap()
const rawValues = new WeakMap()
const infoViews = new WeakMap()
const idFields = new Set(["group_id", "user_id", "owner_id"])

export function contactMap(map, id, sep = ":", nested = false) {
  if (!(map instanceof Map)) return map
  map = rawValues.get(map) || map
  const prefix = `${id}${sep}`
  const mode = `${prefix}\0${nested}`
  let views = mapViews.get(map)
  if (!views) mapViews.set(map, views = new Map())
  if (views.has(mode)) return views.get(mode)
  const plain = value => typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : value
  const aliases = key => {
    const normalized = plain(key)
    return [...new Set([key, `${prefix}${normalized}`, normalized])]
  }
  const locate = key => aliases(key).find(candidate => map.has(candidate))
  function valueView(value) {
    if (nested && value instanceof Map) return contactMap(value, id, sep)
    if (!value || typeof value !== "object" || value instanceof Map || Array.isArray(value)) return value
    let cached = infoViews.get(value)
    if (!cached) infoViews.set(value, cached = new Map())
    if (!cached.has(prefix)) {
      const view = new Proxy({}, {
        get: (_target, prop) => idFields.has(prop) ? plain(value[prop]) : Reflect.get(value, prop, value),
        set: (_target, prop, next) => Reflect.set(value, prop, next, value),
        has: (_target, prop) => prop in value,
        ownKeys: () => Reflect.ownKeys(value),
        getOwnPropertyDescriptor: (_target, prop) => Object.hasOwn(value, prop)
          ? { configurable: true, enumerable: Reflect.getOwnPropertyDescriptor(value, prop).enumerable,
            writable: true, value: idFields.has(prop) ? plain(value[prop]) : value[prop] }
          : undefined,
        deleteProperty: (_target, prop) => Reflect.deleteProperty(value, prop),
      })
      rawValues.set(view, value)
      cached.set(prefix, view)
    }
    return cached.get(prefix)
  }
  const snapshot = () => new Map([...map].map(([key, value]) => [plain(key), valueView(value)]))
  let view
  const methods = {
    get(key) {
      const stored = locate(key)
      return stored === undefined ? undefined : valueView(map.get(stored))
    },
    has: key => locate(key) !== undefined,
    set(key, value) {
      const stored = locate(key) ?? key
      for (const alias of aliases(key)) if (alias !== stored && map.has(alias)) map.delete(alias)
      map.set(stored, rawValues.get(value) || value)
      return view
    },
    delete(key) {
      let removed = false
      for (const alias of aliases(key)) removed = map.delete(alias) || removed
      return removed
    },
    clear() { for (const key of map.keys()) map.delete(key) },
    forEach(callback, thisArg) {
      for (const [key, value] of snapshot()) callback.call(thisArg, value, key, view)
    },
  }
  view = new Proxy(map, {
    get(_target, prop) {
      if (Object.hasOwn(methods, prop)) return methods[prop]
      if (prop === "size") return snapshot().size
      if (["entries", "values", "keys", Symbol.iterator].includes(prop)) {
        const current = snapshot()
        return current[prop].bind(current)
      }
      const value = Reflect.get(map, prop, map)
      return typeof value === "function" && prop !== "constructor" ? value.bind(map) : value
    },
  })
  rawValues.set(view, map)
  views.set(mode, view)
  return view
}
