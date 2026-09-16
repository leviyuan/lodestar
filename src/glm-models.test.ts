import { afterEach, expect, test } from 'bun:test'
import { fetchGlmAnthropicModelIds } from './glm-models'
import { fetchApiModelData } from './token-source-model-api'

const originalFetch = globalThis.fetch
const base = 'https://open.bigmodel.cn/api/anthropic'

afterEach(() => { globalThis.fetch = originalFetch })

function respond(payload: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(payload, { status })) as unknown as typeof fetch
}

test('GLM model catalog uses the configured route, bearer key and upstream names', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`${base}/v1/models`)
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-key')
    return Response.json({ data: [{ id: 'glm-5.3', display_name: 'GLM-5.3' }, { id: 'glm-4.7' }] })
  }) as unknown as typeof fetch
  expect(await fetchGlmAnthropicModelIds(`${base}/`, 'test-key')).toEqual(['GLM-5.3', 'glm-4.7'])
})

test.each([
  [200, { code: 401, msg: '令牌已过期或验证不正确', success: false }, 'HTTP 200: code=401: 令牌已过期或验证不正确'],
  [401, { error: { code: '401', message: '令牌已过期或验证不正确' } }, 'HTTP 401: code=401: 令牌已过期或验证不正确'],
  [200, { error: { type: 'authentication_error', message: 'invalid key' } }, 'HTTP 200: code=authentication_error: invalid key'],
  [200, { code: 401, msg: 'invalid key', data: [{ id: 'glm-5.3' }] }, 'HTTP 200: code=401: invalid key'],
  [200, { success: false, msg: 'permission denied', data: [{ id: 'glm-5.3' }] }, 'HTTP 200: permission denied'],
  [200, {}, '缺少 data 数组'],
  [200, { data: [] }, '模型目录为空'],
  [200, { data: [null] }, '模型目录包含无效条目'],
] as const)('GLM model errors preserve upstream diagnostics (HTTP %s, %j)', async (status, payload, message) => {
  respond(payload, status)
  await expect(fetchApiModelData(`${base}/v1/models`, 'test-key', 'GLM models')).rejects.toThrow(message)
})

test('GLM HTTP errors keep their status when a proxy returns HTML', async () => {
  globalThis.fetch = (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch
  await expect(fetchGlmAnthropicModelIds(base, 'test-key')).rejects.toThrow('HTTP 502: 响应不是有效 JSON')
})

test('GLM error messages redact any echoed credential', async () => {
  respond({ code: 401, msg: 'invalid token private-test-key', success: false })
  await expect(fetchGlmAnthropicModelIds(base, 'private-test-key')).rejects.toThrow('invalid token [redacted]')
})

test('GLM invalid model entries fail instead of producing a usable empty catalog', async () => {
  respond({ data: [{ display_name: '' }] })
  await expect(fetchGlmAnthropicModelIds(base, 'test-key')).rejects.toThrow('模型 id 无效')
})

test('GLM network failures remain visible', async () => {
  globalThis.fetch = (async () => { throw new Error('diagnostic connection refused') }) as unknown as typeof fetch
  await expect(fetchGlmAnthropicModelIds(base, 'test-key')).rejects.toThrow('diagnostic connection refused')
})
