import { dispatch, getMap, log } from "../lib/utils/common.js"
import BotApi from "./bot-api.js"
import { isAtSelf, receivedMessageText } from "./message/received.js"
import { mapKey, memberInfo, unixTime } from "./compat.js"

export default class AdapterEvents extends BotApi {
  async makeFriendMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    const cached = data.bot.fl.get(user_id)
    data.sender = {
      ...cached,
      ...event.sender,
      user_id,
      nickname: event.user_name === event.sender.user_id ? cached?.nickname || event.user_name : event.user_name,
    }
    data.target_id = user_id
    data.nickname = data.sender.nickname
    log("info", `好友消息：[${data.user_id}] ${data.raw_message}`, data.self_id)

    data.reply = (msg, quote, extra) =>
      this.sendFriendMsg(
        {
          ...data,
          user_id: event.sender.user_id,
          replyExtra: extra,
        },
        msg,
      )
    await this.setFriendMap(data)
  }

  async makeGroupMessage(data, event) {
    const user_id = `${data.self_id}${this.sep}${event.sender.user_id}`
    data.group_id = `${data.self_id}${this.sep}${event.group_id}`
    const cachedSender = data.bot.gml.get(data.group_id)?.get(user_id) || data.bot.fl.get(user_id)
    data.sender = {
      ...cachedSender,
      ...event.sender,
      user_id,
      nickname: event.user_name === event.sender.user_id ? cachedSender?.nickname || event.user_name : event.user_name,
    }
    const cached = data.bot.gl.get(data.group_id)
    data.group_name = event.group_name || cached?.group_name || cached?.name || event.group_id
    data.nickname = data.sender.nickname
    log(
      "info",
      `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = (msg, quote, extra) =>
      this.sendGroupMsg(
        {
          ...data,
          group_id: event.group_id,
          replyExtra: extra,
        },
        msg,
      )
    await this.setGroupMap(data)
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
    log(
      "info",
      `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )

    data.reply = (msg, quote, extra) =>
      this.sendDirectMsg(
        {
          ...data,
          user_id: event.user_id,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
          replyExtra: extra,
        },
        msg,
      )
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
    log(
      "info",
      `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`,
      data.self_id,
    )
    data.reply = (msg, quote, extra) =>
      this.sendGuildMsg(
        {
          ...data,
          guild_id: event.guild_id,
          channel_id: event.channel_id,
          replyExtra: extra,
        },
        msg,
      )
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
      ...(data.group_name ? { group_name: data.group_name, name: data.group_name } : {}),
      time: data.time,
      message_id: data.message_id,
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      ...data.sender,
    })
  }

  async makeMessage(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      message_type: event.message_type,
      sub_type: event.sub_type,
      message_id: event.message_id,
      source: event.source,
      time: Math.trunc(event.timestamp),
      get user_id() {
        return this.sender.user_id
      },
      message: (event.message || []).map(item => ({ ...item })),
      message_format: "array",
      raw_message: event.raw_message,
      /** 是否群里 @ 了机器人（1.3.0 用事件名区分，message_type 都是 group） */
      _at: isAtSelf(event),
    }

    for (const i of data.message)
      switch (i.type) {
        case "at":
          if (i.qq === "all" || i.user_id === "all") i.qq = "all"
          else if (i.is_you === true || i.is_you === "true") i.qq = data.self_id
          else if (data.message_type === "group" || data.sub_type === "friend")
            i.qq = `${data.self_id}${this.sep}${i.user_id || i.qq}`
          else i.qq = `qg_${i.user_id}`
          break
      }

    // GROUP_AT_MESSAGE_CREATE 有时不含机器人占位符，事件名仍能证明该次 @。
    if (data.message_type === "group" && data._at && !data.message.some(item => item.type === "at" && String(item.qq) === String(id))) {
      const name = data.bot.nickname || data.bot.info?.username || String(id)
      const index = data.message[0]?.type === "reply" ? 1 : 0
      data.message.splice(index, 0, { type: "at", qq: id, user_id: String(id), is_you: true, text: `@${name}` })
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
        log("warn", ["未知消息", event], id)
        return
    }

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
        if (Bot[id].callback[data.user_id]) return event.reply(3)
        Bot[id].callback[data.user_id] = true

        let msg = `请先发送 #QQBot绑定用户${data.user_id}`
        const real_id = callback.message.replace(/^#[Qq]+[Bb]ot绑定用户确认/, "").trim()
        if (this.bind_user[real_id] === data.user_id) {
          await Bot[id].fl.set(data.user_id, {
            ...Bot[id].fl.get(data.user_id),
            real_id,
          })
          msg = `绑定成功 ${data.user_id} → ${real_id}`
        }

        event.reply(0)
        return data.group.sendMsg(msg)
      }
      log(
        "info",
        [
          `群按钮点击事件：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})]`,
          data.raw_message,
        ],
        data.self_id,
      )
    } else {
      await Bot[id].fl.set(data.user_id, {
        ...Bot[id].fl.get(data.user_id),
        real_id: callback.user_id,
      })
      data.friend = data.bot.pickFriend(callback.user_id)
      data.sender = {
        ...((await data.friend.getInfo()) || data.friend),
      }
      log(
        "info",
        [`好友按钮点击事件：[${data.sender.nickname}(${data.user_id})]`, data.raw_message],
        data.self_id,
      )
    }

    event.reply(0)
    dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeCallback(id, event) {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        const result = await reply(...args)
        if (result === false) {
          log(
            "error",
            ["回复按钮点击事件失败", {
              notice_id: event.notice_id,
              group_id: event.group_id,
              operator_id: event.operator_id,
              code: args[0],
            }],
            id,
          )
        }
        return result
      } catch (err) {
        log(
          "error",
          ["回复按钮点击事件错误", {
            notice_id: event.notice_id,
            group_id: event.group_id,
            operator_id: event.operator_id,
            message: err?.message || String(err),
          }],
          id,
        )
      }
    }

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

    const callback = data.bot.callback[event.data?.resolved?.button_id]
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
      if (event.data?.resolved?.button_id) {
        data.message.push({ type: "reply", id: event.data?.resolved?.button_id })
        data.raw_message += `[回复：${event.data?.resolved?.button_id}]`
      }
      if (event.data?.resolved?.button_data) {
        data.message.push({ type: "text", text: event.data?.resolved?.button_data })
        data.raw_message += event.data?.resolved?.button_data
      } else {
        event.reply(1)
      }
    }
    event.reply(0)

    switch (data.message_type) {
      case "friend":
        data.message_type = "private"
        log("info", [`好友按钮点击事件：[${data.user_id}]`, data.raw_message], data.self_id)

        data.reply = (msg, quote, extra) =>
          this.sendFriendMsg({ ...data, user_id: event.operator_id, replyExtra: extra }, msg)
        await this.setFriendMap(data)
        break
      case "group":
        data.group_id = `${id}${this.sep}${event.group_id}`
        log(
          "info",
          [`群按钮点击事件：[${data.group_id}, ${data.user_id}]`, data.raw_message],
          data.self_id,
        )

        data.reply = (msg, quote, extra) =>
          this.sendGroupMsg({ ...data, group_id: event.group_id, replyExtra: extra }, msg)
        await this.setGroupMap(data)
        break
      case "guild":
        break
      default:
        log("warn", ["未知按钮点击事件", event], data.self_id)
    }

    dispatch(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  async makeNotice(id, event) {
    if (event.sub_type === "action") return this.makeCallback(id, event)
    const bot = Bot[id]
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
      time: event.time ?? unixTime(event.apply_at) ?? Math.floor(Date.now() / 1000),
      operator_id: event.operator_id === undefined ? undefined : `${id}${this.sep}${event.operator_id}`,
    }
    if (event.user_id !== undefined) data.user_id = `${id}${this.sep}${event.user_id}`
    if (event.group_id !== undefined) {
      data.group_id = `${id}${this.sep}${event.group_id}`
      data.group_name = bot.gl.get(data.group_id)?.group_name || event.group_id
    }

    if (event.notice_type === "friend") {
      const key = mapKey(bot.fl, event.user_id, id, this.sep)
      if (event.sub_type === "decrease") await bot.fl.delete(key)
      else await bot.fl.set(key, {
        ...bot.fl.get(key), user_id: data.user_id,
        ...(event.sub_type.startsWith("receive_") ? { receive_msg: event.sub_type === "receive_open" } : {}),
      })
    } else if (event.notice_type === "group" && event.group_id) {
      const groupKey = mapKey(bot.gl, event.group_id, id, this.sep)
      const memberKey = mapKey(bot.gml, event.group_id, id, this.sep)
      if (event.sub_type === "join_request") {
        data.post_type = "request"
        data.request_type = "group"
        data.notice_type = undefined
        data.sub_type = "add"
        data.flag = event.join_request_id
        data.comment = typeof event.verify_info === "string" ? event.verify_info : event.verify_info?.verify_message || ""
        data.approve = (yes = true, reason = "", block = false) => bot.sdk.approveGroupJoinRequest(event.group_id, event.user_id, {
          op: yes ? "approve" : "decline", join_request_id: event.join_request_id,
          ...(!yes ? { reject_reason: reason, add_to_member_blacklist: Boolean(block) } : {}),
        })
      } else if (event.sub_type.startsWith("member.")) {
        data.sub_type = event.sub_type.slice("member.".length)
        let members = bot.gml.get(memberKey)
        if (!members) { members = new Map(); await bot.gml.set(memberKey, members) }
        const userKey = mapKey(members, event.user_id, id, this.sep)
        data.sender = members.get(userKey)
        if (event.sub_type === "member.decrease") await members.delete(userKey)
        else await members.set(userKey, {
          ...memberInfo({
            ...members.get(userKey),
            ...(event.username ? { nickname: event.username } : {}),
            ...(event.member_role ? { member_role: event.member_role } : {}),
            ...(event.is_bot !== undefined ? { bot: event.is_bot } : {}),
          }, event.user_id, event.group_id), user_id: data.user_id,
        })
      } else if (event.sub_type === "increase" || event.sub_type === "decrease") {
        // 机器人进退群的 user_id 指机器人；操作人独立放在 operator_id。
        data.user_id = `${id}${this.sep}${id}`
        if (event.sub_type === "decrease") { await bot.gl.delete(groupKey); await bot.gml.delete(memberKey) }
        else await bot.gl.set(groupKey, { ...bot.gl.get(groupKey), group_id: data.group_id, group_name: data.group_name })
      } else if (event.sub_type.startsWith("receive_")) {
        await bot.gl.set(groupKey, { ...bot.gl.get(groupKey), group_id: data.group_id, receive_msg: event.sub_type === "receive_open" })
      }
    }
    return dispatch(`${data.post_type}.${data.request_type || data.notice_type}.${data.sub_type}`, data)
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
