import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Keep accelerated retry timers and the real HTTP wrappers isolated from the
// shared Session mocks. The preload supplies private test configuration/state.
async function runIsolated(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, '--eval', `
    import assert from 'node:assert/strict'
    const cardkit = await import('./src/cardkit')
    const delays = [], calls = []
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
    await (await import('./src/feishu')).getTenantToken()
    let now = Date.now()
    Date.now = () => now
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => {
      assert.ok(ms >= 0 && ms <= 60000, 'unexpected timer: ' + ms)
      delays.push(ms)
      return originalSetTimeout(() => { now += ms; fn(...args) }, 0)
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
    assert.deepEqual(delays, [3000, 3000, 3000, 3000])
    assert.deepEqual(failures, [])
  `)
})

test('consumed UUIDs after uncertain footer and settings writes require a successful new-identity confirmation', async () => {
  await runIsolated(`
    for (const method of ['PUT', 'PATCH']) {
      for (const firstAttemptLanded of [false, true]) {
        const failures = []
        let remoteValue = 'old'
        cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
        calls.length = 0; delays.length = 0
        const footer = { tag: 'markdown', element_id: 'footer', content: 'Thinking(17s)' }
        const settings = { config: { streaming_mode: false }, summary: { content: 'complete' } }
        const expectedValue = JSON.stringify(method === 'PUT' ? footer : settings)
        respond = async call => {
          assert.equal(failures.length, 0, 'do not notify while confirming the write')
          if (calls.length <= 3) {
            assert.equal(call.method, method)
            assert.equal(call.body[method === 'PUT' ? 'element' : 'settings'], expectedValue)
          }
          if (calls.length === 1) {
            if (firstAttemptLanded) remoteValue = expectedValue
            return Response.json({ code: 300308, msg: 'Server Internal Error' })
          }
          if (calls.length === 2) {
            assert.equal(call.raw, calls[0].raw)
            return Response.json({ code: 200770, msg: 'ErrMsg: this UUID has been recently consumed;' })
          }
          if (calls.length === 3) {
            assert.deepEqual(delays, [3000, 8000], 'confirmation must wait for upstream recovery')
            assert.notEqual(call.body.uuid, calls[0].body.uuid)
            assert.equal(call.body.sequence, 2)
            remoteValue = expectedValue
            return Response.json({ code: 0 })
          }
          assert.equal(remoteValue, expectedValue, 'the next queued write must wait for confirmation')
          assert.equal(call.body.sequence, 3)
          return Response.json({ code: 0 })
        }
        const firstWrite = method === 'PUT'
          ? cardkit.replaceElementChecked('card', 'footer', footer)
          : cardkit.patchSettingsChecked('card', settings, failure => failures.push(failure))
        const nextWrite = cardkit.replaceElementChecked('card', 'tool_19', element('done'))
        assert.deepEqual(await Promise.all([firstWrite, nextWrite]), [true, true])
        assert.equal(remoteValue, expectedValue)
        assert.deepEqual(calls.map(call => call.body.sequence), [1, 1, 2, 3])
        assert.equal(new Set(calls.map(call => call.body.uuid)).size, 3)
        assert.equal(new Set(calls.map(call => call.signal)).size, 4)
        assert.equal(cardkit.isDeadElement('card', 'footer'), false)
        assert.deepEqual(delays, [3000, 8000])
        assert.deepEqual(failures, [])
        await cardkit.dispose('card')
      }
    }
  `)
})

test('UUID confirmation shares one minute across identities and reports final diagnostics only at the deadline', async () => {
  await runIsolated(`
    for (const method of ['PUT', 'PATCH']) {
      for (const repeatedConsumption of [false, true]) {
        const failures = []
        cardkit.recordCardCreated('card', 1, (_code, failure) => {
          assert.equal(now - startedAt, 60000, 'do not notify before the shared deadline')
          failures.push(failure)
        })
        calls.length = 0; delays.length = 0
        const startedAt = now
        respond = async () => {
          assert.equal(failures.length, 0, 'notify only after confirmation has failed')
          assert.ok(calls.length <= 6, 'confirmation must remain within the one-minute window')
          const internal = calls.length === 1 || (repeatedConsumption && calls.length % 2 === 1)
          if (internal) return Response.json({ code: 300308, msg: 'Server Internal Error' })
          const code = calls.length === 2 || repeatedConsumption ? 200770 : 300121
          return Response.json({ code, msg: code === 200770 ? 'this UUID has been recently consumed' : 'replacement rejected' },
            { headers: { 'x-tt-logid': 'confirmation-attempt-' + calls.length } })
        }
        const landed = method === 'PUT'
          ? (await cardkit.replaceElementResult('card', 'footer', { tag: 'markdown', content: 'Thinking(17s)' })).landed
          : await cardkit.patchSettingsChecked('card', { config: { streaming_mode: false } }, failure => failures.push(failure))
        const count = repeatedConsumption ? 6 : 3
        assert.equal(landed, false)
        assert.equal(calls.length, count)
        assert.deepEqual(calls.map(call => call.body.sequence), repeatedConsumption ? [1, 1, 2, 2, 3, 3] : [1, 1, 2])
        assert.equal(new Set(calls.map(call => call.body.uuid)).size, repeatedConsumption ? 3 : 2)
        assert.equal(now - startedAt, 60000)
        assert.equal(failures.length, 1)
        assert.equal(failures[0].code, repeatedConsumption ? 200770 : 300121)
        assert.equal(failures[0].logId, 'confirmation-attempt-' + count)
        assert.match(failures[0].message, new RegExp('log_id=confirmation-attempt-' + count))
        assert.deepEqual(delays, repeatedConsumption ? [3000, 8000, 15000, 15000, 15000, 4000] : [3000, 8000, 49000])
        if (method === 'PUT') assert.equal(cardkit.isDeadElement('card', 'footer'), true)
        await cardkit.dispose('card')
      }
    }
  `)
})

test('repeated ambiguous UUIDs can recover within one minute without duplicate inserts or early notices', async () => {
  await runIsolated(`
    for (const method of ['PUT', 'PATCH', 'POST']) {
      calls.length = 0; delays.length = 0
      const startedAt = now, failures = []
      cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
      const seen = new Set()
      let inserts = 0
      respond = async call => {
        assert.equal(failures.length, 0)
        if (call.method === 'POST' && !seen.has(call.body.uuid)) inserts++
        const duplicate = seen.has(call.body.uuid)
        seen.add(call.body.uuid)
        if (now - startedAt < 35000) return Response.json(duplicate
          ? { code: 200770, msg: 'this UUID has been recently consumed' }
          : { code: 300308, msg: 'Server Internal Error' })
        assert.equal(call.method, method === 'POST' ? 'PUT' : method)
        return Response.json({ code: 0 })
      }
      const landed = method === 'POST'
        ? await cardkit.addElementChecked('card', element('final result'))
        : method === 'PUT'
          ? await cardkit.replaceElementChecked('card', 'tool_19', element('final result'))
          : await cardkit.patchSettingsChecked('card', { config: { streaming_mode: false } }, failure => failures.push(failure))
      assert.equal(landed, true)
      assert.equal(now - startedAt, 41000)
      assert.deepEqual(calls.map(call => call.body.sequence), [1, 1, 2, 2, 3])
      assert.equal(inserts, method === 'POST' ? 1 : 0)
      assert.equal(cardkit.getElementCount('card'), method === 'POST' ? 2 : 1)
      assert.deepEqual(failures, [])
      await cardkit.dispose('card')
    }
  `)
})

test('a consumed UUID without an uncertain attempt does not authorize a new mutation identity', async () => {
  await runIsolated(`
    for (const method of ['POST', 'PUT', 'PATCH']) {
      for (const prior of [undefined, 99991400, 230020, 'http429']) {
        const failures = []
        cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
        calls.length = 0; delays.length = 0
        respond = async () => {
          if (calls.length === 1 && prior !== undefined) {
            return prior === 'http429'
              ? new Response('rate limited', { status: 429 })
              : Response.json({ code: prior, msg: 'rate limited' })
          }
          return Response.json({ code: 200770, msg: 'this UUID has been recently consumed' },
            { headers: { 'x-tt-logid': 'unproven-consumption' } })
        }
        const landed = method === 'POST'
          ? (await cardkit.addElementResult('card', element())).landed
          : method === 'PUT'
            ? (await cardkit.replaceElementResult('card', 'tool_19', element('done'))).landed
            : await cardkit.patchSettingsChecked('card', { config: { streaming_mode: false } }, failure => failures.push(failure))
        assert.equal(landed, false)
        assert.equal(calls.length, prior === undefined ? 1 : 2)
        assert.equal(new Set(calls.map(call => call.raw)).size, 1)
        assert.ok(calls.every(call => call.method === method))
        assert.equal(failures.length, 1)
        assert.equal(failures[0].code, 200770)
        assert.equal(failures[0].logId, 'unproven-consumption')
        assert.equal(cardkit.getElementCount('card'), 1)
        assert.deepEqual(delays, prior === undefined ? [60000] : [3000, 57000])
        await cardkit.dispose('card')
      }
    }
  `)
})

test('confirmation and add reconciliation respect server cooldown without bypassing the bounded wait', async () => {
  await runIsolated(`
    for (const operation of ['PUT', 'PATCH', 'POST-consumed', 'POST-duplicate']) {
      for (const retryAfter of ['12', '61']) {
        const failures = []
        cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
        calls.length = 0; delays.length = 0
        const duplicate = operation === 'POST-duplicate'
        respond = async call => {
          if (calls.length === 1) return Response.json({ code: 300308, msg: 'Server Internal Error' })
          if (calls.length === 2) return Response.json({
            code: duplicate ? 300315 : 200770,
            msg: duplicate ? 'Duplicate ID; code: 300301' : 'this UUID has been recently consumed',
          }, { headers: { 'x-ogw-ratelimit-reset': retryAfter, 'x-tt-logid': 'confirmation-cooldown' } })
          assert.equal(retryAfter, '12', 'an excessive cooldown must preserve the original failure')
          assert.deepEqual(delays, [3000, 12000])
          assert.equal(call.method, operation === 'PATCH' ? 'PATCH' : 'PUT')
          return Response.json({ code: 0 })
        }
        const landed = operation.startsWith('POST')
          ? await cardkit.addElementChecked('card', element())
          : operation === 'PATCH'
            ? await cardkit.patchSettingsChecked('card', { config: { streaming_mode: false } }, failure => failures.push(failure))
            : (await cardkit.replaceElementResult('card', 'tool_19', element('done'))).landed
        assert.equal(landed, retryAfter === '12')
        assert.equal(calls.length, retryAfter === '12' ? 3 : 2)
        assert.deepEqual(delays, retryAfter === '12' ? [3000, 12000] : [3000, 57000])
        if (retryAfter === '61') {
          assert.equal(failures.length, 1)
          assert.equal(failures[0].code, duplicate ? 300315 : 200770)
          assert.equal(failures[0].logId, 'confirmation-cooldown')
        } else assert.deepEqual(failures, [])
        await cardkit.dispose('card')
      }
    }
  `)
})

test('uncertain adds reconcile consumed UUIDs and reconfirm duplicate-ID replacements without inserting twice', async () => {
  await runIsolated(`
    for (const rejection of ['consumed', 'duplicate']) {
      const failures = [], remote = new Map()
      cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
      calls.length = 0; delays.length = 0
      respond = async call => {
        if (calls.length === 1) {
          assert.equal(call.method, 'POST')
          remote.set('tool_19', JSON.parse(call.body.elements)[0])
          return Response.json({ code: 300308, msg: 'Server Internal Error' })
        }
        if (calls.length === 2) {
          assert.equal(call.raw, calls[0].raw)
          return rejection === 'consumed'
            ? Response.json({ code: 200770, msg: 'this UUID has been recently consumed' })
            : Response.json({ code: 300315, msg: 'Duplicate ID; code: 300301' })
        }
        assert.equal(call.method, 'PUT', 'an uncertain add must reconcile the existing ID')
        if (calls.length === 3) assert.deepEqual(delays, [3000, 8000], 'reconciliation must back off before PUT')
        assert.equal(call.path, '/cards/card/elements/tool_19')
        assert.equal(remote.has('tool_19'), true)
        remote.set('tool_19', JSON.parse(call.body.element))
        if (rejection === 'duplicate' && calls.length === 3) return Response.json({ code: 300308, msg: 'Server Internal Error' })
        if (rejection === 'duplicate' && calls.length === 4) {
          assert.equal(call.raw, calls[2].raw)
          return Response.json({ code: 200770, msg: 'this UUID has been recently consumed' })
        }
        return Response.json({ code: 0 })
      }
      const expectedElement = element('latest result')
      assert.deepEqual(await cardkit.addElementResult('card', expectedElement,
        { type: 'insert_before', targetElementId: 'footer' }), { landed: true })
      assert.deepEqual(calls.map(call => call.method), rejection === 'consumed'
        ? ['POST', 'POST', 'PUT'] : ['POST', 'POST', 'PUT', 'PUT', 'PUT'])
      assert.deepEqual(calls.map(call => call.body.sequence), rejection === 'consumed' ? [1, 1, 2] : [1, 1, 2, 2, 3])
      assert.equal(new Set(calls.map(call => call.body.uuid)).size, rejection === 'consumed' ? 2 : 3)
      assert.deepEqual(remote.get('tool_19'), expectedElement)
      assert.equal(remote.size, 1)
      assert.equal(cardkit.getElementCount('card'), 2)
      assert.equal(cardkit.isDeadElement('card', 'tool_19'), false)
      assert.deepEqual(cardkit.getWrittenContentElementIds('card'), ['tool_19'])
      assert.deepEqual(failures, [])
      assert.deepEqual(delays, rejection === 'consumed' ? [3000, 8000] : [3000, 8000, 15000, 15000])
      await cardkit.dispose('card')
    }
  `)
})

test('an uncertain add with a consumed UUID is not counted when the authoritative replacement fails', async () => {
  await runIsolated(`
    const failures = []
    cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
    respond = async call => {
      if (calls.length === 1) return Response.json({ code: 300308, msg: 'Server Internal Error' })
      if (calls.length === 2) return Response.json({ code: 200770, msg: 'this UUID has been recently consumed' })
      assert.equal(call.method, 'PUT')
      return Response.json({ code: 300121, msg: 'element does not exist' },
        { headers: { 'x-tt-logid': 'missing-after-consumption' } })
    }
    const result = await cardkit.addElementResult('card', element())
    assert.equal(result.landed, false)
    assert.equal(result.failure.code, 300121)
    assert.equal(result.failure.logId, 'missing-after-consumption')
    assert.deepEqual(calls.map(call => call.method), ['POST', 'POST', 'PUT'])
    assert.equal(failures.length, 1)
    assert.equal(failures[0], result.failure)
    assert.equal(cardkit.getElementCount('card'), 1)
    assert.equal(cardkit.isDeadElement('card', 'tool_19'), true)
    assert.deepEqual(cardkit.getWrittenContentElementIds('card'), [])
    await cardkit.dispose('card')
  `)
})

test('an earlier uncertain add does not authorize a consumed UUID from a later request', async () => {
  await runIsolated(`
    cardkit.recordCardCreated('card', 1)
    respond = async () => Response.json({ code: 300308, msg: 'Server Internal Error' })
    assert.equal((await cardkit.addElementResult('card', element())).landed, false)
    assert.equal(calls.length, 6)
    calls.length = 0; delays.length = 0
    respond = async () => Response.json({ code: 200770, msg: 'this UUID has been recently consumed' },
      { headers: { 'x-tt-logid': 'later-request-consumption' } })
    const result = await cardkit.addElementResult('card', element('latest result'))
    assert.equal(result.landed, false)
    assert.equal(result.failure.code, 200770)
    assert.equal(result.failure.logId, 'later-request-consumption')
    assert.equal(calls.length, 1, 'previous uncertainAdds state cannot authorize this request')
    assert.equal(calls[0].method, 'POST')
    assert.equal(cardkit.getElementCount('card'), 1)
    assert.equal(cardkit.isDeadElement('card', 'tool_19'), true)
    assert.deepEqual(delays, [60000])
    await cardkit.dispose('card')
  `)
})

test('an uncertain DELETE with a consumed UUID remains unconfirmed without changing the element count', async () => {
  await runIsolated(`
    const failures = []
    cardkit.recordCardCreated('card', 2)
    respond = async () => calls.length === 1
      ? Response.json({ code: 300308, msg: 'Server Internal Error' })
      : Response.json({ code: 200770, msg: 'this UUID has been recently consumed' },
        { headers: { 'x-tt-logid': 'uncertain-delete' } })
    assert.equal(await cardkit.deleteElementChecked('card', 'tool_19', failure => failures.push(failure)), false)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].raw, calls[1].raw)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].code, 200770)
    assert.equal(failures[0].logId, 'uncertain-delete')
    assert.equal(cardkit.getElementCount('card'), 2)
    assert.equal(cardkit.isDeadElement('card', 'tool_19'), false)
    await cardkit.dispose('card')
  `)
})

test('card mutations retry known transport, gateway and rate-limit failures but reject permanent errors', async () => {
  await runIsolated(`
    cardkit.recordCardCreated('card', 1)
    for (const [failure, expectedDelay] of [
      [reset(), 3000],
      [new TypeError('fetch failed', { cause: reset() }), 3000],
      [Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }), 3000],
      [Object.assign(new Error('connection refused'), { code: 'ConnectionRefused' }), 3000],
      [new DOMException('timed out', 'TimeoutError'), 3000],
      ...[408, 429, 500, 502, 503, 504].map(status => [new Response('gateway unavailable', { status }), 3000]),
      [Response.json({ code: 99991400, msg: 'rate limited' }, { status: 400, headers: { 'retry-after': '7' } }), 7000],
      [Response.json({ code: 230020, msg: 'rate limited' }, { headers: { 'x-ogw-ratelimit-reset': '7' } }), 7000],
      [Response.json({ code: 300308, msg: 'Server Internal Error' }), 3000],
      [Response.json({ code: '300308', msg: 'Server Internal Error' }), 3000],
      [Response.json({ code: 300308, msg: 'Server Internal Error' }, { status: 400 }), 3000],
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
      const result = await cardkit.replaceElementResult('card', 'tool_19', element('done'))
      assert.equal(result.landed, false)
      assert.equal(calls.length, 1)
      const immediate = cardkit.isCardCapacityFailure(result.failure.code, result.failure) || failure.name === 'AbortError'
      assert.deepEqual(delays, immediate ? [] : [60000])
    }
    await cardkit.dispose('card')
  `)
})

test('a 55-second outage recovers before notification without losing or reordering queued content', async () => {
  await runIsolated(`
    const failures = []
    cardkit.recordCardCreated('card', 1, (_code, failure) => failures.push(failure))
    let remoteContent
    respond = async call => {
      assert.equal(failures.length, 0, 'no failure notification during recovery')
      const elapsed = delays.reduce((total, delay) => total + delay, 0)
      if (elapsed < 55000) return Response.json({ code: 300308, msg: 'Server Internal Error' })
      if (calls.length === 6) {
        assert.equal(call.method, 'POST')
        remoteContent = JSON.parse(call.body.elements)[0].content
      } else {
        assert.equal(remoteContent, 'working', 'queued result waits for the insertion to recover')
        assert.equal(call.method, 'PUT')
        remoteContent = JSON.parse(call.body.element).content
      }
      return Response.json({ code: 0 })
    }
    const writes = [
      cardkit.addElementChecked('card', element()),
      cardkit.replaceElementChecked('card', 'tool_19', element('done')),
    ]
    assert.deepEqual(await Promise.all(writes), [true, true])
    assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000])
    assert.deepEqual(calls.map(call => call.body.sequence), [1, 1, 1, 1, 1, 1, 2])
    assert.equal(new Set(calls.slice(0, 6).map(call => call.raw)).size, 1)
    assert.equal(new Set(calls.map(call => call.signal)).size, 7)
    assert.equal(remoteContent, 'done')
    assert.equal(cardkit.getElementCount('card'), 2)
    assert.equal(cardkit.isDeadElement('card', 'tool_19'), false)
    assert.deepEqual(failures, [])
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
      assert.equal(calls.length, 6)
      assert.equal(new Set(calls.map(c => c.raw)).size, 1)
      assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000, 4000])
      assert.equal(failures.length, 1)
      assert.equal(failures[0], result.failure)
      assert.equal(result.failure.operation, 'addElement')
      assert.equal(result.failure.elementId, 'tool_19')
      assert.equal(result.failure.targetElementId, 'footer')
      assert.equal(result.failure.code, transportFailure ? 'ECONNRESET' : 300308)
      assert.equal(cardkit.isCardCapacityFailure(result.failure.code, result.failure), false)
      if (!transportFailure) {
        assert.equal(result.failure.httpStatus, failureKind === 'gateway' ? 503 : 200)
        assert.equal(result.failure.logId, 'last-attempt-6')
        assert.match(result.failure.message, /log_id=last-attempt-6/)
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
        assert.deepEqual(delays, [3000])
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
      assert.deepEqual(delays, [3000, 8000])
      assert.deepEqual(failures, [])
      assert.equal(cardkit.getElementCount('card'), 2, 'count the accepted add exactly once')
      assert.deepEqual(cardkit.getWrittenContentElementIds('card'), ['tool_19'])
      await cardkit.dispose('card')
    }
  `)
})

test('TTL reopening and the original write share request time and never restart the minute', async () => {
  await runIsolated(`
    const failures = [], timeouts = []
    const startedAt = now
    const originalTimeout = AbortSignal.timeout
    AbortSignal.timeout = ms => { timeouts.push(ms); return originalTimeout(ms) }
    cardkit.recordCardCreated('card', 1, (_code, failure) => {
      assert.equal(now - startedAt, 60000)
      failures.push(failure)
    })
    respond = async call => {
      assert.equal(failures.length, 0)
      if (calls.length === 1) {
        now += 14000
        return Response.json({ code: 300309, msg: 'streaming closed' })
      }
      if (call.method === 'PATCH') return Response.json({ code: 0 })
      now += Math.min(14000, 60000 - (now - startedAt))
      return Response.json({ code: 300308, msg: 'Server Internal Error' },
        { headers: { 'x-tt-logid': 'ttl-deadline' } })
    }
    const result = await cardkit.addElementResult('card', element())
    assert.equal(result.landed, false)
    assert.equal(now - startedAt, 60000)
    assert.deepEqual(calls.map(call => call.method), ['POST', 'PATCH', 'POST', 'POST', 'POST'])
    assert.deepEqual(calls.map(call => call.body.sequence), [1, 2, 3, 3, 3])
    assert.equal(timeouts.at(-1), 7000, 'the final HTTP attempt only has the remaining budget')
    assert.equal(failures.length, 1)
    assert.equal(result.failure.logId, 'ttl-deadline')
    await cardkit.dispose('card')
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
    assert.deepEqual(delays, [3000])
  `)
})
