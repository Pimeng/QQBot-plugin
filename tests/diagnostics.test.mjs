import assert from "node:assert/strict"
import test from "node:test"
import {
  accountDiag,
  describeCloseCode,
  describeError,
  describeErrorHint,
  maskSecret,
  redactDetail,
} from "../lib/utils/diagnostics.js"

test("账号摘要永远不输出 Secret 明文", () => {
  const summary = accountDiag({ uin: "4018856587", appid: "1904743720", secret: "sensitive-secret", group: true })
  const text = JSON.stringify(summary)
  assert.equal(summary.uin, "4018856587")
  assert.equal(summary.appid, "1904743720")
  assert.ok(!text.includes("sensitive-secret"))
  assert.match(summary.secret, /长度 16/)
  assert.equal(maskSecret(""), "***（已隐藏，长度 0）")
  // 日志格式化会再脱敏一次；已脱敏的值必须保留真实长度，否则每次都显示同一个数字。
  const formatted = redactDetail({ account: summary })
  assert.equal(formatted.account.secret, summary.secret)
  assert.match(formatted.account.secret, /长度 16/)
})

test("错误详情包含 HTTP 状态、平台错误码和排查提示", () => {
  const error = new Error('Request "/gateway/bot" failed with code(100016): appid或secret错误')
  error.code = 100016
  error.response = {
    status: 401,
    data: { code: 100016, message: "invalid app secret", access_token: "leaked-token" },
    headers: { "x-tps-trace-id": "trace-1" },
  }
  const detail = describeError(error, { phase: "login" })
  assert.equal(detail.phase, "login")
  assert.equal(detail.httpStatus, 401)
  assert.equal(detail.code, 100016)
  assert.equal(detail.traceId, "trace-1")
  assert.equal(detail.response.access_token, maskSecret("leaked-token"))
  assert.ok(!JSON.stringify(detail).includes("leaked-token"))
  assert.match(describeErrorHint(error), /AppSecret/)
  assert.equal(describeErrorHint(new Error("ENOTFOUND api.bot.qq.com")), "域名解析失败：检查网络 / DNS / 代理")
  assert.equal(describeErrorHint(new Error("其他错误")), "")
})

test("网关关闭码翻译成可执行结论", () => {
  assert.match(describeCloseCode(4014), /intents 无权限/)
  assert.match(describeCloseCode(4915), /封禁/)
  assert.equal(describeCloseCode(9999), "")
  assert.equal(describeCloseCode(undefined), "")
})
