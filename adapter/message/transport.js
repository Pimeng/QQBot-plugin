import { randomInt } from "node:crypto"
import { isActiveMsgDenied, isPassiveReplyLimit, log } from "../../lib/utils/common.js"
import MarkdownBuilder from "../markdown.js"

export default class MessageTransport extends MarkdownBuilder {
  mediaTarget(data) {
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
    const fileType = { image: 1, video: 2, audio: 3 }[elem.type]
    if (!fileType) return null
    try {
      const info = await data.bot.sdk.fileProcessor.uploadForMessage(
        { file_type: fileType, file: elem.file, file_name: elem.name || elem.file_name },
        { targetType: target.target_type, targetId: target.target_id, sendMessage: false },
      )
      log("debug", ["富媒体上传完成", target, info], data.self_id)
      return info
    } catch (err) {
      log("error", ["富媒体上传失败", elem.type, err], data.self_id)
      return null
    }
  }

  /** 单独发一条富媒体消息（msg_type 7），带引用时走被动回复；content 作为图片下方文字 */
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
    log("debug", ["富媒体消息已发送", target, ret], data.self_id)
    return ret
  }

  /**
   * 发送一批消息
   *
   * 带媒体时不再走 SDK 的「富媒体 + caption 合成一条」（SDK 的分片上传有 850019 的坑），
   * 而是自己上传后按 `msg_type 7` 直发：
   *   1. 先把媒体全部上传（任一失败就整体回退给 SDK，避免发出半条）
   *   2. 非媒体内容并进**第一条**媒体的 `content`（QQ 里就是图片下面那行字），图文合成一条
   *   3. 每条媒体都带同一个引用（同一 msg_id、不同 msg_seq），走被动回复，不占主动频次
   *
   * 两种例外仍然拆开发送：
   *   - 非媒体部分里有无法塞进 `content` 的段（markdown / keyboard / ark 等）；
   *   - caption 被平台拒绝（例如超长）时退回「媒体一条 + 文字一条」，不让整条消息发不出去。
   */
  async sendBatch(data, batch, send) {
    const isMedia = s => ["image", "video", "audio"].includes(s?.type)
    const media = batch.filter(isMedia)
    if (!media.length) return await send(batch)

    const target = this.mediaTarget(data)
    if (!target) return await send(batch)

    const others = batch.filter(s => !isMedia(s))
    const reply = others.find(s => s?.type === "reply")

    const infos = []
    for (const elem of media) {
      const info = await this.uploadFileInfo(data, elem, target)
      if (!info?.file_info) return await send(batch)
      infos.push(info)
    }

    const contentSegs = others.filter(s => s?.type !== "reply")
    /** 只有全是文本段才能并进 caption（SDK 拼 content 时也是把文本首尾直接相接，这里保持一致） */
    const textOnly = contentSegs.length > 0 && contentSegs.every(s => typeof s?.text === "string")
    const caption = textOnly ? contentSegs.map(s => s.text).join("") : ""

    const rets = []
    const post = async (i, content) =>
      rets.push(await this.sendFileInfoMessage(data, target, infos[i], reply, content))
    const strip = list => list.map(({ _atText, ...rest }) => rest)

    let inline = !!caption
    if (inline)
      try {
        await post(0, caption)
      } catch (err) {
        /** 回复超时/无主动权限这类错误交给 sendMsg 的降级逻辑处理，不要在这里吞掉 */
        if (isPassiveReplyLimit(err) || isActiveMsgDenied(err)) throw err
        inline = false
        log("warn", ["图文合成一条发送失败，改为拆开发送", err], data.self_id)
      }

    if (inline) {
      for (let i = 1; i < infos.length; i++) await post(i, "")
    } else {
      for (let i = 0; i < infos.length; i++) await post(i, "")
      if (contentSegs.length) rets.push(await send(strip(others)))
    }
    return rets.length === 1 ? rets[0] : rets
  }

  /**
   * 检查待发送的消息里有没有「回调按钮」（action.type=1）
   *
   * 回调按钮依赖 INTERACTION intent：没申请/没开通时点击事件不会推到机器人，
   * 用户点完（有 modal 的话是二次确认之后）客户端只会提示“请求第三方失败”。
   * 这里提前把原因写进日志，免得对着一句客户端提示排查。
   */

}
