import { config } from "../utils/cfg.js"
import { createQQBotPanelService } from "./service.js"
import { createQrLoginService } from "../qr-login.js"

const service = createQQBotPanelService(config)
const qrLogin = createQrLoginService({ config })
const accountSelector = { key: "account", label: "机器人账号", type: "select", optionsFrom: "accounts" }
const linkField = { key: "link", label: "HTTPS 链接", type: "text", required: true, when: { key: "type", value: "link" } }
const messageField = { key: "send_message", label: "发送内容", type: "textarea", required: true, when: { key: "type", value: "send_message" } }
const menuTypes = [{ label: "发送消息", value: "send_message" }, { label: "跳转链接", value: "link" }]
const menuFields = [
  { key: "name", label: "名称", type: "text", required: true, description: "一级名称最多 10 个宽度，中文按 2 计。" },
  { key: "type", label: "类型", type: "select", required: true, options: [...menuTypes, { label: "开关", value: "switch" }, { label: "子菜单", value: "menu" }] },
  messageField, linkField,
  { key: "switch", label: "开关设置", type: "object", required: true, when: { key: "type", value: "switch" }, fields: [
    { key: "switch_id", label: "开关标识", type: "text", required: true },
    { key: "default", label: "默认开启", type: "boolean" },
  ] },
  { key: "sub_menu_items", label: "子菜单项", type: "array", required: true, minItems: 1, maxItems: 5, itemLabel: "name", when: { key: "type", value: "menu" }, fields: [
    { key: "name", label: "子项名称", type: "text", required: true, description: "最多 14 个宽度，中文按 2 计。" },
    { key: "type", label: "子项类型", type: "select", required: true, options: menuTypes }, messageField, linkField,
  ] },
]
const panelFields = [{ key: "panel", label: "面板内容", type: "object", required: true, fields: [
  { key: "remark", label: "管理备注", type: "text", description: "最多 255 字符，仅供管理。" },
  { key: "items", label: "指令项", type: "array", minItems: 1, maxItems: 20, itemLabel: "name", required: true, fields: [
    { key: "name", label: "指令名称", type: "text", required: true, description: "最多 14 个宽度；指令类型点击后填写此名称。" },
    { key: "type", label: "类型", type: "select", required: true, options: [{ label: "指令", value: "command" }, { label: "链接", value: "link" }] },
    { key: "desc", label: "描述", type: "text", description: "最多 30 个宽度。" },
    { key: "only_admin", label: "仅管理员可操作", type: "boolean" }, linkField,
  ] },
] },
{ key: "target_type", label: "生效对象", type: "select", required: true, createOnly: true, options: [{ label: "全部对象", value: "all" }, { label: "指定对象（仅单聊/群聊）", value: "specific" }] },
{ key: "openids", label: "初始关联 OpenID", type: "textarea", createOnly: true, when: { key: "target_type", value: "specific" }, description: "每行一个，最多 20 个。单聊填写用户 OpenID，群聊填写群 OpenID。" }]

export const panelExtensions = {
  version: 1,
  pages: [{
    id: "qqbot", title: "QQBot 控制台",
    description: "查看 QQBot 账号运行状态，管理 QQ 平台菜单和指令面板。连接消息计数仅统计本次运行；今日字段来自持久化 DAU 日统计；群与好友仅包含本插件已知数据。",
    tabs: [
      { id: "overview", title: "运行概览", blocks: ["summary", "accounts"] },
      { id: "menu", title: "自定义菜单", blocks: ["menu"] },
      { id: "panels", title: "指令面板", blocks: ["panels"] },
      { id: "contacts", title: "群与好友", blocks: ["contacts"] },
      { id: "login", title: "扫码登录", blocks: ["qrStart", "qrImage", "qrStatus", "qrCancel"] },
    ],
    blocks: [{
      id: "summary", type: "stats", title: "运行概览",
      fields: [
        { key: "accounts", label: "已配置账号" }, { key: "online", label: "在线账号" },
        { key: "groups", label: "已知群" }, { key: "friends", label: "已知好友" },
        { key: "received", label: "接收消息", unit: "条" }, { key: "sent", label: "发送消息", unit: "条" },
        { key: "todayReceived", label: "今日上行", unit: "条" }, { key: "todaySent", label: "今日下行", unit: "条" },
        { key: "dauUsers", label: "今日日活用户", unit: "人" }, { key: "dauGroups", label: "今日日活群", unit: "个" },
        { key: "cachedMessages", label: "本地缓存消息", unit: "条" },
      ], read: () => service.summary(),
    }, {
      id: "accounts", type: "table", title: "账号状态",
      columns: [{ key: "id", label: "账号" }, { key: "appid", label: "AppID" }, { key: "nickname", label: "名称" },
        { key: "status", label: "状态" }, { key: "mode", label: "连接方式" }, { key: "environment", label: "环境" },
        { key: "groups", label: "已知群" }, { key: "friends", label: "已知好友" },
        { key: "received", label: "已接收" }, { key: "sent", label: "已发送" },
        { key: "todayReceived", label: "今日上行" }, { key: "todaySent", label: "今日下行" },
        { key: "dauUsers", label: "日活用户" }, { key: "dauGroups", label: "日活群" },
        { key: "cachedMessages", label: "缓存消息" }, { key: "intents", label: "当前事件权限" }],
      read: ({ offset, limit, search }) => {
        const items = service.summaries().map(item => ({ ...item, status: item.online ? "在线" : "离线" }))
          .filter(item => !search || [item.id, item.appid, item.nickname, item.status].some(value => value.includes(search)))
        return { items: items.slice(offset, offset + limit), total: items.length }
      },
    }, {
      id: "menu", type: "resource", mode: "singleton", title: "自定义菜单",
      description: "仅在单聊生效，对该账号全部用户生效。可增删和调整顺序；保存会替换完整菜单，移除全部项并保存可清空。",
      confirm: "确认替换该机器人对全部单聊用户生效的自定义菜单？",
      selectors: [accountSelector],
      fields: [{ key: "items", label: "菜单项", type: "array", required: true, maxItems: 10, itemLabel: "name", fields: menuFields }],
      preview: { items: "items", name: "name", children: "sub_menu_items" },
      read: query => service.readResource("menu", query), write: (data, context) => service.writeResource("menu", data, context),
    }, {
      id: "panels", type: "resource", mode: "collection", title: "指令面板", create: true, remove: true,
      description: "一个机器人最多 20 个面板。频道与频道私信仅支持全部对象；已有面板的场景和生效类型不可更改。关联操作每次最多 20 个 OpenID。",
      confirm: "确认将本次面板操作提交到 QQ 平台？删除面板会立即移除其关联关系。",
      selectors: [accountSelector, { key: "scope", label: "场景", type: "select", options: [
        { label: "单聊", value: "c2c" }, { label: "群聊", value: "group" }, { label: "文字子频道", value: "channel" }, { label: "频道私信", value: "dm" },
      ] }], fields: panelFields,
      preview: { items: "panel.items", name: "name", description: "desc" },
      actions: [{ id: "targets", title: "修改关联对象", description: "仅单聊/群聊且指定对象面板可用。详情最多返回 1000 个 OpenID。",
        confirm: "确认修改该面板的生效对象？", fields: [
          { key: "op", label: "操作", type: "select", required: true, options: [{ label: "添加关联", value: "add" }, { label: "移除关联", value: "del" }] },
          { key: "openids", label: "关联 OpenID", type: "textarea", required: true, description: "每行一个，最多 20 个。单聊填写用户 OpenID，群聊填写群 OpenID。" },
        ] }],
      read: query => service.readResource("panels", query), write: (data, context) => service.writeResource("panels", data, context),
    }, {
      id: "contacts", type: "table", title: "已知群与好友",
      description: "来源于已连接账号的本地联系人缓存，可搜索账号、名称或 OpenID；这些记录不是 QQ 平台完整用户或群列表。",
      columns: [
        { key: "account", label: "机器人账号" }, { key: "kind", label: "类型" }, { key: "openid", label: "OpenID" },
        { key: "name", label: "名称" }, { key: "members", label: "已知成员数" },
      ], read: query => service.contacts(query),
    }, {
      id: "qrStart", type: "action", title: "创建扫码任务",
      confirm: "扫码会重置所选机器人的 AppSecret，旧 Secret 将失效。确认创建扫码登录任务？",
      execute: async (_, { Result }) => Result.ok(await qrLogin.start(), "扫码任务已创建，请查看二维码和任务状态"),
    }, {
      id: "qrImage", type: "image", title: "使用手机 QQ 扫码",
      description: "二维码在本地生成，也可点击打开官方扫码链接。任务约 5 分钟有效。",
      read: () => qrLogin.image(),
    }, {
      id: "qrStatus", type: "stats", title: "任务状态",
      fields: [
        { key: "statusText", label: "当前状态" }, { key: "appid", label: "AppID" },
        { key: "uin", label: "机器人标识" }, { key: "expiresAt", label: "到期时间" },
        { key: "error", label: "错误信息" },
      ], read: () => qrLogin.snapshot(),
    }, {
      id: "qrCancel", type: "action", title: "取消当前扫码任务",
      confirm: "确认取消当前扫码任务？已保存的账号配置不会受影响。",
      execute: (_, { Result }) => Result.ok(qrLogin.cancel(), "已取消当前扫码任务"),
    }],
  }],
}
