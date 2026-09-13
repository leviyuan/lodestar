import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Exercise the real wrappers without the shared feishu mock, credentials or
// external requests. Only retry timers are accelerated, with their delays checked.
async function runIsolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    const feishu = await import('./src/feishu')
    const delays = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      assert.ok([1000, 2000, 4000].includes(ms), 'unexpected timer: ' + ms)
      delays.push(ms)
      return originalSetTimeout(fn, 0, ...args)
    }
    globalThis.fetch = async () => { throw new Error('unexpected network request') }
    feishu.client.im.message.create = async () => { throw new Error('unexpected SDK call') }
    ${script}
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      NO_PROXY: '*', no_proxy: '*',
    }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, stdout + stderr).toBe(0)
}

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
      assert.deepEqual(delays, [1000, 4000])
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
      assert.deepEqual(delays, [])
    }
    let calls = 0
    delays.length = 0
    feishu.client.im.message.create = async () => {
      if (++calls === 1) throw Object.assign(new Error('rate limited'), { response: { status: 429, headers: { 'retry-after': '2' } } })
      return { code: 0, data: { message_id: 'after-rate-limit' } }
    }
    assert.equal(await feishu.sendFile('chat', 'key'), 'after-rate-limit')
    assert.deepEqual(delays, [2000])
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
      assert.deepEqual(delays, [failure instanceof Error ? 2000 : 1000])
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
      assert.deepEqual(delays, [1000])

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
        assert.deepEqual(delays, [1000, 4000, 1000])
      }
      for (const [failure, delay] of [
        [() => new Response('busy', { status: 429, headers: { 'Retry-After': '2' } }), 2000],
        [() => Response.json({ code: 99991400, msg: 'rate limited' }, { status: 400, headers: { 'x-ogw-ratelimit-reset': '2' } }), 2000],
        [() => { throw new DOMException('upload timed out', 'TimeoutError') }, 1000],
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
          assert.deepEqual(delays, [1000])
        }
      } finally { AbortSignal.timeout = originalTimeout }
    } finally { rmSync(root, { recursive: true, force: true }) }
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
      assert.equal(sends.length, 3)
      assert.equal(new Set(sends.map(send => send.uuid)).size, 1)
      assert.equal(notices.length, 1)
      assert.match(notices[0], /出站文件发送失败.*report.txt/)
      assert.deepEqual(delays, [1000, 4000])

      for (const [response, expectedAttempts] of [
        [() => new Response('busy', { status: 503 }), 3],
        [() => Response.json({ code: 234002, msg: 'unauthorized' }, { status: 401 }), 1],
        [() => Response.json({ code: 234001, msg: 'invalid parameters' }), 1],
        [() => Response.json({ code: 0, data: {} }), 1],
        [() => Response.json({ data: { file_key: 'missing-code' } }), 1],
        [() => new Response('invalid JSON'), 1],
        [() => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }), 1],
      ]) {
        uploads = 0; notices.length = 0; sends.length = 0; delays.length = 0
        globalThis.fetch = async () => { uploads++; return response() }
        assert.equal(await feishu.uploadAndSend('chat', path), false)
        assert.equal(uploads, expectedAttempts)
        assert.equal(sends.length, 0)
        assert.equal(notices.length, 1)
        assert.match(notices[0], /出站文件上传失败.*report.txt/)
        assert.equal(delays.length, expectedAttempts - 1)
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
