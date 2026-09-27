/**
 * 账号配置规范化
 *
 * 新写法（推荐）：config.accounts，每个账号写成显式 key: value
 *
 *   accounts:
 *     - uin: 3889013403     # 机器人QQ号，账号标识；省略时用 appid 顶替
 *       appid: 102091829    # 开放平台 AppID（必填）
 *       secret: xxxxxxxxxx  # 开放平台 AppSecret（必填，唯一真正参与鉴权的密钥）
 *       group: true         # 群聊能力（默认 true）
 *       guild: false        # 频道能力（默认 false）
 *       webhook: false      # true 走 WebHook，需要 webhookPort + 公网 url
 *
 * 旧写法（只用于兼容 #QQBot设置 指令写过的历史数据）：
 *
 *   token:
 *     - 机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域
 *
 *   第 3 段 Token 是 v1 时代的凭证，现在取凭证只认 appid + secret
 *   （POST /app/getAppAccessToken 换 access_token），Token 段填什么都行。
 *
 * 冒号串按**段数**区分两种写法，避免歧义：
 *   3 段       机器人QQ号:AppID:AppSecret（新短写法，group 默认 true）
 *   4 段及以上 机器人QQ号:AppID:Token:AppSecret[:是否群Bot[:是否频道私域]]（旧写法）
 * 4 段以上一律按旧写法解析，所以想用新写法就不要写第 4 段——需要关掉群聊/开频道/
 * 走 WebHook 时请用 accounts 的对象写法显式声明。
 *
 * 本文件保持零依赖，方便直接用 node 单测。
 */

/** 冒号串 -> 段数组，容忍空值与首尾空白 */
function segments(entry) {
  return String(entry ?? "")
    .trim()
    .split(":")
    .map(item => item.trim())
}

/**
 * 把一条账号配置规范成 { uin, appid, secret, group, guild, webhook }
 *
 * @param {object|string} entry accounts 里的对象，或 token 里的冒号串
 */
export function normalizeAccount(entry) {
  if (entry && typeof entry === "object") {
    const appid = String(entry.appid ?? "").trim()
    return {
      uin: String(entry.uin ?? appid).trim(),
      appid,
      secret: String(entry.secret ?? "").trim(),
      group: entry.group !== false,
      guild: entry.guild === true,
      webhook: entry.webhook === true,
    }
  }

  const t = segments(entry)

  /** 三段短写法：机器人QQ号:AppID:AppSecret（已经不写 Token 段了） */
  if (t.length <= 3)
    return {
      uin: t[0] ?? "",
      appid: t[1] ?? "",
      secret: t[2] ?? "",
      group: true,
      guild: false,
      webhook: false,
    }

  /** 旧写法：机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域 */
  return {
    uin: t[0] ?? "",
    appid: t[1] ?? "",
    secret: t[3] ?? "",
    group: t[4] === "2" ? true : !!+t[4],
    guild: !!+t[5],
    webhook: t[4] === "2" || t[5] === "2",
  }
}

/**
 * 配置里声明的全部账号
 *
 * accounts 优先，token 里的旧数据作为兼容；同一个机器人（按 uin 判断）只保留一条。
 * appid / secret 缺失的条目会被跳过。
 *
 * @param {object} config 插件活配置
 */
export function getAccounts(config = {}) {
  const list = []
  const seen = new Set()

  for (const entry of [...(config.accounts ?? []), ...(config.token ?? [])]) {
    const account = normalizeAccount(entry)
    if (!account.appid || !account.secret) continue
    const key = account.uin || account.appid
    if (seen.has(key)) continue
    seen.add(key)
    list.push(account)
  }

  return list
}

/** 账号摘要，供 #QQBot账号 之类的文字输出使用 */
export function describeAccount(account) {
  const flags = [
    account.group && "群Bot",
    account.guild && "频道",
    account.webhook && "WebHook",
  ]
    .filter(Boolean)
    .join("/")
  return `${account.uin}（AppID ${account.appid}${flags ? `，${flags}` : ""}）`
}
