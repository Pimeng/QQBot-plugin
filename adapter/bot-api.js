import MessageSender from "./message/sender.js"
import imageSize from "image-size"
import { fileToUrl, fileToUrlInfo, toBuffer } from "../lib/utils/common.js"

export default class BotApi extends MessageSender {
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
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
    }
    return {
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
      getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`,
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
    else if (user_id.startsWith("qg_")) return this.pickGuildMember(id, group_id, user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(`${id}${this.sep}`, ""),
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    else if (group_id.startsWith("qg_")) return this.pickGuild(id, group_id)
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id: group_id.replace(`${id}${this.sep}`, ""),
    }
    return {
      ...i,
      /** pickGroup(...).sendMsg 是主动推送，不是回复（不拿群里最后一条消息当引用） */
      sendMsg: msg => this.sendGroupMsg(i, msg, true),
      sendFile: (file, name) =>
        this.sendGroupMsg(i, { type: "file", file, ...(name ? { name } : {}) }, true),
      uploadImage: (file, opts) => this.uploadImage(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      fileToUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      filetoUrl: (file, opts) => this.fileToUrl(id, file, { ...opts, targetType: "group", targetId: i.group_id }),
      recallMsg: message_id => this.recallGroupMsg(i, message_id),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
    }
  }

  pickGuildFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...i,
      /** pickGuildFriend(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
    }
  }

  pickGuildMember(id, group_id, user_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      src_guild_id: guild_id[0],
      src_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...this.pickGuildFriend(id, user_id),
      ...i,
      sendMsg: msg => this.sendDirectMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
    }
  }

  pickGuild(id, group_id) {
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
    }
    return {
      ...i,
      /** pickGuild(...).sendMsg 是主动推送，不是回复 */
      sendMsg: msg => this.sendGuildMsg({ ...i, active: true }, msg),
      recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
      makeForwardMsg: nodes => this.makeForwardMsg(nodes),
      pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
      getMemberMap: () => i.bot.gml.get(group_id),
    }
  }


}
