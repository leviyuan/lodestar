import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Exercise the real wrappers without the shared feishu mock, credentials or
// external requests. Only retry timers are accelerated, with their delays checked.
async function runIsolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    const feishu = await import('./src/feishu')
    const delays = []
    let now = 1800000000000
    Date.now = () => now
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      assert.ok(Number.isFinite(ms) && ms >= 0 && ms <= 32 * 60000, 'unexpected timer: ' + ms)
      delays.push(ms)
      now += ms
      return originalSetTimeout(fn, 0, ...args)
    }
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    feishu.client.im.message.create = async () => { throw new Error('unexpected SDK call') }
    ${script}
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      NO_PROXY: '*', no_proxy: '*',
    }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
}

test('SDK diagnostics preserve header request IDs, HTTP response messages and task permission scopes', async () => {
  await runIsolated(`
    const body = { code: 99991672, msg: 'missing application permission', error: {
      permission_violations: [{ scope: 'task:tasklist:write' }],
    } }
    const response = await feishu.client.httpInstance.request({
      url: 'https://example.invalid/diagnostics',
      adapter: async config => {
        assert.match(config.headers.get('User-Agent'), /lark|oapi/i)
        return { config, data: body, status: 200, statusText: 'OK', headers: { 'x-tt-logid': 'sdk-business-log' } }
      },
    })
    assert.equal(response.log_id, 'sdk-business-log')
    assert.equal(response.msg, body.msg)
    const envelope = await feishu.client.httpInstance.post('https://example.invalid/headers', { test: 'body' }, {
      $return_headers: true,
      adapter: async config => {
        assert.equal(config.method, 'post')
        assert.deepEqual(JSON.parse(config.data), { test: 'body' })
        return { config, data: { code: 0, data: {} }, status: 200, statusText: 'OK', headers: { 'x-tt-logid': 'sdk-envelope-log' } }
      },
    })
    assert.equal(envelope.data.code, 0)
    assert.equal(envelope.headers['x-tt-logid'], 'sdk-envelope-log')
    feishu.client.im.v1.message.patch = async () => response
    await assert.rejects(feishu.updateCard('message', {}), error => {
      assert.match(error.message, /code=99991672/)
      assert.match(error.message, /message=missing application permission/)
      assert.match(error.message, /log_id=sdk-business-log/)
      return true
    })

    const failure = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { code: body.code, msg: body.msg, error: body.error }, headers: { 'x-tt-logid': 'sdk-http-log' } },
    })
    feishu.client.task.v2.tasklist.create = () => feishu.client.httpInstance.request({
      url: 'https://example.invalid/diagnostics', adapter: async () => { throw failure },
    })
    await assert.rejects(feishu.createTasklistWithOwner('project', 'owner'), error => {
      assert.match(error.message, /code=99991672/)
      assert.match(error.message, /message=missing application permission/)
      assert.match(error.message, /log_id=sdk-http-log/)
      assert.match(error.message, /missing_scopes=task:tasklist:write/)
      return true
    })
    assert.equal(failure.response.data.error.permission_violations[0].scope, 'task:tasklist:write')
  `)
})

test('send and upload failure callbacks expose the final Feishu message and log ID', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-failure-details-'))
    try {
      const failures = []
      feishu.client.im.message.create = async () => ({ code: 230001, msg: 'invalid receiver', error: { log_id: 'send-log' } })
      assert.equal(await feishu.sendCard('chat', {}, error => failures.push(error)), null)
      assert.equal(failures.length, 1)
      assert.match(failures[0].message, /code=230001.*message=invalid receiver.*log_id=send-log/)

      const png = join(root, 'picture.png')
      writeFileSync(png, 'png')
      globalThis.fetch = async url => String(url).includes('/tenant_access_token/')
        ? Response.json({ code: 0, tenant_access_token: 'test-token' })
        : Response.json({ code: 99991672, msg: 'image upload forbidden' }, { status: 403, headers: { 'x-tt-logid': 'upload-log' } })
      assert.equal(await feishu.uploadImageKey(png, error => failures.push(error)), null)
      assert.equal(failures.length, 2)
      assert.match(failures[1].message, /code=99991672.*message=image upload forbidden.*log_id=upload-log/)

      globalThis.fetch = async () => Response.json({ code: 0, data: { image_key: 'uploaded' } })
      const notices = []
      feishu.client.im.message.create = async args => {
        if (args.data.msg_type === 'image') return { code: 230001, msg: 'delivery rejected', error: { log_id: 'delivery-log' } }
        notices.push(JSON.parse(args.data.content).text)
        return { code: 0, data: { message_id: 'notice' } }
      }
      assert.equal(await feishu.uploadAndSend('chat', png), false)
      assert.equal(notices.length, 1)
      assert.match(notices[0], /上传已完成/)
      assert.match(notices[0], /code=230001.*message=delivery rejected.*log_id=delivery-log/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  `)
})

test('all message types retry transient SDK failures with the same UUID and reject permanent or incomplete responses', async () => {
  await runIsolated(`
    for (const [type, send] of [
      ['file', () => feishu.sendFile('chat', 'file-key')],
      ['image', () => feishu.sendImage('chat', 'image-key')],
      ['text', () => feishu.sendText('chat', 'hello')],
      ['interactive', () => feishu.sendCard('chat', { schema: '2.0', body: { elements: [] } })],
    ]) {
      const calls = []
      delays.length = 0
      feishu.client.im.message.create = async args => {
        calls.push(args)
        if (calls.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) })
        if (calls.length === 2) throw Object.assign(new Error('gateway unavailable'), { response: { status: 503 } })
        return { code: 0, data: { message_id: 'delivered-' + type } }
      }
      assert.equal(await send(), 'delivered-' + type)
      assert.equal(calls.length, 3)
      assert.ok(calls[0].data.uuid)
      assert.equal(new Set(calls.map(call => call.data.uuid)).size, 1)
      assert.equal(new Set(calls.map(call => call.data.content)).size, 1)
      assert.ok(calls.every(call => call.data.msg_type === type))
      assert.deepEqual(delays, [3000, 8000])
      await send()
      assert.notEqual(calls[3].data.uuid, calls[0].data.uuid, 'new delivery gets a new UUID')
    }
    for (const failure of [
      { code: 230001, msg: 'invalid parameter' },
      { code: 0, data: {} }, { code: 0, data: { message_id: 42 } },
      { data: { message_id: 'missing-code' } },
      Object.assign(new Error('forbidden'), { response: { status: 403 } }),
      Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }),
      Object.assign(new Error('cancelled'), { name: 'AbortError' }),
      new TypeError('programming error'),
    ]) {
      let calls = 0
      delays.length = 0
      feishu.client.im.message.create = async () => {
        calls++
        if (failure instanceof Error) throw failure
        return failure
      }
      assert.equal(await feishu.sendFile('chat', 'key'), null)
      assert.equal(calls, 1)
      assert.deepEqual(delays, failure.name === 'AbortError' ? [] : [60000])
    }
    let calls = 0
    delays.length = 0
    feishu.client.im.message.create = async () => {
      if (++calls === 1) throw Object.assign(new Error('rate limited'), { response: { status: 429, headers: { 'retry-after': '2' } } })
      return { code: 0, data: { message_id: 'after-rate-limit' } }
    }
    assert.equal(await feishu.sendFile('chat', 'key'), 'after-rate-limit')
    assert.deepEqual(delays, [3000])
    for (const failure of [
      { code: 230020, msg: 'group rate limit' },
      { code: 99991400, msg: 'application rate limit' },
      Object.assign(new Error('rate limited'), { response: { status: 400, data: { code: 230020 }, headers: { 'x-ogw-ratelimit-reset': '2' } } }),
    ]) {
      calls = 0; delays.length = 0
      feishu.client.im.message.create = async () => {
        if (++calls > 1) return { code: 0, data: { message_id: 'after-business-rate-limit' } }
        if (failure instanceof Error) throw failure
        return failure
      }
      assert.equal(await feishu.sendFile('chat', 'key'), 'after-business-rate-limit')
      assert.equal(calls, 2)
      assert.deepEqual(delays, [3000])
    }
  `)
})

test('Drive explicit retryable errors use the shared bounded retry policy', async () => {
  await runIsolated(`
    const { withFeishuRetry, FeishuRequestError } = await import('./src/feishu-retry')
    let attempts = 0
    const value = await withFeishuRetry('Drive upload', async () => {
      if (++attempts < 3) throw new FeishuRequestError('can retry', 400, 1061045)
      return 'uploaded'
    })
    assert.equal(value, 'uploaded')
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [1000, 4000])
  `)
})

test('outbound SDK requests recover after 55 seconds with their original UUID and remaining transport timeout', async () => {
  await runIsolated(`
    const calls = [], failures = []
    const started = now
    feishu.client.im.message.create = args => feishu.client.httpInstance.request({
      url: 'https://example.invalid/output', method: 'POST', data: args.data,
      adapter: async config => {
        calls.push(JSON.parse(config.data))
        assert.equal(config.timeout, calls.length === 1 ? 15000 : 5000)
        assert.ok(config.signal instanceof AbortSignal)
        if (calls.length === 1) throw Object.assign(new Error('brief outage'), {
          response: { status: 503, data: { code: 99991400, msg: 'try later', log_id: 'recoverable' }, headers: { 'retry-after': '55' } },
        })
        return { config, data: { code: 0, data: { message_id: 'recovered' } }, status: 200, statusText: 'OK', headers: {} }
      },
    })
    assert.equal(await feishu.sendText('chat', 'pending output', error => failures.push(error)), 'recovered')
    assert.equal(now - started, 55000)
    assert.deepEqual(delays, [55000])
    assert.equal(failures.length, 0)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].uuid, calls[1].uuid)
    assert.equal(calls[0].content, calls[1].content)
  `)
})

test('outbound failure callbacks wait one minute and preserve final diagnostics without repeating permanent rejections', async () => {
  await runIsolated(`
    for (const permanent of [false, true]) {
      const started = now, failures = []
      let attempts = 0
      delays.length = 0
      feishu.client.im.message.create = async () => {
        attempts++
        assert.equal(failures.length, 0)
        return { code: permanent ? 230001 : 230020, msg: permanent ? 'invalid receiver' : 'temporary limit', error: { log_id: 'final-' + attempts } }
      }
      assert.equal(await feishu.sendCard('chat', {}, error => {
        assert.equal(now - started, 60000)
        failures.push(error)
      }), null)
      assert.equal(attempts, permanent ? 1 : 6)
      assert.equal(failures.length, 1)
      assert.equal(failures[0].logId, 'final-' + attempts)
      assert.equal(failures[0].apiMessage, permanent ? 'invalid receiver' : 'temporary limit')
      assert.equal(now - started, 60000)
    }
  `)
})

test('chat-tail reads and ordinary card replacements share the output recovery policy', async () => {
  await runIsolated(`
    for (const kind of ['tail', 'patch']) {
      const started = now
      let attempts = 0
      const argsSeen = []
      const operation = async args => {
        argsSeen.push(args)
        if (++attempts === 1) throw Object.assign(new Error('brief outage'), {
          response: { status: 503, headers: { 'retry-after': '55' } },
        })
        return { code: 0, data: { items: [{ message_id: 'actual-tail' }] } }
      }
      if (kind === 'tail') {
        feishu.client.im.message.list = operation
        assert.equal(await feishu.getChatTailMessageId('chat'), 'actual-tail')
      } else {
        feishu.client.im.v1.message.patch = operation
        await feishu.updateCard('card-message', { schema: '2.0', body: { elements: [] } })
      }
      assert.equal(now - started, 55000)
      assert.equal(attempts, 2)
      assert.deepEqual(argsSeen[0], argsSeen[1])
    }
  `)
})

test('expired token waiters stop output without cancelling the shared refresh or sending a late upload', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-token-deadline-'))
    const png = join(root, 'picture.png')
    writeFileSync(png, 'image bytes')
    const originalTimeout = AbortSignal.timeout
    const timers = [], failures = []
    let resolveToken, tokenCalls = 0, uploadCalls = 0
    AbortSignal.timeout = ms => {
      const controller = new AbortController()
      timers.push({ ms, controller })
      return controller.signal
    }
    globalThis.fetch = async url => {
      if (String(url).includes('/tenant_access_token/')) {
        tokenCalls++
        return new Promise(resolve => { resolveToken = resolve })
      }
      uploadCalls++
      throw new Error('expired operation must not upload')
    }
    try {
      const started = now
      const upload = feishu.uploadImageKey(png, error => failures.push(error))
      while (!resolveToken) await new Promise(resolve => originalSetTimeout(resolve, 0))
      const shared = feishu.getTenantToken()
      assert.equal(tokenCalls, 1)
      const waiter = timers.find(timer => timer.ms === 60000)
      assert.ok(waiter)
      now += 60000
      waiter.controller.abort(new DOMException('waiter expired', 'TimeoutError'))
      assert.equal(await upload, null)
      assert.equal(now - started, 60000)
      assert.equal(failures.length, 1)
      assert.equal(uploadCalls, 0)
      assert.equal(timers.find(timer => timer.ms === 15000).controller.signal.aborted, false)
      resolveToken(Response.json({ code: 0, tenant_access_token: 'shared-token' }))
      assert.equal(await shared, 'shared-token')
      await Promise.resolve()
      assert.equal(uploadCalls, 0)
    } finally {
      AbortSignal.timeout = originalTimeout
      rmSync(root, { recursive: true, force: true })
    }
  `)
})

test('interactive card replacement requires explicit API confirmation', async () => {
  await runIsolated(`
    const card = { schema: '2.0', body: { elements: [] } }
    for (const response of [undefined, null, {}, { data: {} }, { code: '0' }, { code: 230001, msg: 'invalid card' }]) {
      feishu.client.im.v1.message.patch = async () => response
      await assert.rejects(feishu.updateCard('message', card), /feishu message.patch failed/)
    }
    feishu.client.im.v1.message.patch = async args => {
      assert.equal(args.path.message_id, 'message')
      assert.deepEqual(JSON.parse(args.data.content), card)
      return { code: 0 }
    }
    await feishu.updateCard('message', card)
  `)
})

test('simultaneous same-name attachments retain separate bytes in the shared inbox', async () => {
  await runIsolated(`
    const { readFileSync, rmSync } = await import('node:fs')
    const originalNow = Date.now
    const paths = []
    try {
      Date.now = () => 1800000000000
      globalThis.fetch = async url => {
        if (String(url).includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 'test-token' })
        return new Response(String(url).includes('/message-a/') ? 'first private report' : 'second private report')
      }
      paths.push(...await Promise.all([
        feishu.downloadAttachment('message-a', 'key-a', 'file', 'report.txt'),
        feishu.downloadAttachment('message-b', 'key-b', 'file', 'report.txt'),
      ]))
      assert.ok(paths.every(path => typeof path === 'string'))
      assert.notEqual(paths[0], paths[1], 'shared inbox paths must not collide across messages')
      assert.equal(readFileSync(paths[0], 'utf8'), 'first private report')
      assert.equal(readFileSync(paths[1], 'utf8'), 'second private report')
    } finally {
      Date.now = originalNow
      for (const path of new Set(paths)) if (path) rmSync(path, { force: true })
    }
  `)
})

test('uploads retry token failures and rebuild multipart bodies; message retries reuse the uploaded key', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-outbound-'))
    const png = join(root, 'picture.png')
    writeFileSync(png, 'image content')
    try {
      let tokenCalls = 0
      globalThis.fetch = async url => {
        if (String(url).includes('/tenant_access_token/')) {
          if (++tokenCalls === 1) return new Response('gateway unavailable', { status: 503 })
          return Response.json({ code: 0, tenant_access_token: 'test-token' })
        }
        return Response.json({ code: 0, data: { image_key: 'token-recovered' } })
      }
      assert.equal(await feishu.uploadImageKey(png), 'token-recovered')
      assert.equal(tokenCalls, 2)
      assert.deepEqual(delays, [3000])

      for (const [type, extension] of [['file', 'txt'], ['image', 'png']]) {
        const path = join(root, '附件.' + extension)
        writeFileSync(path, 'complete upload contents')
        const forms = [], signals = [], sends = []
        delays.length = 0
        globalThis.fetch = async (url, init) => {
          assert.ok(String(url).endsWith('/im/v1/' + type + 's'))
          forms.push(init.body)
          signals.push(init.signal)
          assert.equal(await init.body.get(type).text(), 'complete upload contents')
          assert.equal(init.body.get(type).name, '附件.' + extension)
          if (type === 'image') assert.equal(init.body.get('image_type'), 'message')
          else {
            assert.equal(init.body.get('file_type'), 'stream')
            assert.equal(init.body.get('file_name'), '附件.txt')
          }
          if (forms.length === 1) {
            writeFileSync(path, 'changed while retrying')
            throw Object.assign(new Error('connection refused'), { code: 'ConnectionRefused' })
          }
          if (forms.length === 2) return new Response('<html>bad gateway</html>', { status: 502 })
          return Response.json({ code: 0, data: { [type + '_key']: 'uploaded-once' } })
        }
        feishu.client.im.message.create = async args => {
          sends.push(args.data)
          assert.equal(args.data.msg_type, type)
          assert.equal(JSON.parse(args.data.content)[type + '_key'], 'uploaded-once')
          if (sends.length === 1) throw Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' })
          return { code: 0, data: { message_id: 'delivered' } }
        }
        assert.equal(await feishu.uploadAndSend('chat', path), true)
        assert.equal(forms.length, 3, 'send retry must not upload again')
        assert.equal(new Set(forms).size, 3)
        assert.equal(new Set(signals).size, 3)
        assert.equal(sends.length, 2)
        assert.equal(sends[0].uuid, sends[1].uuid)
        assert.deepEqual(delays, [3000, 8000, 3000])
      }
      for (const [failure, delay] of [
        [() => new Response('busy', { status: 429, headers: { 'Retry-After': '2' } }), 3000],
        [() => Response.json({ code: 99991400, msg: 'rate limited' }, { status: 400, headers: { 'x-ogw-ratelimit-reset': '2' } }), 3000],
        [() => { throw new DOMException('upload timed out', 'TimeoutError') }, 3000],
      ]) {
        let attempts = 0
        delays.length = 0
        globalThis.fetch = async () => ++attempts === 1 ? failure() : Response.json({ code: 0, data: { image_key: 'recovered' } })
        assert.equal(await feishu.uploadImageKey(png), 'recovered')
        assert.equal(attempts, 2)
        assert.deepEqual(delays, [delay])
      }
      // node-fetch rejects a timed-out fetch/body with AbortError. The owned
      // signal's TimeoutError must still trigger retries on the Node runtime.
      const originalTimeout = AbortSignal.timeout
      try {
        for (const phase of ['headers', 'body']) {
          let controller, attempts = 0
          delays.length = 0
          AbortSignal.timeout = () => {
            controller = new AbortController()
            return controller.signal
          }
          globalThis.fetch = async () => {
            if (++attempts > 1) return Response.json({ code: 0, data: { image_key: 'after-node-timeout' } })
            controller.abort(new DOMException('deadline exceeded', 'TimeoutError'))
            const error = new DOMException('The operation was aborted', 'AbortError')
            if (phase === 'headers') throw error
            return new Response(new ReadableStream({ start(stream) { stream.error(error) } }))
          }
          assert.equal(await feishu.uploadImageKey(png), 'after-node-timeout')
          assert.equal(attempts, 2)
          assert.deepEqual(delays, [3000])
        }
      } finally { AbortSignal.timeout = originalTimeout }
    } finally { rmSync(root, { recursive: true, force: true }) }
  `)
})

test('file uploads allow five-minute attempts and five retries, including Node timeout errors', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-slow-upload-'))
    const path = join(root, 'video.mp4')
    writeFileSync(path, 'video bytes')
    const originalTimeout = AbortSignal.timeout
    try {
      globalThis.fetch = async () => Response.json({ code: 0, tenant_access_token: 'test-token' })
      await feishu.getTenantToken()
      const timers = new WeakMap()
      AbortSignal.timeout = ms => {
        const controller = new AbortController()
        timers.set(controller.signal, { ms, controller })
        return controller.signal
      }
      for (const succeeds of [true, false]) {
        const started = now, starts = [], forms = [], signals = [], sent = []
        delays.length = 0
        globalThis.fetch = async (url, init) => {
          assert.ok(String(url).endsWith('/im/v1/files'))
          const timer = timers.get(init.signal)
          assert.equal(timer.ms, 300000)
          starts.push(now - started)
          forms.push(init.body)
          signals.push(init.signal)
          assert.equal(await init.body.get('file').text(), 'video bytes')
          if (starts.length === 6 && succeeds) {
            now += 120000
            return Response.json({ code: 0, data: { file_key: 'slow-upload' } })
          }
          now += timer.ms
          timer.controller.abort(new DOMException('upload attempt ' + starts.length + ' timed out', 'TimeoutError'))
          const error = new DOMException('The operation was aborted', 'AbortError')
          if (starts.length % 2) throw error
          return new Response(new ReadableStream({ start(stream) { stream.error(error) } }))
        }
        feishu.client.im.message.create = async args => {
          sent.push(args.data)
          return { code: 0, data: { message_id: 'result' } }
        }
        assert.equal(await feishu.uploadAndSend('chat', path), succeeds)
        assert.deepEqual(starts, [0, 303000, 611000, 926000, 1241000, 1556000])
        assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000])
        assert.equal(new Set(forms).size, 6)
        assert.equal(new Set(signals).size, 6)
        assert.equal(now - started, succeeds ? 1676000 : 1856000)
        assert.equal(sent.length, 1)
        assert.equal(sent[0].msg_type, succeeds ? 'file' : 'text')
        if (succeeds) assert.equal(JSON.parse(sent[0].content).file_key, 'slow-upload')
        else assert.match(JSON.parse(sent[0].content).text, /code=23 message=upload attempt 6 timed out/)
      }
    } finally {
      AbortSignal.timeout = originalTimeout
      rmSync(root, { recursive: true, force: true })
    }
  `)
})

test('file uploads honor server cooldown and cap their last request at the remaining total budget', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-upload-deadline-'))
    const path = join(root, 'report.txt')
    writeFileSync(path, 'report')
    const originalTimeout = AbortSignal.timeout
    try {
      globalThis.fetch = async () => Response.json({ code: 0, tenant_access_token: 'test-token' })
      await feishu.getTenantToken()
      const timeouts = [], notices = []
      let controller, attempts = 0
      AbortSignal.timeout = ms => {
        timeouts.push(ms)
        controller = new AbortController()
        return controller.signal
      }
      globalThis.fetch = async () => {
        if (++attempts === 1) return new Response('busy', { status: 503, headers: { 'Retry-After': '1800' } })
        now += timeouts.at(-1)
        controller.abort(new DOMException('total upload deadline', 'TimeoutError'))
        throw new DOMException('The operation was aborted', 'AbortError')
      }
      feishu.client.im.message.create = async args => {
        notices.push(JSON.parse(args.data.content).text)
        return { code: 0, data: { message_id: 'error-notice' } }
      }
      const started = now
      assert.equal(await feishu.uploadAndSend('chat', path), false)
      assert.equal(attempts, 2)
      assert.deepEqual(timeouts, [300000, 120000])
      assert.deepEqual(delays, [1800000])
      assert.equal(now - started, 1920000)
      assert.equal(notices.length, 1)
      assert.match(notices[0], /code=23 message=total upload deadline/)
    } finally {
      AbortSignal.timeout = originalTimeout
      rmSync(root, { recursive: true, force: true })
    }
  `)
})

test('upload and send exhaustion produce visible errors; invalid files and permanent rejections do not retry', async () => {
  await runIsolated(`
    const { mkdtempSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-outbound-fail-'))
    const path = join(root, 'report.txt')
    writeFileSync(path, 'report')
    const notices = [], sends = []
    feishu.client.im.message.create = async args => {
      if (args.data.msg_type === 'text') {
        notices.push(JSON.parse(args.data.content).text)
        return { code: 0, data: { message_id: 'error-notice' } }
      }
      sends.push(args.data)
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    }
    let uploads = 0
    globalThis.fetch = async url => {
      if (String(url).includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 'test-token' })
      uploads++
      return Response.json({ code: 0, data: { file_key: 'uploaded-key' } })
    }
    try {
      assert.equal(await feishu.uploadAndSend('chat', path), false)
      assert.equal(uploads, 1)
      assert.equal(sends.length, 6)
      assert.equal(new Set(sends.map(send => send.uuid)).size, 1)
      assert.equal(notices.length, 1)
      assert.match(notices[0], /出站文件发送失败.*report.txt/)
      assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000, 4000])

      for (const [response, expectedAttempts, expectedWait] of [
        [() => new Response('busy', { status: 503 }), 6, 56000],
        [() => Response.json({ code: 234002, msg: 'unauthorized' }, { status: 401 }), 1, 0],
        [() => Response.json({ code: 234001, msg: 'invalid parameters' }), 1, 0],
        [() => Response.json({ code: 0, data: {} }), 1, 0],
        [() => Response.json({ data: { file_key: 'missing-code' } }), 1, 0],
        [() => new Response('invalid JSON'), 1, 0],
        [() => { throw new DOMException('cancelled', 'AbortError') }, 1, 0],
        [() => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }), 6, 600000],
        [() => new Response('busy', { status: 429, headers: { 'Retry-After': '2000' } }), 1, 1920000],
      ]) {
        uploads = 0; notices.length = 0; sends.length = 0; delays.length = 0
        globalThis.fetch = async () => { uploads++; return response() }
        assert.equal(await feishu.uploadAndSend('chat', path), false)
        assert.equal(uploads, expectedAttempts)
        assert.equal(sends.length, 0)
        assert.equal(notices.length, 1)
        assert.match(notices[0], /出站文件上传失败.*report.txt/)
        assert.match(notices[0], /code=.*message=.*log_id=/)
        assert.equal(delays.reduce((sum, delay) => sum + delay, 0), expectedWait)
      }
      globalThis.fetch = async () => { throw new Error('invalid file must not upload') }
      const fd = openSync(path, 'w')
      try { ftruncateSync(fd, feishu.MAX_UPLOAD_BYTES + 1) } finally { closeSync(fd) }
      for (const badPath of [path, root, join(root, 'missing.txt')]) {
        notices.length = 0; delays.length = 0
        assert.equal(await feishu.uploadAndSend('chat', badPath), false)
        assert.equal(notices.length, 1)
        assert.deepEqual(delays, [])
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  `)
})


test('SDK logger drops normal chatter and excludes identities, bodies, paths and credentials from failures', async () => {
  await runIsolated(`
    const output = []
    const originalWrite = process.stderr.write
    process.stderr.write = chunk => { output.push(String(chunk)); return true }
    try {
      const privateText = 'user-private@example.invalid oc_private_chat project-private /Users/private/report.txt Bearer private-token'
      const details = Object.assign(new Error('permission denied ' + privateText), {
        code: 'EACCES', response: { status: 403, data: { code: 99991672, msg: privateText } },
        config: { headers: { Authorization: privateText }, data: privateText },
      })
      for (const level of ['info', 'debug', 'trace']) feishu.client.logger[level](privateText, details)
      assert.equal(output.length, 0)
      feishu.client.logger.error(details)
      feishu.client.logger.warn(details)
      const text = output.join('')
      assert.match(text, /feishu sdk error/)
      assert.match(text, /status=403/)
      assert.match(text, /code=99991672/)
      assert.doesNotMatch(text, /user-private|oc_private_chat|project-private|Users|report[.]txt|private-token|Authorization/)
    } finally { process.stderr.write = originalWrite }
  `)
})
