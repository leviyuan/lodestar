import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { FeishuRequestError, readFeishuResponse } from './feishu-retry'

test('JSON response errors retain structured API message, body log_id and retry metadata', async () => {
  const response = Response.json({ code: 300121, msg: 'Failed to replace element', error: { log_id: 'body-log' } }, {
    status: 400, headers: { 'X-Tt-Logid': 'header-log', 'Retry-After': '2' },
  })
  const error = await readFeishuResponse(response, 'replaceElement tool_28').catch(error => error)
  expect(error).toBeInstanceOf(FeishuRequestError)
  expect(error.message).toBe('replaceElement tool_28 HTTP 400: code=300121 message=Failed to replace element log_id=body-log')
  expect(error.code).toBe(300121)
  expect(error.apiMessage).toBe('Failed to replace element')
  expect(error.logId).toBe('body-log')
  expect(error.status).toBe(400)
  expect(error.retryAfter).toBe('2')
})

test('JSON and non-JSON gateway failures preserve response-header request IDs', async () => {
  for (const [body, expectedMessage] of [
    [JSON.stringify({ code: 99991400, msg: 'busy' }), 'busy'],
    ['gateway unavailable', 'invalid JSON — gateway unavailable'],
  ]) {
    const response = new Response(body, {
      status: 503, headers: { 'X-Request-Id': 'gateway-log', 'X-Ogw-Ratelimit-Reset': '4' },
    })
    const error = await readFeishuResponse(response, 'upload').catch(error => error)
    expect(error).toBeInstanceOf(FeishuRequestError)
    expect(error.apiMessage).toBe(expectedMessage)
    expect(error.logId).toBe('gateway-log')
    expect(error.status).toBe(503)
    expect(error.retryAfter).toBe('4')
    expect(error.message).toContain(`message=${expectedMessage} log_id=gateway-log`)
  }
})

test('malformed success response exposes missing diagnostics; actual success is unchanged', async () => {
  const error = await readFeishuResponse(Response.json({ data: {} }), 'upload').catch(error => error)
  expect(error.message).toBe('upload HTTP 200: code=MISS message=MISS log_id=MISS')
  expect(await readFeishuResponse(Response.json({ code: 0, data: { file_key: 'key' } }), 'upload'))
    .toEqual({ code: 0, data: { file_key: 'key' } })
})

test('SDK rejection normalization preserves bounded retries, Retry-After and final diagnostics', async () => {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    import { FeishuRequestError, withFeishuRetry } from './src/feishu-retry'
    const timers = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      timers.push(ms)
      return originalSetTimeout(fn, 0, ...args)
    }
    for (const headers of [new Headers({ 'Retry-After': '2' }), { 'RETRY-AFTER': '2' }]) {
      timers.length = 0
      let attempts = 0
      const source = Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { code: 230020, msg: 'rate limited', error: { log_id: 'sdk-log' } }, headers },
      })
      const error = await withFeishuRetry('sendFile', async () => { attempts++; throw source }).catch(error => error)
      assert.equal(attempts, 3)
      assert.deepEqual(timers, [2000, 4000])
      assert.ok(error instanceof FeishuRequestError)
      assert.equal(error.code, 230020)
      assert.equal(error.status, 400)
      assert.equal(error.retryAfter, '2')
      assert.equal(error.apiMessage, 'rate limited')
      assert.equal(error.logId, 'sdk-log')
      assert.equal(error.cause, source)
      assert.equal(error.message, 'sendFile: code=230020 message=rate limited log_id=sdk-log')
    }
    for (const [status, code, retryAfter] of [[403, 99991672, undefined], [429, 230020, '120']]) {
      timers.length = 0
      let attempts = 0
      const error = await withFeishuRetry('sendFile', async () => {
        attempts++
        throw { response: { status, data: { code, msg: 'denied' }, headers: { 'Retry-After': retryAfter, 'REQUEST-ID': 'denied-log' } } }
      }).catch(error => error)
      assert.equal(attempts, 1)
      assert.deepEqual(timers, [])
      assert.equal(error.logId, 'denied-log')
      assert.equal(error.code, code)
    }
    timers.length = 0
    let attempts = 0
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const error = await withFeishuRetry('fetch', async () => { attempts++; throw failure }).catch(error => error)
    assert.equal(error, failure)
    assert.equal(attempts, 3)
    assert.deepEqual(timers, [1000, 4000])
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(status, stdout + stderr).toBe(0)
})
