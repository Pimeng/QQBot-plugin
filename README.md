<div align="center">

# QQBot-Plugin（Miao-Yunzai 适配版）

QQ 开放平台官方机器人适配器 · 已从 TRSS-Yunzai 移植到 Miao-Yunzai / Elia-Yunzai

上游：[TimeRainStarSky/Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)（原作者：时雨🌌星空）

</div>

## 这是什么

上游插件完全基于 TRSS-Yunzai 的 Bot API（`Bot.getMap` / `Bot.makeLog` / `Bot.express` / `Bot.em` / `Bot.uin` 等），
直接放到 Miao-Yunzai 上会报 `Bot.getMap is not a function`，连账号都加不上。

本目录已经改造成 Miao-Yunzai 版本，且**不再有兼容层**（没有 `miao-compat.js`，也不再伪装 TRSS 的 `Bot`）：

- 只依赖 miao 原生设施：全局 `logger`、全局 `Bot`、全局 `segment` / `plugin`、`PluginsLoader.deal(e)`；
  `makeLog` / `String` / `Buffer` / `exec` / `rm` / `sleep` / `getMap` / `fileToUrl` / `express` / `em` / `uin` 全部写成 `lib/utils/common.js` 内的本地函数或原生调用。
- 目录结构对齐 [napcat-adapter](https://github.com/qiannqq/napcat-adapter) / [snowluma-adapter](https://github.com/SnowLuma/SnowLuma)：
  入口 `index.js` 只负责拉起适配器，业务代码分到 `adapter/`（适配器主体 + SDK 层）与 `lib/`（工具 + 指令），配置放在插件目录内。
- 适配器约定对齐 napcat-adapter 与 `plugins/system/stdin.js`：
  `Bot[id].adapter = "QQBot"`（字符串），`Bot.adapter` 是**在线账号 id 数组**（连接成功才登记、断开即摘除），
  yenai 的 `Bot.adapter.includes(e.self_id)`、「快递订阅」等按 uin 判断的插件都能正确识别本适配器账号。
  不向全局注入任何 TRSS 风格的 `Bot.*` 方法，其它 miao 插件（例如会检测 `Bot.makeLog` 的 DF-plugin）行为不变。
- 事件投递同 napcat-adapter：构造好 miao 事件后 `Bot.emit("message", e)`（并 emit `message.<type>`），
  由 miao 的 `lib/events/message.js` 调用 `PluginsLoader.deal(e)`，因此其它 `Bot.on("message")` 的插件也能收到 QQBot 消息；
  没有监听者时（控制台模式等）退回直接 `deal`。事件会剥掉 QQBot 的 `${self_id}:${id}` 前缀，并带 `e.adapter = "QQBot"`。
- WebHook 用内置 `node:http` 服务（miao 没有 express），端口见配置 `webhookPort`。
- 适配器启动由入口 `index.js` 的 `qqbot.init()` 触发（幂等），指令插件的 `init()` 也会调用同一个函数作为兜底。
- 官方 SDK 用 **`qq-official-bot@1.3.0`**（旧的 `qq-group-bot@1.1.0` 上游 2023 年就停更了）。
  SDK 差异集中在 `adapter/sdk.js`：`mode: websocket`、`sandbox → apiBaseUrl`、群/单聊 intent 合并成 `GROUP_AND_C2C_EVENT`、
  消息段 `{type,data}` 双向转换、`group_openid → group_id`、用事件名区分「群里被 @」等；换 SDK 只改这一个文件。
- 另有两个 miao 社区惯例的小垫片（与 napcat / snowluma 同名同写法）：`lib/bot.js` 把全局 `Bot` 换成代理，
  让 `Bot.pickGroup / pickFriend / pickMember` 能跨适配器找到 QQBot 的群与好友；`lib/uin.js` 把 `Bot.uin`
  变成多账号数组（`toString`/`valueOf` 仍返回第一个，老写法 `Bot[Bot.uin]`、`${Bot.uin}` 照旧可用）。

## 目录结构

```
plugins/QQBot-Plugin/
├── index.js                入口：日志横幅、初始化 Bot.adapter、qqbot.init()、导出管理指令插件
├── adapter/
│   ├── index.js            适配器主体（连接 / intents 降级 / 收发消息 / 事件投递 / WebHook …）
│   └── sdk.js              qq-official-bot 适配层（换 SDK 只改这里）
├── lib/
│   ├── index.js            统一出口（qqbotCommon / cfg / config / configSave）
│   ├── bot.js              全局 Bot 代理（跨适配器 pick*）
│   ├── uin.js              Bot.uin 多账号 shim
│   ├── plugin.js           管理指令（#QQBot账号 / 设置 / MD / 发送模式 / 图片限制 / 绑定用户）
│   └── utils/
│       ├── cfg.js          插件内配置读写（defSet 合并 + 旧配置迁移 + 热更新）
│       └── common.js       日志 / JSON Map 持久化 / WebHook / 文件直链 / markdown 工具 / 事件构造
├── config/
│   ├── defSet/cfg.yaml     默认配置（随插件提交）
│   └── config/cfg.yaml     用户配置（自动生成，已 gitignore）
├── package.json
└── README.md
```

## 配置

配置在**插件目录内**（与 napcat / snowluma 一致）：

| 文件 | 作用 |
| --- | --- |
| `config/defSet/cfg.yaml` | 默认值，随插件更新；不要改它，改它无效 |
| `config/config/cfg.yaml` | 用户实际生效的配置，由「设置」指令写入或手工编辑；首次加载自动从 defSet 复制生成（带注释） |

配置文件支持热更新：外部改动会在几秒内合并进内存配置。

## 安装

1. 依赖已装在 `plugins/QQBot-Plugin/node_modules`，如需重装：

```bash
cd plugins/QQBot-Plugin && pnpm i
```

2. 打开 [QQ 开放平台](https://q.qq.com) 创建机器人：
   「开发设置」里只需要记下 **AppID** 和 **AppSecret** 两个值（见 [官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)）。

   > v1 时代的 `Token` 已作废：SDK 取凭证只认 `AppID + AppSecret`
   > （`POST /app/getAppAccessToken` → `access_token`，有效期 7200 秒，插件自动刷新），
   > 调用时带上 `Authorization: QQBot <access_token>`。本插件已不再使用 Token。

3. 把账号写进 `plugins/QQBot-Plugin/config/config/cfg.yaml` 的 `accounts`（推荐，key: value 一目了然）：

```yaml
accounts:
  - uin: 3889013403     # 机器人QQ号（账号标识；可省略，省略时用 appid 顶替）
    appid: 102091829    # 开放平台 AppID
    secret: xxxxxxxxxx  # 开放平台 AppSecret（在 q.qq.com 重置后必须同步改这里）
    group: true         # 群聊 + C2C 私聊（默认 true）
    guild: false        # 频道（默认 false）
    webhook: false      # true 走 WebHook（需同时配 webhookPort + 公网 url）
```

   也可以用主人账号（`config/config/other.yaml: masterQQ`）或标准输入控制台发指令，写入的是同一处 `accounts`：

```
#QQBot设置3889013403:102091829:AppSecret
```

   指令里 3 段是上面的简写（默认群Bot）；**4 段及以上**仍按旧格式解析：
   `机器人QQ号:AppID:Token:AppSecret[:是否群Bot[:是否频道私域]]`，其中 Token 段会被忽略，末段为 `2` 表示 WebHook。
   需要关掉群聊 / 开频道 / 走 WebHook 时，用 `accounts` 的对象写法显式声明更清楚。重复发送同一个机器人即删除该账号。

> WebHook 需要公网 HTTPS，并在 QQ 开放平台填写 `url/QQBot`，同时把 `config/config/cfg.yaml: webhookPort` 设为监听端口（默认 0 表示不启用）。

## Miao 适配差异（重要）

| 项目 | TRSS 版 | 本 Miao 版 |
| --- | --- | --- |
| 账号数据 | leveldb（`data/QQBot/xxx-leveldb`） | JSON（`data/QQBot/xxx.json`） |
| WebHook | TRSS 内置 express 服务 | 内置 `node:http`，`config/config/cfg.yaml: webhookPort` |
| 图片直链 | `config/config/server.yaml: url` | `config/config/cfg.yaml: url`（公网地址，用于 markdown 图片/文件直链） |
| 主人判定 | `cfg.master[BotID]` | `config/config/other.yaml: masterQQ`，或 `#QQBot绑定用户` 绑定后按绑定 QQ 判定，也可用 `config/config/cfg.yaml: master` 追加 |
| 命令入口 | 所有 TRSS 适配器 | 主人通过 miao 主账号（icqq）或标准输入控制台发送 |

### intents 与连接错误

默认 **只申请群聊事件 + 按钮交互，频道相关一律不默认申请**（频道 intent 需要机器人具备频道能力，未开通时会让整个握手 4014）：

| 账号声明（`accounts` 字段 / 旧写法末两段） | 默认申请的 intents |
| --- | --- |
| `group: true`（默认；旧写法第 5 位 `1`） | `GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE`、`INTERACTION` |
| 只声明频道（`group: false` + `guild: true`；旧写法第 5 位 `0`、第 6 位 `1`） | `GUILDS`、`GUILD_MESSAGE_REACTIONS`、`DIRECT_MESSAGE`、`GUILD_MESSAGES` |
| 都没声明 | 空 |

其中 `INTERACTION` 是给消息按钮里的**回调按钮**（`keyboard` 里 `action.type=1`）用的：
用户点按钮后平台靠它把 `INTERACTION_CREATE` 推给机器人，机器人再 `PUT /interactions/{interaction_id}` 回应。
没申请的话事件根本到不了本地，用户点完按钮（带二次确认的话是确认之后）客户端只会提示 **“请求第三方失败”**。
如果机器人没在开放平台开通「消息按钮/按钮交互」，`INTERACTION` 会让握手 4014，此时插件会**自动摘掉它重连**并打印一条 warn，不会导致掉线；
但那种情况下回调按钮点了依旧会提示“请求第三方失败”，只能去开放平台开通能力，或把按钮改成 `action.type=2`（指令按钮，点击=发一条消息）。

需要频道/消息审核时在 `config/config/cfg.yaml: intents` 里显式填写（填了就以它为准）：

```yaml
intents:
  - GROUP_AT_MESSAGE_CREATE
  - C2C_MESSAGE_CREATE
  - INTERACTION        # 按钮交互（需在开放平台申请）
  - GUILDS             # 频道，需要频道能力
  - GUILD_MESSAGES
  - PUBLIC_GUILD_MESSAGES  # 公域频道消息
  - MESSAGE_AUDIT          # 消息审核
```

常见错误：

- `4014 intent无权限` / `4013 无效的intent`：申请的 intent 里有该机器人未获授权的项。
  插件会按「能力从多到少」自动降级重连：先按配置来，再摘掉 `INTERACTION`/`MESSAGE_AUDIT`/`GUILD_MEMBERS`/`PUBLIC_GUILD_MESSAGES`
  这些需要单独申请的项，最后再退到最保守的群聊组合，并在日志里说明摘掉了哪些。
  全都失败才判定连接失败，并打印最后一次申请的 intents 与可选清单。
  `GUILD_MEMBERS`、`MESSAGE_AUDIT`、`INTERACTION` 都需要在 QQ 开放平台单独申请/开启能力。
- `100017 接口调用超过频率限制`：握手一直失败时 SDK 会无间隔重连猛打 `/gateway/bot`。
  本版已加：`connectTimeout` 超时判定失败、`maxRetry` 次数上限、`retryDelay` 递增退避。
- 添加账号后收不到回复：以前的 `login()` 在握手被拒时**永久挂起**，现在会超时/被拒后返回"账号连接失败"。

> 另外 `#QQBot设置` 的配置落盘有 3 秒防抖，设置成功后请稍等几秒再重启，确认 `config/config/cfg.yaml: accounts` 已写入。

### 白名单

Miao 的 `config/config/other.yaml` 如果配置了 `whiteGroup` / `whiteQQ`，QQBot 的群和用户也必须加进去，否则消息会被静默丢弃。
适配层在这种情况下会打印一次提示，直接复制日志里的 id 即可：

```
[QQBot] 群 102000000:xxxxx 不在 config/config/other.yaml 的 whiteGroup 中，消息不会触发任何插件；如需启用请把上面这个 id 加进 whiteGroup
```

### 被动回复 / 主动消息

QQ 的**引用回复**属于被动回复：带 `msg_id` 发送，有时间与次数上限（超了会 `40034128 回复消息失败，被动回复时间或者次数超过限制`）。
不带 `msg_id` 的则是**主动消息**，需要机器人在开放平台具备主动推送权限（且有配额）。

`config/config/cfg.yaml: activeMsg`（默认 `auto`）：

| 值 | 行为 |
| --- | --- |
| `auto` | 只要有 `msg_id` 就带引用（被动回复）；被 `40034128` 拒绝才**去掉引用**改用主动消息重发，之后 5 分钟该账号不再引用，到期自动恢复。主动消息被 `40034105` 拒绝时会**改回带引用**再试一次 |
| `true` | 始终作为主动消息发送（**不走引用回复**），适合已确认有主动推送权限的账号 |
| `false` | 保持原行为：始终按被动回复发（失败就失败，不降级） |

> 早期版本会本地判断「消息是否超过 300 秒」来决定要不要引用，但那个门限和 QQ 服务端的限制一样是 300 秒，
> 只要插件处理稍慢（例如渲染图片花了几秒）就会误判成主动消息，于是没开主动推送权限的机器人直接 `40034105 主动消息失败, 无权限`，整条消息发不出去。
> 现在改为**优先引用、由 QQ 判定**：真超时/超次数时服务端会回 `40034128`，插件再降级成主动消息。

日志会提示「被动回复超出时间/次数限制（40034128），5 分钟内改用主动消息」。
如果降级后仍然失败（`40034105 主动消息失败, 无权限`），说明该机器人没有主动消息配额/权限，需要到开放平台处理；
此时插件会自动回到带引用的被动回复。

### 回复（reply）与主动推送（pickGroup().sendMsg）

适配器按**调用方式**区分两者，不需要插件自己判断：

| 调用 | 发出的消息 |
| --- | --- |
| `e.reply(msg)` / `e.group.sendMsg(msg)` / `e.friend.sendMsg(msg)`（事件里） | **回复**：带 `msg_id` 的被动回复（引用触发消息），不消耗主动推送配额 |
| 监听 `INTERACTION_CREATE`（按钮回调）时的 `e.reply(msg)` | **被动回复**（带 `event_id`） |
| `Bot.pickGroup(id).sendMsg(msg)` / `Bot.pickFriend(...).sendMsg(msg)` / `e.group.sendMsg()` 之外拿到的 group/friend 对象 | **主动推送**：不带 `msg_id`，需要开放平台的主动消息权限 |

注意 `pickGroup()` 返回的群对象里带着「该群最后一条消息」的 `message_id`/`time`（`setGroupMap` 写的），
所以推送必须显式声明为主动消息——否则会把群里最后一条消息当成引用发出去。
本适配器的 `pick*.sendMsg` 已自动带上这个标记；插件若自己拼 `sendGroupMsg({...})`，请在 data 上加 `active: true`。

### 颜文字 / markdown 语法字符

QQ 的 markdown 会把 `>`、`#`、`*`、`_`、`~`、`` ` ``、`-`、`|` 当语法解析，
所以 `>_<`、`¯\_(ツ)_/¯` 这类颜文字会被渲染成引用块/斜体。

适配器会在文本送进 markdown 前插入**零宽空格**（和插件对 `@` 的处理方式一致）打断语法，可见文本不变：

- 行首的 `>`、`#`、`|`、`*`、`-`、`+`、`_`、`~`、`1.` 前插一个零宽空格；
- 行内的 `*`、`_`、`~`、`` ` `` 后插一个零宽空格；
- 适配器自己生成的图片/链接标记受保护，不受影响；
- 需要插件原样输出 markdown 时，把 `config/config/cfg.yaml: escapeMarkdown` 设为 `false`。

### @用户（at）

QQ 官方机器人的 @ **只有放在 markdown 里**（`<qqbot-at-user id="…" />`）才会渲染成真正的 @；
普通消息 content 里的 `<@openid>`（`qq-official-bot` SDK 的写法）QQ 不解析，会原样显示成文本。

适配器的策略：

- **群/单聊的纯文本 `content` 没有 @ 语法**：`<@id>` 是**频道**的内嵌格式，群事件的 @ 走独立的 `mentions` 数组。
  所以 `auto`（默认）/`text` 模式下，at 会退化成可见的「**@昵称**」：名字依次取 at 段自带的名字 → 若 @ 的是发言人本人则用 sender 的昵称 → 群成员缓存 `gml`（群 key 兼容裸 openid 与带实例前缀两种写法）→ 好友缓存 `fl` → 最后兜底「用户」，
  不会再出现 `<@openid>` 这种字面文本；
- 想要**真 @**（可点击的 @ 标签），需要用 `markdown` 模式，或让插件显式发 `segment.markdown`（`auto` 会为显式 markdown 走 markdown 构建器）：
  只有 markdown 的 `<qqbot-at-user id="…" />` 能渲染成真 @；
- markdown 模式下 at 段一律走 `<qqbot-at-user>` 标签，`qq` / `id` / `user_id` 三种写法都识别，自动剥掉实例前缀与 `qg_`，`qq: 0` 这类坏值会回退用 `id`。
- **指向同一个人的重复 at 会自动去重（保留第一个）**：插件自己发了 `segment.at(e.user_id)`、reply 又带了 `{ at: true }` 时，
  miao 核心会再补一个 at；两段目标相同但一个带群名片、一个没有，渲染出来就是「@群名片 @昵称」两个 @。
  现在 4 个消息构建器入口都会先按目标 id 去重。
- **适配器不再往消息里塞任何 @**：群里「@ 了机器人」以前是靠往入站消息里插一个机器人自己的 at 段来实现的，
  那个段会被插件转发/回显到回复里，表现为「适配器凭空多加了一个 @」。现在改成直接给事件置 `e.atBot = true`，
  入站消息里不会再出现注入的 at。
- **被动回复（引用）发言人本人时，不再补「@昵称」**：QQ 的引用本身就会显示「回复 @对方」，
  这是真正可点击、会提醒对方的那一个；我们再用纯文本补一个「@昵称」只会变成结尾多出来的一坨死文本。
  所以 `makeMsg` 里遇到 `at` 段、且该段目标正好是当前发言人、且这条消息走被动回复时会直接丢掉这个 at。
  - 只影响普通消息（`auto` / `text`）：@ 别人、@全体成员、以及主动推送时的 @ 发言人 都照常渲染；
  - 只有「@ 发言人」这一个 at、丢掉后整条消息就空了时（例如插件只发了 `segment.at(e.user_id)`），
    仍然会把「@昵称」留下来兜底，避免回复变成空消息发不出去；
  - `markdown` 模式不变：那里是真正的 `<qqbot-at-user>` 标签，本身就是有效提醒。

### 图片

- 普通消息（`auto` 默认 / `text` / `#QQBotMD机器人QQ号:legacy`）会由 `qq-official-bot` SDK 直接上传本地图片/音频/视频，**无需公网地址**。
- 只有 **`markdown` 模式**才把图片内嵌进 markdown，此时无法上传图片、只能给一个**公网直链**：需要同时配置
  `config/config/cfg.yaml: url`（如 `https://bot.example.com`）和 `webhookPort`（内置文件服务端口），并把该端口反代到公网。
- **带图片的消息默认「图文合成一条」**（`sendBatch`）：不走 SDK 自带的富媒体通道（它内部的分片上传有 850019 的坑），
  而是自己上传后按 `msg_type 7` 直发：
  1. 先把所有媒体上传（`srv_send_msg: false`，只上传不发）；任一失败就整批回退给 SDK，避免发出半条；
  2. 非媒体内容（文字、以及退化成 `@昵称` 的 at）**并进第一条媒体的 `content`**，在 QQ 里就是图片下面那行字；
  3. 每条媒体都带同一个引用（同 `msg_id`、不同 `msg_seq`），都走**被动回复**，不占用主动消息频次。

  多条媒体时只有第一条带文字，其余只发图；文字段的拼接方式与 SDK 发纯文本时一致（直接首尾相接，不额外补分隔符）。
- **两种例外仍然拆开发送**（媒体一条、其余内容一条）：
  - 非媒体部分里有塞不进 `content` 的段，例如显式 markdown、`keyboard`、`ark`；
  - caption 被平台拒绝（超长等）时自动退回拆分，不会因为文字太长就整条发不出去。
    回复超时（40034128）、无主动消息权限（40034105）这类错误不在这里吞掉，照旧交给上层的降级逻辑处理。
- **没有配置公网地址时不会再发乱码**：媒体直接走上面的上传+直发路径；没有引用（主动推送、或已降级成主动消息）时，
  媒体同样照发，只是不带 `msg_id`。日志会提示一次「未配置 config/config/cfg.yaml: url …」。
- 图片即使走 markdown，也必须能被 QQ 服务器拉取；本适配器的直链来自内置文件服务（`webhookPort` + `url`）。
- 也可整体切换成普通消息：`#QQBotMD机器人QQ号:legacy`
- **图片必须独占一行**：QQ 的 markdown 把 `![alt](url)` 当行内节点，前面没有换行时会和相邻的 @、文字挤成一行。
  例如签到消息拼出来是 `<qqbot-at-user id="…" />![图片 #2560px #1350px](…)签到成功！…`，
  客户端就把 @ / 卡片 / 文字排成**一横排**。适配器现在给图片标记前面统一补换行（`markdownImage()`），
  **后面跟着内容时才补换行**，图片在结尾时不补、也不会留下空行（`content.trimEnd()`）；
  文本行内出现的二维码图片同样处理；模板模式本身按行参数发送，不受影响。

### 富媒体上传（SDK 补丁）

`qq-official-bot@1.3.0` 的分片上传有 bug：平台 `upload_prepare` 返回的分片序号是 **1 起始**（实测 `parts[0].index === 1`），
而 SDK 用 `part.index * blockSize` 计算偏移，首片直接落到文件末尾 → 上传的是**空分片** → 合并时报
`850019 不支持的文件格式`（图片、语音、视频都会中招）。

`adapter/sdk.js` 里对 `FileProcessor.prototype.uploadByChunks` 做了修复：按分片序号基数归一化偏移，
`upload_part_finish` 仍回传平台原始序号；SDK 其余行为（消息构建、内容/引用/键盘）完全不变。
修复后已用真实接口验证能正常拿到 `file_info`。

### markdown 段与按钮

- 兼容两种 markdown 段写法：`{type:"markdown", content:"…"}`（miao/icqq `segment.markdown`）与 `{type:"markdown", data:{…}}`（QQ 原始 markdown 对象）；
- QQ 官方 markdown 里的 `<qqbot-cmd-input … />`、`<qqbot-at-user … />` 等标签会原样透传，所以快捷指令按钮能正常显示；
- miao 的 `PluginsLoader.reply` 只把 `(msg, quote)` 传给适配器，插件常用 `e.reply(msg, quote, {keyboard})` 传的 **QQ 官方扩展（keyboard / button / markdown）会丢**。
  本适配器在**事件自己的 `reply` 上**包了一层（`lib/utils/common.js: installReplyExtra()`，不猴补 `loader`、不改核心文件）：
  只有本次调用带了第 3 个参数时才透传，其它适配器与核心的 `recallMsg`/`at`/计数逻辑完全不变；
  透传进来的 `keyboard` 会挂到同一条 markdown 消息上。

### 合并转发

QQ 官方机器人接口没有合并转发能力，适配器分两种处理：

- **markdown 模式**：官方 markdown 支持 `>` 块引用语法，转发**渲染成块引用并并入同一条消息**：

```
> 第一行
>
> 第二行
```

- **`auto`（默认）/ `text` 模式**：不套 markdown，直接把各节点内容**硬拆/展开成普通消息**（不加 `>`）。

其余规则：

- 每个转发节点内部的换行照旧，节点之间用空引用行 `>` 分隔；
- 节点里的文字 / 图片 / @ 会保留；表情、语音、文件、按钮、嵌套转发等无法表达的段会被丢弃；
- 兼容三种转发形态：`{type:"node",data:[...]}`（本适配器产物）、icqq `segment.fake` 单节点、裸的 `[{user_id,nickname,message}]` 数组；
- `e.group.makeForwardMsg()` / `e.friend.makeForwardMsg()` 已实现并返回适配器可识别的转发段，因此 `common.makeForwardMsg(e, [...])` 在 QQBot 下也能正常工作（以前会退化成 `msg.join("\n")`）；
- 内容并成一条，转发特别长时可能被 QQ 接口拒绝，此时走原有的失败日志/回退逻辑。

### 断线重连日志

SDK 的重连过程会打一串「等待断线重连中 / 重新连接中，尝试次数 / 连接关闭…」，
适配器把这些**过程日志静默**掉（`adapter/index.js` 里的 `SILENT_SDK_LOG`）：

- 只保留真正的**错误**（如 `发生错误：4009 连接过期，请重连`）；
- 重连**成功**时只记一条 `自动重连成功`（由 SDK receiver 的 `ready` 事件触发，首次连接不算）；
- 每条消息的 `recv from …` 原始事件日志也照旧丢弃。

### 发送模式与「某些客户端看不到 markdown」

QQ 官方 markdown（`msg_type = 2`）在**部分客户端/机器人上不会渲染**（客户端显示空白）；
而平台在机器人没有「原生 Markdown」权限、markdown 参数非法、或内容里的链接命中 URL 白名单时，
会直接用 `304036` / `40034127` / `40034124` / `40034028` 等错误**拒绝整条消息**。

适配器做了两层处理：

1. **发送失败自动降级**：一旦报错被判定为 markdown 类错误（无权限 / 参数 / 审核），
   就把消息**剥成纯文本 + 富媒体**（`msg_type 0/7`）重发一次，不再重试 markdown；
   `40034128`（被动超限）/ `40034105`（无主动权限）仍走原来的 引用↔主动 兜底，互不影响。
2. **`sendMode` 主动选择**：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 只有显式 `markdown` / 按钮（`button`、`keyboard`）的消息才走 markdown；其余文字・图片・@・合并转发一律**硬拆成普通消息**（`msg_type 0/7`） |
| `markdown` | 强制所有消息都走 markdown 构建器（普通文本也会被转义进 markdown 内容）；需要**真 @** 或 markdown 排版时用 |
| `text` | 始终普通消息，连显式 `markdown` 段也不走 markdown（最保险，会丢 markdown 排版） |

```yaml
sendMode:
  default: auto           # 全局默认
  3889013403: markdown    # 可按机器人 QQ 号覆盖
```

> `auto` 适合"不确定客户端是否渲染 markdown"的场景；`text` 最保险，但会失去 markdown 排版，
> markdown 内嵌图片也会改为单独富媒体消息发送。

## 命令

- `#QQBot账号`
- `#QQBot设置` + `机器人QQ号:AppID:AppSecret`（3 段简写，默认群Bot）；4 段及以上按旧格式 `机器人QQ号:AppID:Token:AppSecret[:是否群Bot[:是否频道私域]]`（Token 段忽略，是 1 否 0，末段 2 为 WebHook）；重复发送同一个机器人即删除该账号
- `#QQBotMD` + `机器人QQ号:raw/inline/legacy`（MD 按钮消息 / MD 消息 / 普通消息）
- `#QQBot发送模式` + `[机器人QQ号:]markdown/text/auto`（不带参数为查询当前模式）
- `#QQBot图片限制` + `数字`（MB，默认 3）
- `#QQBot绑定用户` + `QQ号`

## 配置文件

`config/config/cfg.yaml`（完整默认值见 `config/defSet/cfg.yaml`，带注释）：

```yaml
permission: master      # 设置命令所需权限
imageLength: 3          # 图片压缩阈值（MB）
escapeMarkdown: true    # 转义 markdown 语法字符（颜文字不被误解析）
activeMsg: auto         # 引用回复策略：auto / true（始终主动消息）/ false
bot:
  maxRetry: 3           # 断线重连次数上限
  connectTimeout: 30000 # 握手超时（毫秒）
  retryDelay: 5000      # 重连基础间隔（毫秒），按次数递增
intents: []             # 留空：默认只开群聊 + INTERACTION，频道不申请（见上文）
master: []              # 额外主人（QQBot 用户 openid 无法用 QQ 号匹配时使用）
webhookPort: 0          # WebHook 监听端口，0 为不启用
url: ""                 # 公网地址，如 https://bot.example.com（markdown 图片/文件直链）
markdown:
  template: abcdefghij
sendMode:
  default: auto         # markdown / text / auto（见上文「发送模式」）
accounts:               # 账号列表：只填开放平台的 AppID / AppSecret（推荐写法）
  - uin: 3889013403     # 机器人QQ号（账号标识；可省略，省略时用 appid 顶替）
    appid: 102091829    # 开放平台 AppID
    secret: xxxxxxxxxx  # 开放平台 AppSecret（重置后要同步改）
    group: true         # 群聊 + C2C 私聊（默认 true）
    guild: false        # 频道（默认 false）
    webhook: false      # true 走 WebHook（需 webhookPort + 公网 url）
token: []               # 旧写法（#QQBot设置 写过的历史数据），含义同 accounts，留空即可
```
