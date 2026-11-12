import { expect, test } from 'bun:test'

test('fresh setup displays Feishu rejection messages and request IDs without requiring config', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { unlinkSync } from 'node:fs'
    import { mock } from 'bun:test'
    unlinkSync(process.env.LODESTAR_CONFIG)
    mock.module('node:readline/promises', () => ({ createInterface: () => ({ close() {} }) }))
    const { testFeishuCreds } = await import('./src/setup')
    globalThis.fetch = async () => Response.json({ code: 10014, msg: 'app secret invalid' }, {
      status: 400, headers: { 'x-tt-logid': 'setup-request-id' },
    })
    const failed = await testFeishuCreds('test-id', 'test-secret')
    assert.equal(failed.ok, false)
    assert.match(failed.error, /code=10014.*message=app secret invalid.*log_id=setup-request-id/)
    assert.ok(!failed.error.includes('test-secret'))

    globalThis.fetch = async () => { throw new Error('connection refused') }
    const offline = await testFeishuCreds('test-id', 'test-secret')
    assert.equal(offline.ok, false)
    assert.match(offline.error, /code=MISS.*message=connection refused.*log_id=MISS/)

    globalThis.fetch = async () => Response.json({ code: 0, tenant_access_token: 'valid-token' })
    assert.deepEqual(await testFeishuCreds('test-id', 'test-secret'), { ok: true, domain: 'feishu' })
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    env: { ...process.env, HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('a Lark app is detected only after the preferred cloud rejects the credentials', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { unlinkSync } from 'node:fs'
    import { mock } from 'bun:test'
    unlinkSync(process.env.LODESTAR_CONFIG)
    mock.module('node:readline/promises', () => ({ createInterface: () => ({ close() {} }) }))
    const { testFeishuCreds } = await import('./src/setup')
    const calls = []
    globalThis.fetch = async url => {
      calls.push(String(url))
      return String(url).startsWith('https://open.larksuite.com/')
        ? Response.json({ code: 0, tenant_access_token: 'lark-token' })
        : Response.json({ code: 1000040351, msg: 'Incorrect domain name' }, { status: 400 })
    }
    const detected = await testFeishuCreds('lark-id', 'lark-secret')
    assert.deepEqual(detected, { ok: true, domain: 'lark' })
    assert.equal(calls[0], 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
    assert.equal(calls[1], 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')

    // A working 飞书 app never consults the other cloud.
    calls.length = 0
    globalThis.fetch = async url => {
      calls.push(String(url))
      return Response.json({ code: 0, tenant_access_token: 'feishu-token' })
    }
    assert.deepEqual(await testFeishuCreds('feishu-id', 'feishu-secret'), { ok: true, domain: 'feishu' })
    assert.deepEqual(calls, ['https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'])
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    env: { ...process.env, HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
