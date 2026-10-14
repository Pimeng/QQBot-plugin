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
- `adapter/events.js` 负责将消息、按钮交互和通知转换为 Yunzai 事件，并维护好友、群和成员缓存。
- `adapter/sdk.js` 封装 `qq-official-bot@1.3.0` 的接口差异，包括 WebSocket 模式、沙箱地址、事件与消息段转换，以及媒体分片上传处理。
- `lib/` 提供账号、配置、Bot 代理、事件构造与通用工具。
- `config/defSet/cfg.yaml` 是随插件发布的默认配置；实际配置位于 `config/config/cfg.yaml`。首次启动时会复制默认配置，之后该文件的外部改动会热加载。

适配器通过 Yunzai 的全局 `Bot`、`logger`、`segment` 等运行环境工作。收到的消息、通知和申请会构造成 Yunzai 事件，按根事件、场景、子类型逐层投递，例如 `message` → `message.group` → `message.group.normal`。监听器检测同时兼容 Node EventEmitter 的 listenerCount 与 ICQQ TripTrap 的 listeners，不要求存在 listenerCount。若没有根事件监听器，则直接交给插件加载器处理。事件标记 `adapter = "QQBot"`，用户和群 ID 会去除平台实例前缀。

SDK 收到网关包时会以 `debug` 级别输出完整数据：WebSocket 记录收到的原始帧，WebHook 记录进入 SDK 的事件包；不识别的事件类型也会记录。

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

文件同时提供 `e.file`。官方未提供真实文件 ID 时，`fid` 使用该附件 URL 作为当前消息的下载句柄；不生成虚构的 `file_id`。插件可通过 `await e.group.getFileUrl(e.file.fid)` 或 `await e.friend.getFileUrl(e.file.fid)` 读取当前消息附件地址，也可直接使用消息段的 `url`。该句柄只用于当前事件，不能传给 NapCat 的文件 API；URL 有效期由 QQ 平台决定，缺少下载地址时会报错。

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

群主的 `member.is_admin` 与 icqq 一样为 `true`，`is_owner` 可独立判断群主；群对象的管理状态来自机器人自身的官方群角色。成员进退群、机器人进退群、好友增减和接收开关都会投递通知并更新相应缓存。成员通知需要订阅 `GROUP_MEMBER`；入群申请映射为 `request.group.add`，保留实际申请 `flag` 并提供 `approve(yes, reason, block)`。

消息事件提供 `isGroup / isPrivate / isGuild`、`atme / atall`、私聊 `from_id / to_id`、`toString()` 和 `toJSON()`；JSON 不包含 SDK、Bot 和场景对象。`reply()` 第三个参数通过异步调用上下文透传，并发回复不会串用键盘或 Markdown 参数。

发送成功返回单个字符串 `message_id`，全部拆分消息 ID 在 `message_ids` 中，`data` 保留原始回执。`time` 使用平台回执时间，没有时间时使用发送完成时间；官方没有提供的 `seq / rand` 不生成。全部失败时 Promise 拒绝；部分成功时返回 `partial: true`、已发送的 ID 和 `error`，停止重发已发送部分。成功降级后的历史错误放入 `retry_errors`，`error` 为空。面板聊天同时兼容旧数组回执和上述新回执。

事件场景会关联本次回复拆分出的 ID，宿主按主 `message_id` 执行自动撤回时，会撤回同次回复的全部消息并返回 `boolean`；关联只保留在原事件场景内，最多 32 次拆分回复，不跨事件或账号合并撤回目标。

固定的 SDK 1.3.0 尚未实现群成员查询，适配层按 [SDK 上游 GroupService](https://github.com/zhinjs/qq-official-bot/blob/master/src/services/group.ts) 的 `/members` 接口补齐分页与详情请求。群资料、成员查询、禁言和审批能否成功仍取决于机器人已开通的官方权限。这里只兼容可实现的接口：历史消息查询、icqq 二进制序列化、戳一戳、群名片与管理员设置、真实群文件目录和原生合并转发没有对应实现；手动引用不等于官方被动回复上下文。频道保持 `qg_` 路由和本地资料接口，不把频道标识送入群 OpenID 查询。

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
