import MessageSender from "./message/sender.js"
import imageSize from "image-size"
import { fileToUrl, fileToUrlInfo, log, toBuffer } from "../lib/utils/common.js"
import { fileName, liveInfo, mapKey, memberInfo, plainId } from "./compat.js"

export default class BotApi extends MessageSender {
  accountMethods(id) {
    return {
      sendPrivateMsg: (user_id, msg) => this.pickFriend(id, user_id).sendMsg(msg),
      sendGroupMsg: (group_id, msg) => this.pickGroup(id, group_id).sendMsg(msg),
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

  pickFriend(id, user_id) {
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildFriend(id, user_id)
    const read = () => ({ ...Bot[id].fl.get(mapKey(Bot[id].fl, user_id, id, this.sep)), user_id: plainId(user_id, id, this.sep) })
    const i = {
      ...read(),
      self_id: id,
      bot: Bot[id],
      user_id: plainId(user_id, id, this.sep),
    }
    const contact = {
      ...i,
      /** pickFriend(...).sendMsg 是主动推送，不是回复（不拿缓存的上一条消息当引用） */
      sendMsg: msg => this.sendFriendMsg(i, msg, true),
      sendFile: (file, name) =>
        this.sendFriendMsg(i, { type: "file", file, ...(name ? { name } : {}) }, true),
      uploadImage: (file, opts) => this.uploadImage(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "user", targetId: i.user_id }),
      recallMsg: message_id => this.recallFriendMsg(i, message_id),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      getAvatarUrl: (size = 0) => read().avatar || `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/${size}`,
      getSimpleInfo: async () => read(),
      asFriend: () => this.pickFriend(id, user_id),
      asMember: group_id => this.pickMember(id, group_id, user_id),
    }
    return liveInfo(contact, read, ["nickname", "card", "avatar", "real_id"])
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
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
    }
    Object.defineProperty(contact, "group", { enumerable: true, configurable: true, get: () => this.pickGroup(id, group_id) })
    return liveInfo(contact, read, ["nickname", "title", "role"])
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    else if (group_id.startsWith("qg_")) return this.pickGuild(id, group_id)
    const key = mapKey(Bot[id].gl, group_id, id, this.sep)
    const gid = plainId(group_id, id, this.sep)
    const read = () => ({ ...Bot[id].gl.get(mapKey(Bot[id].gl, group_id, id, this.sep)), group_id: gid })
    const i = {
      ...read(),
      self_id: id,
      bot: Bot[id],
      group_id: gid,
    }
    const contact = {
      ...i,
      get name() { return read().group_name || read().name || gid },
      get is_owner() { return read().bot_role === "owner" },
      get is_admin() { return ["owner", "admin"].includes(read().bot_role) },
      get mute_left() { return Math.max(0, (Number(read().shutup_time_me) || 0) - Math.floor(Date.now() / 1000)) },
      get all_muted() { return Number(read().shutup_time_whole) > Date.now() / 1000 },
      getAvatarUrl: () => read().avatar || read().group_avatar || "",
      /** pickGroup(...).sendMsg 是主动推送，不是回复（不拿群里最后一条消息当引用） */
      sendMsg: msg => this.sendGroupMsg(i, msg, true),
      sendFile: (file, pidOrName, name) => {
        const resolved = fileName(pidOrName, name)
        return this.sendGroupMsg(i, { type: "file", file, ...(resolved ? { name: resolved } : {}) }, true)
      },
      uploadImage: (file, opts) => this.uploadImage(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap: noCache => this.groupMembers(id, gid, noCache),
      renew: async () => {
        const info = await i.bot.sdk.getGroupInfo(gid)
        const cached = i.bot.gl.get(key)
        await i.bot.gl.set(key, { ...cached, ...info, group_id: key, member_count: info.group_member_num ?? info.member_count ?? cached?.member_count })
        if (typeof i.bot.sdk.getGroupBotState === "function") {
          try {
            const state = await i.bot.sdk.getGroupBotState(gid)
            await i.bot.gl.set(key, { ...i.bot.gl.get(key), bot_role: state.member_role, bot_state: state })
          } catch (err) {
            await i.bot.gl.set(key, { ...i.bot.gl.get(key), bot_role: undefined })
            log("debug", ["刷新机器人群角色失败", err?.message || String(err)], id)
          }
        }
        return read()
      },
      muteMember: (user_id, duration = 1800) => this.muteMember(id, gid, user_id, duration),
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
    const seconds = Number(duration)
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30 * 24 * 60 * 60)
      throw new RangeError("禁言时长须为 0 至 2592000 秒的整数")
    const gid = plainId(group_id, id, this.sep), uid = plainId(user_id, id, this.sep)
    const group = Bot[id].sdk.group(gid)
    if (!seconds) await group.unmute(uid)
    else await group.mute(uid, new Date(Date.now() + seconds * 1000).toISOString())
    const members = Bot[id].gml.get(mapKey(Bot[id].gml, gid, id, this.sep))
    const key = mapKey(members, uid, id, this.sep)
    if (members?.has(key)) await members.set(key, { ...members.get(key), shutup_time: seconds ? Math.floor(Date.now() / 1000) + seconds : 0 })
  }

  pickGuildFriend(id, user_id) {
    const read = () => ({ ...Bot[id].fl.get(user_id), user_id: user_id.replace(/^qg_/, "") })
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    const contact = {
      ...i,
      /** pickGuildFriend(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      getSimpleInfo: async () => read(),
      getAvatarUrl: () => read().avatar || "",
    }
    return liveInfo(contact, read, ["nickname", "card", "avatar", "real_id"])
  }

  pickGuildMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const read = () => ({ ...Bot[id].fl.get(user_id), ...Bot[id].gml.get(group_id)?.get(user_id), user_id: user_id.replace(/^qg_/, ""), group_id })
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
      ...i,
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
      get is_owner() { return read().role === "owner" },
      get is_admin() { return ["owner", "admin"].includes(read().role) },
    }
    Object.defineProperty(contact, "group", { enumerable: true, configurable: true, get: () => this.pickGuild(id, group_id) })
    return liveInfo(contact, read, ["nickname", "card", "role"])
  }

  pickGuild(id, group_id) {
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
      ...i,
      group_id,
      get name() { return read().group_name || read().name || group_id },
      /** pickGuild(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendGuildMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: async (noCache = false) => {
        if (noCache) throw new Error("QQBot 当前频道成员列表仅提供已观察缓存")
        return new Map(i.bot.gml.get(group_id) || [])
      },
    }
    return liveInfo(contact, read, ["group_name"])
  }


}
