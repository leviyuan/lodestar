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

async function runRecoveryScript(script: string): Promise<string> {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    import { FeishuRecoveryWindow, FeishuRequestError, readFeishuResponse, withFeishuRetry } from './src/feishu-retry'
    const delays = [], logs = []
    let now = 1800000000000
    Date.now = () => now
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      delays.push(ms)
      now += ms
      return originalSetTimeout(fn, 0, ...args)
    }
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...args) => {
      logs.push({ time: now, text: String(chunk) })
      return originalWrite(chunk, ...args)
    }
    ${script}
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(status, stdout + stderr).toBe(0)
  return stderr
}

test('a shared recovery window accepts success at 55 seconds and records only actual recovery', async () => {
  const stderr = await runRecoveryScript(`
    assert.equal(await withFeishuRetry('first-attempt success', async () => 'delivered', {
      api: 'cardkit', recovery: new FeishuRecoveryWindow(),
    }), 'delivered')
    for (const code of [300308, '300308']) {
      delays.length = 0
      const recovery = new FeishuRecoveryWindow(), startedAt = now
      const starts = [], timeouts = []
      const result = await withFeishuRetry('cardkit PUT', async () => {
        starts.push(now - startedAt)
        timeouts.push(recovery.timeoutMs(15000))
        if (starts.length < 5) {
          now += 3500
          throw new FeishuRequestError('server failure', 200, code, null, 'attempt-' + starts.length, 'Server Internal Error')
        }
        return 'delivered'
      }, { api: 'cardkit', recovery })
      assert.equal(result, 'delivered')
      assert.deepEqual(starts, [0, 6500, 18000, 36500, 55000])
      assert.deepEqual(timeouts, [15000, 15000, 15000, 15000, 5000])
      assert.deepEqual(delays, [3000, 8000, 15000, 15000])
      assert.equal(recovery.remainingMs(), 5000)
    }
  `)
  expect(stderr).not.toContain('first-attempt success')
  expect(stderr.match(/cardkit PUT recovered: attempts=5 elapsed=55000ms/g)).toHaveLength(2)
  expect(stderr).not.toContain('FINAL')
})

test('request time and waits share one deadline and exhaustion retains the final upstream error', async () => {
  await runRecoveryScript(`
    const recovery = new FeishuRecoveryWindow(), startedAt = now
    const starts = []
    let lastFailure
    const failure = await withFeishuRetry('cardkit PATCH', async () => {
      starts.push(now - startedAt)
      now += recovery.timeoutMs(15000)
      lastFailure = new FeishuRequestError('server failed', 200, 300308, null, 'final-' + starts.length, 'Server Internal Error')
      throw lastFailure
    }, { api: 'cardkit', recovery }).catch(error => error)
    assert.equal(now - startedAt, 60000)
    assert.deepEqual(starts, [0, 18000, 41000])
    assert.deepEqual(delays, [3000, 8000, 4000])
    assert.equal(failure, lastFailure)
    assert.equal(failure.logId, 'final-3')
    assert.equal(failure.code, 300308)
    assert.equal(failure.apiMessage, 'Server Internal Error')
    assert.equal(recovery.remainingMs(), 0)
    assert.throws(() => recovery.timeoutMs(15000), error => error === lastFailure)
    const expired = await withFeishuRetry('already expired', async () => assert.fail('request after deadline'), {
      api: 'cardkit', recovery,
    }).catch(error => error)
    assert.equal(expired, lastFailure)
    assert.equal(logs.filter(entry => entry.text.includes('; FINAL')).length, 1)
    assert.ok(logs.filter(entry => entry.text.includes('; FINAL')).every(entry => entry.time === startedAt + 60000))
    const empty = new FeishuRecoveryWindow()
    now += 60000
    assert.throws(() => empty.timeoutMs(15000), error => error.name === 'TimeoutError')
  `)
})

test('a fast outage is retried through the full minute instead of exhausting an attempt count', async () => {
  await runRecoveryScript(`
    const recovery = new FeishuRecoveryWindow(), startedAt = now
    const starts = []
    let lastFailure
    const failure = await withFeishuRetry('fast outage', async () => {
      starts.push(now - startedAt)
      lastFailure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      throw lastFailure
    }, { recovery }).catch(error => error)
    assert.deepEqual(starts, [0, 3000, 11000, 26000, 41000, 56000])
    assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000, 4000])
    assert.equal(now - startedAt, 60000)
    assert.equal(failure, lastFailure)
    assert.equal(logs.filter(entry => entry.text.includes('; FINAL')).length, 1)
    assert.ok(logs.filter(entry => entry.text.includes('; FINAL')).every(entry => entry.time === startedAt + 60000))
  `)
})

test('Retry-After beyond the window waits until its deadline without retrying or reporting early', async () => {
  await runRecoveryScript(`
    for (const header of ['Retry-After', 'X-Ogw-Ratelimit-Reset']) {
      for (const hint of ['60', '61', '120', 'date']) {
        const startedAt = now, recovery = new FeishuRecoveryWindow()
        const value = hint === 'date' ? new Date(now + 120000).toUTCString() : hint
        let timer, attempts = 0, settled = false, source
        globalThis.setTimeout = (fn, ms) => {
          assert.equal(ms, 60000)
          timer = fn
          return 1
        }
        const result = withFeishuRetry('long server cooldown', async () => {
          attempts++
          source = await readFeishuResponse(Response.json({ code: 230020, msg: 'rate limited', error: { log_id: 'cooldown-log' } }, {
            status: 429, headers: { [header]: value },
          }), 'rate limit').catch(error => error)
          throw source
        }, { recovery }).catch(error => error).then(error => { settled = true; return error })
        while (!timer && !settled) await new Promise(resolve => originalSetTimeout(resolve, 0))
        assert.ok(timer, 'failure must wait for the recovery deadline')
        assert.equal(settled, false)
        now = startedAt + 59999
        await Promise.resolve()
        assert.equal(settled, false)
        now = startedAt + 60000
        timer()
        const failure = await result
        assert.equal(settled, true)
        assert.equal(attempts, 1)
        assert.equal(failure, source)
        assert.equal(failure.code, 230020)
        assert.equal(failure.logId, 'cooldown-log')
        assert.equal(failure.retryAfter, value)
      }
    }
  `)
})

test('transport retry and explicit reconciliation share backoff, minimum delay and server hints', async () => {
  await runRecoveryScript(`
    for (const header of ['Retry-After', 'X-Ogw-Ratelimit-Reset']) {
      delays.length = 0
      const recovery = new FeishuRecoveryWindow(), startedAt = now
      const failure = new FeishuRequestError('server failed', 200, 300308, null, 'transient', 'Server Internal Error')
      const consumed = await readFeishuResponse(Response.json({ code: 200770, msg: 'UUID consumed' }, {
        headers: { [header]: '12' },
      }), 'confirm').catch(error => error)
      assert.equal(await recovery.waitForRetry('transport', failure), true)
      assert.equal(await recovery.waitForRetry('confirmation', consumed, 5000), true)
      assert.equal(await recovery.waitForRetry('confirmation again', consumed, 20000), true)
      assert.deepEqual(delays, [3000, 12000, 20000])
      assert.equal(now - startedAt, 35000)
      assert.equal(recovery.timeoutMs(15000), 15000)
      await recovery.waitUntilDeadline()
      assert.equal(now - startedAt, 60000)
      assert.throws(() => recovery.timeoutMs(15000), error => error === consumed)
    }
    delays.length = 0
    const recovery = new FeishuRecoveryWindow(), startedAt = now
    const dated = new FeishuRequestError('rate limited', 429, 230020, new Date(now + 12000).toUTCString())
    assert.equal(await recovery.waitForRetry('dated', dated), true)
    assert.deepEqual(delays, [12000])
    assert.equal(now - startedAt, 12000)
    await recovery.waitUntilDeadline()
    assert.equal(now - startedAt, 60000)
    assert.throws(() => recovery.timeoutMs(15000), error => error === dated)
  `)
})

test('permanent rejections remain immediate and api classification alone does not enable a recovery window', async () => {
  await runRecoveryScript(`
    for (const [code, message, api] of [
      [300308, 'Server Internal Error', undefined],
      [300308, 'unclassified API rejection', 'cardkit'],
      ...[200770, 300121, 300301, 300305, 300311, 300315, 300317].map(code => [code, 'Server Internal Error', 'cardkit']),
    ]) {
      delays.length = 0
      let attempts = 0
      const source = new FeishuRequestError('rejected', 200, code, null, 'permanent', message)
      const error = await withFeishuRetry('permanent request', async () => { attempts++; throw source }, {
        api, recovery: new FeishuRecoveryWindow(),
      }).catch(error => error)
      assert.equal(error, source)
      assert.equal(attempts, 1)
      assert.deepEqual(delays, [])
    }
    delays.length = 0
    let attempts = 0
    const source = new FeishuRequestError('server failed', 200, 300308, null, 'ordinary-cardkit', 'Server Internal Error')
    const failure = await withFeishuRetry('cardkit without window', async () => { attempts++; throw source }, {
      api: 'cardkit',
    }).catch(error => error)
    assert.equal(failure, source)
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [1000, 4000])
  `)
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
