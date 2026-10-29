<div align="center">

# QQBot-Plugin

QQBot-Plugin 是面向 Elia-Yunzai 的 QQ 官方机器人适配器   
它将 QQ 开放平台的机器人账号接入 Yunzai，让现有插件可以通过统一的机器人事件和消息接口收发 QQ 消息

</div>

## 功能

- 支持多个 QQ 官方机器人账号
- 支持群聊、C2C 私聊和频道事件（按账号能力配置）
- 支持 WebSocket，或配置 WebHook 接收事件（推荐Websocket，官方已支持直接上传图片无需 WebHook）
- 支持普通消息、Markdown、按钮、图片及常见媒体消息
- 提供账号管理、发送模式、图片限制和用户绑定命令
- 提供持久化 DAU、用户统计、C2C 流式输出和插件处理时的输入状态
- 提供 icqq 风格成员/好友通知，插件可自行捕获入群事件并推送欢迎消息
- 兼容全局 Bot、账号及好友/群/成员的常用调用，支持群成员禁言与频道管理
- 可通过 `pickGroup(...).getChatHistory()` / `getMsg()` 查询实际接收的消息并持久保存
- 接入 EliaAdminPanel 插件扩展，查看账号状态与本地统计，图形化编辑自定义菜单、指令面板和关联对象

## 可用性

Yunzai：
- [x] **Elia-Yunzai**：**完美**适配
- [x] **Miao-Yunzai**：理论可用
- ~~**TRSS-Yunzai** 请使用[官方版](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)或其fork，不接受使用TRSS发送的Issue~~

发送：

| 类型 | 状态 / 说明 |
| --- | --- |
| 文件 | 正常 |
| 文本消息 | 正常 |
| Markdown 消息 | 正常 |
| 按钮 | 正常 |
| 图文 | 正常 |
| @ | 如打开全量消息，可能无法正常使用，Markdown无视，可正常@ |

## 安装

在 Yunzai 根目录执行：

```bash
git clone --depth=1 https://github.com/Pimeng/QQBot-Plugin ./plugins/QQBot-Plugin
pnpm i --filter ./plugins/QQBot-Plugin
```

安装后重启 Yunzai。插件首次启动时会生成 `config/config/cfg.yaml`

## 配置账号

在 QQ 开放平台创建机器人，在「开发设置」中取得 AppID 和 AppSecret。编辑 `plugins/QQBot-Plugin/config/config/cfg.yaml`，添加账号：

```yaml
accounts:
  - uin: 114514             # 机器人的QQ号（可选）
    appid: 1919810          # 机器人的 AppID
    secret: your-app-secret # 机器人的 AppSecret
    group: true             # 是否群Bot
    guild: false            # 是否频道私域
    webhook: false          # 是否走 WebHook
```

`group` 控制群聊和 C2C 私聊，`guild` 控制频道事件。保存后重启插件或等待配置热更新。

也可以通过主人账号或 Yunzai 标准输入控制台发送：

```text
#QQBot设置机器人QQ号:AppID:AppSecret
```

## 管理命令

| 命令 | 用途 |
| --- | --- |
| `#QQBot账号` | 查看账号状态 |
| `#QQBot设置` + `机器人QQ号:AppID:AppSecret` | 添加或移除账号 |
| `#QQBotMD` | 设置 Markdown 消息模式 |
| `#QQBot发送模式` | 查询或设置 `auto`、`markdown`、`text` |
| `#QQBot图片限制` | 设置图片压缩阈值（MB） |
| `#QQBotDAU[机器人标识]` | 查看今日、昨日和最近 30 天平均 DAU |
| `#QQBot用户统计[机器人标识]` | 查看累计已见联系人、今日新增和用户留存 |
| `#QQBot绑定用户` | 绑定 QQ 用户 |

DAU 默认开启并按账号保存到 `data/QQBot/<id>/DAU.json`。普通成员入群使用 icqq 的 `notice.group.increase`，插件捕获后自行推送欢迎。`stream` 控制 C2C 文本/Markdown 默认流式输出，`inputNotify` 控制实际插件处理时显示输入中；统计口径、事件示例和 stream 段写法见[技术说明](docs/technical-details.md)。

## WebHook

默认使用 WebSocket。使用 WebHook 时，在 `cfg.yaml` 中设置 `webhook: true`、`webhookPort` 和公网 `url`，并将 QQ 开放平台回调地址配置为 `https://你的域名/QQBot`。WebHook 需要公网 HTTPS 和正确的反向代理。

仅在插件启动时存在有效 WebHook 账号且 `webhookPort` 大于 `0` 时启动内置 HTTP 服务。首次安装尚未配置账号、没有 WebHook 账号时均不监听端口；后续添加 WebHook 账号会提示需要重启 Yunzai 才能接入。所有媒体消息与 `fileToUrl` 均优先使用官方上传，Markdown 图片使用分片合并返回的 `raw_url`，无需 WebHook 或公网端口。只有官方不可用时才回退到已有公网地址或内置文件服务；需要文件服务回退但未配置公网地址、端口未监听时会输出警告，Markdown 图片则尝试作为普通图片发送。

账号、群和 C2C 好友对象均提供 `uploadImage(file)`、`fileToUrl(file)`（兼容 `filetoUrl`）接口：

```js
const group = Bot[e.self_id].pickGroup(e.group_id)
const image = await group.uploadImage("./image.png") // { url, width, height, file_info, ttl, ... }
const url = await group.fileToUrl("./image.png")
// 直接调用账号接口时可显式指定上传目标；省略时使用该账号已知的群或 C2C 好友。
const directUrl = await Bot[e.self_id].fileToUrl("./image.png", {
  targetType: "group", targetId: e.group_id,
})
```

上传仅获取凭据，不自动发送消息。上传结果按账号、目标和文件内容缓存；`ttl` 到期后重新上传，`ttl=0` 可长期复用。官方 `raw_url` 仅支持分片上传的图片、视频和语音，普通文件不提供官方下载直链，需内置文件服务回退。无可用直链时 `fileToUrl` 返回空字符串并警告；`uploadImage` 无可用直链时抛出明确错误。

## 文档

配置字段、事件权限、消息发送行为、媒体处理和常见故障排查见[技术说明](docs/technical-details.md)。

EliaAdminPanel 扩展页的接入、菜单与指令面板编辑、平台限制和测试方式见[管理面板说明](docs/admin-panel.md)。

## 致谢

- [TimeRainStarSky 原作者](https://github.com/TimeRainStarSky)
- [Yunzai-QQBot-Plugin 原作](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)

## 许可证

[GPL-3.0](LICENSE)
