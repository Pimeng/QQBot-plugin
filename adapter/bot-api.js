import MessageSender from "./message/sender.js"
import imageSize from "image-size"
import { fileToUrl, fileToUrlInfo, log, toBuffer } from "../lib/utils/common.js"
import { fileName, liveInfo, mapKey, memberInfo, plainId } from "./compat.js"

function unsupportedMethods(scope, names) {
  return Object.fromEntries(names.map(name => [name, async () => {
    throw new Error(`QQBot 官方接口不支持 ${scope}.${name}`)
  }]))
}

const unsupportedAccount = ["setNickname", "setAvatar", "setSignature", "setOnlineStatus", "sendLike", "imageOcr", "getForwardMsg", "getSystemMsg", "setFriendAddRequest", "setGroupAddRequest", "setEssenceMessage", "removeEssenceMessage", "sendGroupSign", "getCookies", "getCsrfToken", "getBkn", "cleanCache", "reloadFriendList", "reloadGroupList"]
const unsupportedFriend = ["delete", "poke", "thumbUp", "sendLike", "markRead", "addFriendBack", "setFriendReq", "setGroupReq", "setGroupInvite", "getFileUrl", "getNTPicRkey"]
const unsupportedGroup = ["setName", "setAvatar", "muteAll", "pokeMember", "setCard", "setAdmin", "setTitle", "invite", "quit", "muteAnony", "getAnonyInfo", "allowAnony", "getAtAllRemainder", "addEssence", "removeEssence", "announce", "sign", "setTodo", "delTodo", "setReaction", "markRead", "getFileUrl"]
const unsupportedMember = ["poke", "setAdmin", "setCard", "setTitle"]
const unsupportedFiles = ["upload", "download", "ls", "dir", "rm", "df", "mkdir", "stat", "mv", "rename", "forward"]

function groupMemberOpenids(ids, selfId, sep) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) throw new RangeError("QQBot 单次成员操作须为 1 至 20 个 OpenID 的数组")
  return ids.map(id => {
    const value = plainId(id, selfId, sep)
    if (!value || value.startsWith("qg_")) throw new TypeError("QQBot 群成员操作需要群成员 OpenID")
    return value
  })
}

function durationSeconds(duration) {
  const seconds = Number(duration)
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30 * 24 * 60 * 60)
    throw new RangeError("禁言时长须为 0 至 2592000 秒的整数")
  return seconds
}

export function globalMuteActive(rule, now = Date.now()) {
  if (rule?.mode === "always") return true
  if (rule?.mode !== "schedule") return false
  if (Array.isArray(rule.schedule_rules) && rule.schedule_rules.some(item => item.enabled && Date.parse(item.start_at) <= now && now < Date.parse(item.end_at))) return true
  const beijing = new Date(now + 8 * 60 * 60 * 1000)
  const weekday = beijing.getUTCDay() || 7
  const previous = weekday === 1 ? 7 : weekday - 1
  const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const clockMinute = value => {
    const matched = /^(\d{2}):(\d{2})$/.exec(String(value))
    return matched && Number(matched[1]) < 24 && Number(matched[2]) < 60 ? Number(matched[1]) * 60 + Number(matched[2]) : NaN
  }
  return Boolean(Array.isArray(rule.recurring_rules) && rule.recurring_rules.some(item => {
    if (!item.enabled || !Array.isArray(item.weekdays)) return false
    const start = clockMinute(item.start_time), end = clockMinute(item.end_time)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    const days = item.weekdays.map(Number)
    return end < start ? days.includes(weekday) && minute >= start || days.includes(previous) && minute < end
      : days.includes(weekday) && start <= minute && minute < end
  }))
}

function guildMemberInfo(raw = {}, userId, groupId) {
  const user = raw.user || {}
  const roles = raw.roles?.map(String) || []
  const role = Array.isArray(raw.roles) ? roles.includes("4") ? "owner" : roles.some(role => ["2", "5"].includes(role)) ? "admin" : "member" : raw.member_role ?? raw.role
  return memberInfo({ ...user, ...raw, username: user.username ?? raw.username, avatar: user.avatar ?? raw.avatar, nickname: user.username || raw.username || raw.nickname || userId, card: raw.nick ?? raw.card ?? "", member_role: role, role }, userId, groupId)
}

export default class BotApi extends MessageSender {
  accountMethods(id) {
    return {
      ...unsupportedMethods("Bot", unsupportedAccount),
      sendPrivateMsg: (user_id, msg, source) => this.pickFriend(id, user_id).sendMsg(msg, source),
      sendFriendMsg: (user_id, msg, source) => this.pickFriend(id, user_id).sendMsg(msg, source),
      sendGroupMsg: (group_id, msg, source) => this.pickGroup(id, group_id).sendMsg(msg, source),
      sendGuildMsg: (guild_id, channel_id, msg, source) => this.pickGuild(id, `qg_${String(guild_id).replace(/^qg_/, "")}-${channel_id}`).sendMsg(msg, source),
      getMsg: message_id => this.getMsg(id, message_id),
      getChatHistory: (message_id, count) => this.getChatHistory(id, message_id, count),
      getGroupMsgHistory: (group_id, seq, count) => this.contactHistory(id, "group", plainId(group_id, id, this.sep), seq, count),
      getFriendMsgHistory: (user_id, seq, count) => this.contactHistory(id, "private", plainId(user_id, id, this.sep), seq, count),
      getFriendInfo: (user_id, noCache = false) => this.pickFriend(id, user_id).getInfo(noCache),
      getStrangerInfo: (user_id, noCache = false) => this.pickFriend(id, user_id).getInfo(noCache),
      getAvatarUrl: () => Bot[id].avatar || Bot[id].info?.avatar || "",
      getFriendList: async () => new Map([...Bot[id].fl].map(([uid]) => {
        const friend = this.pickFriend(id, uid)
        return [String(uid).startsWith("qg_") ? uid : friend.user_id, friend.info]
      })),
      getGroupList: async () => new Map([...Bot[id].gl].map(([gid]) => {
        const group = this.pickGroup(id, gid)
        return [group.group_id, group.info]
      })),
      getGroupInfo: (group_id, noCache = false) => this.pickGroup(id, group_id).getInfo(noCache),
      getGroupMemberInfo: (group_id, user_id, noCache = false) => this.pickMember(id, group_id, user_id).getInfo(noCache),
      getGroupMemberList: (group_id, noCache = false) => this.groupMembers(id, group_id, noCache),
      getGroupBotState: group_id => this.getGroupBotState(id, group_id),
      getGroupMuteSetting: group_id => this.getGroupMuteSetting(id, group_id),
      setGroupMemberMute: (group_id, members) => this.setGroupMemberMute(id, group_id, members),
      getGroupJoinRequests: (group_id, options) => Bot[id].sdk.getGroupJoinRequests(plainId(group_id, id, this.sep), options),
      approveGroupJoinRequest: (group_id, user_id, options) => Bot[id].sdk.approveGroupJoinRequest(plainId(group_id, id, this.sep), plainId(user_id, id, this.sep), options),
      batchRemoveGroupMembers: (group_id, user_ids, block = false) => this.batchRemoveGroupMembers(id, group_id, user_ids, block),
      getGroupMemberBlacklist: (group_id, options) => this.getGroupMemberBlacklist(id, group_id, options),
      setGroupMemberBlacklist: (group_id, options) => this.setGroupMemberBlacklist(id, group_id, options),
      getGroupJoinApprovalStrategies: options => Bot[id].sdk.getGroupJoinApprovalStrategies(options),
      createGroupJoinApprovalStrategy: options => Bot[id].sdk.createGroupJoinApprovalStrategy(options),
      updateGroupJoinApprovalStrategy: (strategy_id, options) => Bot[id].sdk.updateGroupJoinApprovalStrategy(strategy_id, options),
      deleteGroupJoinApprovalStrategy: strategy_id => Bot[id].sdk.deleteGroupJoinApprovalStrategy(strategy_id),
      executeGroupJoinApprovalStrategy: strategy_id => Bot[id].sdk.executeGroupJoinApprovalStrategy(strategy_id),
      updateGroupJoinApprovalWhitelist: (strategy_id, options) => Bot[id].sdk.updateGroupJoinApprovalWhitelist(strategy_id, options),
      getGuildList: () => this.guildList(id),
      getGuildInfo: guild_id => Bot[id].sdk.getGuildInfo(String(guild_id).replace(/^qg_/, "").split("-")[0]),
      getChannelList: guild_id => Bot[id].sdk.getChannelList(String(guild_id).replace(/^qg_/, "").split("-")[0]),
      getChannelInfo: channel_id => Bot[id].sdk.getChannelInfo(String(channel_id)),
      getGuildMemberInfo: (guild_id, user_id, noCache = false) => this.pickGuildMember(id, `qg_${String(guild_id).replace(/^qg_/, "")}`, user_id).getInfo(noCache),
      getGuildMemberList: (guild_id, noCache = false) => this.guildMembers(id, `qg_${String(guild_id).replace(/^qg_/, "")}`, noCache),
      setGroupBan: (group_id, user_id, duration = 1800) => this.pickGroup(id, group_id).muteMember(user_id, duration),
      setGroupWholeBan: (group_id, enable = true, duration) => this.pickGroup(id, group_id).muteAll(enable, duration),
      setGroupKick: (group_id, user_id, block = false) => this.pickGroup(id, group_id).kickMember(user_id, "", block),
      setGroupAdmin: (group_id, user_id, enable = true) => this.pickGroup(id, group_id).setAdmin(user_id, enable),
      setGroupCard: (group_id, user_id, card) => this.pickGroup(id, group_id).setCard(user_id, card),
      setGroupName: (group_id, name) => this.pickGroup(id, group_id).setName(name),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
    }
  }

  async uploadImage(id, file, opts = {}) {
    const info = await fileToUrlInfo(file, { ...opts, bot: Bot[id], fileType: 1 })
    if (!info.url) throw new Error("QQBot 官方图片直链不可用，且回退文件服务未配置公网地址或未监听端口")
    let size = {}
    try { size = imageSize(await toBuffer(file)) } catch {}
    return { ...info, width: size.width, height: size.height }
  }

  fileToUrl(id, file, opts = {}) {
    return fileToUrl(file, { ...opts, bot: Bot[id] })
  }

  makeForwardMsg(nodes = []) {
    return { type: "node", data: (Array.isArray(nodes) ? nodes : [nodes]).filter(Boolean) }
  }

  /** icqq sendMsg(content, source)：只引用调用方明确指定、可定位的消息。 */
  async sendContactMsg(id, type, target, context, msg, source, method) {
    if (source === undefined || source === null || source === false)
      return this[method]({ ...context, active: true }, msg, true)
    if (!source || typeof source !== "object") throw new TypeError("QQBot 引用消息须提供含 message_id 或已缓存 seq 的消息对象")
    if (source.self_id !== undefined && String(source.self_id) !== String(id))
      throw new Error("QQBot 不能引用其他账号的消息")
    if (source.message_type !== undefined && source.message_type !== type)
      throw new Error("QQBot 引用消息不属于当前会话类型")
    const peer = plainId(target, id, this.sep)
    const sourcePeer = type === "group" ? source.group_id : source.user_id
    if (sourcePeer !== undefined && plainId(sourcePeer, id, this.sep).replace(/^qg_/, "") !== peer.replace(/^qg_/, ""))
      throw new Error("QQBot 引用消息不属于当前会话")
    const records = this.matchingHistory(id, type, target)
    let message_id = source.message_id ?? source.id
    const record = records.findLast(item =>
      typeof message_id === "string" && message_id ? item.message_id === message_id
        : source.seq !== undefined && item.seq !== undefined ? String(item.seq) === String(source.seq)
          : type === "private" && source.time !== undefined && item.time === source.time)
    message_id ||= record?.message_id
    if (typeof message_id !== "string" || !message_id)
      throw new Error("QQBot 引用消息缺少真实 message_id，且无法从当前会话缓存定位；不能将 seq 当作官方消息 ID")
    const sender = source.sender || record?.sender
    return this[method]({ ...context, active: false, message_type: type, message_id,
      ...(source.sub_type !== undefined ? { sub_type: source.sub_type } : record?.sub_type ? { sub_type: record.sub_type } : {}),
      ...(sender ? { sender } : {}),
      ...(type === "group" && (source.user_id ?? record?.user_id) ? { user_id: plainId(source.user_id ?? record.user_id, id, this.sep) } : {}),
    }, msg)
  }

  observedUserInfo(id, user_id) {
    const uid = plainId(user_id, id, this.sep)
    const guild = uid.startsWith("qg_")
    const bot = Bot[id]
    let profile = {}
    // 群成员的已观察昵称和头像也可用于 pickUser；不因此将群成员加入好友列表。
    for (const [group_id, members] of bot.gml) {
      if (plainId(group_id, id, this.sep).startsWith("qg_") !== guild) continue
      const member = members?.get(guild ? uid : mapKey(members, uid, id, this.sep))
      if (!member) continue
      for (const key of ["nickname", "username", "avatar", "real_id", "union_openid", "union_user_account"])
        if (member[key] !== undefined) profile[key] = member[key]
    }
    profile = { ...profile, ...bot.fl.get(guild ? uid : mapKey(bot.fl, uid, id, this.sep)) }
    return { ...profile, user_id: guild ? uid.slice(3) : uid }
  }

  pickFriend(id, user_id) {
    user_id = plainId(user_id, id, this.sep)
    if (user_id.startsWith("qg_")) return this.pickGuildFriend(id, user_id)
    const read = () => this.observedUserInfo(id, user_id)
    const i = {
      ...read(),
      self_id: id,
      bot: Bot[id],
      user_id: plainId(user_id, id, this.sep),
    }
    const contact = {
      ...unsupportedMethods("Friend", unsupportedFriend),
      ...i,
      /** pickFriend(...).sendMsg 是主动推送，不是回复（不拿缓存的上一条消息当引用） */
      sendMsg: (msg, source) => this.sendContactMsg(id, "private", i.user_id, i, msg, source, "sendFriendMsg"),
      sendFile: (file, name) =>
        this.sendFriendMsg(i, { type: "file", file, ...(name ? { name } : {}) }, true),
      uploadImage: (file, opts) => this.uploadImage(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      getFileUrl: fid => this.contactFileUrl(id, "private", i.user_id, fid),
      getMsg: message_id => this.contactMessage(id, "private", i.user_id, message_id),
      getChatHistory: (seq, count) => this.contactHistory(id, "private", i.user_id, seq, count),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      getAvatarUrl: (size = 0) => read().avatar || `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/${size}`,
      getSimpleInfo: async () => read(),
      asFriend: () => this.pickFriend(id, user_id),
      asMember: group_id => this.pickMember(id, group_id, user_id),
      searchSameGroup: () => this.sameGroups(id, user_id),
    }
    return liveInfo(contact, read, ["nickname", "card", "avatar", "real_id"])
  }

  pickMember(id, group_id, user_id) {
    group_id = plainId(group_id, id, this.sep)
    user_id = plainId(user_id, id, this.sep)
    if (group_id.startsWith("qg_") || user_id.startsWith("qg_"))
      return this.pickGuildMember(id, group_id, user_id.startsWith("qg_") ? user_id : `qg_${user_id}`)
    const uid = plainId(user_id, id, this.sep), gid = plainId(group_id, id, this.sep)
    const read = () => {
      const members = Bot[id].gml.get(mapKey(Bot[id].gml, group_id, id, this.sep))
      return memberInfo({ ...Bot[id].fl.get(mapKey(Bot[id].fl, user_id, id, this.sep)), ...members?.get(mapKey(members, user_id, id, this.sep)) }, uid, gid)
    }
    const i = {
      ...read(),
      self_id: id,
      bot: Bot[id],
      user_id: uid,
      group_id: gid,
    }
    const contact = {
      ...this.pickFriend(id, user_id),
      ...unsupportedMethods("Member", unsupportedMember),
      ...i,
      get is_admin() { return ["owner", "admin"].includes(read().role) },
      get is_owner() { return read().role === "owner" },
      get is_friend() { return Bot[id].fl.has(mapKey(Bot[id].fl, user_id, id, this.sep)) },
      get mute_left() { return Math.max(0, (Number(read().shutup_time) || 0) - Math.floor(Date.now() / 1000)) },
      get card() { return read().card || read().nickname },
      renew: async () => {
        const info = await i.bot.sdk.getGroupMemberInfo(gid, uid)
        const groupKey = mapKey(i.bot.gml, group_id, id, this.sep)
        let members = i.bot.gml.get(groupKey)
        if (!members) { members = new Map(); await i.bot.gml.set(groupKey, members) }
        const userKey = mapKey(members, user_id, id, this.sep)
        await members.set(userKey, memberInfo({ ...members.get(userKey), ...info, nickname: info.username || info.nickname || read().nickname }, uid, gid))
        return read()
      },
      mute: (duration = 1800) => this.muteMember(id, gid, uid, duration),
      unmute: () => this.muteMember(id, gid, uid, 0),
      kick: (message = "", block = false) => this.kickMember(id, gid, uid, block),
    }
    Object.defineProperty(contact, "group", { enumerable: true, configurable: true, get: () => this.pickGroup(id, group_id) })
    return liveInfo(contact, read, ["nickname", "title", "role"])
  }

  pickGroup(id, group_id) {
    group_id = plainId(group_id, id, this.sep)
    if (group_id.startsWith("qg_")) return this.pickGuild(id, group_id)
    const gid = plainId(group_id, id, this.sep)
    const read = () => ({ ...Bot[id].gl.get(mapKey(Bot[id].gl, group_id, id, this.sep)), group_id: gid })
    const i = {
      ...read(),
      self_id: id,
      bot: Bot[id],
      group_id: gid,
    }
    const contact = {
      ...unsupportedMethods("Group", unsupportedGroup),
      ...i,
      fs: unsupportedMethods("Group.fs", unsupportedFiles),
      get name() { return read().group_name || read().name || gid },
      get is_owner() { return read().bot_role === "owner" },
      get is_admin() { return ["owner", "admin"].includes(read().bot_role) },
      get mute_left() { return Math.max(0, (Number(read().shutup_time_me) || 0) - Math.floor(Date.now() / 1000)) },
      get all_muted() { return read().global_mute_rule ? globalMuteActive(read().global_mute_rule) : Number(read().shutup_time_whole) > Date.now() / 1000 },
      getAvatarUrl: () => read().avatar || read().group_avatar || "",
      /** pickGroup(...).sendMsg 是主动推送，不是回复（不拿群里最后一条消息当引用） */
      sendMsg: (msg, source) => this.sendContactMsg(id, "group", gid, i, msg, source, "sendGroupMsg"),
      sendFile: (file, pidOrName, name) => {
        const resolved = fileName(pidOrName, name)
        return this.sendGroupMsg(i, { type: "file", file, ...(resolved ? { name: resolved } : {}) }, true)
      },
      uploadImage: (file, opts) => this.uploadImage(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      getFileUrl: fid => this.contactFileUrl(id, "group", gid, fid),
      getMsg: message_id => this.contactMessage(id, "group", gid, message_id),
      getChatHistory: (seq, count) => this.contactHistory(id, "group", gid, seq, count),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap: noCache => this.groupMembers(id, gid, noCache),
      renew: async () => {
        const info = await i.bot.sdk.getGroupInfo(gid)
        const key = mapKey(i.bot.gl, group_id, id, this.sep)
        const cached = i.bot.gl.get(key)
        await i.bot.gl.set(key, { ...cached, ...info, group_id: key, member_count: info.group_member_num ?? info.member_count ?? cached?.member_count })
        if (typeof i.bot.sdk.getGroupBotState === "function") {
          try {
            await this.getGroupBotState(id, gid)
          } catch (err) {
            await i.bot.gl.set(key, { ...i.bot.gl.get(key), bot_role: undefined })
            log("debug", ["刷新机器人群角色失败", err?.message || String(err)], id)
          }
        }
        return read()
      },
      muteMember: (user_id, duration = 1800) => this.muteMember(id, gid, user_id, duration),
      unmuteMember: user_id => this.muteMember(id, gid, user_id, 0),
      muteMembers: members => this.setGroupMemberMute(id, gid, members),
      setMemberMute: members => this.setGroupMemberMute(id, gid, members),
      getBotState: () => this.getGroupBotState(id, gid),
      getMuteSetting: () => this.getGroupMuteSetting(id, gid),
      getJoinRequests: options => i.bot.sdk.getGroupJoinRequests(gid, options),
      approveJoinRequest: (user_id, options) => i.bot.sdk.approveGroupJoinRequest(gid, plainId(user_id, id, this.sep), options),
      kickMember: (user_id, message = "", block = false) => this.kickMember(id, gid, user_id, block),
      kickMembers: (user_ids, block = false) => this.batchRemoveGroupMembers(id, gid, user_ids, block),
      getBlacklist: options => this.getGroupMemberBlacklist(id, gid, options),
      updateBlacklist: options => this.setGroupMemberBlacklist(id, gid, options),
    }
    return liveInfo(contact, read, ["group_name", "member_count", "owner_id"])
  }

  async groupMembers(id, group_id, noCache = false) {
    const bot = Bot[id], gid = plainId(group_id, id, this.sep)
    if (gid.startsWith("qg_")) return this.pickGuild(id, gid).getMemberMap(noCache)
    const key = mapKey(bot.gml, gid, id, this.sep)
    let members = bot.gml.get(key)
    if (noCache) {
      const list = await bot.sdk.getGroupMemberList(gid, true)
      const next = new Map()
      for (const raw of list) {
        const uid = raw.member_openid || raw.user_id || raw.id
        if (!uid) continue
        const userKey = mapKey(members, uid, id, this.sep)
        next.set(userKey, memberInfo({ ...members?.get(userKey), ...raw, nickname: raw.username || raw.nickname || members?.get(userKey)?.nickname }, String(uid), gid))
      }
      await bot.gml.set(key, next)
      members = next
    }
    return new Map([...(members || [])].map(([uid, info]) => {
      const plain = plainId(uid, id, this.sep)
      return [plain, memberInfo(info, plain, gid)]
    }))
  }

  async muteMember(id, group_id, user_id, duration) {
    const seconds = durationSeconds(duration)
    const gid = plainId(group_id, id, this.sep), uid = plainId(user_id, id, this.sep)
    const group = Bot[id].sdk.group(gid)
    const mute_expire_at = seconds ? new Date(Date.now() + seconds * 1000).toISOString() : ""
    if (!seconds) await group.unmute(uid)
    else await group.mute(uid, mute_expire_at)
    await this.applyGroupMemberMute(id, gid, [{ member_openid: uid, op: seconds ? "add" : "del", mute_expire_at }])
    return true
  }

  async getGroupBotState(id, group_id) {
    const gid = plainId(group_id, id, this.sep), bot = Bot[id]
    const state = await bot.sdk.getGroupBotState(gid)
    if (!state || !["owner", "admin", "member"].includes(state.member_role)) throw new Error("QQBot 群机器人状态响应无效")
    const key = mapKey(bot.gl, gid, id, this.sep), info = bot.gl.get(key)
    const ownMute = info?.mute_setting?.members?.find(item => item.member_openid === state.member_openid)
    await bot.gl.set(key, { ...info, group_id: key, bot_role: state.member_role, bot_state: state,
      ...(info?.mute_setting ? { shutup_time_me: ownMute ? Math.floor(Date.parse(ownMute.mute_expire_at) / 1000) : 0 } : {}),
    })
    return state
  }

  async getGroupMuteSetting(id, group_id) {
    const gid = plainId(group_id, id, this.sep), bot = Bot[id]
    const setting = await bot.sdk.getGroupMuteSetting(gid)
    if (!setting || !Array.isArray(setting.members) || !["none", "always", "schedule"].includes(setting.global_rule?.mode))
      throw new Error("QQBot 群禁言状态响应无效")
    const entries = setting.members.map(item => {
      const expires = Date.parse(item.mute_expire_at)
      if (!item.member_openid || !Number.isFinite(expires)) throw new Error("QQBot 群成员禁言状态响应无效")
      return [String(item.member_openid), { ...item, shutup_time: Math.floor(expires / 1000) }]
    })
    const memberKey = mapKey(bot.gml, gid, id, this.sep)
    const existing = bot.gml.get(memberKey), members = new Map(existing || [])
    for (const [key, info] of members) members.set(key, { ...info, shutup_time: 0 })
    for (const [uid, info] of entries) {
      const key = mapKey(members, uid, id, this.sep)
      members.set(key, memberInfo({ ...members.get(key), ...info, nickname: info.username || members.get(key)?.nickname }, uid, gid))
    }
    await bot.gml.set(memberKey, members)
    const groupKey = mapKey(bot.gl, gid, id, this.sep), info = bot.gl.get(groupKey)
    const ownMute = entries.find(([uid]) => uid === info?.bot_state?.member_openid)?.[1]
    await bot.gl.set(groupKey, { ...info, group_id: groupKey, mute_setting: setting, global_mute_rule: setting.global_rule,
      ...(info?.bot_state?.member_openid ? { shutup_time_me: ownMute?.shutup_time || 0 } : {}),
    })
    return setting
  }

  async applyGroupMemberMute(id, group_id, changes) {
    const bot = Bot[id], memberKey = mapKey(bot.gml, group_id, id, this.sep)
    let members = bot.gml.get(memberKey)
    if (!members) { members = new Map(); await bot.gml.set(memberKey, members) }
    const groupKey = mapKey(bot.gl, group_id, id, this.sep), info = bot.gl.get(groupKey)
    const muted = new Map((info?.mute_setting?.members || []).map(item => [String(item.member_openid), item]))
    let shutup_time_me = info?.shutup_time_me
    for (const change of changes) {
      const uid = change.member_openid, key = mapKey(members, uid, id, this.sep)
      const expires = change.op === "del" ? 0 : Date.parse(change.mute_expire_at) / 1000
      if (!Number.isFinite(expires)) continue
      await members.set(key, memberInfo({ ...members.get(key), shutup_time: Math.floor(expires) }, uid, group_id))
      if (change.op === "del") muted.delete(uid)
      else muted.set(uid, { ...muted.get(uid), member_openid: uid, mute_expire_at: change.mute_expire_at })
      if (uid === info?.bot_state?.member_openid) shutup_time_me = Math.floor(expires)
    }
    await bot.gl.set(groupKey, { ...info, group_id: groupKey, shutup_time_me,
      ...(info?.mute_setting ? { mute_setting: { ...info.mute_setting, members: [...muted.values()] } } : {}),
    })
  }

  async setGroupMemberMute(id, group_id, members) {
    if (!Array.isArray(members) || members.length > 20) throw new RangeError("QQBot 单次禁言设置须为最多 20 个成员的数组")
    const gid = plainId(group_id, id, this.sep), now = Date.now()
    const changes = members.map(item => {
      if (!item || !["add", "update", "del"].includes(item.op) || !item.member_openid) throw new TypeError("QQBot 禁言设置须提供 op 和 member_openid")
      const member_openid = plainId(item.member_openid, id, this.sep)
      const result = { op: item.op, member_openid }
      if (item.mute_expire_at !== undefined) {
        if (item.op !== "del") {
          const expires = Date.parse(item.mute_expire_at)
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.mute_expire_at) || !Number.isFinite(expires) || expires <= now || expires > now + 2592000 * 1000)
            throw new RangeError("QQBot 禁言到期时间须为未来 30 天内的 RFC3339 时间")
        }
        result.mute_expire_at = item.mute_expire_at
      }
      return result
    })
    await Bot[id].sdk.setGroupMemberMute(gid, changes)
    await this.applyGroupMemberMute(id, gid, changes)
    return true
  }

  async batchRemoveGroupMembers(id, group_id, user_ids, block = false) {
    const gid = plainId(group_id, id, this.sep), bot = Bot[id]
    const member_openids = groupMemberOpenids(user_ids, id, this.sep)
    const { data } = await bot.sdk.request.post(`/v2/groups/${encodeURIComponent(gid)}/batch_remove_members`, {
      member_openids, add_to_member_blacklist: Boolean(block),
    })
    if (data?.remove_members_result !== "success" || !Array.isArray(data.add_to_member_blacklist_fail_openids))
      throw Object.assign(new Error("QQBot 群成员批量移除未确认成功"), { result: data })
    const members = bot.gml.get(mapKey(bot.gml, gid, id, this.sep))
    for (const uid of member_openids) await members?.delete(mapKey(members, uid, id, this.sep))
    return data
  }

  async kickMember(id, group_id, user_id, block = false) {
    const result = await this.batchRemoveGroupMembers(id, group_id, [user_id], block)
    if (block && result.add_to_member_blacklist_fail_openids.length)
      throw Object.assign(new Error("QQBot 成员已移除，但加入群黑名单失败"), { partial: true, result })
    return true
  }

  async getGroupMemberBlacklist(id, group_id, options = {}) {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
      throw new RangeError("QQBot 群黑名单每页数量须为 1 至 100")
    const gid = plainId(group_id, id, this.sep)
    const { data } = await Bot[id].sdk.request.get(`/v2/groups/${encodeURIComponent(gid)}/member_blacklist`, { params: options })
    return data
  }

  async setGroupMemberBlacklist(id, group_id, options) {
    if (!options || !["add", "del"].includes(options.op)) throw new TypeError("QQBot 群黑名单操作须为 add 或 del")
    const gid = plainId(group_id, id, this.sep)
    const member_openids = groupMemberOpenids(options.member_openids, id, this.sep)
    const { data } = await Bot[id].sdk.request.post(`/v2/groups/${encodeURIComponent(gid)}/member_blacklist`, { op: options.op, member_openids })
    if (!Array.isArray(data?.fail_openids)) throw new Error("QQBot 群黑名单设置响应缺少 fail_openids")
    return data
  }

  async sameGroups(id, user_id) {
    const uid = plainId(user_id, id, this.sep)
    const found = []
    for (const [key, members] of Bot[id].gml) {
      const group_id = plainId(key, id, this.sep)
      const userKey = group_id.startsWith("qg_") ? `qg_${uid.replace(/^qg_/, "")}` : mapKey(members, uid, id, this.sep)
      // 频道 ID 和群/C2C OpenID 互不通用，不能仅凭字符串相同合并联系人。
      if (group_id.startsWith("qg_") !== uid.startsWith("qg_") || !members?.has(userKey)) continue
      const group = this.pickGroup(id, group_id)
      found.push({ group_id, group_name: group.name, Group_Id: group_id, groupName: group.name })
    }
    return found
  }

  async guildPages(id, url) {
    // SDK 1.3.0 的频道列表分页吞掉所有 HTTP 错误；这里保留失败，避免把权限错误当作空列表写回缓存。
    this.guildPageRequests ||= new Map()
    const requestKey = `${id}\0${url}`
    if (this.guildPageRequests.has(requestKey)) return this.guildPageRequests.get(requestKey)
    const promise = (async () => {
      const rows = new Map(), cursors = new Set()
      let after
      for (let page = 0; page < 1000; page++) {
        const { data } = await Bot[id].sdk.request.get(url, { params: { after, limit: 100 } })
        if (!Array.isArray(data)) throw new Error("QQBot 频道分页响应缺少列表")
        for (const row of data) {
          const key = row?.user?.id ?? row?.id
          if (!key) throw new Error("QQBot 频道分页响应缺少 ID")
          rows.set(String(key), row)
        }
        if (data.length < 100) return [...rows.values()]
        const next = String(data.at(-1)?.user?.id ?? data.at(-1)?.id ?? "")
        if (!next || cursors.has(next)) throw new Error("QQBot 频道分页游标无效或重复")
        cursors.add(next)
        after = next
      }
      throw new Error("QQBot 频道分页超出上限")
    })()
    this.guildPageRequests.set(requestKey, promise)
    promise.then(() => this.guildPageRequests.delete(requestKey), () => this.guildPageRequests.delete(requestKey))
    return promise
  }

  async guildList(id) {
    const list = (await this.guildPages(id, "/users/@me/guilds")).map(({ id: guild_id, name: guild_name, joined_at, ...info }) => ({
      ...info, guild_id, guild_name,
      ...(Number.isFinite(Date.parse(joined_at)) ? { join_time: Math.floor(Date.parse(joined_at) / 1000) } : {}),
    }))
    Bot[id].guilds ||= new Map()
    for (const info of list) await Bot[id].guilds.set(String(info.guild_id), info)
    return list
  }

  async guildMembers(id, group_id, noCache = false) {
    group_id = plainId(group_id, id, this.sep)
    const guild_id = group_id.replace(/^qg_/, "").split("-")[0]
    const bot = Bot[id]
    let members = new Map(bot.gml.get(group_id) || [])
    if (!group_id.includes("-")) for (const [key, observed] of bot.gml)
      if (key.startsWith(`${group_id}-`)) for (const [uid, info] of observed) members.set(uid, info)
    if (noCache) {
      const rows = await this.guildPages(id, `/guilds/${encodeURIComponent(guild_id)}/members`)
      const next = new Map()
      for (const raw of rows) {
        const uid = String(raw.user.id)
        const userKey = `qg_${uid}`
        next.set(userKey, guildMemberInfo({ ...members.get(userKey), ...raw }, uid, group_id))
      }
      await bot.gml.set(group_id, next)
      members = next
    }
    return new Map([...members].map(([key, info]) => [key, guildMemberInfo(info, String(key).replace(/^qg_/, ""), group_id)]))
  }

  async updateGuildMember(id, group_id, user_id, update) {
    const uid = `qg_${String(user_id).replace(/^qg_/, "")}`
    const guild_id = group_id.replace(/^qg_/, "").split("-")[0]
    if (update !== null) {
      let members = Bot[id].gml.get(group_id)
      if (!members) { members = new Map(); await Bot[id].gml.set(group_id, members) }
      await members.set(uid, { ...members.get(uid), ...update })
    }
    for (const [key, members] of Bot[id].gml) {
      if (key !== `qg_${guild_id}` && !key.startsWith(`qg_${guild_id}-`)) continue
      if (!members.has(uid)) continue
      if (update === null) await members.delete(uid)
      else await members.set(uid, { ...members.get(uid), ...update })
    }
  }

  async muteGuildMember(id, group_id, user_id, duration = 1800) {
    const seconds = durationSeconds(duration)
    const guild_id = group_id.replace(/^qg_/, "").split("-")[0]
    const uid = plainId(user_id, id, this.sep).replace(/^qg_/, "")
    const success = await Bot[id].sdk.muteGuildMember(guild_id, uid, seconds)
    if (success) await this.updateGuildMember(id, group_id, uid, { shutup_time: seconds ? Math.floor(Date.now() / 1000) + seconds : 0 })
    return success
  }

  async kickGuildMember(id, group_id, user_id, block = false) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")[0]
    const uid = plainId(user_id, id, this.sep).replace(/^qg_/, "")
    const success = await Bot[id].sdk.kickGuildMember(guild_id, uid, 0, Boolean(block))
    if (success) await this.updateGuildMember(id, group_id, uid, null)
    return success
  }

  async setGuildAdmin(id, group_id, user_id, enable = true) {
    const [guild_id, channel_id] = group_id.replace(/^qg_/, "").split("-")
    const uid = plainId(user_id, id, this.sep).replace(/^qg_/, "")
    const method = enable ? "addGuildMemberRoles" : "removeGuildMemberRoles"
    const success = await Bot[id].sdk[method](guild_id, channel_id, uid, "2")
    if (success) {
      const current = this.pickGuildMember(id, group_id, uid).info
      const roles = (current.roles || []).map(String).filter(role => role !== "2")
      if (enable) roles.push("2")
      await this.updateGuildMember(id, group_id, uid, { roles, role: roles.includes("4") ? "owner" : roles.some(role => ["2", "5"].includes(role)) ? "admin" : "member" })
    }
    return success
  }

  pickGuildFriend(id, user_id) {
    user_id = `qg_${plainId(user_id, id, this.sep).replace(/^qg_/, "")}`
    const read = () => this.observedUserInfo(id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    const contact = {
      ...unsupportedMethods("Friend", unsupportedFriend),
      ...unsupportedMethods("GuildFriend", ["sendFile", "uploadImage", "fileToUrl", "filetoUrl"]),
      ...i,
      /** pickGuildFriend(...).sendMsg 是主动推送，不是回复 */
      sendMsg: (msg, source) => this.sendContactMsg(id, "private", user_id, { ...i, ...read() }, msg, source, "sendDirectMsg"),
      recallMsg: (message_id, hide) => this.recallDirectMsg({ ...i, ...read() }, message_id, hide),
      getFileUrl: fid => this.contactFileUrl(id, "private", user_id, fid),
      getMsg: message_id => this.contactMessage(id, "private", user_id, message_id),
      getChatHistory: (seq, count) => this.contactHistory(id, "private", user_id, seq, count),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      getSimpleInfo: async () => read(),
      getAvatarUrl: () => read().avatar || "",
      asFriend: () => this.pickGuildFriend(id, user_id),
      asMember: group_id => this.pickGuildMember(id, group_id, user_id),
      searchSameGroup: () => this.sameGroups(id, user_id),
    }
    return liveInfo(contact, read, ["nickname", "card", "avatar", "real_id"])
  }

  pickGuildMember(id, group_id, user_id) {
    group_id = plainId(group_id, id, this.sep)
    user_id = `qg_${plainId(user_id, id, this.sep).replace(/^qg_/, "")}`
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const uid = user_id.replace(/^qg_/, "")
    const read = () => {
      let observed = Bot[id].gml.get(`qg_${guild_id[0]}`)?.get(user_id)
      if (!observed) for (const [key, members] of Bot[id].gml)
        if (key.startsWith(`qg_${guild_id[0]}-`) && members.has(user_id)) { observed = members.get(user_id); break }
      return guildMemberInfo({ ...Bot[id].fl.get(user_id), ...observed, ...Bot[id].gml.get(group_id)?.get(user_id) }, uid, group_id)
    }
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ""),
    }
    const contact = {
      ...this.pickGuildFriend(id, user_id),
      ...unsupportedMethods("Member", unsupportedMember),
      ...i,
      group_id,
      sendMsg: (msg, source) => this.sendContactMsg(id, "private", user_id, { ...i, ...read(), ...Bot[id].fl.get(user_id), user_id: uid, src_guild_id: guild_id[0], src_channel_id: guild_id[1] }, msg, source, "sendDirectMsg"),
      recallMsg: (message_id, hide) => this.recallDirectMsg({ ...i, ...Bot[id].fl.get(user_id), user_id: uid }, message_id, hide),
      getFileUrl: fid => this.contactFileUrl(id, "private", user_id, fid),
      renew: async () => {
        const info = await i.bot.sdk.getGuildMemberInfo(guild_id[0], uid)
        let members = i.bot.gml.get(group_id)
        if (!members) { members = new Map(); await i.bot.gml.set(group_id, members) }
        await members.set(user_id, guildMemberInfo({ ...read(), ...info }, uid, group_id))
        return read()
      },
      mute: (duration = 1800) => this.muteGuildMember(id, group_id, uid, duration),
      kick: (message = "", block = false) => this.kickGuildMember(id, group_id, uid, block),
      setAdmin: (enable = true) => this.setGuildAdmin(id, group_id, uid, enable),
      get mute_left() { return Math.max(0, (Number(read().shutup_time) || 0) - Math.floor(Date.now() / 1000)) },
      get is_owner() { return read().role === "owner" },
      get is_admin() { return ["owner", "admin"].includes(read().role) },
    }
    Object.defineProperty(contact, "group", { enumerable: true, configurable: true, get: () => this.pickGuild(id, group_id) })
    return liveInfo(contact, read, ["nickname", "card", "role"])
  }

  pickGuild(id, group_id) {
    group_id = plainId(group_id, id, this.sep)
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const read = () => ({ ...Bot[id].gl.get(group_id), group_id, guild_id: guild_id[0], channel_id: guild_id[1] })
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
    }
    const contact = {
      ...unsupportedMethods("Guild", unsupportedGroup),
      ...unsupportedMethods("Guild", ["sendFile", "uploadImage", "fileToUrl", "filetoUrl"]),
      ...i,
      fs: unsupportedMethods("Guild.fs", unsupportedFiles),
      group_id,
      get name() { return read().group_name || read().name || group_id },
      get is_owner() { return read().owner_id === String(i.bot.info?.id || i.bot.uin) || read().owner === true },
      get is_admin() { return ["owner", "admin"].includes(read().bot_role) || contact.is_owner },
      get all_muted() { return Number(read().shutup_time_whole) > Date.now() / 1000 },
      getAvatarUrl: () => read().avatar || read().icon || "",
      /** pickGuild(...).sendMsg 是主动推送，不是回复 */
      sendMsg: (msg, source) => this.sendContactMsg(id, "group", group_id, i, msg, source, "sendGuildMsg"),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      getFileUrl: fid => this.contactFileUrl(id, "group", group_id, fid),
      getMsg: message_id => this.contactMessage(id, "group", group_id, message_id),
      getChatHistory: (seq, count) => this.contactHistory(id, "group", group_id, seq, count),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: (noCache = false) => this.guildMembers(id, group_id, noCache),
      renew: async () => {
        const [guild, channel] = await Promise.all([i.bot.sdk.getGuildInfo(i.guild_id), i.channel_id ? i.bot.sdk.getChannelInfo(i.channel_id) : Promise.resolve({})])
        const cached = i.bot.gl.get(group_id)
        const group_name = channel.channel_name || channel.name || guild.guild_name || guild.name || cached?.group_name || group_id
        await i.bot.gl.set(group_id, { ...cached, ...guild, ...channel, group_id, group_name, name: group_name })
        return read()
      },
      setName: async name => {
        await i.bot.sdk.updateChannel(i.channel_id, { name: String(name) })
        await i.bot.gl.set(group_id, { ...i.bot.gl.get(group_id), group_name: String(name), name: String(name), channel_name: String(name) })
        return true
      },
      // 官方频道禁言有最长 30 天的期限，调用方可显式缩短；false 解除禁言。
      muteAll: async (enable = true, duration = 2592000) => {
        const seconds = enable ? durationSeconds(duration) : 0
        const success = await i.bot.sdk.muteGuild(i.guild_id, seconds)
        if (success) {
          const shutup_time_whole = seconds ? Math.floor(Date.now() / 1000) + seconds : 0
          await i.bot.gl.set(group_id, { ...i.bot.gl.get(group_id), group_id, shutup_time_whole })
          for (const [key, info] of i.bot.gl)
            if (key === `qg_${i.guild_id}` || key.startsWith(`qg_${i.guild_id}-`))
              await i.bot.gl.set(key, { ...info, shutup_time_whole })
        }
        return success
      },
      muteMember: (user_id, duration = 1800) => this.muteGuildMember(id, group_id, user_id, duration),
      kickMember: (user_id, message = "", block = false) => this.kickGuildMember(id, group_id, user_id, block),
      setAdmin: (user_id, enable = true) => this.setGuildAdmin(id, group_id, user_id, enable),
      getChannelList: () => i.bot.sdk.getChannelList(i.guild_id),
      getPins: () => i.bot.sdk.getChannelPins(i.channel_id),
      pinMsg: message_id => i.bot.sdk.pinChannelMessage(i.channel_id, message_id),
      unpinMsg: message_id => i.bot.sdk.unPinChannelMessage(i.channel_id, message_id),
      // 与 NapCat announce(content)/setReaction(id, code, add) 区分，官方接口显式使用消息 ID 和 EmojiType。
      setAnnounce: message_id => i.bot.sdk.setChannelAnnounce(i.guild_id, i.channel_id, message_id),
      addReaction: (message_id, type, emoji_id) => i.bot.sdk.addGuildMessageReaction(i.channel_id, message_id, type, emoji_id),
      deleteReaction: (message_id, type, emoji_id) => i.bot.sdk.deleteGuildMessageReaction(i.channel_id, message_id, type, emoji_id),
      getReactionMembers: (message_id, type, emoji_id) => i.bot.sdk.getGuildMessageReactionMembers(i.channel_id, message_id, type, emoji_id),
    }
    return liveInfo(contact, read, ["group_name", "member_count", "owner_id", "guild_name", "channel_name"])
  }


}
