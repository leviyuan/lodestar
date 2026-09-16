/** 给配置向导、群命令与模型目录共用的错误说明；保留诊断，但不回显凭据。 */
export function tokenSourceErrorMessage(error: unknown, secrets: Array<string | undefined> = []): string {
  let detail = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.cause instanceof Error && !detail.includes(error.cause.message)) {
    detail += `；${error.cause.message}`
  }
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, '[redacted]')
  let hint = ''
  if (/HTTP 401\b|code=(?:401|1000|1001|1003|1005)\b|authentication_error/i.test(detail)) {
    hint = '认证失败，请检查 API Key 是否完整、有效，并确认 Key 与接口所属平台一致'
  } else if (/HTTP 403\b|code=(?:403|1220)\b|permission_error/i.test(detail)) {
    hint = '访问被拒绝，请检查账号及 API Key 的接口权限'
  } else if (/HTTP 429\b|code=(?:429|1302|1305|1308|1309|1310|1311)\b/i.test(detail)) {
    hint = '请求受限，请按接口说明检查套餐、额度或稍后重试'
  } else if (/timeout|timed out|aborted|超时/i.test(detail)) {
    hint = '请求超时，请检查网络和代理后重试'
  } else if (/fetch failed|failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|network|代理/i.test(detail)) {
    hint = '连接失败，请检查网络、代理和接口地址后重试'
  } else if (/HTTP 404\b/i.test(detail)) {
    hint = '模型接口不存在，请检查 API 地址'
  } else if (/HTTP 5\d\d\b/i.test(detail)) {
    hint = '上游服务异常，请稍后重试'
  } else if (/data 数组|有效 JSON|无效条目|模型 id 无效/i.test(detail)) {
    hint = '模型接口返回异常，请检查 API 地址；持续出现时请反馈诊断信息'
  } else if (/模型目录为空|catalog is empty/i.test(detail)) {
    hint = '账号未返回可用模型，请检查套餐和模型权限'
  }
  return hint && !detail.startsWith(hint) ? `${hint}（${detail}）` : detail
}
