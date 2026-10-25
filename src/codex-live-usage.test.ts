import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { CodexLiveUsageRefresh } from './codex-live-usage'
import type { UsageSnapshot } from './usage'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function harness() {
  let now = 0, runningWatch: (() => void) | undefined
  const timers = new Set<{ at: number; callback(): void }>()
  const revisions = new Map<string, string>()
  const readers: Array<{ accountId: string; reader: FakeReader; isCurrent(): boolean }> = []
  const errors: unknown[] = [], commits: Array<{ accountId: string; value: UsageSnapshot }> = []
  const attempts: Array<{ accountId: string; force: boolean; current(): boolean }> = []
  class FakeReader extends EventEmitter {
    alive = true
    calls = 0
    response: () => Promise<any> = async () => ({ state: 'ok', fetchedAt: now, readStartedAt: now,
      fiveHour: null, weekly: null })
    isAlive() { return this.alive }
    readRateLimits() { this.calls++; return this.response() }
  }
  const service = new CodexLiveUsageRefresh({
    readers: accountId => readers.filter(entry => entry.isCurrent() && (accountId === undefined || entry.accountId === accountId)),
    watch(listener) { runningWatch = listener; return () => { runningWatch = undefined } },
    revision: id => revisions.get(id) ?? 'initial', now: () => now,
    schedule(callback, delay) {
      const timer = { at: now + delay, callback }; timers.add(timer)
      return () => { timers.delete(timer) }
    },
    async refresh(request, accountId, options) {
      attempts.push({ accountId, force: options.force, current: options.isCurrent })
      const result = await request('account/rateLimits/read', {}) as UsageSnapshot
      if (!options.isCurrent()) return null
      commits.push({ accountId, value: result })
      return result
    },
    error: error => errors.push(error),
  })
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  const advance = async (milliseconds: number) => {
    const target = now + milliseconds
    for (;;) {
      const next = [...timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at; timers.delete(next); next.callback(); await flush()
    }
    now = target
    await flush()
  }
  const add = (id: string) => {
    const reader = new FakeReader()
    const entry = { accountId: id, reader, isCurrent: () => reader.alive && readers.includes(entry) }
    readers.push(entry); runningWatch?.()
    return reader
  }
  const remove = (reader: FakeReader) => {
    reader.alive = false
    const index = readers.findIndex(entry => entry.reader === reader)
    if (index >= 0) readers.splice(index, 1)
    reader.emit('exit'); runningWatch?.()
  }
  return { service, add, remove, advance, flush, timers, attempts, commits, errors, revisions, now: () => now }
}

test('live refresh is opt-in, polls once per account and coalesces native signals', async () => {
  const h = harness(), first = h.add('a'), second = h.add('a'), other = h.add('b')
  try {
    expect(await h.service.refresh('a')).toBeNull()
    expect(first.calls).toBe(0)
    h.service.start(); h.service.start(); await h.advance(0)
    expect([first.calls, second.calls, other.calls]).toEqual([1, 0, 1])
    first.emit('rate_limits_updated', { untrusted: true })
    second.emit('result', {})
    first.emit('rate_limits_updated', {})
    await h.advance(999)
    expect(first.calls).toBe(1)
    await h.advance(1)
    expect([first.calls, second.calls, other.calls]).toEqual([2, 0, 1])
    await h.advance(58_999)
    expect(other.calls).toBe(1)
    await h.advance(1)
    expect(other.calls).toBe(2)
    await h.advance(1_000)
    expect(first.calls).toBe(3)
    expect(h.attempts.every(read => read.force)).toBe(true)
    h.remove(first)
    second.emit('rate_limits_updated', {})
    await h.advance(1_000)
    expect(second.calls).toBe(1)
    h.remove(second)
    expect(await h.service.refresh('a')).toBeNull()
  } finally { h.service.stop() }
  expect(h.timers.size).toBe(0)
  expect(first.listenerCount('result')).toBe(0)
  expect(other.listenerCount('rate_limits_updated')).toBe(0)
})

test('an in-flight signal gets one follow-up and callers do not wait for later generations', async () => {
  const h = harness(), reader = h.add('a')
  const first = deferred<UsageSnapshot>(), second = deferred<UsageSnapshot>(), third = deferred<UsageSnapshot>()
  const responses = [first, second, third]
  reader.response = () => responses[reader.calls - 1]!.promise
  try {
    h.service.start(); await h.advance(0)
    let done = false
    const requested = h.service.refresh('a').then(value => { done = true; return value })
    reader.emit('rate_limits_updated', {})
    reader.emit('result', {})
    first.resolve({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null })
    await h.flush()
    expect(done).toBe(false)
    await h.advance(1_000)
    expect(reader.calls).toBe(2)
    reader.emit('rate_limits_updated', {})
    const value: UsageSnapshot = { state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null }
    second.resolve(value); await h.flush()
    expect(await requested).toBe(value)
    expect(done).toBe(true)
    await h.advance(1_000)
    expect(reader.calls).toBe(3)
    third.resolve({ state: 'network' }); await h.flush()
    expect(reader.calls).toBe(3)
  } finally { h.service.stop() }
})

test('retired connections and changed account revisions cannot commit late results', async () => {
  const h = harness(), reader = h.add('a'), old = deferred<UsageSnapshot>()
  reader.response = () => old.promise
  try {
    h.service.start(); const waiter = h.service.refresh('a'); await h.advance(0)
    h.revisions.set('a', 'new-login')
    old.resolve({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null }); await h.flush()
    expect(await waiter).toBeNull()
    expect(h.commits).toHaveLength(0)
    reader.response = async () => ({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null })
    const next = h.service.refresh('a'); await h.advance(0)
    expect((await next)?.state).toBe('ok')
    const late = deferred<UsageSnapshot>(); reader.response = () => late.promise
    const exiting = h.service.refresh('a'); await h.advance(0); h.remove(reader)
    expect(await exiting).toBeNull()
    late.resolve({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null }); await h.flush()
    expect(h.commits).toHaveLength(1)
    expect(h.timers.size).toBe(0)
    expect(await h.service.refresh('a')).toBeNull()
  } finally { h.service.stop() }
})

test('an exiting reader hands a pending refresh to another live reader of the same account', async () => {
  const h = harness(), first = h.add('a'), reply = deferred<UsageSnapshot>()
  first.response = () => reply.promise
  try {
    h.service.start(); const requested = h.service.refresh('a'); await h.advance(0)
    const replacement = h.add('a'), unrelated = h.add('b')
    h.remove(first)
    reply.resolve({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null })
    await h.flush(); await h.advance(1_000)
    expect((await requested)?.state).toBe('ok')
    expect(first.calls).toBe(1)
    expect(replacement.calls).toBe(1)
    expect(unrelated.calls).toBe(1)
    expect(h.commits.filter(commit => commit.accountId === 'a')).toHaveLength(1)
    expect(first.listenerCount('rate_limits_updated')).toBe(0)
  } finally { h.service.stop() }
})

test('joining a snapshot started before the signal gets one fresh follow-up', async () => {
  const h = harness(), reader = h.add('a')
  await h.advance(100)
  reader.response = async () => ({ state: 'ok', fetchedAt: h.now(), readStartedAt: reader.calls === 1 ? 0 : h.now(),
    fiveHour: null, weekly: null })
  try {
    h.service.start(); let complete = false
    const requested = h.service.refresh('a').then(value => { complete = true; return value })
    await h.advance(0)
    expect(complete).toBe(false)
    await h.advance(999); expect(reader.calls).toBe(1)
    await h.advance(1)
    const result = await requested
    expect(reader.calls).toBe(2)
    expect(result?.state === 'ok' && result.readStartedAt).toBe(h.now())
  } finally { h.service.stop() }
})

test('shutdown cancels waiters and bounded final joins do not hang on a live transport', async () => {
  const h = harness(), reader = h.add('a'), barrier = deferred<UsageSnapshot>()
  reader.response = () => barrier.promise
  h.service.start(); await h.advance(0)
  let finished = false
  const waiting = h.service.wait('a', 5_000).then(() => { finished = true })
  await h.advance(4_999); expect(finished).toBe(false)
  await h.advance(1); await waiting; expect(finished).toBe(true)
  const pending = h.service.refresh('a')
  h.service.stop(); expect(await pending).toBeNull()
  expect(h.timers.size).toBe(0)
  barrier.resolve({ state: 'ok', fetchedAt: h.now(), fiveHour: null, weekly: null }); await h.flush()
  expect(h.commits).toHaveLength(0)
  expect(reader.listenerCount('result')).toBe(0)
})
