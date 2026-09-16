import { expect, test } from 'bun:test'
import { tokenSourceErrorMessage } from './token-source-errors'

test.each([
  ['GLM models HTTP 200: code=401: 令牌已过期或验证不正确', '认证失败'],
  ['HTTP 403: permission denied', '访问被拒绝'],
  ['HTTP 429: quota exceeded', '请求受限'],
  ['TimeoutError: timed out', '请求超时'],
  ['fetch failed', '连接失败'],
  ['HTTP 404', '模型接口不存在'],
  ['HTTP 502: 响应不是有效 JSON', '上游服务异常'],
  ['GLM models 缺少 data 数组', '模型接口返回异常'],
  ['GLM models 模型目录为空', '账号未返回可用模型'],
])('catalog diagnostics add actionable guidance to %s', (raw, hint) => {
  const formatted = tokenSourceErrorMessage(new Error(raw))
  expect(formatted).toContain(raw)
  expect(formatted).toStartWith(hint)
  expect(tokenSourceErrorMessage(formatted)).toBe(formatted)
})

test('nested transport diagnostics preserve the reason and redact all supplied credentials', () => {
  const error = new Error('fetch failed: key-one', { cause: new Error('ECONNREFUSED key-two') })
  const formatted = tokenSourceErrorMessage(error, ['key-one', 'key-two'])
  expect(formatted).toStartWith('连接失败')
  expect(formatted).toContain('ECONNREFUSED')
  expect(formatted).not.toContain('key-one')
  expect(formatted).not.toContain('key-two')
})
