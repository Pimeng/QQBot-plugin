/** icqq 常用接口的字段、标识和返回值约定，不推导官方未提供的 QQ 号。 */
export function plainId(id, selfId, sep) {
  const value = String(id ?? "")
  const prefix = `${selfId}${sep}`
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

export function mapKey(map, id, selfId, sep) {
  const plain = plainId(id, selfId, sep)
  const scoped = `${selfId}${sep}${plain}`
  if (map?.has(scoped)) return scoped
  if (map?.has(plain)) return plain
  return scoped
}

export function memberInfo(info = {}, userId, groupId) {
  const role = info.member_role ?? info.role
  const joined = Date.parse(info.joined_at)
  return {
    ...info, user_id: userId, group_id: groupId,
    nickname: info.nickname || info.username || userId,
    card: info.card || "",
    role: ["owner", "admin"].includes(role) ? role : "member",
    ...(Number.isFinite(joined) ? { join_time: Math.floor(joined / 1000) } : {}),
  }
}

export function liveInfo(contact, read, fields) {
  Object.defineProperty(contact, "info", { enumerable: true, get: read })
  for (const key of fields) Object.defineProperty(contact, key, {
    configurable: true, enumerable: true, get: () => read()[key],
  })
  contact.getInfo = async (noCache = false) => {
    if (!noCache) return read()
    if (typeof contact.renew !== "function") throw new Error("QQBot 当前场景不提供资料刷新接口")
    return contact.renew()
  }
  return contact
}

export function fileName(pidOrName, name) {
  if (name !== undefined && pidOrName && pidOrName !== "/")
    throw new Error("QQBot 官方文件消息不支持群文件目录")
  return name ?? (pidOrName === "/" ? undefined : pidOrName)
}

export function unixTime(value) {
  if (value === undefined || value === null || value === "") return undefined
  const numeric = Number(value)
  const seconds = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric / 1000 : numeric) : Date.parse(value) / 1000
  return Number.isFinite(seconds) ? Math.floor(seconds) : undefined
}

/** 单条 icqq MessageRet.message_id；拆分发送的全部 ID 仍保留在 message_ids。 */
export function sentResult(result) {
  const data = result.data.flat(Infinity)
  const ids = [...new Set(data.map(item => item?.id || item?.message_id).filter(id => typeof id === "string" && id))]
  if (!data.length && result.error.length) throw result.error.at(-1)
  const first = data[0]
  const timestamp = unixTime(first?.timestamp ?? first?.time)
  return {
    ...result, data, message_id: ids[0] || "", message_ids: ids,
    ...(!result.partial && data.length ? { error: [], retry_errors: result.error } : {}),
    ...(data.length ? { time: Number.isFinite(timestamp) ? Math.floor(timestamp) : Math.floor(Date.now() / 1000) } : {}),
    ...(first?.seq !== undefined ? { seq: first.seq } : {}),
    ...(first?.rand !== undefined ? { rand: first.rand } : {}),
  }
}
