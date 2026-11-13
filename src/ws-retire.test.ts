import { describe, expect, test } from 'bun:test'
import { clientEventDispatcher, createWsRetirement, type WsRetireTimers } from './ws-retire'

function fakeTimers() {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const timers: WsRetireTimers<number> = {
    set(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id },
    clear(id) { pending.delete(id) },
  }
  const fireAll = () => {
    const due = [...pending]
    pending.clear()
    for (const [, timer] of due) timer.fn()
  }
  return { timers, pending, fireAll }
}

function harness(checks = 2) {
  const closes: string[] = []
  const errors: unknown[] = []
  const clock = fakeTimers()
  let failClose = false
  const retirement = createWsRetirement<string, number>({
    close: client => { closes.push(client); if (failClose) throw new Error('close failed') },
    onCloseError: error => errors.push(error),
    timers: clock.timers,
    checkIntervalMs: 30_000,
    checks,
  })
  return { retirement, closes, errors, clock, setFailClose: (value: boolean) => { failClose = value } }
}

describe('WebSocket client retirement', () => {
  test('closes immediately and again on each later check, then forgets the client', () => {
    const h = harness(2)
    h.retirement.retire('old')
    expect(h.closes).toEqual(['old'])
    expect([...h.clock.pending.values()].map(timer => timer.ms)).toEqual([30_000])
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old'])
    expect(h.retirement.size).toBe(1)
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old', 'old'])
    expect(h.retirement.size).toBe(0)
    expect(h.clock.pending.size).toBe(0)
  })

  test('a late connect that completes after close() is closed by the next check', () => {
    // Model of the SDK: close() cannot cancel an in-flight attempt; the socket
    // opens afterwards and stays open until close() runs again.
    let open = false
    let inFlight = true
    const clock = fakeTimers()
    const retirement = createWsRetirement<object, number>({
      close: () => { open = false; inFlight = false },
      onCloseError: () => {},
      timers: clock.timers,
    })
    const client = {}
    retirement.retire(client)
    expect(inFlight).toBe(false)
    open = true
    clock.fireAll()
    expect(open).toBe(false)
  })

  test('retiring again restarts the window without duplicating timers', () => {
    const h = harness(2)
    h.retirement.retire('old')
    h.clock.fireAll()
    h.retirement.retire('old')
    expect(h.clock.pending.size).toBe(1)
    h.clock.fireAll()
    h.clock.fireAll()
    expect(h.closes).toEqual(['old', 'old', 'old', 'old', 'old'])
    expect(h.retirement.size).toBe(0)
  })

  test('closeAll closes every retired client, cancels checks and stops scheduling', () => {
    const h = harness(5)
    h.retirement.retire('a')
    h.retirement.retire('b')
    h.retirement.closeAll()
    expect(h.closes).toEqual(['a', 'b', 'a', 'b'])
    expect(h.clock.pending.size).toBe(0)
    expect(h.retirement.size).toBe(0)
    h.retirement.retire('c')
    expect(h.closes.at(-1)).toBe('c')
    expect(h.clock.pending.size).toBe(0)
  })

  test('close failures are reported and do not stop later checks', () => {
    const h = harness(2)
    h.setFailClose(true)
    h.retirement.retire('old')
    expect(h.errors).toHaveLength(1)
    h.clock.fireAll()
    expect(h.errors).toHaveLength(2)
    expect(h.clock.pending.size).toBe(1)
  })
})

test('an event counts as proof of life only when the current client delivered it, and is handled either way', async () => {
  const handled: unknown[] = []
  const shared = { invoke: async (data: unknown, params?: unknown) => { handled.push([data, params]); return 'ack' } }
  let current = 'new'
  let proofs = 0
  const retired = clientEventDispatcher(shared, () => current === 'old', () => { proofs++ })
  const live = clientEventDispatcher(shared, () => current === 'new', () => { proofs++ })

  expect(await retired.invoke({ id: 1 }, { needCheck: false })).toBe('ack')
  expect(proofs).toBe(0)
  expect(await live.invoke({ id: 2 }, { needCheck: false })).toBe('ack')
  expect(proofs).toBe(1)
  expect(handled).toEqual([[{ id: 1 }, { needCheck: false }], [{ id: 2 }, { needCheck: false }]])

  // After the next rebuild the same wrapper belongs to a retired client.
  current = 'newer'
  await live.invoke({ id: 3 })
  expect(proofs).toBe(1)
  expect(handled).toHaveLength(3)
})
