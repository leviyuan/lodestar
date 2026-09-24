import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __setStoreFileForTest,
  buildNotifyResult,
  beginCallbackDispatch,
  clearDispatching,
  dispatchCallback,
  get,
  isDispatching,
  loadCallbacks,
  markResolved,
  recordCallbackSuccess,
  recordCallbackFailure,
  prune,
  register,
  setDispatching,
  type NotifyRegistration,
} from './notify-callbacks'

let tempDir: string
let tempFile: string

function sampleReg(overrides: Partial<NotifyRegistration> = {}): NotifyRegistration {
  return {
    notifyId: 'nf_test1',
    callbackUrl: 'http://127.0.0.1:9999/hook',
    chatId: 'oc_chat',
    messageId: 'om_msg',
    project: 'feishu',
    title: 'ops',
    text: 'approve?',
    level: 'info',
    imageKeys: [],
    buttons: [{ id: 'approve', text: '✅ 通过', type: 'primary' }],
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lodestar-nc-'))
  tempFile = join(tempDir, 'notify-callbacks.json')
  __setStoreFileForTest(tempFile)  // also clears the in-memory map
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('notify-callbacks store', () => {
  test('register + get round-trip', () => {
    expect(get('nf_test1')).toBeUndefined()
    register(sampleReg())
    const got = get('nf_test1')
    expect(got?.callbackUrl).toBe('http://127.0.0.1:9999/hook')
    expect(got?.buttons[0].id).toBe('approve')
    expect(got?.resolvedAt).toBeUndefined()
  })

  test('persistence survives a fresh load (reload from disk)', () => {
    register(sampleReg({ notifyId: 'nf_persist' }))
    // Simulate a daemon restart: in-memory map is wiped, then we reload
    // from the same file path.
    __setStoreFileForTest(tempFile)  // clear memory but keep the file
    loadCallbacks()
    expect(get('nf_persist')?.messageId).toBe('om_msg')
  })

  test('markResolved stamps resolvedAt + resolvedBy and persists', () => {
    register(sampleReg())
    markResolved('nf_test1', 'approve', 'ou_user1')
    const got = get('nf_test1')
    expect(got?.resolvedAt).toBeGreaterThan(0)
    expect(got?.resolvedBy).toEqual({ buttonId: 'approve', openId: 'ou_user1' })
    // Confirmed on disk after a fresh load.
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.resolvedBy?.openId).toBe('ou_user1')
  })

  test('markResolved exposes persistence failure and rolls back the resolved flag', () => {
    register(sampleReg())
    // A regular file cannot be used as a parent directory, forcing the atomic
    // writer to fail without relying on platform-specific chmod semantics.
    __setStoreFileForTest(join(tempFile, 'child.json'), false)

    expect(() => markResolved('nf_test1', 'approve', 'ou_user1')).toThrow()
    expect(get('nf_test1')?.resolvedAt).toBeUndefined()
    expect(get('nf_test1')?.resolvedBy).toBeUndefined()
  })

  test('successful external callback becomes non-retryable unknown when tombstone persistence fails', () => {
    register(sampleReg())
    __setStoreFileForTest(join(tempFile, 'child.json'), false)

    const outcome = recordCallbackSuccess('nf_test1', 'approve', 'ou_user1')

    expect(outcome.state).toBe('unknown')
    expect(get('nf_test1')?.resolvedAt).toBeUndefined()
    expect(get('nf_test1')?.unknownAt).toBeGreaterThan(0)
    expect(get('nf_test1')?.unknownBy).toEqual({ buttonId: 'approve', openId: 'ou_user1' })
    expect(get('nf_test1')?.unknownReason).toContain('tombstone persistence')
  })

  test('prune(now) drops entries older than 7 days, keeps fresh', () => {
    const now = 1_700_000_000_000
    register(sampleReg({ notifyId: 'nf_old', createdAt: now - 8 * 24 * 3600_000 }))
    register(sampleReg({ notifyId: 'nf_new', createdAt: now - 1 * 3600_000 }))
    const removed = prune(now)
    expect(removed).toBe(1)
    expect(get('nf_old')).toBeUndefined()
    expect(get('nf_new')).toBeDefined()
  })

  test('only a missing store is treated as first boot; unreadable and malformed stores fail visibly', () => {
    expect(loadCallbacks()).toEqual([])
    for (const contents of ['{ not valid json', 'null', '[]']) {
      writeFileSync(tempFile, contents)
      __setStoreFileForTest(tempFile)
      expect(() => loadCallbacks()).toThrow()
      expect(readFileSync(tempFile, 'utf8')).toBe(contents)
    }
    __setStoreFileForTest(tempDir)
    expect(() => loadCallbacks()).toThrow()
  })

  test('a button callback interrupted after durable dispatch becomes UNKNOWN on restart', () => {
    register(sampleReg())
    beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')
    expect(() => beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')).toThrow()
    __setStoreFileForTest(tempFile)
    const recovered = loadCallbacks()
    expect(recovered.map(reg => reg.notifyId)).toEqual(['nf_test1'])
    expect(buildNotifyResult(get('nf_test1')!)).toMatchObject({
      resolved: false, unknown: true, button: { id: 'approve' }, unknown_by: 'ou_operator',
    })
    expect(() => beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')).toThrow()
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.unknownAt).toBeDefined()
  })

  test('dispatch cannot begin when its pending marker cannot be saved', () => {
    register(sampleReg())
    __setStoreFileForTest(join(tempFile, 'child.json'), false)
    expect(() => beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')).toThrow()
    expect(get('nf_test1')?.dispatchState).toBeUndefined()
  })

  test('confirmed success and failed dispatch clear the pending marker durably', () => {
    register(sampleReg())
    beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')
    expect(recordCallbackFailure('nf_test1')).toEqual({ state: 'retry' })
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.dispatchState).toBeUndefined()
    expect(get('nf_test1')?.unknownAt).toBeUndefined()
    beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')
    expect(recordCallbackSuccess('nf_test1', 'approve', 'ou_operator')).toEqual({ state: 'complete' })
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.dispatchState).toBeUndefined()
    expect(get('nf_test1')?.resolvedAt).toBeDefined()
  })

  test.each(['success', 'failure'])('failed %s persistence keeps the original dispatch nonretryable after restart', outcome => {
    register(sampleReg())
    beginCallbackDispatch('nf_test1', 'approve', 'ou_operator')
    __setStoreFileForTest(join(tempFile, 'child.json'), false)
    const recorded = outcome === 'success'
      ? recordCallbackSuccess('nf_test1', 'approve', 'ou_operator') : recordCallbackFailure('nf_test1')
    expect(recorded.state).toBe('unknown')
    expect(get('nf_test1')?.unknownAt).toBeDefined()
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(get('nf_test1')?.unknownAt).toBeDefined()
    expect(get('nf_test1')?.unknownBy?.buttonId).toBe('approve')
  })

  test('callbackUrl may be empty (pull / display-only mode still registers)', () => {
    register(sampleReg({ notifyId: 'nf_pull', callbackUrl: '' }))
    expect(get('nf_pull')?.callbackUrl).toBe('')
  })

  test('dispatching guard is in-memory only and survives a reload as cleared', () => {
    register(sampleReg({ notifyId: 'nf_dispatch' }))
    expect(isDispatching('nf_dispatch')).toBe(false)
    setDispatching('nf_dispatch')
    expect(isDispatching('nf_dispatch')).toBe(true)
    // A "restart" wipes the in-memory guard but persists registrations.
    __setStoreFileForTest(tempFile)
    loadCallbacks()
    expect(isDispatching('nf_dispatch')).toBe(false)
    expect(get('nf_dispatch')).toBeDefined()
    // Manual clear also works.
    setDispatching('nf_dispatch')
    clearDispatching('nf_dispatch')
    expect(isDispatching('nf_dispatch')).toBe(false)
  })
})

describe('buildNotifyResult (pull payload)', () => {
  test('pending ⇒ resolved:false, no button fields', () => {
    register(sampleReg({ notifyId: 'nf_pending' }))
    const r = buildNotifyResult(get('nf_pending')!) as any
    expect(r.resolved).toBe(false)
    expect(r.unknown).toBe(false)
    expect(r.notify_id).toBe('nf_pending')
    expect(r.project).toBe('feishu')
    expect(r.message_id).toBe('om_msg')
    expect(r.button).toBeUndefined()
    expect(r.resolved_at).toBeUndefined()
  })

  test('resolved ⇒ full verdict with button text/type + operator', () => {
    register(sampleReg({ notifyId: 'nf_done' }))
    markResolved('nf_done', 'approve', 'ou_op')
    const r = buildNotifyResult(get('nf_done')!) as any
    expect(r.resolved).toBe(true)
    expect(r.button).toEqual({ id: 'approve', text: '✅ 通过', type: 'primary' })
    expect(typeof r.resolved_at).toBe('number')
    expect(r.resolved_by).toBe('ou_op')
  })

  test('unknown ⇒ non-retryable ambiguous outcome with operator and reason', () => {
    register(sampleReg({ notifyId: 'nf_unknown' }))
    __setStoreFileForTest(join(tempFile, 'child.json'), false)
    expect(recordCallbackSuccess('nf_unknown', 'approve', 'ou_op').state).toBe('unknown')

    const r = buildNotifyResult(get('nf_unknown')!) as any
    expect(r.resolved).toBe(false)
    expect(r.unknown).toBe(true)
    expect(r.button).toEqual({ id: 'approve', text: '✅ 通过', type: 'primary' })
    expect(r.unknown_by).toBe('ou_op')
    expect(r.unknown_reason).toContain('tombstone persistence')
  })
})

describe('dispatchCallback', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('2xx ⇒ ok', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 204 })) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅ 通过', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(true)
  })

  test('non-2xx ⇒ !ok with HTTP status in detail', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/500/)
  })

  test('abort (timeout) ⇒ !ok with 超时 detail, never a safe fallback', async () => {
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      // Emulate the AbortController firing inside the dispatcher.
      init?.signal?.dispatchEvent?.(new Event('abort'))
      const e = new Error('aborted')
      ;(e as any).name = 'AbortError'
      throw e
    }) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/超时/)
  })

  test('network error ⇒ !ok with the real message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:9999')
    }) as unknown as typeof fetch
    const r = await dispatchCallback(sampleReg(), { id: 'approve', text: '✅', type: 'primary' }, 'ou_u')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/ECONNREFUSED/)
  })

  test('payload shape: notify_id / button / operator carried to the caller', async () => {
    let captured: any = null
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    await dispatchCallback(sampleReg({ notifyId: 'nf_shape' }), { id: 'reject', text: '❌', type: 'danger' }, 'ou_op')
    expect(captured.notify_id).toBe('nf_shape')
    expect(captured.message_id).toBe('om_msg')
    expect(captured.chat_id).toBe('oc_chat')
    expect(captured.project).toBe('feishu')
    expect(captured.button).toEqual({ id: 'reject', text: '❌', type: 'danger' })
    expect(captured.operator).toEqual({ open_id: 'ou_op' })
    expect(typeof captured.timestamp).toBe('number')
  })

  test('text reply payload preserves user text and both message references without inventing a button', async () => {
    let captured: any
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      return new Response('{"text":"收到回复"}', { status: 200 })
    }) as unknown as typeof fetch
    const response = { text: '明天十点\n**保留原文**', message_id: 'om_user', prompt_message_id: 'om_waiting' }
    const result = await dispatchCallback(sampleReg(), response, 'ou_author')
    expect(captured.response).toEqual({ type: 'text', ...response })
    expect(captured.message_id).toBe('om_msg')
    expect(captured.operator).toEqual({ open_id: 'ou_author' })
    expect(captured.button).toBeUndefined()
    expect(result.reply).toBe('收到回复')
  })

  test('reply capture: JSON {text} / {reply} / plain text / empty', async () => {
    // JSON {text}
    globalThis.fetch = (async () => new Response(JSON.stringify({ text: '已发布 v1.2.3' }), { status: 200 })) as unknown as typeof fetch
    let r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('已发布 v1.2.3')
    // JSON {reply} alias
    globalThis.fetch = (async () => new Response(JSON.stringify({ reply: 'ok done' }), { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('ok done')
    // plain text body
    globalThis.fetch = (async () => new Response('deployed', { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBe('deployed')
    // empty body → no reply
    globalThis.fetch = (async () => new Response('', { status: 204 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply).toBeUndefined()
    // capped at 500 chars
    const long = 'x'.repeat(800)
    globalThis.fetch = (async () => new Response(long, { status: 200 })) as unknown as typeof fetch
    r = await dispatchCallback(sampleReg(), { id: 'a', text: 'x', type: 'default' }, 'ou_u')
    expect(r.reply?.length).toBe(500)
  })
})
