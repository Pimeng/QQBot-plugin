# 技术说明

本文记录 QQBot 适配器的配置模型、消息处理方式与常见故障排查。面向需要调试适配器或了解实现边界的维护者；安装和基础使用请先看 [README](../README.md)。

## 运行结构

- `index.js` 注册管理指令插件并调用 `qqbot.init()`；初始化具有幂等性。
- `adapter/index.js` 组装适配器实例并导出单例；功能模块沿继承链组合，保留原有 `qqbot` 实例 API。
- `adapter/lifecycle.js` 负责账号连接、intents 降级协商、重连状态登记与 WebHook 生命周期。
- `adapter/message/builder.js` 负责普通消息段、@ 解析和转发节点；`adapter/message/media.js` 负责语音/图片转换、二维码及按钮构建。
- `adapter/markdown.js` 独立处理 QQ Markdown 模板及标签。
- `adapter/message/sender.js` 负责消息组装、回复策略、重试和交互检查；`adapter/message/transport.js` 负责富媒体上传与批次传输。
- `adapter/bot-api.js` 提供 `pickFriend`、`pickGroup` 等 Bot 对象代理。
- `adapter/compat.js` 集中处理 icqq 的联系人字段、账号标识和发送回执约定。
- `adapter/history.js` 按账号保存实际接收消息，提供会话历史和单条消息查询。
- `adapter/events.js` 负责将消息、按钮交互和通知转换为 Yunzai 事件，并维护好友、群和成员缓存。
- `adapter/sdk.js` 封装 `qq-official-bot@1.3.0` 的接口差异，包括 WebSocket 模式、沙箱地址、事件与消息段转换，以及媒体分片上传处理。
- `adapter/sdk-logger.js` 仅处理 SDK 重复日志过滤和完整网关包输出。
- `lib/` 提供账号、配置、Bot 代理、事件构造与通用工具。
- `config/defSet/cfg.yaml` 是随插件发布的默认配置；实际配置位于 `config/config/cfg.yaml`。首次启动时会复制默认配置，之后该文件的外部改动会热加载。

适配器通过 Yunzai 的全局 `Bot`、`logger`、`segment` 等运行环境工作。收到的消息、通知和申请会构造成 Yunzai 事件，按根事件、场景、子类型逐层投递，例如 `message` → `message.group` → `message.group.normal`。监听器检测同时兼容 Node EventEmitter 的 listenerCount 与 ICQQ TripTrap 的 listeners，不要求存在 listenerCount。若没有根事件监听器，则直接交给插件加载器处理。事件标记 `adapter = "QQBot"`，用户和群 ID 会去除平台实例前缀。

SDK 收到网关包时会以 `debug` 级别输出完整数据：WebSocket 记录收到的原始帧，WebHook 记录进入 SDK 的事件包；不识别的事件类型也会记录。

### 修改代码时从哪里开始

`lib/utils/common.js` 只保留旧导入的兼容出口。插件内部直接从对应模块导入，避免修改一个工具就牵动所有职责：

| 模块 | 职责 |
| --- | --- |
| `logger.js` | 统一日志前缀，调用宿主 logger |
| `message.js` | 消息段、发送模式、错误判断、Markdown 和转发节点工具 |
| `files.js` | 文件读取、格式识别、图片压缩依赖和命令执行 |
| `store.js` | JSON Map 编解码和延迟保存，沿用原数据格式与路径 |
| `webhook.js` | HTTP 回调和静态文件服务 |
| `file-upload.js` | 官方上传、文件直链和回退策略 |
| `events.js` | Yunzai 事件构造、主人判断和事件投递 |

业务日志直接写在处理位置，不另建日志描述表或分发规则：

```js
import { qblog } from "../lib/utils/logger.js"

qblog.info(`[${id}] 账号已连接`)
qblog.error(`[${id}] 消息处理失败`, error)
```

群聊、C2C 与频道共用 `sendWithFallback()` 和 `sendBatches()`；消息构建保持各场景的规则。新增发送策略时修改这条公共流程；一旦部分消息已发出，后续失败保留真实回执，停止整批重发。联系人共用消息查询、媒体上传方法；通知按事件类型进入具体处理方法。

本地回归命令为 `npm test`，测试使用隔离配置和 SDK 桩，不连接实际机器人账号。

## 接收消息规范

群消息与 C2C 私聊沿用 NapCat 给 Yunzai 插件的扁平消息段：`e.message` 是数组，`message_format` 为 `array`；`message_type` 为 `group` 或 `private`，私聊 `sub_type` 为 `friend`，群消息为 `normal`。`time` 使用整数 Unix 秒。

| 官方消息内容 | 插件收到的消息段 |
| --- | --- |
| 普通文字 | `{ type: "text", text }` |
| `<@OpenID>` / `<@!OpenID>` | `{ type: "at", qq: OpenID, text: "@昵称", is_you }`，保留正文顺序与多个 @ |
| 全体成员 @ | `{ type: "at", qq: "all", text: "@全体成员" }` |
| 图片附件 | `{ type: "image", url, file, ... }` |
| 音频附件 | `{ type: "record", url, file, ... }` |
| 视频附件 | `{ type: "video", url, file, ... }` |
| 文件附件及其他 MIME 附件 | `{ type: "file", name, size, file_size, fid, url, file, ... }` |

适配器关闭 SDK 默认的 @ 删除行为；兼容 Unicode 转义和 HTML 转义的 @ 占位符。`GROUP_AT_MESSAGE_CREATE` 即使正文未提供机器人占位符，也会恢复一个机器人 `at` 段并设置 `e.atBot = true`；已有机器人 @ 时不重复添加。`raw_message` 使用 `@昵称`、`[文件]`、`[图片]`、`[语音]` 等可读摘要，下载 URL 保留在消息段内。

文件同时提供 `e.file`。官方未提供真实文件 ID 时，`fid` 使用该附件 URL 作为下载句柄；不生成虚构的 `file_id`。插件可通过 `await e.group.getFileUrl(fid)` 或 `await e.friend.getFileUrl(fid)` 读取当前消息或本会话已接收历史的附件地址，也可直接使用消息段的 `url`。账号独立联系人提供同样查询；不能跨账号、会话取文件，也不能把该句柄传给 NapCat 的文件 API。URL 有效期由 QQ 平台决定，未接收或缺少下载地址时明确报错。

发送者群角色规范为 `sender.role = "owner" | "admin" | "member"`，并提供 `e.member.is_owner` / `is_admin`。昵称缺失时优先使用已有好友缓存，再用 OpenID；群名优先使用事件字段或现有缓存，均不可用时用群 OpenID 兜底。用户和群的 OpenID 沿用原来的账号隔离与去前缀规则，无法由这些事件推导出真实 QQ 号、群号或群名。

## icqq 常用接口兼容

| 调用方式 | 行为 |
| --- | --- |
| `Bot[id].pickGroup(gid)` / `pickFriend(uid)` / `pickMember(gid, uid)` | 同时接受裸 OpenID 和本账号带前缀的 ID，读取本账号缓存 |
| `group.info` / `member.info` / `friend.info` | 返回缓存资料；已取出的场景对象也能读取后续更新的群名、昵称和角色 |
| `getInfo()` / `friend.getSimpleInfo()` | 获取已知资料；好友资料不触发不存在的官方用户查询 |
| `group.renew()` / `member.renew()` / `getInfo(true)` | 显式刷新官方群或成员资料，权限错误向调用方返回 |
| `group.getMemberMap()` / `Bot[id].getGroupMemberList(gid)` | 返回以裸 OpenID 为键的 `Map`，默认只包含已观察或已刷新到的成员 |
| `group.getMemberMap(true)` / `getGroupMemberList(gid, true)` | 拉取完整分页成员；相同群的并发请求合并，重复游标中止，失败不覆盖旧缓存 |
| `Bot[id].getGroupInfo()` / `getGroupMemberInfo()` / `getFriendList()` / `getGroupList()` | 提供常用账号快捷方法；群和成员资料可传 `true` 刷新 |
| `e.group.sendMsg(msg)` / `e.friend.sendMsg(msg)` | 使用该事件自己的被动回复上下文，后续消息不会替换旧事件的回复目标 |
| `Bot[id].sendGroupMsg(gid, msg)` / `sendPrivateMsg(uid, msg)` | 主动发送，与直接获取场景对象后的 `sendMsg()` 一致 |
| `group.sendFile(file, undefined, name)` | 支持 icqq 第三个文件名参数，也保留原来的两参数用法；不支持群文件目录 |
| `e.recall()` / `peer.recallMsg(id)` / `peer.recallMsg(message)` | 撤回单条返回 `boolean`，传 ID 数组或带 `message_ids` 的回执时返回逐条结果 |
| `member.mute(seconds)` / `group.muteMember(uid, seconds)` | 秒数映射官方禁言到期时间，`0` 解禁，失败不更新禁言缓存 |
| `group.getChatHistory(cursor, count)` / `friend.getChatHistory(cursor, count)` | 从实际接收并留档的消息中查询；默认最新 20 条 |
| `Bot[id].getMsg(message_id)` / `peer.getMsg(message_id)` | 返回缓存的规范消息对象，包含可调用的 `reply()`、`recall()` 和场景对象 |
| `Bot[id].getGroupMsgHistory(gid, cursor, count)` / `getFriendMsgHistory(uid, cursor, count)` | 账号级会话历史快捷入口 |
| `Bot[id].getChatHistory(message_id, count)` | 由已缓存消息确定会话，以该消息为分页终点 |
| `Bot[id].on/once/off(...)` | 监听该账号的规范消息、通知和请求；全局 `Bot.on(...)` 仍监听所有账号 |
| `friend.searchSameGroup()` / `member.asFriend()` / `friend.asMember(gid)` | 共同群仅使用本账号观察到的成员缓存，场景转换保留原账号 |
| `e.getReply()` / `e.reply_id` / `e.hasReply` | 用引用的真实消息 ID 读取本会话已收到的消息，后到消息不会改变引用目标；无引用时 `getReply()` 返回 `undefined` |
| `peer.sendMsg(content, source)` | 独立联系人默认主动发送；显式传入可定位的 `source` 时保留该引用，不隐式引用上一条消息 |
| `Bot.sendFriendMsg(botId, uid, content, source)` / `Bot[id].sendFriendMsg(uid, content, source)` | 兼容 phi 等插件的指定账号私聊快捷调用，分别保留全局与账号签名 |

群主的 `member.is_admin` 与 icqq 一样为 `true`，`is_owner` 可独立判断群主；群对象的管理状态来自机器人自身的官方群角色。成员进退群、机器人进退群、好友增减和接收开关都会投递通知并更新相应缓存。成员通知需要订阅 `GROUP_MEMBER`；入群申请映射为 `request.group.add`，保留实际申请 `flag` 并提供 `approve(yes, reason, block)`。

`refreshGroupState` 默认 `true`：收到群消息时按需读取官方机器人角色，五分钟内复用并合并并发请求，再将事件交给插件。这样群管插件在首条消息中读取 `group.is_admin/is_owner` 时可使用真实状态；查询失败不伪造管理员，五分钟后可重试。关闭此设置时可显式调用 `group.getBotState()` 或 `renew()` 刷新。

消息事件提供 `isGroup / isPrivate / isGuild`、`atme / atall`、私聊 `from_id / to_id`、`toString()` 和 `toJSON()`；JSON 不包含 SDK、Bot 和场景对象。`reply()` 第三个参数通过异步调用上下文透传，并发回复不会串用键盘或 Markdown 参数。

发送成功返回单个字符串 `message_id`，全部拆分消息 ID 在 `message_ids` 中，`data` 保留原始回执。`time` 使用平台回执时间，没有时间时使用发送完成时间；官方没有提供的 `seq / rand` 不生成。全部失败时 Promise 拒绝；部分成功时返回 `partial: true`、已发送的 ID 和 `error`，停止重发已发送部分。成功降级后的历史错误放入 `retry_errors`，`error` 为空。面板聊天同时兼容旧数组回执和上述新回执。

事件场景会关联本次回复拆分出的 ID，宿主按主 `message_id` 执行自动撤回时，会撤回同次回复的全部消息并返回 `boolean`；关联只保留在原事件场景内，最多 32 次拆分回复，不跨事件或账号合并撤回目标。

固定的 SDK 1.3.0 尚未实现群成员查询，适配层按 [SDK 上游 GroupService](https://github.com/zhinjs/qq-official-bot/blob/master/src/services/group.ts) 的 `/members` 接口补齐分页与详情请求；新增踢人和黑名单接口按官方群文档桥接。群资料、成员查询、禁言、踢人和审批能否成功仍取决于机器人已开通的官方权限。普通 QQ 群的改名、全员禁言设置、戳一戳、名片、管理员与头衔设置，以及真实群文件目录、原生合并转发读取、OCR 和账号资料修改等没有可用的对应接口；常见方法会明确拒绝调用，不返回伪造成功。频道使用单独的官方接口。

### 官方群管理

| 调用方式 | 行为 |
| --- | --- |
| `group.renew()` / `Bot[id].getGroupInfo(gid, true)` | 获取群名称、简介、分类、标签和人数，人数映射为 `member_count` |
| `group.getBotState()` / `Bot[id].getGroupBotState(gid)` | 读取并缓存机器人群角色、OpenID、入群时间及消息接收设置 |
| `group.getMuteSetting()` / `Bot[id].getGroupMuteSetting(gid)` | 查询并同步成员到期时间、机器人 `mute_left` 和群 `all_muted` |
| `member.mute(seconds)` / `group.muteMember(uid, seconds)` / `Bot[id].setGroupBan(gid, uid, seconds)` | 单人禁言，默认 1800 秒；`0` 解禁 |
| `member.unmute()` / `group.unmuteMember(uid)` | 单人解禁别名 |
| `group.muteMembers(members)` / `setMemberMute(members)` / `Bot[id].setGroupMemberMute(gid, members)` | 原始批量禁言参数，单次最多 20 人；`op` 为 `add/update/del` |
| `group.kickMember(uid, reason, block)` / `member.kick(reason, block)` / `Bot[id].setGroupKick(gid, uid, block)` | 使用官方批量移除接口踢单人；官方无理由参数，`reason` 不发送 |
| `group.kickMembers(uids, block)` / `Bot[id].batchRemoveGroupMembers(gid, uids, block)` | 单次移除 1 至 20 人，返回原始结果及拉黑失败名单 |
| `group.getBlacklist({ cursor, limit })` / `Bot[id].getGroupMemberBlacklist(gid, options)` | 按游标读取黑名单，单页最多 100 人，返回原始 `users/next_cursor` |
| `group.updateBlacklist({ op, member_openids })` / `Bot[id].setGroupMemberBlacklist(gid, options)` | 增删黑名单，单次 1 至 20 人，保留 `fail_openids` |
| `group.getJoinRequests(options)` / `approveJoinRequest(uid, options)` | 入群申请查询及审批，账号同名接口为 `getGroupJoinRequests/approveGroupJoinRequest` |

禁言按[官方成员禁言接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html)发送 RFC3339 到期时间，最长 30 天。平台只允许增加或更新普通成员禁言，群主、管理员和机器人不能作为该操作目标。查询到的全员禁言按 `none/always/schedule` 判断，支持绝对时段及北京时间周期规则和跨日；当前官方写接口只接受成员列表，因此不能由 `muteAll()` 设置群级规则。

踢人接入[批量移除接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_batch_remove_members.post.html)。若成员已踢出但加入黑名单失败，单人接口清理成员缓存后抛出带 `partial: true` 和原始 `result` 的错误；批量接口直接返回原始失败名单。黑名单只能给已不在群内的用户加黑，接口权限和成员状态错误由平台返回，失败不伪造缓存更新。

账号另提供 `getGroupJoinApprovalStrategies(options)`、`createGroupJoinApprovalStrategy(options)`、`updateGroupJoinApprovalStrategy(id, options)`、`deleteGroupJoinApprovalStrategy(id)`、`executeGroupJoinApprovalStrategy(id)` 和 `updateGroupJoinApprovalWhitelist(id, options)`，参数遵循[官方自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.post.html)。白名单使用真实 QQ 号字符串，不能换成 OpenID；策略执行是异步提交，接口成功仅表示已提交。

### 全局 Bot 与账号缓存

行为参考 [napcat-adapter](https://github.com/qiannqq/napcat-adapter)。仅 QQBot 在线时，`Bot.uin`、`Bot[Bot.uin]`、`Bot.nickname` 和默认账号方法指向实际连接的账号。原始 icqq 已登录时保留原账号作为默认账号。事件总线始终绑定原始宿主；QQBot 账号另外提供自己的 `on/once/off`。

`Bot.pickGroup/pickFriend/pickMember` 以及全局发送、资料和会话历史方法按缓存归属或实例前缀选账号。只有一个适配器账号在线时，可主动调用尚未缓存的目标；多个账号同时在线时应使用 `Bot[id].pickGroup(gid)`，或传本账号带前缀的 ID。`strict=true` 且目标未知时抛错。

全局 `Bot.gl/fl/gml` 实时聚合各在线账号的缓存，资料带 `uin` 标明所属账号；冲突 ID 可通过实例前缀访问。账号自己的 `fl/gl/gml` 同时接受裸 ID 和带前缀 ID；迭代只显示一份裸 ID，嵌套成员 Map 也保持实时更新。频道的 `qg_` 标识保留，不与同名群 OpenID 混用。

### 接收消息历史

```js
const bot = Bot[e.self_id]
const group = bot.pickGroup(e.group_id)
const latest = await group.getChatHistory(0, 20)
const earlier = await group.getChatHistory(latest[0].message_id, 20)
const message = await bot.getMsg(e.message_id)
await message.reply("回复这条已接收的消息")
```

历史只包括本适配器实际收到的消息，普通群消息和 @ 消息均会留档，不依赖全量消息权限，也不补拉未收到的消息。群聊、C2C、频道和频道私信按账号及会话隔离；重复包按消息 ID 去重。结果按接收顺序从旧到新排列，游标包含自身，下一页如需去重应去掉重复游标消息。`0` 或省略游标表示最新；未知消息 ID 返回空数组，单条消息未缓存时抛错。仅接受平台实际提供的 `seq`，不生成虚构序号；私聊另接受真实接收时间作为截止游标。引用消息应优先调用 `e.getReply()`，它按明确的消息 ID 定位，避免按时间查询漂到同秒的其他消息。

`e.source` 的时间、用户、消息段等信息只有在引用 ID 精确命中本会话接收缓存时才补齐；没有可定位 ID 或消息已过期时，`getReply()` 明确拒绝，不返回最近一条消息充当引用。

`messageCacheSize` 默认 `1000`，限制每个账号所有会话合计保留的消息数，`0` 关闭并清空留档。消息存入 `data/QQBot/<id>/Message.json`，通过现有持久化机制延迟保存；重启后仍可查询。仅保存必要的内容和频道上下文，查询结果与原快照独立，宿主改写消息不会污染留档。按钮生成的模拟消息不进入历史。历史消息回复仍使用原消息 ID，是否超过被动回复有效期由 QQ 平台决定。

### 频道接口

频道群场景为 `qg_频道ID-子频道ID`，频道用户为 `qg_用户ID`。消息和通知保留 `guild_id/channel_id`；频道、子频道和成员变化更新对应缓存，表态、论坛通知保留实际消息、表情和帖子标识。

| 调用方式 | 官方行为 |
| --- | --- |
| `Bot[id].getGuildList()` / `getGuildInfo(guild_id)` / `getChannelList(guild_id)` / `getChannelInfo(channel_id)` | 获取官方资料；列表为官方字段数组 |
| `Bot[id].sendGuildMsg(guild_id, channel_id, msg)` | 主动发送子频道消息 |
| `group.renew()` / `member.renew()` / `getInfo(true)` | 按需刷新频道、子频道或频道成员资料 |
| `group.getMemberMap(true)` / `Bot[id].getGuildMemberList(guild_id, true)` | 完整分页成员 Map，键为 `qg_用户ID`；默认只读观察缓存 |
| `group.setName(name)` | 修改当前子频道名称 |
| `group.muteAll(enable, duration)` | 频道全员禁言；启用时默认 2592000 秒，`false` 解除 |
| `group.muteMember(uid, seconds)` / `member.mute(seconds)` | 对当前频道成员禁言或解禁 |
| `group.kickMember(uid, reason, block)` / `member.kick(reason, block)` | 踢出频道；官方无踢人理由参数，`reason` 不发送 |
| `group.setAdmin(uid, enable)` / `member.setAdmin(enable)` | 增删官方管理员角色 `2` |
| `group.getPins()` / `pinMsg(mid)` / `unpinMsg(mid)` | 查询、设置和取消子频道消息置顶 |
| `group.setAnnounce(mid)` | 将已有消息设为频道公告 |
| `group.addReaction(mid, type, emoji_id)` / `deleteReaction(...)` / `getReactionMembers(...)` | 使用官方表情类型及 ID 操作消息表态 |

频道的全员禁言、成员禁言、踢人和管理员角色作用于整个频道；子频道对象只用来确定所属频道。权限错误向调用方返回，操作失败不改写缓存。`announce(content)`、`setReaction(mid, code, add)` 与官方接口签名不同，保持明确不支持，避免把正文或表情码当成官方标识。频道文件发送及群/C2C 富媒体上传接口不混用。

## 账号与配置

推荐在 `config/config/cfg.yaml` 使用对象列表管理账号：

```yaml
accounts:
  - uin: 114514             # 机器人的QQ号（可选）
    appid: 1919810          # 机器人的 AppID
    secret: your-app-secret # 机器人的 AppSecret
    group: true             # 是否群Bot
    guild: false            # 是否频道私域
    webhook: false          # 是否走 WebHook
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `uin` | 机器人账号标识，可省略；省略时以 `appid` 作为标识 |
| `appid` | QQ 开放平台 AppID |
| `secret` | QQ 开放平台 AppSecret |
| `group` | 是否接收群聊和 C2C 私聊事件，默认 `true` |
| `guild` | 是否接收频道事件，默认 `false` |
| `webhook` | 是否使用 WebHook；默认使用 WebSocket |

也可通过 `#QQBot设置机器人QQ号:AppID:AppSecret` 添加账号。旧格式仍可读：`机器人QQ号:AppID:Token:AppSecret[:是否群Bot[:是否频道私域]]`；其中旧 Token 字段会被忽略。重复添加同一个机器人会移除该账号。

配置保存有短暂防抖；使用指令修改后稍等几秒，再检查配置文件。

## Intents 与连接

`intents: []` 表示根据账号类型自动申请事件权限。群聊账号默认申请 `GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE` 和 `INTERACTION`；频道事件不会默认开启。只申请频道事件时，配置 `group: false` 和 `guild: true`。

需要手动覆盖时，在 `intents` 中填写完整列表，例如：

```yaml
intents:
  - GROUP_AT_MESSAGE_CREATE
  - C2C_MESSAGE_CREATE
  - INTERACTION
  - GUILDS
  - GUILD_MESSAGES
```

频道、按钮交互、成员信息和消息审核等事件可能需要在 QQ 开放平台单独开通权限。遇到 `4014` 或 `4013` 时，适配器会逐步移除可选 intents 并重连；全部尝试失败后才报告连接失败。可用 `bot.maxRetry`、`bot.connectTimeout` 和 `bot.retryDelay` 调整重试次数、握手超时和递增等待间隔。

## WebSocket 与 WebHook

WebSocket 是默认连接方式。若账号设置 `webhook: true`，还需要配置监听端口和公网基础地址：

```yaml
webhookPort: 8080
url: "https://bot.example.com"
```

在 QQ 开放平台将回调地址设置为 `https://bot.example.com/QQBot`，并将公网 HTTPS 请求反向代理到插件监听端口。端口为 `0` 时 WebHook 服务不会启动。内置文件路由使用 `/QQBot/File/<name>`，因此公网直链同样依赖有效的反向代理。

内置 HTTP 服务仅在插件初始化时存在有效 WebHook 账号且端口大于 `0` 时启动；无账号或仅有 WebSocket 账号时，即使已填写端口和公网地址也不监听。运行中通过配置文件、管理指令或面板新增 WebHook 账号，若 HTTP 服务未启动，会提示重启 Yunzai 后才能接入。路由注册和本地图片直链不会临时启动服务。媒体与 `fileToUrl` 始终优先官方上传，不依赖 HTTP 服务；仅官方不可用且需要本地直链回退时，检查公网地址及监听状态并输出警告。

## 消息发送

### 回复与主动消息

事件中的 `e.reply()` 以及事件关联的群/好友发送方法会作为回复发送，并尽可能携带触发消息 ID。通过 `Bot.pickGroup()`、`Bot.pickFriend()` 等对象主动发送的消息不引用触发事件，通常需要机器人具备主动消息权限。

`activeMsg` 控制引用策略：

| 值 | 行为 |
| --- | --- |
| `auto` | 优先引用；平台以 `40034128` 拒绝时临时改用主动消息，之后自动恢复 |
| `true` | 始终发送主动消息，不附带引用 |
| `false` | 始终按引用回复，失败时不切换 |

需要对单个群覆盖全局策略时，可设置 `activeMsgGroups`，键为机器人 QQ 号与群 OpenID，用冒号连接；`true` 强制主动发送，`false` 强制被动回复。未列出的群仍使用 `activeMsg`：

```yaml
activeMsgGroups:
  "4018856587:群OpenID": true
  "4018856587:另一个群OpenID": false
```

`40034105` 表示主动消息权限或配额不足。主动发送失败时，检查机器人权限，并优先使用事件回复。

### 发送模式与 Markdown

`sendMode` 支持 `auto`、`markdown`、`text`，可为默认值和单个机器人分别设置。EliaAdminPanel 的“发送模式映射”使用 `KeyValue` 控件，以 `default` 或机器人标识为键、下拉选择发送模式；可新增、改名和删除映射，保存仍为下面的键值对象：

```yaml
sendMode:
  default: auto
  "3889013403": markdown
```

- `auto`：只有消息显式包含 Markdown 或按钮时使用 Markdown，其余走普通消息。
- `markdown`：所有消息均走 Markdown 构建流程。
- `text`：始终使用普通消息，不保留 Markdown 排版。

普通 Markdown 文本会按配置转义语法字符，以避免颜文字被解析为格式；`escapeMarkdown: false` 可关闭转义。QQ 的真 @ 标签需要 Markdown 消息，普通文本无法提供可点击的 @，因此会显示为可读昵称。入站事件保留用户实际触发的 @，并通过 `atBot` 标记机器人被提及。

回调按钮依赖 `INTERACTION` intent 和开放平台的按钮交互能力；指令按钮使用 `action.type: 2`，点击后会发送一条消息。适配器支持 QQ Markdown 标签和键盘数据透传。

发送数据与宿主构造器是两个层面。当前 Yunzai 加载器将全局 `segment.button` 设为空函数，且未提供原生 `segment.keyboard/node/reply` 构造器；第三方插件调用这些函数时，不能仅凭适配器接受相应数据类型认定其可用。可使用明确的按钮/键盘对象或宿主已有的 `segment.fake` 转发节点；本适配器保留这些构造器限制，避免改写全局函数影响其他账号适配器。

### 图片与其他媒体

群聊和 C2C 私聊的普通消息可通过官方富媒体接口上传本地图片、音频、视频和文件，不要求配置公网地址；文件以原生文件卡片发送。适配器会补充 Yunzai 当前没有的 `segment.file(file, name)` 构造器，也可直接传 `{ type: "file", file, name }`；QQ 群和好友私聊事件中的 `e.group.sendFile(file, name)` / `e.friend.sendFile(file, name)` 会引用当前事件被动发送文件，直接通过 `Bot.pickGroup()` / `Bot.pickFriend()` 获取的对象则按主动消息发送。收到的文件附件会归一为标准 `file` 段。频道不支持原生文件消息。Markdown 内嵌图片与 `fileToUrl` 优先通过官方分片合并取得 `raw_url`，无需公网端口。公网源文件也先尝试官方直链，不可用时才返回原 URL。官方不可用且需要内置文件服务时，须配置 `url`、`webhookPort` 和有效 WebHook 账号，重启后确保服务运行并正确反向代理。`imageLength` 是图片压缩阈值；未安装 `sharp` 时压缩会自动关闭。

带图片的普通消息会尽量将文字与首张媒体合并发送；如果内容包含无法合并的段或平台拒绝 caption，则会拆分发送。所有媒体优先官方接口；平台 URL 转存失败时先在本机下载后按分片流程重传，仍失败时才尝试文件服务 URL 转存。需要文件服务但公网地址缺失或端口未监听时输出警告。Markdown 无可用直链时改用普通媒体消息，不会把 base64 或空值拼成链接。

账号、`pickGroup()` 与 `pickFriend()` 对象暴露 `uploadImage(file, opts)`、`fileToUrl(file, opts)` 和 `filetoUrl` 别名，支持 Buffer、Uint8Array、ArrayBuffer、本地路径、`file://`、Base64、data URL 和 HTTP(S) URL。群/好友对象自动绑定当前目标；账号级调用可传 `targetType: "group" | "user"` 与 `targetId`，省略时选择已知群或 C2C 好友；没有目标时官方上传不可用，进入直链回退。频道 ID 不会作为群/C2C 上传目标。

`uploadImage` 返回 `{ url, width, height, file_info, file_uuid, ttl, raw_url }`（回退结果只有 URL 和尺寸），无可用直链时抛出错误；`fileToUrl` 返回 URL 或空字符串。依据[官方富媒体文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)，`raw_url` 仅在图片、视频、语音的分片合并路径返回，普通文件类型不返回此字段。`file_info` 原样透传用于发送，不解析为 URL。

上传缓存按 SDK 实例、目标、文件类型、文件名和内容隔离，并合并相同的并发上传；在 `ttl` 到期前失效，`ttl=0` 可长期复用，未知有效期不缓存。预上传提供全文件 MD5/SHA1 和前 10002432 字节的 `md5_10m`；分片默认 5MB，并发和重试参数遵循服务端 `upload_config`，PUT 超时至少 5 秒；兼容 0/1 起始分片序号。无分片的秒传响应使用 `upload_id` 直接合并。所有上传均 `srv_send_msg=false`。历史 `toBotUpload` 配置不再改变官方优先策略，面板已移除该开关。

SDK 的媒体分片上传在平台分片序号从 1 开始时需要归一化偏移；该处理集中在 `adapter/sdk.js`。若媒体上传报 `850019`，可先确认 SDK 版本和该适配层是否加载。

### 转发与 Markdown 段

平台接口不提供与通用机器人框架完全相同的合并转发能力。Markdown 模式会将转发节点转成块引用；普通模式会展开节点为普通消息。嵌套转发、语音、文件和按钮等无法表达的节点内容可能被忽略，过长内容也可能被平台拒绝。

适配器接受 Yunzai 的 Markdown 段和 QQ 原始 Markdown 对象。事件回复支持额外透传键盘等 QQ 扩展参数；支持范围以事件自己的 `reply()` 为准。

## 管理命令

| 命令 | 用途 |
| --- | --- |
| `#QQBot账号` | 查看账号状态 |
| `#QQBot设置` | 添加或移除账号 |
| `#QQBotMD` | 设置 Markdown/按钮/普通消息模式 |
| `#QQBot发送模式` | 查询或设置 `auto`、`markdown`、`text` |
| `#QQBot图片限制` | 设置图片压缩阈值（MB） |
| `#QQBot绑定用户` | 将平台用户绑定到 QQ 号 |

设置类命令受 `permission` 配置控制。账号使用的官方 `user_id` 可能是 OpenID，无法与 QQ 号直接对应时，可使用绑定命令或在 `master` 中添加额外主人。

## 常见问题

- **`4014` / `4013` 握手失败**：检查开放平台已开通的事件权限，避免在 `intents` 中申请未授权项目。频道事件及按钮交互尤其需要确认能力开通情况。
- **持续出现网关频率限制**：检查网络和连接稳定性；`connectTimeout`、`maxRetry`、`retryDelay` 用于限制握手超时与重试节奏。
- **`40034128`**：被动回复超时或超过次数限制；`activeMsg: auto` 会尝试改为主动消息。
- **`40034105`**：主动消息无权限或配额不足；在开放平台检查权限，或使用引用回复。
- **Markdown 拒绝或客户端显示空白**：确认机器人 Markdown 能力及模板/内容合法性；必要时将 `sendMode` 调为 `text` 或 `auto`。
- **收不到群或用户消息**：检查 Yunzai 的 `whiteGroup`、`whiteQQ` 白名单是否包含对应群号或用户标识。
- **Markdown 本地图片直链不可见**：先检查官方分片上传或 `raw_url` 错误。只有官方不可用时才需要核对回退服务的公网 `url`、WebHook 账号、`webhookPort` 和 `/QQBot/File/` 反向代理；端口未监听时会警告并尝试普通富媒体消息。

QQBot 引用事件（类型 103）的原消息内容位于 msg_elements[0]。适配层保留该类型并转换为 reply 段与 source 摘要，正文独立展示；纯引用也显示引用卡片。msg_idx 与 OpenAPI 消息 ID 是不同标识，不凭文本相同猜测跳转对象；缺少可定位消息 ID 时显示摘要并禁用跳转。旧缓存中已经丢失的内容无法恢复，只显示未提供内容提示。
