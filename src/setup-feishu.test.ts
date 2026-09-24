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
    assert.deepEqual(await testFeishuCreds('test-id', 'test-secret'), { ok: true })
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    env: { ...process.env, HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
