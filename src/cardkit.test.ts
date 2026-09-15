import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
// 注册共享 ./feishu mock(见该文件头注释:多文件各自 mock 会互相覆盖)
import './feishu-test-mock'

const cardkit = await import('./cardkit')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: String(init?.method ?? 'GET'),
      path: url.pathname.replace('/open-apis/cardkit/v1', ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cardkit card operations', () => {
  test('settings failures preserve the upstream error for the caller', async () => {
    const cardId = 'settings_error_details'
    cardkit.recordCardCreated(cardId, 1)
    globalThis.fetch = (async () => Response.json({ code: 300317, msg: 'sequence number compare failed' },
      { headers: { 'x-tt-logid': 'settings-error-request-id' } })) as unknown as typeof fetch
    const failures: import('./cardkit').CardWriteFailure[] = []
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } }, failure => { failures.push(failure) })).toBe(false)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ cardId, operation: 'patchSettings', code: 300317, httpStatus: 200, logId: 'settings-error-request-id' })
    expect(failures[0]!.message).toContain('sequence number compare failed')
    await cardkit.dispose(cardId)
  })

  test('checked replacement returns the capacity error and does not revive disposed cards', async () => {
    const cardId = 'delegation_replace_result'
    cardkit.recordCardCreated(cardId, 1)
    globalThis.fetch = (async () => Response.json({ code: 200860, msg: 'card over max size' })) as unknown as typeof fetch
    const element = { tag: 'markdown', element_id: 'run', content: 'result' }
    const result = await cardkit.replaceElementResult(cardId, 'run', element)
    expect(result.landed).toBe(false)
    expect(result.failure).toMatchObject({ code: 200860, cardId, elementId: 'run' })
    expect(cardkit.isDeadElement(cardId, 'run')).toBe(true)
    globalThis.fetch = (async () => Response.json({ code: 0 })) as unknown as typeof fetch
    expect((await cardkit.replaceElementResult(cardId, 'run', element)).landed).toBe(true)
    await cardkit.dispose(cardId)
    expect(await cardkit.replaceElementResult(cardId, 'run', element)).toEqual({ landed: false })
  })

  test('classifies card size and component limits without treating schema errors as capacity', () => {
    expect(cardkit.isCardCapacityFailure(200860, { message: 'ErrMsg: card over max size;' })).toBe(true)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'Failed to add element: inner code: 200860, card over max size',
    })).toBe(true)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'Failed to add element: ErrMsg: card over max size;',
    })).toBe(true)
    expect(cardkit.isCardCapacityFailure(300305, { message: 'component limit' })).toBe(true)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'Failed to add element: inner code: 300305, element exceeds limit',
    })).toBe(true)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'Duplicate ID, inner code: 300301',
    })).toBe(false)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'elementID format error. Only alphabets, numbers, and underscores are allowed. It must start with an alphabet and not exceed 20 characters; code: 300301',
    })).toBe(false)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'number of elements in a column exceeds the maximum; code: 300301',
    })).toBe(false)
    expect(cardkit.isCardCapacityFailure(300315, {
      message: 'markdown element content exceeds maximum length; code: 300301',
    })).toBe(false)
    expect(cardkit.isCardCapacityFailure(200570, { message: 'invalid image keys' })).toBe(false)
    expect(cardkit.isCardCapacityFailure(300308, { message: 'server internal error' })).toBe(false)
    expect(cardkit.isDuplicateElementFailure(300315, { message: 'Duplicate ID; code: 300301' })).toBe(true)
    expect(cardkit.isDuplicateElementFailure(300315, { message: 'elementID format error; code: 300301' })).toBe(false)
  })

  test('reports the failing card, operation, element, target and Feishu log id', async () => {
    const cardId = 'card_failure_context'
    let capturedCode: number | undefined
    let captured: any = null
    cardkit.recordCardCreated(cardId, 1, (code, failure) => {
      capturedCode = code
      captured = failure
    })
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 300315,
      msg: 'Duplicate ID; inner code: 300301',
    }), {
      headers: {
        'Content-Type': 'application/json',
        'x-tt-logid': 'log_card_failure_context',
      },
    })) as unknown as typeof fetch

    await cardkit.addElement(cardId, {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    }, {
      type: 'insert_before', targetElementId: 'footer',
    })

    expect(capturedCode).toBe(300315)
    expect(captured).toMatchObject({
      cardId,
      operation: 'addElement',
      elementId: 'assistant_0',
      targetElementId: 'footer',
      code: 300315,
      httpStatus: 200,
      logId: 'log_card_failure_context',
    })
    expect(captured.message).toContain('Duplicate ID')
    await cardkit.dispose(cardId)
  })

  test('capacity fingerprints follow accepted content across renumbering, updates and deletions', async () => {
    const ids = ['card_fingerprint_old', 'card_fingerprint_new']
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(String(init?.body).includes('oversized')
        ? { code: 200860, msg: 'card over max size' }
        : { code: 0, data: {} }), { headers: { 'Content-Type': 'application/json' } })
    ) as typeof fetch
    const element = (id: string, content: string) => ({
      tag: 'column_set', element_id: id,
      columns: [{ tag: 'column', elements: [{ tag: 'markdown', element_id: `${id}_text`, content }] }],
    })
    const reject = async (cardId: string, id: string) => {
      const result = await cardkit.addElementResult(cardId, element(id, 'oversized'))
      expect(result.landed).toBe(false)
      expect(result.failure?.capacityFingerprint).toMatch(/^[a-f0-9]{64}$/)
      return result.failure!.capacityFingerprint
    }
    try {
      for (const id of ids) cardkit.recordCardCreated(id, 2)
      await cardkit.addElement(ids[0]!, element('tool_0', 'previous'))
      await cardkit.replaceElement(ids[0]!, 'tool_0', element('tool_0', 'current'))
      const old = await reject(ids[0]!, 'assistant_5')
      await cardkit.addElement(ids[1]!, element('tool_7', 'current'))
      await cardkit.replaceElement(ids[1]!, 'footer', { tag: 'markdown', content: 'Thinking(17s)' })
      expect(await reject(ids[1]!, 'assistant_0')).toBe(old)
      await cardkit.replaceElement(ids[1]!, 'tool_7', element('tool_7', 'new output'))
      expect(await reject(ids[1]!, 'assistant_1')).not.toBe(old)
      await cardkit.deleteElement(ids[0]!, 'tool_0')
      await cardkit.deleteElement(ids[1]!, 'tool_7')
      const empty = await reject(ids[0]!, 'assistant_6')
      expect(empty).not.toBe(old)
      expect(await reject(ids[1]!, 'assistant_2')).toBe(empty)
    } finally {
      for (const id of ids) await cardkit.dispose(id)
    }
  })

  test('serializes safe markdown while preserving structured image components', async () => {
    const cardId = 'card_markdown_image_boundary'
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.addElement(cardId, {
      tag: 'column_set',
      element_id: 'assistant_0',
      columns: [{
        tag: 'column',
        elements: [
          { tag: 'markdown', content: 'bad ![x](img_key)' },
          { tag: 'img', img_key: 'img_v2_uploaded' },
        ],
      }],
    })

    const add = calls.find(call =>
      call.method === 'POST' && call.path === `/cards/${cardId}/elements`
    )
    const sent = JSON.parse(add?.body.elements ?? '[]')[0]
    expect(sent.columns[0].elements[0].content).not.toContain('![')
    expect(sent.columns[0].elements[0].content).toContain('img_key')
    expect(sent.columns[0].elements[1]).toEqual({ tag: 'img', img_key: 'img_v2_uploaded' })
    await cardkit.dispose(cardId)
  })

  test('retries id_convert when Feishu has not indexed the just-sent message yet', async () => {
    let attempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method ?? 'GET'),
        path: url.pathname.replace('/open-apis/cardkit/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      attempt++
      if (attempt === 1) {
        return new Response(JSON.stringify({
          code: 200740,
          msg: 'ErrMsg: queried result is empty;',
        }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { card_id: 'card_ready' },
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await expect(cardkit.convertMessageToCard('om_recent', { retryDelaysMs: [0, 0] }))
      .resolves.toBe('card_ready')

    expect(calls.map(call => call.path)).toEqual(['/cards/id_convert', '/cards/id_convert'])
  })

  test('flush waits for queued card writes', async () => {
    const cardId = 'card_flush_queue'
    const element = { tag: 'markdown', element_id: 'assistant_0', content: 'complete assistantMessage' }

    cardkit.recordCardCreated(cardId, 1)
    const write = cardkit.addElement(cardId, element, {
      type: 'insert_before',
      targetElementId: 'footer',
    })

    await cardkit.flush(cardId)
    await write
    await cardkit.dispose(cardId)

    const add = calls.find(call =>
      call.method === 'POST' &&
      call.path === `/cards/${cardId}/elements`
    )
    expect(add?.body.type).toBe('insert_before')
    expect(add?.body.target_element_id).toBe('footer')
    expect(JSON.parse(add?.body.elements ?? '[]')).toEqual([element])
  })
})

describe('checked card writes', () => {
  test('a queued tool result recreates a failed placeholder with its latest content and original placement', async () => {
    const id = 'card_retry_missing_add'
    cardkit.recordCardCreated(id, 1)
    let attempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace('/open-apis/cardkit/v1', '')
      calls.push({ method: String(init?.method), path, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(++attempt === 1
        ? { code: 300308, msg: 'temporary service error' }
        : { code: 0, data: {} }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const added = cardkit.addElementChecked(id, {
        tag: 'markdown', element_id: 'tool_0', content: 'working',
      }, { type: 'insert_before', targetElementId: 'footer' })
      const completed = cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'complete result',
      })
      expect(await added).toBe(false)
      expect(await completed).toBe(true)
      expect(calls.map(call => call.method)).toEqual(['POST', 'POST'])
      expect(calls[1]!.body.target_element_id).toBe('footer')
      expect(calls[1]!.body.elements).toContain('complete result')
      expect(cardkit.isDeadElement(id, 'tool_0')).toBe(false)
      expect(cardkit.getElementCount(id)).toBe(2)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('a rejected update can recover while explicitly deleted elements stay deleted', async () => {
    const id = 'card_retry_failed_update'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, { tag: 'markdown', element_id: 'tool_0', content: 'working' })
    const succeed = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 200860, msg: 'card over max size' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    try {
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'oversized result',
      })).toBe(false)
      globalThis.fetch = succeed
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'updated result',
      })).toBe(true)
      expect(await cardkit.deleteElementChecked(id, 'tool_0')).toBe(true)
      const before = calls.length
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'late result',
      })).toBe(false)
      expect(calls).toHaveLength(before)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('deleting after a failed update actually removes the remote element', async () => {
    const id = 'card_delete_after_failed_update'
    cardkit.recordCardCreated(id, 1)
    await cardkit.addElementChecked(id, { tag: 'markdown', element_id: 'tool_0', content: 'old content' })
    const succeed = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300308, msg: 'temporary error' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    try {
      expect(await cardkit.replaceElementChecked(id, 'tool_0', {
        tag: 'markdown', element_id: 'tool_0', content: 'new content',
      })).toBe(false)
      globalThis.fetch = succeed
      expect(await cardkit.deleteElementChecked(id, 'tool_0')).toBe(true)
      expect(calls.at(-1)?.method).toBe('DELETE')
      expect(cardkit.getElementCount(id)).toBe(1)
    } finally {
      await cardkit.dispose(id)
    }
  })

  test('patchSettingsChecked reports whether the terminal PATCH landed', async () => {
    const cardId = 'card_checked_settings'
    cardkit.recordCardCreated(cardId, 1)
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)

    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300308, msg: 'settings rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(false)
    await cardkit.dispose(cardId)
  })

  test('patchSettingsChecked reopens an expired stream and retries once', async () => {
    const cardId = 'card_checked_settings_reopen'
    cardkit.recordCardCreated(cardId, 1)
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? { code: 300309, msg: 'streaming mode is closed' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    expect(await cardkit.patchSettingsChecked(cardId, { config: { streaming_mode: false } })).toBe(true)
    expect(attempt).toBe(3) // failed PATCH → reopen PATCH → terminal PATCH retry
    await cardkit.dispose(cardId)
  })

  test('replaceElementChecked reports a Feishu PUT rejection', async () => {
    const cardId = 'card_checked_replace'
    cardkit.recordCardCreated(cardId, 1)
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300308, msg: 'element rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'x',
    })).toBe(false)
    await cardkit.dispose(cardId)
  })

  test('a size rejection in an isolated replacement leaves the original element writable', async () => {
    const cardId = 'card_local_size_failure'
    let notifications = 0
    let attempts = 0
    cardkit.recordCardCreated(cardId, 1, () => { notifications++ })
    globalThis.fetch = (async () => new Response(JSON.stringify(++attempts === 1
      ? { code: 200860, msg: 'ErrMsg: card over max size;' }
      : { code: 0, data: {} }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'column_set', element_id: 'assistant_0',
        columns: [{ tag: 'column', elements: [{ tag: 'img', img_key: 'uploaded_formula' }] }],
      }, { notifyCardFailure: false })).toBe(false)
      expect(notifications).toBe(0)
      expect(cardkit.isDeadElement(cardId, 'assistant_0')).toBe(false)
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: '原始公式 $$x^2$$',
      })).toBe(true)
      expect(attempts).toBe(2)
    } finally {
      await cardkit.dispose(cardId)
    }
  })

  test('add/delete checked variants return false on rejected mutations', async () => {
    const addCard = 'card_checked_add'
    cardkit.recordCardCreated(addCard, 1)
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300315, msg: 'add rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    expect(await cardkit.addElementChecked(addCard, {
      tag: 'markdown', element_id: 'math_1', content: 'x',
    })).toBe(false)
    await cardkit.dispose(addCard)

    const deleteCard = 'card_checked_delete'
    cardkit.recordCardCreated(deleteCard, 2)
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 300313, msg: 'delete rejected' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    expect(await cardkit.deleteElementChecked(deleteCard, 'math_1')).toBe(false)
    await cardkit.dispose(deleteCard)
  })

  test('HTTP errors and malformed success bodies never count as landed writes', async () => {
    for (const [cardId, response] of [
      ['card_http_502', new Response(JSON.stringify({ msg: 'gateway error' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      })],
      ['card_missing_code', new Response(JSON.stringify({ data: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })],
    ] as const) {
      cardkit.recordCardCreated(cardId, 1)
      globalThis.fetch = (async () => response.clone()) as unknown as typeof fetch
      expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
        tag: 'markdown', element_id: 'assistant_0', content: 'x',
      }, { notifyCardFailure: false })).toBe(false)
      await cardkit.dispose(cardId)
    }
  }, 10_000) // A persistent HTTP 502 now exhausts the real 1s + 4s retry delays.

  test('a throwing card failure callback cannot poison the write queue', async () => {
    const cardId = 'card_throwing_failure_callback'
    cardkit.recordCardCreated(cardId, 1, () => { throw new Error('callback boom') })
    let attempt = 0
    globalThis.fetch = (async () => {
      attempt++
      return new Response(JSON.stringify(attempt === 1
        ? { code: 300308, msg: 'first rejected' }
        : { code: 0, data: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    expect(await cardkit.replaceElementChecked(cardId, 'assistant_0', {
      tag: 'markdown', element_id: 'assistant_0', content: 'first',
    })).toBe(false)
    expect(await cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'second', content: 'second',
    })).toBe(true)
    await cardkit.dispose(cardId)
  })
})

describe('disposed card write guard (review #3)', () => {
  test('closed cards stay unwritable after thousands of newer cards, and unknown cards are never created by a write', async () => {
    const id = 'card_closed_long_ago'
    cardkit.recordCardCreated(id, 1)
    await cardkit.dispose(id)
    for (let i = 0; i < 5001; i++) {
      const newer = `card_disposal_${i}`
      cardkit.recordCardCreated(newer, 1)
      await cardkit.dispose(newer)
    }
    for (const target of [id, 'never_registered']) {
      expect(cardkit.isDisposed(target)).toBe(true)
      expect(await cardkit.addElementChecked(target, {
        tag: 'markdown', element_id: 'late', content: 'late output',
      })).toBe(false)
      expect(await cardkit.patchSettingsChecked(target, { config: { streaming_mode: true } })).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test('dispose 后 addElement/replaceElement 不产生 HTTP 调用', async () => {
    const cardId = 'card_disposed_guard'
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.dispose(cardId)
    const before = calls.length
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'x1', content: 'hi' })
    await cardkit.replaceElement(cardId, 'footer', { tag: 'markdown', element_id: 'footer', content: 'f' })
    expect(calls.length).toBe(before) // 无新 HTTP
    expect(await cardkit.addElementChecked(cardId, { tag: 'markdown', element_id: 'x2', content: 'hi' })).toBe(false)
  })

  test('recordCardCreated 复活同 id 卡(新 turn 复用 card id 场景)', async () => {
    const cardId = 'card_revive'
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.dispose(cardId)
    cardkit.recordCardCreated(cardId, 1)
    await cardkit.addElement(cardId, { tag: 'markdown', element_id: 'rv1', content: 'ok' })
    await cardkit.flush(cardId)
    expect(calls.some(c => c.method === 'POST' && c.path === `/cards/${cardId}/elements` && JSON.parse(c.body.elements)[0]?.element_id === 'rv1')).toBe(true)
    await cardkit.dispose(cardId)
  })

  test('dispose synchronously closes the enqueue gate before draining', async () => {
    const cardId = 'card_dispose_race'
    cardkit.recordCardCreated(cardId, 1)
    let releaseFetch: () => void = () => {}
    const fetchStarted = new Promise<void>(resolve => {
      globalThis.fetch = (async () => {
        resolve()
        await new Promise<void>(release => { releaseFetch = release })
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch
    })

    const first = cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'first', content: 'first',
    })
    await fetchStarted
    const disposing = cardkit.dispose(cardId)
    const second = await cardkit.addElementChecked(cardId, {
      tag: 'markdown', element_id: 'second', content: 'second',
    })
    expect(second).toBe(false)
    releaseFetch()
    expect(await first).toBe(true)
    await disposing
    expect(cardkit.isDisposed(cardId)).toBe(true)
  })
})
