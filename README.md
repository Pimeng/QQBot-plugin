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

## 可用性

Yunzai：
- [x] **Elia-Yunzai**：**完美**适配
- [x] **Miao-Yunzai**：理论可用
- ~~[ ] **TRSS-Yunzai**：不可用，请使用[官方版](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)或其fork~~

发送：
- [x] 文件：正常
- [x] 文本消息：正常
- [x] Markdown 消息：正常
- [x] 按钮：正常
- [x] 图文：正常
- ？ @：如打开全量消息，可能无法正常使用，Markdown无视，可正常@

## 安装

在 Yunzai 根目录执行：

```bash
git clone --depth=1 https://github.com/Pimeng/QQBot-plugin ./plugins/QQBot-plugin
pnpm i --filter ./plugins/QQBot-plugin
```

安装后重启 Yunzai。插件首次启动时会生成 `config/config/cfg.yaml`

## 配置账号

在 QQ 开放平台创建机器人，在「开发设置」中取得 AppID 和 AppSecret。编辑 `plugins/QQBot-plugin/config/config/cfg.yaml`，添加账号：

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
| `#QQBot绑定用户` | 绑定 QQ 用户 |

## WebHook

默认使用 WebSocket。使用 WebHook 时，在 `cfg.yaml` 中设置 `webhook: true`、`webhookPort` 和公网 `url`，并将 QQ 开放平台回调地址配置为 `https://你的域名/QQBot`。WebHook 需要公网 HTTPS 和正确的反向代理。

## 文档

配置字段、事件权限、消息发送行为、媒体处理和常见故障排查见[技术说明](docs/technical-details.md)。

## 致谢

- [TimeRainStarSky 原作者](https://github.com/TimeRainStarSky)
- [Yunzai-QQBot-Plugin 原作](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin)

## 许可证

[GPL-3.0](LICENSE)
