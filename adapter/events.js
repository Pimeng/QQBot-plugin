import { dispatch } from "../lib/utils/events.js"
import { getMap } from "../lib/utils/store.js"
import { qblog } from "../lib/utils/logger.js"
import BotApi from "./bot-api.js"
import { isAtSelf, receivedMessageSegments, receivedMessageText } from "./message/received.js"
import { mapKey, memberInfo, unixTime } from "./compat.js"
import { config } from "../lib/utils/cfg.js"

function messageSender(event, userId, cached) {
  return {
    ...cached,
    ...event.sender,
    user_id: userId,
    nickname: event.user_name === event.sender.user_id ? cached?.nickname || event.user_name : event.user_name,
  }
}

export default class AdapterEvents extends BotApi {
  async sendInputNotify(data) {
    if (config.inputNotify !== true || data.message_type !== "private" || data.sub_type !== "friend" || !data.message_id) return false
    const configured = Number(config.inputNotifySeconds ?? 30)
    const seconds = Number.isFinite(configured) ? Math.min(60, Math.max(1, Math.trunc(configured))) : 30
    try {
      await data.bot.sdk.request.post(`/v2/users/${data.user_id}/messages`, {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: seconds },
        msg_id: data.message_id,
      })
      return true
    } catch (error) {
      qblog.debug(`[${data.self_id}] 输入状态发送失败`, error?.message || error)
      return false
    }
  }

  async ensureGroupState(id, group_id) {
    if (config.refreshGroupState === false || typeof Bot[id]?.sdk?.getGroupBotState !== "function") return
    this.groupStateChecks ||= new Map()
    const key = `${id}:${group_id}`
    const bot = Bot[id]
    const previous = this.groupStateChecks.get(key)
    if (previous?.bot === bot && Date.now() - previous.time < 300000) return previous.pending
    const check = { bot, time: Date.now() }
    check.pending = this.getGroupBotState(id, group_id).catch(error => {
      qblog.debug(`[${id}] 读取机器人群角色失败`, error?.message || String(error))
    })
    this.groupStateChecks.set(key, check)
    return check.pending
  }

  async makeFriendMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    const cached = data.bot.fl.get(user_id)
    data.sender = messageSender(event, user_id, cached)
    data.target_id = user_id
    data.nickname = data.sender.nickname
    qblog.info(`[${data.self_id}] 好友消息：[${data.user_id}] ${data.raw_message}`)

    data.reply = (msg, quote, extra) =>
      this.sendFriendMsg({ ...data, user_id: event.sender.user_id, replyExtra: extra }, msg)
    await this.setFriendMap(data)
  }

  async makeGroupMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    const cachedSender = data.bot.gml.get(data.group_id)?.get(user_id) || data.bot.fl.get(user_id)
    data.sender = messageSender(event, user_id, cachedSender)
    const cached = data.bot.gl.get(data.group_id)
    data.group_name = event.group_name || cached?.group_name || cached?.name || event.group_id
    data.nickname = data.sender.nickname
    qblog.info(`[${data.self_id}] 群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`)

    data.reply = (msg, quote, extra) =>
      this.sendGroupMsg({ ...data, group_id: event.group_id, replyExtra: extra }, msg)
    await this.setGroupMap(data)
    await this.ensureGroupState(data.self_id, event.group_id)
  }

  async makeDirectMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.nickname || event.sender.user_name || event.sender.user_id,
      avatar: event.author?.avatar,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id,
    }
    qblog.info(`[${data.self_id}] 频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)

    data.reply = (msg, quote, extra) =>
      this.sendDirectMsg({
        ...data,
        user_id: event.user_id,
        guild_id: event.guild_id,
        channel_id: event.channel_id,
        replyExtra: extra,
      }, msg)
    await this.setFriendMap(data)
  }

  async makeGuildMessage(data, event) {
    const user_id = `qg_${event.sender.user_id}`
    data.message_type = "group"
    data.sender = {
      ...data.bot.fl.get(user_id),
      ...event.sender,
      user_id,
      nickname: event.sender.nickname || event.sender.user_name || event.sender.user_id,
      card: event.member?.nick || "",
      avatar: event.author?.avatar,
      src_guild_id: event.guild_id,
      src_channel_id: event.channel_id,
    }
    data.group_id = `qg_${event.guild_id}-${event.channel_id}`
    data.group_name = event.channel_name || data.bot.gl.get(data.group_id)?.group_name || data.group_id
    qblog.info(`[${data.self_id}] 频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)
    data.reply = (msg, quote, extra) =>
      this.sendGuildMsg({
        ...data,
        guild_id: event.guild_id,
        channel_id: event.channel_id,
        replyExtra: extra,
      }, msg)
    await this.setFriendMap(data)
    await this.setGroupMap(data)
  }

  async setFriendMap(data) {
    if (!data.user_id) return
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.sender,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async setGroupMap(data) {
    if (!data.group_id) return
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      ...(data.guild_id !== undefined ? { guild_id: data.guild_id, channel_id: data.channel_id } : {}),
      ...(data.group_name ? { group_name: data.group_name, name: data.group_name } : {}),
      time: data.time,
      message_id: data.message_id,
    })
    const members = await this.getGroupMembers(data.bot, data.group_id)
    await members.set(data.user_id, {
      ...members.get(data.user_id),
      ...data.sender,
    })
  }

  async getGroupMembers(bot, groupId) {
    let members = bot.gml.get(groupId)
    if (!members) {
      members = new Map()
      await bot.gml.set(groupId, members)
    }
    return members
  }

  async makeMessage(id, event) {
    /** MESSAGE_AUDIT 与普通消息共用 SDK 的 message 根事件，但没有 message_type。 */
    if (event._eventName?.startsWith("message.audit")) return this.makeMessageAudit(id, event)
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      src_guild_id: event.src_guild_id,
      seq: event.seq,
      rand: event.rand,
      msg_idx: event.msg_idx,
      ref_msg_idx: event.ref_msg_idx,
      scene_ext: event.scene_ext,
      ...(event.ark_data ? { ark_data: event.ark_data } : {}),
      ...(Array.isArray(event.embeds) ? { embeds: event.embeds } : {}),
      source: event.source,
      time: Math.trunc(event.timestamp),
      get user_id() {
        return this.sender.user_id
      },
      message: receivedMessageSegments(event, id, this.sep, Bot[id]),
      message_format: "array",
      raw_message: event.raw_message,
      /** 是否群里 @ 了机器人（1.3.0 用事件名区分，message_type 都是 group） */
      _at: isAtSelf(event),
    }

    data.raw_message = receivedMessageText(data.message)

    switch (data.message_type) {
      case "private":
        if (data.sub_type === "friend") await this.makeFriendMessage(data, event)
        else await this.makeDirectMessage(data, event)
        break
      case "group":
        await this.makeGroupMessage(data, event)
        break
      case "guild":
        await this.makeGuildMessage(data, event)
        break
      default:
        qblog.warn(`[${id}] 未知消息`, event)
        return
    }

    this.cacheMessage(data)
    return dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeBotCallback(id, event, callback) {
    const data = {
      raw: event,
      bot: Bot[callback.self_id],
      self_id: callback.self_id,
      post_type: "message",
      message_id: `event_${event.notice_id}`,
      message_type: callback.group_id ? "group" : "private",
      sub_type: "callback",
      time: unixTime(event.time) ?? Math.floor(Date.now() / 1000),
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    data.message.push(
      { type: "at", qq: callback.self_id },
      { type: "text", text: callback.message },
    )
    data.raw_message += callback.message

    if (callback.group_id) {
      data.group_id = callback.group_id
      data.group = data.bot.pickGroup(callback.group_id)
      data.group_name = data.group.name
      data.friend = Bot[id].pickFriend(data.user_id)
      if (data.friend.real_id) {
        data.friend = data.bot.pickFriend(data.friend.real_id)
        data.member = data.group.pickMember(data.friend.user_id)
        data.sender = {
          ...((await data.member.getInfo()) || data.member),
        }
      } else {
        return this.bindCallbackUser(id, event, callback, data)
      }
      qblog.info(`[${data.self_id}] 群按钮点击事件：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)
    } else {
      await Bot[id].fl.set(data.user_id, {
        ...Bot[id].fl.get(data.user_id),
        real_id: callback.user_id,
      })
      data.friend = data.bot.pickFriend(callback.user_id)
      data.sender = {
        ...((await data.friend.getInfo()) || data.friend),
      }
      qblog.info(`[${data.self_id}] 好友按钮点击事件：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)
    }

    event.reply(0)
    return dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async bindCallbackUser(id, event, callback, data) {
    const bot = Bot[id]
    if (bot.callback[data.user_id]) return event.reply(3)
    bot.callback[data.user_id] = true

    try {
      let message = `请先发送 #QQBot绑定用户${data.user_id}`
      const real_id = callback.message.replace(/^#[Qq]+[Bb]ot绑定用户确认/, "").trim()
      if (this.bind_user[real_id] === data.user_id) {
        await bot.fl.set(data.user_id, { ...bot.fl.get(data.user_id), real_id })
        message = `绑定成功 ${data.user_id} → ${real_id}`
      }
      await event.reply(0)
      return await data.group.sendMsg(message)
    } finally {
      delete bot.callback[data.user_id]
    }
  }

  wrapCallbackReply(id, event) {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        const result = await reply(...args)
        if (result === false) {
          qblog.error(`[${id}] 回复按钮点击事件失败`, {
            notice_id: event.notice_id,
            group_id: event.group_id,
            operator_id: event.operator_id,
            code: args[0],
          })
        }
        return result
      } catch (error) {
        qblog.error(`[${id}] 回复按钮点击事件错误`, {
          notice_id: event.notice_id,
          group_id: event.group_id,
          operator_id: event.operator_id,
          message: error?.message || String(error),
        })
      }
    }
  }

  async makeCallback(id, event) {
    this.wrapCallbackReply(id, event)
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
      message_type: event.notice_type,
      sub_type: "callback",
      time: event.time ?? Math.floor(Date.now() / 1000),
      get user_id() {
        return this.sender.user_id
      },
      sender: { user_id: `${id}${this.sep}${event.operator_id}` },
      message: [],
      raw_message: "",
    }

    const { button_id, button_data } = event.data?.resolved || {}
    const callback = data.bot.callback[button_id]
    if (callback) {
      if (callback.self_id) return this.makeBotCallback(id, event, callback)
      if (!event.group_id && callback.group_id) event.group_id = callback.group_id
      if (callback.message_id.length) {
        for (const id of callback.message_id) data.message.push({ type: "reply", id })
        data.raw_message += `[回复：${callback.message_id}]`
      }
      data.message.push({ type: "text", text: callback.message })
      data.raw_message += callback.message
    } else {
      if (button_id) {
        data.message.push({ type: "reply", id: button_id })
        data.raw_message += `[回复：${button_id}]`
      }
      if (button_data) {
        data.message.push({ type: "text", text: button_data })
        data.raw_message += button_data
      } else {
        return event.reply(1)
      }
    }
    event.reply(0)

    switch (data.message_type) {
      case "friend":
        data.message_type = "private"
        qblog.info(`[${data.self_id}] 好友按钮点击事件：[${data.user_id}] ${data.raw_message}`)

        data.reply = (msg, quote, extra) =>
          this.sendFriendMsg({ ...data, user_id: event.operator_id, replyExtra: extra }, msg)
        await this.setFriendMap(data)
        break
      case "group":
        data.group_id = `${id}${this.sep}${event.group_id}`
        qblog.info(`[${data.self_id}] 群按钮点击事件：[${data.group_id}, ${data.user_id}] ${data.raw_message}`)

        data.reply = (msg, quote, extra) =>
          this.sendGroupMsg({ ...data, group_id: event.group_id, replyExtra: extra }, msg)
        await this.setGroupMap(data)
        break
      case "guild":
        data.message_type = "group"
        data.guild_id = event.guild_id
        data.channel_id = event.channel_id
        data.group_id = `qg_${event.guild_id}-${event.channel_id}`
        data.sender = { user_id: `qg_${event.operator_id}`, src_guild_id: event.guild_id, src_channel_id: event.channel_id }
        data.reply = (msg, quote, extra) => this.sendGuildMsg({ ...data, replyExtra: extra }, msg)
        await this.setFriendMap(data)
        await this.setGroupMap(data)
        break
      default:
        qblog.warn(`[${data.self_id}] 未知按钮点击事件`, event)
        return
    }

    return dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  /** 频道消息审核结果：保留审核 ID、原消息和频道上下文。 */
  async makeMessageAudit(id, event) {
    const passed = event._eventName === "message.audit.pass" || event.is_passed === true
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "notice",
      notice_type: "message_audit",
      sub_type: passed ? "pass" : "reject",
      notice_id: event.audit_id,
      audit_id: event.audit_id,
      audit_time: event.audit_time,
      message_id: event.message_id,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      is_passed: passed,
      time: unixTime(event.audit_time) ?? unixTime(event.create_time) ?? Math.floor(Date.now() / 1000),
    }
    return dispatch(`notice.message_audit.${data.sub_type}`, data)
  }

  async makeNotice(id, event) {
    if (event.sub_type === "action") return this.makeCallback(id, event)
    const bot = Bot[id]
    const data = {
      raw: event,
      bot,
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
      event_id: event.event_id,
      time: unixTime(event.time) ?? unixTime(event.apply_at) ?? Math.floor(Date.now() / 1000),
      operator_id: event.operator_id === undefined ? undefined : `${id}${this.sep}${event.operator_id}`,
    }
    for (const key of [
      "guild_id", "channel_id", "guild_name", "channel_name", "channel_type",
      "message_id", "emoji", "thread_id", "post_id", "reply_id", "author_id",
      "title", "content", "type", "result", "roles", "is_bot",
    ]) {
      if (event[key] !== undefined) data[key] = event[key]
    }
    if (event.notice_type === "forum" && typeof event.message === "string") data.error_message = event.message
    if (event._eventName?.startsWith("notice.reaction.")) data.notice_type = "reaction"
    if (event.guild_id !== undefined) {
      await this.makeGuildNotice(data, event)
      return dispatch(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }
    if (event.user_id !== undefined) data.user_id = `${id}${this.sep}${event.user_id}`
    if (event.group_id !== undefined) {
      data.group_id = `${id}${this.sep}${event.group_id}`
      data.group_name = bot.gl.get(data.group_id)?.group_name || event.group_id
    }

    if (event.notice_type === "friend") await this.makeFriendNotice(data, event)
    else if (event.notice_type === "group" && event.group_id) await this.makeGroupNotice(data, event)

    if (event.event_id && ["increase", "receive_open"].includes(event.sub_type)) {
      const context = { ...data, message_id: `event_${event.event_id}` }
      if (event.notice_type === "friend" && event.user_id) {
        data.reply = (msg, quote, extra) => this.sendFriendMsg({ ...context, user_id: event.user_id, replyExtra: extra }, msg)
      } else if (event.notice_type === "group" && event.group_id) {
        data.reply = (msg, quote, extra) => this.sendGroupMsg({ ...context, group_id: event.group_id, replyExtra: extra }, msg)
      }
    }
    return dispatch(`${data.post_type}.${data.request_type || data.notice_type}.${data.sub_type}`, data)
  }

  async makeFriendNotice(data, event) {
    const friends = data.bot.fl
    const key = mapKey(friends, event.user_id, data.self_id, this.sep)
    if (event.sub_type === "decrease") return friends.delete(key)
    const friend = { ...friends.get(key), user_id: data.user_id }
    if (event.sub_type.startsWith("receive_")) friend.receive_msg = event.sub_type === "receive_open"
    await friends.set(key, friend)
  }

  async makeGroupNotice(data, event) {
    const bot = data.bot
    const groupKey = mapKey(bot.gl, event.group_id, data.self_id, this.sep)
    const memberKey = mapKey(bot.gml, event.group_id, data.self_id, this.sep)
    if (event.sub_type === "join_request") return this.makeGroupJoinRequest(data, event)
    if (event.sub_type.startsWith("member.")) return this.makeGroupMemberNotice(data, event, memberKey)

    if (event.sub_type === "increase" || event.sub_type === "decrease") {
      // 机器人进退群的 user_id 指机器人；操作人独立放在 operator_id。
      data.user_id = `${data.self_id}${this.sep}${data.self_id}`
      bot.dau?.recordGroupEvent(event.sub_type, data)
      if (event.sub_type === "decrease") {
        await bot.gl.delete(groupKey)
        await bot.gml.delete(memberKey)
      } else {
        await bot.gl.set(groupKey, { ...bot.gl.get(groupKey), group_id: data.group_id, group_name: data.group_name })
      }
    } else if (event.sub_type.startsWith("receive_")) {
      await bot.gl.set(groupKey, {
        ...bot.gl.get(groupKey),
        group_id: data.group_id,
        receive_msg: event.sub_type === "receive_open",
      })
    }
  }

  makeGroupJoinRequest(data, event) {
    const bot = data.bot
    data.post_type = "request"
    data.request_type = "group"
    data.notice_type = undefined
    data.sub_type = "add"
    data.flag = event.join_request_id
    data.comment = typeof event.verify_info === "string" ? event.verify_info : event.verify_info?.verify_message || ""
    data.approve = (yes = true, reason = "", block = false) => {
      const options = { op: yes ? "approve" : "decline", join_request_id: event.join_request_id }
      if (!yes) {
        options.reject_reason = reason
        options.add_to_member_blacklist = Boolean(block)
      }
      return bot.sdk.approveGroupJoinRequest(event.group_id, event.user_id, options)
    }
  }

  async makeGroupMemberNotice(data, event, groupKey) {
    data.sub_type = event.sub_type.slice("member.".length)
    data.bot.dau?.recordGroupEvent(event.sub_type, data)
    const members = await this.getGroupMembers(data.bot, groupKey)
    const userKey = mapKey(members, event.user_id, data.self_id, this.sep)
    data.sender = members.get(userKey)
    if (event.sub_type === "member.decrease") return members.delete(userKey)

    const member = { ...members.get(userKey) }
    if (event.username) member.nickname = event.username
    if (event.member_role) member.member_role = event.member_role
    if (event.is_bot !== undefined) member.bot = event.is_bot
    await members.set(userKey, {
      ...memberInfo(member, event.user_id, event.group_id),
      user_id: data.user_id,
    })
  }

  /** 频道事件使用频道用户 ID 和子频道场景，不能套用群 OpenID 的账号前缀。 */
  async makeGuildNotice(data, event) {
    const bot = data.bot
    const guildId = String(event.guild_id)
    const guildKey = `qg_${guildId}`
    bot.guilds ||= new Map()
    const channelKeys = new Set([guildKey])
    for (const key of [...bot.gl.keys(), ...bot.gml.keys()]) {
      if (String(key).startsWith(`${guildKey}-`) || String(bot.gl.get(key)?.guild_id) === guildId)
        channelKeys.add(key)
    }
    if (event.operator_id !== undefined) data.operator_id = `qg_${event.operator_id}`
    if (event.user_id !== undefined) data.user_id = `qg_${event.user_id}`
    if (event.channel_id !== undefined) {
      data.group_id = `${guildKey}-${event.channel_id}`
      data.group_name = event.channel_name || bot.gl.get(data.group_id)?.group_name || data.group_id
    }

    if (event.notice_type === "channel") return this.makeChannelNotice(data, event)
    if (event.notice_type !== "guild") return
    if (event.sub_type?.startsWith("member.")) {
      if (data.user_id) await this.makeGuildMemberNotice(data, event, channelKeys)
    } else {
      await this.makeGuildInfoNotice(data, event, channelKeys)
    }
  }

  async makeGuildInfoNotice(data, event, channelKeys) {
    const bot = data.bot
    const guildId = String(event.guild_id)
    if (event.sub_type === "decrease") {
      await bot.guilds.delete(guildId)
      for (const key of channelKeys) {
        await bot.gl.delete(key)
        await bot.gml.delete(key)
      }
      return
    }
    if (!["increase", "update"].includes(event.sub_type)) return

    const guild = { ...bot.guilds.get(guildId), guild_id: guildId }
    if (event.guild_name) guild.guild_name = guild.name = event.guild_name
    await bot.guilds.set(guildId, guild)
    if (!event.guild_name) return
    for (const key of channelKeys) {
      if (bot.gl.has(key)) await bot.gl.set(key, { ...bot.gl.get(key), guild_name: event.guild_name })
    }
  }

  async makeChannelNotice(data, event) {
    if (!data.group_id || !["increase", "update", "decrease"].includes(event.sub_type)) return
    const bot = data.bot
    if (event.sub_type === "decrease") {
      await bot.gl.delete(data.group_id)
      await bot.gml.delete(data.group_id)
      return
    }
    const guildId = String(event.guild_id)
    await bot.gl.set(data.group_id, {
      ...bot.gl.get(data.group_id),
      group_id: data.group_id,
      guild_id: guildId,
      channel_id: String(event.channel_id),
      channel_type: event.channel_type,
      group_name: data.group_name,
      name: data.group_name,
      guild_name: bot.guilds.get(guildId)?.guild_name,
    })
  }

  async makeGuildMemberNotice(data, event, channelKeys) {
    const bot = data.bot
    const sender = { ...bot.fl.get(data.user_id), user_id: data.user_id, src_guild_id: String(event.guild_id) }
    if (event.user_name) sender.nickname = event.user_name
    if (event.nick !== undefined) sender.card = event.nick
    if (event.avatar) sender.avatar = event.avatar
    if (event.is_bot !== undefined) sender.bot = event.is_bot
    if (Array.isArray(event.roles)) {
      sender.roles = event.roles.map(String)
      if (sender.roles.includes("4")) sender.role = "owner"
      else if (sender.roles.some(role => role === "2" || role === "5")) sender.role = "admin"
      else sender.role = "member"
    }
    data.sender = sender
    if (event.sub_type !== "member.decrease") await bot.fl.set(data.user_id, sender)
    for (const key of channelKeys) {
      if (event.sub_type === "member.decrease") await bot.gml.get(key)?.delete(data.user_id)
      else {
        const members = await this.getGroupMembers(bot, key)
        await members.set(data.user_id, { ...members.get(data.user_id), ...sender, group_id: key })
      }
    }
  }

  getFriendMap(id) {
    return getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return getMap(`${this.path}${id}/Member`)
  }
}
