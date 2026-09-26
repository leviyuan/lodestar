import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Keep accelerated retry timers and the real HTTP wrappers isolated from the
// shared Session mocks. The preload supplies private test configuration/state.
async function runIsolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    const cardkit = await import('./src/cardkit')
    const delays = [], calls = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      assert.ok([1000, 2000, 4000].includes(ms), 'unexpected timer: ' + ms)
      delays.push(ms)
      return originalSetTimeout(fn, 0, ...args)
    }
    let respond = async () => { throw new Error('unexpected card request') }
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/tenant_access_token/')) {
        return Response.json({ code: 0, tenant_access_token: 'test-token' })
      }
      assert.ok(String(url).startsWith('https://open.feishu.cn/open-apis/cardkit/v1/'))
      const call = {
        method: init.method, path: new URL(url).pathname.replace('/open-apis/cardkit/v1', ''),
        raw: init.body, body: JSON.parse(init.body), signal: init.signal,
      }
      calls.push(call)
      return respond(call)
    }
    const reset = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const element = (content = 'working') => ({ tag: 'markdown', element_id: 'tool_19', content })
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

test('lost acknowledgements retry queued mutations once per UUID and dispose waits for delivery', async () => {
  await runIsolated(`
    const failures = [], accepted = new Map(), remote = new Map()
    let closingSettings
    cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
    respond = async call => {
      const { body, method } = call
      assert.match(body.uuid, /^[a-f0-9-]{36}$/)
      if (accepted.has(body.uuid)) {
        assert.equal(call.raw, accepted.get(body.uuid), 'retry must be byte-for-byte identical')
        return Response.json({ code: 0 })
      }
      accepted.set(body.uuid, call.raw)
      if (method === 'POST') {
        const next = JSON.parse(body.elements)[0]
        assert.equal(remote.has(next.element_id), false, 'must not insert the element twice')
        remote.set(next.element_id, next)
      } else if (method === 'PUT') {
        assert.equal(remote.get('tool_19').content, 'working')
        remote.set('tool_19', JSON.parse(body.element))
      } else if (method === 'DELETE') {
        assert.equal(remote.get('tool_19').content, 'done')
        remote.delete('tool_19')
      } else if (method === 'PATCH') {
        assert.equal(remote.size, 0)
        closingSettings = JSON.parse(body.settings)
      } else assert.fail('unexpected mutation')
      // The server applied the mutation, but the response body was interrupted.
      return new Response(new ReadableStream({ start(controller) { controller.error(reset()) } }))
    }
    const writes = [
      cardkit.addElementChecked('card', element(), { type: 'insert_before', targetElementId: 'footer' }),
      cardkit.replaceElementChecked('card', 'tool_19', element('done')),
      cardkit.deleteElementChecked('card', 'tool_19'),
      cardkit.patchSettingsChecked('card', { config: { streaming_mode: false } }),
    ]
    const disposing = cardkit.dispose('card')
    assert.equal(await cardkit.addElementChecked('card', element('late')), false)
    assert.deepEqual(await Promise.all(writes), [true, true, true, true])
    await disposing
    assert.equal(cardkit.isDisposed('card'), true)
    assert.deepEqual(closingSettings, { config: { streaming_mode: false } })
    assert.deepEqual(calls.map(c => c.method), ['POST', 'POST', 'PUT', 'PUT', 'DELETE', 'DELETE', 'PATCH', 'PATCH'])
    assert.deepEqual(calls.map(c => c.body.sequence), [1, 1, 2, 2, 3, 3, 4, 4])
    assert.equal(new Set(calls.map(c => c.body.uuid)).size, 4)
    assert.equal(new Set(calls.map(c => c.signal)).size, 8, 'each attempt gets a fresh timeout')
    assert.deepEqual(delays, [1000, 1000, 1000, 1000])
    assert.deepEqual(failures, [])
  `)
})

test('card mutations retry known transport, gateway and rate-limit failures but reject permanent errors', async () => {
  await runIsolated(`
    cardkit.recordCardCreated('card', 1)
    for (const [failure, expectedDelay] of [
      [reset(), 1000],
      [new TypeError('fetch failed', { cause: reset() }), 1000],
      [Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }), 1000],
      [Object.assign(new Error('connection refused'), { code: 'ConnectionRefused' }), 1000],
      [new DOMException('timed out', 'TimeoutError'), 1000],
      ...[408, 429, 500, 502, 503, 504].map(status => [new Response('gateway unavailable', { status }), 1000]),
      [Response.json({ code: 99991400, msg: 'rate limited' }, { status: 400, headers: { 'retry-after': '2' } }), 2000],
      [Response.json({ code: 230020, msg: 'rate limited' }, { headers: { 'x-ogw-ratelimit-reset': '2' } }), 2000],
      [Response.json({ code: 300308, msg: 'Server Internal Error' }), 1000],
      [Response.json({ code: '300308', msg: 'Server Internal Error' }), 1000],
      [Response.json({ code: 300308, msg: 'Server Internal Error' }, { status: 400 }), 1000],
    ]) {
      calls.length = 0; delays.length = 0
      respond = async () => {
        if (calls.length > 1) return Response.json({ code: 0 })
        if (failure instanceof Error) throw failure
        return failure.clone()
      }
      assert.deepEqual(await cardkit.replaceElementResult('card', 'tool_19', element('done')), { landed: true })
      assert.equal(calls.length, 2)
      assert.equal(calls[0].raw, calls[1].raw)
      assert.deepEqual(delays, [expectedDelay])
      assert.equal(cardkit.isDeadElement('card', 'tool_19'), false)
    }
    for (const failure of [
      new Response('forbidden', { status: 403 }),
      Response.json({ code: 300315, msg: 'invalid layout' }),
      Response.json({ code: 200860, msg: 'card over max size' }),
      Response.json({ code: 300305, msg: 'too many components' }),
      Response.json({ code: 300308, msg: 'unclassified API rejection' }),
      Response.json({ data: {} }), new Response('invalid success JSON'),
      new TypeError('programming error'), new DOMException('cancelled', 'AbortError'),
      Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }),
      new Response('rate limited', { status: 429, headers: { 'retry-after': '61' } }),
    ]) {
      calls.length = 0; delays.length = 0
      respond = async () => {
        if (failure instanceof Error) throw failure
        return failure.clone()
      }
      assert.equal((await cardkit.replaceElementResult('card', 'tool_19', element('done'))).landed, false)
      assert.equal(calls.length, 1)
      assert.deepEqual(delays, [])
    }
    await cardkit.dispose('card')
  `)
})

test('exhausted card retries report one failure and allow a later result to rebuild the missing tool', async () => {
  await runIsolated(`
    for (const failureKind of ['transport', 'gateway', 'internal']) {
      const transportFailure = failureKind === 'transport'
      const failures = []
      cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
      calls.length = 0; delays.length = 0
      respond = async () => {
        assert.equal(failures.length, 0, 'do not notify before retries finish')
        if (transportFailure) throw reset()
        return Response.json({ code: 300308, msg: 'Server Internal Error' }, {
          status: failureKind === 'gateway' ? 503 : 200, headers: { 'x-tt-logid': 'last-attempt-' + calls.length },
        })
      }
      const result = await cardkit.addElementResult('card', element(), {
        type: 'insert_before', targetElementId: 'footer',
      })
      assert.equal(result.landed, false)
      assert.equal(calls.length, 3)
      assert.equal(new Set(calls.map(c => c.raw)).size, 1)
      assert.deepEqual(delays, [1000, 4000])
      assert.equal(failures.length, 1)
      assert.equal(failures[0], result.failure)
      assert.equal(result.failure.operation, 'addElement')
      assert.equal(result.failure.elementId, 'tool_19')
      assert.equal(result.failure.targetElementId, 'footer')
      assert.equal(result.failure.code, transportFailure ? 'ECONNRESET' : 300308)
      assert.equal(cardkit.isCardCapacityFailure(result.failure.code, result.failure), false)
      if (!transportFailure) {
        assert.equal(result.failure.httpStatus, failureKind === 'gateway' ? 503 : 200)
        assert.equal(result.failure.logId, 'last-attempt-3')
        assert.match(result.failure.message, /log_id=last-attempt-3/)
      }
      assert.equal(cardkit.getElementCount('card'), 1)
      assert.equal(cardkit.isDeadElement('card', 'tool_19'), true)
      respond = async () => Response.json({ code: 0 })
      assert.equal(await cardkit.replaceElementChecked('card', 'tool_19', element('done')), true)
      const last = calls.at(-1)
      assert.equal(last.method, 'POST')
      assert.equal(last.body.type, 'insert_before')
      assert.equal(last.body.target_element_id, 'footer')
      assert.deepEqual(JSON.parse(last.body.elements), [element('done')])
      assert.equal(last.body.sequence, 2)
      assert.notEqual(last.body.uuid, calls[0].body.uuid)
      assert.equal(cardkit.getElementCount('card'), 2)
      assert.equal(cardkit.isDeadElement('card', 'tool_19'), false)
      assert.deepEqual(cardkit.getWrittenContentElementIds('card'), ['tool_19'])
      await cardkit.dispose('card')
    }
  `)
})

test('Node header and body AbortErrors retry only when the owned deadline expired', async () => {
  await runIsolated(`
    // Prime the tenant token so the injected timeout belongs to the card call.
    respond = async () => Response.json({ code: 0, data: { card_id: 'card' } })
    await cardkit.convertMessageToCard('om_recent')
    const originalTimeout = AbortSignal.timeout
    let controller
    AbortSignal.timeout = ms => {
      assert.equal(ms, 15000)
      controller = new AbortController()
      return controller.signal
    }
    try {
      cardkit.recordCardCreated('card', 1)
      for (const phase of ['headers', 'body']) {
        calls.length = 0; delays.length = 0
        respond = async () => {
          if (calls.length > 1) return Response.json({ code: 0 })
          controller.abort(new DOMException('deadline exceeded', 'TimeoutError'))
          const error = new DOMException('The operation was aborted', 'AbortError')
          if (phase === 'headers') throw error
          return new Response(new ReadableStream({ start(stream) { stream.error(error) } }))
        }
        assert.equal(await cardkit.replaceElementChecked('card', 'tool_19', element('done')), true)
        assert.equal(calls.length, 2)
        assert.equal(calls[0].raw, calls[1].raw)
        assert.notEqual(calls[0].signal, calls[1].signal)
        assert.equal(calls[1].signal.aborted, false)
        assert.deepEqual(delays, [1000])
      }
      calls.length = 0; delays.length = 0
      respond = async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'))
        throw controller.signal.reason
      }
      assert.equal(await cardkit.replaceElementChecked('card', 'tool_19', element('done')), false)
      assert.equal(calls.length, 1)
      assert.deepEqual(delays, [])
      await cardkit.dispose('card')
    } finally { AbortSignal.timeout = originalTimeout }
  `)
})

test('TTL reopens allocate new operations while each interrupted request retains its UUID and sequence', async () => {
  await runIsolated(`
    for (const code of [300309, 200850]) {
      const failures = []
      cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
      calls.length = 0; delays.length = 0
      respond = async () => {
        if (calls.length === 1) return Response.json({ code, msg: 'streaming expired' })
        if (calls.length === 2 || calls.length === 4) throw reset()
        return Response.json({ code: 0 })
      }
      assert.equal(await cardkit.addElementChecked('card', element()), true)
      assert.deepEqual(calls.map(c => c.method), ['POST', 'PATCH', 'PATCH', 'POST', 'POST'])
      assert.deepEqual(calls.map(c => c.body.sequence), [1, 2, 2, 3, 3])
      assert.equal(new Set(calls.map(c => c.body.uuid)).size, 3)
      assert.equal(calls[1].raw, calls[2].raw)
      assert.equal(calls[3].raw, calls[4].raw)
      assert.deepEqual(JSON.parse(calls[1].body.settings), { config: { streaming_mode: true } })
      assert.deepEqual(delays, [1000, 1000])
      assert.deepEqual(failures, [])
      assert.equal(cardkit.getElementCount('card'), 2, 'count the accepted add exactly once')
      assert.deepEqual(cardkit.getWrittenContentElementIds('card'), ['tool_19'])
      await cardkit.dispose('card')
    }
  `)
})

test('id conversion can retry transport failures without adding mutation-only parameters', async () => {
  await runIsolated(`
    respond = async call => {
      assert.equal(call.path, '/cards/id_convert')
      assert.deepEqual(call.body, { message_id: 'om_recent' })
      if (calls.length === 1) throw reset()
      if (calls.length === 2) return Response.json({ code: 200740, msg: 'queried result is empty' })
      return Response.json({ code: 0, data: { card_id: 'card_ready' } })
    }
    assert.equal(await cardkit.convertMessageToCard('om_recent', { retryDelaysMs: [0, 0] }), 'card_ready')
    assert.equal(calls.length, 3)
    assert.deepEqual(delays, [1000])
  `)
})
