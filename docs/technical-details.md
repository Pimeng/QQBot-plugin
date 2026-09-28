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
- `adapter/events.js` 负责将消息、按钮交互和通知转换为 Yunzai 事件，并维护好友、群和成员缓存。
- `adapter/sdk.js` 封装 `qq-official-bot@1.3.0` 的接口差异，包括 WebSocket 模式、沙箱地址、事件与消息段转换，以及媒体分片上传处理。
- `lib/` 提供账号、配置、Bot 代理、事件构造与通用工具。
- `config/defSet/cfg.yaml` 是随插件发布的默认配置；实际配置位于 `config/config/cfg.yaml`。首次启动时会复制默认配置，之后该文件的外部改动会热加载。

适配器通过 Yunzai 的全局 `Bot`、`logger`、`segment` 等运行环境工作。收到的消息会构造成 Yunzai 事件并通过 `Bot.emit("message", event)` 投递；若没有消息事件监听器，则直接交给插件加载器处理。事件标记 `adapter = "QQBot"`，消息 ID 会去除平台实例前缀。

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

## 消息发送

### 回复与主动消息

事件中的 `e.reply()` 以及事件关联的群/好友发送方法会作为回复发送，并尽可能携带触发消息 ID。通过 `Bot.pickGroup()`、`Bot.pickFriend()` 等对象主动发送的消息不引用触发事件，通常需要机器人具备主动消息权限。

`activeMsg` 控制引用策略：

| 值 | 行为 |
| --- | --- |
| `auto` | 优先引用；平台以 `40034128` 拒绝时临时改用主动消息，之后自动恢复 |
| `true` | 始终发送主动消息，不附带引用 |
| `false` | 始终按引用回复，失败时不切换 |

`40034105` 表示主动消息权限或配额不足。主动发送失败时，检查机器人权限，并优先使用事件回复。

### 发送模式与 Markdown

`sendMode` 支持 `auto`、`markdown`、`text`，可为默认值和单个机器人分别设置：

```yaml
sendMode:
  default: auto
  "3889013403": markdown
```

- `auto`：只有消息显式包含 Markdown 或按钮时使用 Markdown，其余走普通消息。
- `markdown`：所有消息均走 Markdown 构建流程。
- `text`：始终使用普通消息，不保留 Markdown 排版。

普通 Markdown 文本会按配置转义语法字符，以避免颜文字被解析为格式；`escapeMarkdown: false` 可关闭转义。QQ 的真 @ 标签需要 Markdown 消息，普通文本无法提供可点击的 @，因此会显示为可读昵称。入站事件会通过 `atBot` 标记机器人被提及，不需要在消息段里额外注入机器人自己的 @。

回调按钮依赖 `INTERACTION` intent 和开放平台的按钮交互能力；指令按钮使用 `action.type: 2`，点击后会发送一条消息。适配器支持 QQ Markdown 标签和键盘数据透传。

### 图片与其他媒体

群聊和 C2C 私聊的普通消息可通过官方富媒体接口上传本地图片、音频、视频和文件，不要求配置公网地址；文件以原生文件卡片发送。适配器会补充 Yunzai 当前没有的 `segment.file(file, name)` 构造器，也可直接传 `{ type: "file", file, name }`；QQ 群和好友私聊事件中的 `e.group.sendFile(file, name)` / `e.friend.sendFile(file, name)` 会引用当前事件被动发送文件，直接通过 `Bot.pickGroup()` / `Bot.pickFriend()` 获取的对象则按主动消息发送。收到的文件附件会归一为标准 `file` 段。频道不支持原生文件消息。Markdown 内嵌图片需要 QQ 服务端可访问的公网 URL，因此必须同时配置 `url` 和 `webhookPort`，并正确设置反向代理。`imageLength` 是图片压缩阈值；未安装 `sharp` 时压缩会自动关闭。

带图片的普通消息会尽量将文字与首张媒体合并发送；如果内容包含无法合并的段或平台拒绝 caption，则会拆分发送。Markdown 图片使用公网文件直链。没有公网地址时，适配器会改用普通媒体消息，而不会把 base64 或空值拼成 Markdown 链接。

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
- **Markdown 图片不可见**：确认 `url` 是公网 HTTPS 地址、`webhookPort` 已启用，且反向代理可访问 `/QQBot/File/`。
