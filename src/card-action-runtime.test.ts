import { describe, expect, test } from 'bun:test'
import * as lark from '@larksuiteoapi/node-sdk'
import {
  ActionDeduper,
  PerKeyActor,
  createCardActionAdmission,
  createPerChatAdmission,
  afterCardActionAck,
  cardActionDedupeKey,
  cardActionDedupeKeys,
  validateCardActionAdmission,
  type ActionCompletion,
} from './card-action-runtime'
import { drainDynamicWork, trackWork } from './inflight-work'

describe('PerKeyActor', () => {
  test('serializes one chat while allowing another chat to progress', async () => {
    const actor = new PerKeyActor()
    const events: string[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>(resolve => { releaseA = resolve })
    const first = actor.enqueue('chat-a', async () => { events.push('a1-start'); await gateA; events.push('a1-end') })
    const second = actor.enqueue('chat-a', async () => { events.push('a2') })
    const other = actor.enqueue('chat-b', async () => { events.push('b1') })

    await other
    expect(events).toEqual(['a1-start', 'b1'])
    releaseA()
    await Promise.all([first, second])
    expect(events).toEqual(['a1-start', 'b1', 'a1-end', 'a2'])
    expect([...actor.pending()]).toHaveLength(0)
  })

  test('continues the FIFO after a rejected task', async () => {
    const actor = new PerKeyActor()
    const events: string[] = []
    await expect(actor.enqueue('chat', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await actor.enqueue('chat', async () => { events.push('next') })
    expect(events).toEqual(['next'])
  })
})

describe('ActionDeduper', () => {
  test('suppresses in-flight and recently completed duplicates, then expires', () => {
    let now = 1_000
    const deduper = new ActionDeduper(100, () => now)
    expect(deduper.claim('x')).toBe('started')
    expect(deduper.claim('x')).toBe('inflight')
    deduper.complete('x')
    expect(deduper.claim('x')).toBe('completed')
    now += 101
    expect(deduper.claim('x')).toBe('started')
  })

  test('allows retry after handler failure', () => {
    const deduper = new ActionDeduper()
    expect(deduper.claim('x')).toBe('started')
    deduper.fail('x')
    expect(deduper.claim('x')).toBe('started')
  })

  test('bounds completed tombstones and evicts the oldest claim', () => {
    const deduper = new ActionDeduper(1_000, () => 0, 2)
    for (const key of ['a', 'b', 'c']) {
      expect(deduper.claim(key)).toBe('started')
      deduper.complete(key)
    }
    expect(deduper.claim('a')).toBe('started')
    expect(deduper.claim('b')).toBe('completed')
    expect(deduper.claim('c')).toBe('completed')
  })

  test('atomically suppresses either event-id retries or semantic double-clicks', () => {
    const deduper = new ActionDeduper()
    expect(deduper.claimAll(['event:e1', 'semantic:x'])).toBe('started')
    expect(deduper.claimAll(['event:e1', 'semantic:y'])).toBe('inflight')
    expect(deduper.claimAll(['event:e2', 'semantic:x'])).toBe('inflight')
    deduper.completeAll(['event:e1', 'semantic:x'])
    expect(deduper.claimAll(['event:e3', 'semantic:x'])).toBe('completed')
  })

})

describe('card action identity', () => {
  const data = (value: object) => ({
    context: { open_chat_id: 'chat', open_message_id: 'message' },
    action: { value },
  })

  test('collapses different buttons in the same one-shot model stage', () => {
    expect(cardActionDedupeKey(data({ kind: 'model_effort_select', panel_id: 'p', effort: 'high' })))
      .toBe(cardActionDedupeKey(data({ kind: 'model_effort_select', panel_id: 'p', effort: 'xhigh' })))
  })

  test('collapses every choice from one menu/temp source card into one stage', () => {
    expect(cardActionDedupeKey(data({ kind: 'menu', request_id: 'menu-1', choice: 0 })))
      .toBe(cardActionDedupeKey(data({ kind: 'menu', request_id: 'menu-1', choice: 2 })))
    expect(cardActionDedupeKey(data({ kind: 'temp_fork_select', panel_id: 'fork-panel', choice_id: 'a' })))
      .toBe(cardActionDedupeKey(data({ kind: 'temp_fork_select', panel_id: 'fork-panel', choice_id: 'b' })))
    expect(cardActionDedupeKey(data({ kind: 'temp_back_select', panel_id: 'back-panel', choice_id: 'a' })))
      .toBe(cardActionDedupeKey(data({ kind: 'temp_back_select', panel_id: 'back-panel', choice_id: 'b' })))
    expect(cardActionDedupeKey(data({ kind: 'temp_resume_select', panel_id: 'resume-panel', choice_id: 'a' })))
      .toBe(cardActionDedupeKey(data({ kind: 'temp_resume_select', panel_id: 'resume-panel', choice_id: 'b' })))
    expect(cardActionDedupeKey(data({ kind: 'temp_fork_select', panel_id: 'fork-panel-a', choice_id: 'x' })))
      .not.toBe(cardActionDedupeKey(data({ kind: 'temp_fork_select', panel_id: 'fork-panel-b', choice_id: 'x' })))
  })

  test('keeps independent ask questions distinct', () => {
    expect(cardActionDedupeKey(data({ kind: 'ask', tool_use_id: 't', question_idx: 0, option_idx: 0 })))
      .not.toBe(cardActionDedupeKey(data({ kind: 'ask', tool_use_id: 't', question_idx: 1, option_idx: 0 })))
  })

  test('admits global Agent identity pagination and keeps targets distinct', () => {
    expect(validateCardActionAdmission(data({ kind: 'agent_identity_page', panel_id: 'p', page: 1 }))).toBeNull()
    expect(cardActionDedupeKey(data({ kind: 'agent_identity_page', panel_id: 'p', page: 1 })))
      .not.toBe(cardActionDedupeKey(data({ kind: 'agent_identity_page', panel_id: 'p', page: 2 })))
  })

  test('uses event_id and semantic keys together', () => {
    const event = { ...data({ kind: 'tasklist_enable' }), event_id: 'evt-1' }
    expect(cardActionDedupeKeys(event)).toHaveLength(2)
    expect(cardActionDedupeKeys(event)[0]).toContain('evt-1')
  })

  test('fallback semantic fingerprint is canonical across value key order', () => {
    expect(cardActionDedupeKey(data({ kind: 'menu', choice: 1, extra: { b: 2, a: 1 } })))
      .toBe(cardActionDedupeKey(data({ extra: { a: 1, b: 2 }, choice: 1, kind: 'menu' })))
  })

  test('rejects malformed permissions and missing ordinary card identity', () => {
    const malformed = data({ kind: 'permission', request_id: 'r', decision: 'surprise' })
    expect(validateCardActionAdmission(malformed)).toContain('无效的权限决定')
    expect(validateCardActionAdmission({
      context: { open_chat_id: 'chat' },
      action: { value: { kind: 'tasklist_enable' } },
    })).toContain('message_id')
    expect(validateCardActionAdmission(data({
      kind: 'permission', request_id: 'r', decision: 'deny',
    }))).toBeNull()
  })

  test('defers work beyond the current microtask checkpoint', async () => {
    let ran = false
    const deferred = afterCardActionAck().then(() => { ran = true })
    await Promise.resolve()
    expect(ran).toBe(false)
    await deferred
    expect(ran).toBe(true)
  })
})

interface TestAck {
  state: 'accepted' | 'inflight' | 'completed' | 'closed' | 'invalid'
  message?: string
}

interface TestResult {
  __businessOk?: boolean
  __cardActionCompletion?: Promise<ActionCompletion>
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function actionEvent(
  eventId: string,
  chatId = 'chat-a',
  value: Record<string, unknown> = { kind: 'menu', choice: 0 },
): any {
  return {
    event_id: eventId,
    context: { open_chat_id: chatId, open_message_id: `message-${chatId}` },
    operator: { open_id: 'user-1' },
    action: { value },
  }
}

function admissionHarness(overrides: Partial<{
  afterAck: () => Promise<void>
  execute: (data: any) => Promise<TestResult>
  present: (data: any, result: TestResult) => Promise<void>
  presentExecutionFailure: (data: any, error: unknown) => Promise<void>
  presentPresentationFailure: (data: any, error: unknown) => Promise<void>
}> = {}) {
  const actor = new PerKeyActor()
  const deduper = new ActionDeduper(30_000)
  const work = new Set<Promise<unknown>>()
  const effects: string[] = []
  const errors: unknown[] = []
  let executeCalls = 0
  const messages = createPerChatAdmission<{
    chatId: string
    run(acceptedAt: number): Promise<void>
  }>({
    actor,
    key: message => message.chatId,
    execute: (message, acceptedAt) => message.run(acceptedAt),
  })
  const admission = createCardActionAdmission<TestResult, TestAck>({
    actor,
    deduper,
    scope: data => String(data?.context?.open_chat_id ?? '') || '__notify__',
    afterAck: overrides.afterAck ?? (() => Promise.resolve()),
    execute: overrides.execute ?? (async data => {
      executeCalls++
      effects.push(`execute:${data.event_id}`)
      return { __businessOk: true }
    }),
    present: overrides.present ?? (async data => { effects.push(`present:${data.event_id}`) }),
    presentExecutionFailure: overrides.presentExecutionFailure
      ?? (async (_data, error) => { effects.push(`execution-failure:${String(error)}`) }),
    presentPresentationFailure: overrides.presentPresentationFailure
      ?? (async (_data, error) => { effects.push(`presentation-failure:${String(error)}`) }),
    businessSucceeded: (_data, result) => result.__businessOk !== false,
    completion: (_data, result) => result.__cardActionCompletion ?? null,
    track: promise => { trackWork(work, promise) },
    onBackgroundError: error => { errors.push(error) },
    responses: {
      accepted: () => ({ state: 'accepted' }),
      inflight: () => ({ state: 'inflight' }),
      completed: () => ({ state: 'completed' }),
      closed: () => ({ state: 'closed' }),
      invalid: (_data, message) => ({ state: 'invalid', message }),
    },
  })
  const drain = () => drainDynamicWork(() => [...actor.pending(), ...work])
  return {
    actor, messages, admission, drain, effects, errors, work,
    executeCalls: () => executeCalls,
  }
}

describe('CardActionAdmission integration', () => {
  test('Lark EventDispatcher returns the ACK while the admitted side effect is still gated', async () => {
    const ackGate = deferred<void>()
    const h = admissionHarness({ afterAck: () => ackGate.promise })
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error })
    let flattenedEventId = ''
    dispatcher.register({
      'card.action.trigger': async (data: any) => {
        flattenedEventId = String(data.event_id ?? '')
        return h.admission.accept(data)
      },
    })

    const eventPayload = actionEvent('payload-has-no-event-id')
    delete eventPayload.event_id
    const response = await dispatcher.invoke({
      schema: '2.0',
      header: {
        event_id: 'evt-sdk-adapter',
        event_type: 'card.action.trigger',
        create_time: String(Date.now()),
      },
      event: eventPayload,
    }, { needCheck: false })

    expect(response).toEqual({ state: 'accepted' })
    expect(flattenedEventId).toBe('evt-sdk-adapter')
    expect(h.executeCalls()).toBe(0)
    expect(h.effects).toEqual([])

    ackGate.resolve()
    await h.drain()
    expect(h.executeCalls()).toBe(1)
  })

  test('returns ACK before business or presentation side effects', async () => {
    const barrier = deferred<void>()
    const h = admissionHarness({ afterAck: () => barrier.promise })

    expect(h.admission.accept(actionEvent('event-ack'))).toEqual({ state: 'accepted' })
    expect(h.effects).toEqual([])
    expect(h.executeCalls()).toBe(0)
    expect(h.work.size).toBe(1)

    barrier.resolve()
    await h.drain()
    expect(h.effects).toEqual(['execute:event-ack', 'present:event-ack'])
    expect(h.errors).toEqual([])
  })

  test('shares one actor for message → action → message FIFO', async () => {
    const h = admissionHarness()
    const firstGate = deferred<void>()
    const first = h.messages.accept({
      chatId: 'chat-a',
      run: async () => {
        h.effects.push('message-1-start')
        await firstGate.promise
        h.effects.push('message-1-end')
      },
    })
    expect(first.accepted).toBe(true)

    expect(h.admission.accept(actionEvent('event-middle'))).toEqual({ state: 'accepted' })
    const last = h.messages.accept({
      chatId: 'chat-a',
      run: async () => { h.effects.push('message-2') },
    })
    expect(last.accepted).toBe(true)
    await Promise.resolve()
    expect(h.effects).toEqual(['message-1-start'])

    firstGate.resolve()
    await h.drain()
    expect(h.effects).toEqual([
      'message-1-start', 'message-1-end',
      'execute:event-middle', 'present:event-middle',
      'message-2',
    ])
  })

  test('runs action before a later message in the same chat', async () => {
    const actionGate = deferred<void>()
    const actionStarted = deferred<void>()
    const h = admissionHarness({
      execute: async data => {
        h.effects.push(`action-start:${data.event_id}`)
        actionStarted.resolve()
        await actionGate.promise
        h.effects.push(`action-end:${data.event_id}`)
        return { __businessOk: true }
      },
    })

    expect(h.admission.accept(actionEvent('event-first'))).toEqual({ state: 'accepted' })
    const message = h.messages.accept({
      chatId: 'chat-a',
      run: async () => { h.effects.push('message-after') },
    })
    expect(message.accepted).toBe(true)
    await actionStarted.promise
    expect(h.effects).toEqual(['action-start:event-first'])

    actionGate.resolve()
    await h.drain()
    expect(h.effects).toEqual([
      'action-start:event-first', 'action-end:event-first',
      'present:event-first', 'message-after',
    ])
  })

  test('allows unrelated chats to execute concurrently', async () => {
    const chatAGate = deferred<void>()
    const chatAStarted = deferred<void>()
    const chatBPresented = deferred<void>()
    const h = admissionHarness({
      execute: async data => {
        h.effects.push(`execute:${data.event_id}`)
        if (data.context.open_chat_id === 'chat-a') {
          chatAStarted.resolve()
          await chatAGate.promise
        }
        return { __businessOk: true }
      },
      present: async data => {
        h.effects.push(`present:${data.event_id}`)
        if (data.context.open_chat_id === 'chat-b') chatBPresented.resolve()
      },
    })

    expect(h.admission.accept(actionEvent('event-a', 'chat-a'))).toEqual({ state: 'accepted' })
    expect(h.admission.accept(actionEvent('event-b', 'chat-b'))).toEqual({ state: 'accepted' })
    await chatAStarted.promise
    await chatBPresented.promise
    expect(h.effects).toContain('present:event-b')
    expect(h.effects).not.toContain('present:event-a')

    chatAGate.resolve()
    await h.drain()
    expect(h.effects).toContain('present:event-a')
  })

  test('double-click registers one business execution', async () => {
    const barrier = deferred<void>()
    const h = admissionHarness({ afterAck: () => barrier.promise })
    const event = actionEvent('event-double')

    expect(h.admission.accept(event)).toEqual({ state: 'accepted' })
    expect(h.admission.accept(event)).toEqual({ state: 'inflight' })
    barrier.resolve()
    await h.drain()
    expect(h.executeCalls()).toBe(1)
    expect(h.admission.accept(event)).toEqual({ state: 'completed' })
  })

  test('paging back and refreshing again stay available while duplicate deliveries remain suppressed', async () => {
    const h = admissionHarness()
    for (const [index, page] of [1, 0, 1, 1].entries()) {
      const event = actionEvent(`page-click-${index}`, 'chat-a', {
        kind: 'agent_identity_page', panel_id: 'panel-1', page,
      })
      expect(h.admission.accept(event)).toEqual({ state: 'accepted' })
      await h.drain()
      expect(h.admission.accept(event)).toEqual({ state: 'completed' })
    }
    expect(h.executeCalls()).toBe(4)
  })

  test('presentation rejection cannot rerun successful business work', async () => {
    let executeCalls = 0
    let failureReceipts = 0
    const h = admissionHarness({
      execute: async () => { executeCalls++; return { __businessOk: true } },
      present: async () => { throw new Error('message.patch rejected') },
      presentPresentationFailure: async () => { failureReceipts++ },
    })

    expect(h.admission.accept(actionEvent('event-present-1'))).toEqual({ state: 'accepted' })
    await h.drain()
    expect(failureReceipts).toBe(1)
    expect(h.admission.accept(actionEvent('event-present-2'))).toEqual({ state: 'completed' })
    expect(executeCalls).toBe(1)
  })

  test('explicit business failure completes delivery but releases semantic retry', async () => {
    let executeCalls = 0
    const h = admissionHarness({
      execute: async () => { executeCalls++; return { __businessOk: false } },
    })
    const first = actionEvent('event-business-fail')

    expect(h.admission.accept(first)).toEqual({ state: 'accepted' })
    await h.drain()
    expect(h.admission.accept(first)).toEqual({ state: 'completed' })
    expect(h.admission.accept(actionEvent('event-business-retry'))).toEqual({ state: 'accepted' })
    await h.drain()
    expect(executeCalls).toBe(2)
  })

  test('unexpected execution rejection quarantines the semantic key to avoid unknown side-effect replay', async () => {
    let executeCalls = 0
    let failureReceipts = 0
    const h = admissionHarness({
      execute: async () => { executeCalls++; throw new Error('commit status unknown') },
      presentExecutionFailure: async () => { failureReceipts++ },
    })

    expect(h.admission.accept(actionEvent('event-unknown-1'))).toEqual({ state: 'accepted' })
    await h.drain()
    expect(failureReceipts).toBe(1)
    expect(h.admission.accept(actionEvent('event-unknown-2'))).toEqual({ state: 'completed' })
    expect(executeCalls).toBe(1)
  })

  test('notify retry releases business key while completion retains it', async () => {
    const firstCompletion = deferred<ActionCompletion>()
    const secondCompletion = deferred<ActionCompletion>()
    const firstPresented = deferred<void>()
    const secondPresented = deferred<void>()
    let executeCalls = 0
    let presentCalls = 0
    const h = admissionHarness({
      execute: async () => {
        executeCalls++
        return {
          __businessOk: true,
          __cardActionCompletion: executeCalls === 1
            ? firstCompletion.promise
            : secondCompletion.promise,
        }
      },
      present: async () => {
        presentCalls++
        if (presentCalls === 1) firstPresented.resolve()
        else secondPresented.resolve()
      },
    })
    const value = { kind: 'notify_callback', notify_id: 'notify-1', button_id: 'go' }
    const first = actionEvent('notify-event-1', '', value)
    const retry = actionEvent('notify-event-2', '', value)

    expect(h.admission.accept(first)).toEqual({ state: 'accepted' })
    await firstPresented.promise
    expect(h.admission.accept(retry)).toEqual({ state: 'inflight' })
    firstCompletion.resolve('retry')
    await h.drain()
    expect(h.admission.accept(first)).toEqual({ state: 'completed' })

    expect(h.admission.accept(retry)).toEqual({ state: 'accepted' })
    await secondPresented.promise
    secondCompletion.resolve('complete')
    await h.drain()
    expect(h.admission.accept(actionEvent('notify-event-3', '', value))).toEqual({ state: 'completed' })
    expect(executeCalls).toBe(2)
  })

  test('notification reply prompts can reopen immediately while replayed deliveries remain deduplicated', async () => {
    let count = 0
    const h = admissionHarness({ execute: async () => { count++; return { __businessOk: true } } })
    const value = { kind: 'notify_reply', notify_id: 'nf_reply' }
    const first = actionEvent('reply-event-1', '', value)
    expect(validateCardActionAdmission(first)).toBeNull()
    expect(h.admission.accept(first)).toEqual({ state: 'accepted' })
    await h.drain()
    expect(h.admission.accept(first)).toEqual({ state: 'completed' })
    expect(h.admission.accept(actionEvent('reply-event-2', '', value))).toEqual({ state: 'accepted' })
    await h.drain()
    expect(count).toBe(2)
    expect(cardActionDedupeKey(actionEvent('cancel-1', '', { kind: 'notify_reply_cancel', notify_id: 'nf_reply', reply_id: 'one' })))
      .not.toBe(cardActionDedupeKey(actionEvent('cancel-2', '', { kind: 'notify_reply_cancel', notify_id: 'nf_reply', reply_id: 'two' })))
  })

  test('close rejects new work while accepted tails remain drainable', async () => {
    const h = admissionHarness()
    const oldGate = deferred<void>()
    const old = h.messages.accept({
      chatId: 'chat-a',
      run: async () => {
        h.effects.push('old-start')
        await oldGate.promise
        h.effects.push('old-end')
      },
    })
    expect(old.accepted).toBe(true)
    await Promise.resolve()

    h.actor.close()
    expect(h.admission.accept(actionEvent('event-closed'))).toEqual({ state: 'closed' })
    expect(h.messages.accept({ chatId: 'chat-a', run: async () => {} })).toEqual({
      accepted: false,
      reason: 'closed',
    })

    oldGate.resolve()
    await h.drain()
    expect(h.effects).toEqual(['old-start', 'old-end'])
    expect([...h.actor.pending()]).toHaveLength(0)
  })

  test('message admission rejects missing chat without running or tracking work', () => {
    const h = admissionHarness()
    let ran = false

    expect(h.messages.accept({
      chatId: '',
      run: async () => { ran = true },
    })).toEqual({ accepted: false, reason: 'invalid-key' })
    expect(ran).toBe(false)
    expect([...h.actor.pending()]).toHaveLength(0)
  })
})
