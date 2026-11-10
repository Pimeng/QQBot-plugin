import { randomInt } from "node:crypto"
import { config } from "../../lib/utils/cfg.js"
import { isActiveMsgDenied, isPassiveReplyLimit } from "../../lib/utils/message.js"
import { uploadBotFile } from "../../lib/utils/file-upload.js"
import { qblog } from "../../lib/utils/logger.js"
import MarkdownBuilder from "../markdown.js"

const mediaTypes = new Set(["image", "video", "audio", "file"])

function isMedia(segment) {
  return mediaTypes.has(segment?.type)
}

export default class MessageTransport extends MarkdownBuilder {
  /**
   * 普通消息（非 Markdown）的图文顺序
   *
   * config.plainImageOrder 可以是字符串，也可以是
   * { default, [机器人标识], "机器人标识:群OpenID" }；群级 > 账号级 > default。
   * 非法值按 auto 处理。仅影响普通富媒体消息，Markdown 消息不受影响。
   */
  plainImageOrder(data) {
    const setting = config.plainImageOrder
    let mode
    if (typeof setting === "string") mode = setting
    else if (setting && typeof setting === "object") {
      const selfId = String(data?.self_id ?? "")
      const prefix = `${selfId}${this.sep ?? ":"}`
      const rawGroup = String(data?.group_id ?? "")
      const groupId = rawGroup.startsWith(prefix) ? rawGroup.slice(prefix.length) : rawGroup
      const groupKey = groupId ? `${selfId}:${groupId}` : ""
      mode = (groupKey && setting[groupKey]) || setting[selfId] || setting.default
    }
    return ["auto", "text-first", "image-first"].includes(mode) ? mode : "auto"
  }

  mediaTarget(data) {
    const target = data._mediaTarget
    if (target?.target_type && target.target_id) return target

    const type = data.raw?.message_type
    if (type === "group" && data.group_id) return { target_type: "group", target_id: data.group_id }
    if (type === "private" && data.sub_type === "friend" && data.user_id)
      return { target_type: "user", target_id: data.user_id }
    return null
  }

  /**
   * 上传富媒体，拿到 file_info（srv_send_msg: false，只上传不发送）
   *
   * 拆开发送的第一步：先把媒体都传上去，这样后面每条媒体都能作为被动回复
   * （带 msg_id）单独发，不占用主动消息频次。
   */
  async uploadFileInfo(data, elem, target) {
    const fileType = { image: 1, video: 2, audio: 3, file: 4 }[elem.type]
    if (!fileType) return null
    const file = elem.file ?? elem.url
    const url = [elem.url, file].find(value => typeof value === "string" && /^https?:\/\//i.test(value))
    let fileName = elem.name || elem.file_name || elem.filename
    if (!fileName && url)
      try {
        fileName = decodeURIComponent(new URL(url).pathname.split("/").pop()) || "file.bin"
      } catch {
        fileName = "file.bin"
      }

    try {
      const info = await uploadBotFile(data.bot, url || file, {
        fileType,
        fileName,
        targetType: target.target_type,
        targetId: target.target_id,
      })
      qblog.debug(`[${data.self_id}] 富媒体上传完成`, target, info)
      return info
    } catch (err) {
      qblog.error(`[${data.self_id}] 富媒体上传失败`, elem.type, err)
      if (elem.type === "file") throw err
      return null
    }
  }

  /** 单独发一条富媒体消息（msg_type 7），带引用时走被动回复 */
  async sendFileInfoMessage(data, target, info, reply, content = "") {
    const payload = {
      msg_type: 7,
      media: { file_info: info.file_info },
      msg_seq: randomInt(1, 1000000),
    }
    if (content) payload.content = content
    const eventId =
      reply?.event_id ||
      (typeof reply?.id === "string" && reply.id.startsWith("event_") ? reply.id : undefined)
    if (eventId) payload.event_id = String(eventId).replace(/^event_/, "")
    else if (reply?.id) payload.msg_id = String(reply.id)

    const { data: ret } = await data.bot.sdk.request.post(
      `/v2/${target.target_type}s/${target.target_id}/messages`,
      payload,
    )
    qblog.debug(`[${data.self_id}] 富媒体消息已发送`, target, ret)
    return ret
  }

  /**
   * 群和单聊先上传全部媒体，再用 msg_type 7 发送，避开 SDK 分片上传的 850019 错误。
   * 纯文本合入第一条媒体的 caption；不支持的消息段或被拒绝的 caption 再单独发送。
   * 每条媒体沿用同一个引用，用不同 msg_seq 区分；部分成功后由上层阻止整批重试。
   */
  async sendBatch(data, batch, send) {
    const media = batch.filter(isMedia)
    if (!media.length) return await send(batch)

    const target = this.mediaTarget(data)
    if (!target) return await send(batch)

    const order = this.plainImageOrder(data)
    const others = batch.filter(s => !isMedia(s))
    const reply = others.find(s => s?.type === "reply")

    const infos = []
    for (const elem of media) {
      const info = await this.uploadFileInfo(data, elem, target)
      if (!info?.file_info) {
        if (media.some(item => item?.type === "file"))
          throw new Error("包含文件的消息富媒体上传未返回 file_info")
        if (order === "text-first")
          qblog.warn(`[${data.self_id}] 富媒体上传失败，无法拆分文字在前，改为合并发送`)
        return await send(batch)
      }
      infos.push(info)
    }

    const contentSegs = others.filter(s => s?.type !== "reply")
    /** 只有全是文本段才能并进 caption（SDK 拼 content 时也是把文本首尾直接相接，这里保持一致） */
    const textOnly = contentSegs.length > 0 && contentSegs.every(s => typeof s?.text === "string")
    const caption = textOnly ? contentSegs.map(s => s.text).join("") : ""

    /** 群聊同一 msg_id 最多 5 次被动回复，单聊为 4 次；文字占 1 条，其余留给媒体 */
    const replyLimit = data.message_type === "group" ? 5 : 4
    const configuredMaxMedia = Number(config.plainImageOrderMaxMedia)
    const maxMedia = Number.isFinite(configuredMaxMedia) && configuredMaxMedia > 0
      ? Math.min(configuredMaxMedia, replyLimit - 1)
      : replyLimit - 1
    /**
     * 文字在前：普通消息没有“一条内文字在上”的能力，只能先发文本、再逐条发媒体。
     * 只在被动回复下拆，避免主动消息消耗双倍配额；媒体过多会超过同一条 msg_id
     * 的被动回复上限（群聊 5 条、单聊 4 条），超过时退回 caption（图片在前）。
     */
    const textFirst =
      order === "text-first" &&
      textOnly &&
      contentSegs.some(s => String(s.text).trim()) &&
      this.useReply(data) &&
      infos.length <= maxMedia

    if (textFirst) {
      const rets = []
      try {
        rets.push(
          await send([
            ...(reply ? [reply] : []),
            ...contentSegs.map(({ _atText, ...segment }) => segment),
          ]),
        )
        for (const info of infos)
          rets.push(await this.sendFileInfoMessage(data, target, info, reply, ""))
      } catch (err) {
        if (rets.length) {
          const error = err instanceof Error ? err : new Error(String(err))
          error.qqbotSent = rets
          throw error
        }
        throw err
      }
      return rets.length === 1 ? rets[0] : rets
    }

    const rets = []
    try {
      let captionSent = false
      if (caption) {
        try {
          rets.push(await this.sendFileInfoMessage(data, target, infos[0], reply, caption))
          captionSent = true
        } catch (err) {
          /** 回复超时/无主动权限这类错误交给 sendMsg 的降级逻辑处理，不要在这里吞掉 */
          if (isPassiveReplyLimit(err) || isActiveMsgDenied(err)) throw err
          qblog.warn(`[${data.self_id}] 图文合成一条发送失败，改为拆开发送`, err)
        }
      }

      for (const info of captionSent ? infos.slice(1) : infos)
        rets.push(await this.sendFileInfoMessage(data, target, info, reply, ""))
      if (!captionSent && contentSegs.length)
        rets.push(await send(others.map(({ _atText, ...segment }) => segment)))
    } catch (err) {
      if (rets.length) {
        const error = err instanceof Error ? err : new Error(String(err))
        error.qqbotSent = rets
        throw error
      }
      throw err
    }
    return rets.length === 1 ? rets[0] : rets
  }
}
