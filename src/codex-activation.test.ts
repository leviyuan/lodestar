import { afterEach, describe, expect, test } from 'bun:test'
import { CodexActivation } from './codex-activation'
import { CODEX_ACTIVATION_MODEL, type ActivationRequestOptions, type CodexActivationUsage } from './codex-activation-request'
import type { TokenSource } from './token-source'

const live: CodexActivation[] = []
afterEach(async () => { await Promise.all(live.splice(0).map(worker => worker.stop())) })
function harness(random = 0) {
  let now = Date.now()
  const usage: CodexActivationUsage = { state: 'ok', accountFingerprint: 'identity', defaultLimitId: 'codex',
    fetchedAt: now, subscriptionType: 'pro', fiveHour: null,
    weekly: { percent: 0, durationMins: 10080, resetsAt: new Date(Math.floor(now / 1000) * 1000 + 7 * 86400_000) } }
  const accounts = [{ id: 'account', name: 'Account', revision: 'login1', usage }]
  const source = { kind: 'codex-subscription', enabled: true, modelCatalogState: { status: 'ready' },
    models: [{ model: CODEX_ACTIVATION_MODEL, display: '', efforts: ['low'], defaultEffort: 'low' }] } as TokenSource
  const calls: ActivationRequestOptions[] = [], logs: string[] = []
  const state = { used: false, loginPending: false, failure: null as Error | null, successfulButRefreshFailed: false,
    barrier: null as Promise<void> | null }
  const worker = new CodexActivation({ accounts: () => accounts, source: () => source,
    loginPending: () => state.loginPending, used: () => state.used, recordUsage: () => { state.used = true },
    activate: async opts => {
      calls.push(opts)
      await state.barrier
      if (state.failure) throw state.failure
      if (!opts.eligible(usage)) return 'skipped'
      opts.used(usage, 3)
      if (state.successfulButRefreshFailed) throw new Error('request succeeded; refresh failed')
      return 'sent'
    }, now: () => now, random: () => random, log: line => { logs.push(line) } })
  live.push(worker); worker.start()
  return { worker, accounts, usage, source, calls, logs, state, advance: (ms: number) => { now += ms } }
}

describe('randomized Codex quota activation', () => {
  test.each([0, 0.5, 0.999999])('new full windows wait the complete random delay: %s', async random => {
    const h = harness(random)
    await h.worker.check()
    const delay = 30 * 60_000 + Math.floor(random * 30 * 60_000)
    h.advance(delay - 1); await h.worker.check(); expect(h.calls).toHaveLength(0)
    h.advance(1); await h.worker.check(); expect(h.calls).toHaveLength(1)
    h.advance(60 * 60_000); await h.worker.check(); expect(h.calls).toHaveLength(1)
  })
  test('a non-full snapshot never queues work and later detection starts a new delay', async () => {
    const h = harness(); h.usage.weekly!.percent = 0.1
    await h.worker.check(); h.advance(60 * 60_000); await h.worker.check()
    expect(h.calls).toHaveLength(0)
    h.usage.weekly!.percent = 0
    await h.worker.check(); expect(h.calls).toHaveLength(0)
    h.advance(30 * 60_000); await h.worker.check(); expect(h.calls).toHaveLength(1)
  })
  test('same native identity under two local names sends only once', async () => {
    const h = harness(); h.accounts.push({ ...h.accounts[0], id: 'alias', name: 'Alias' })
    await h.worker.check(); h.advance(30 * 60_000); await h.worker.check()
    expect(h.calls).toHaveLength(1)
  })
  test.each(['device', 'foreground', 'login', 'deleted'])('activity during random waiting prevents sends: %s', async reason => {
    const h = harness(); await h.worker.check(); h.advance(30 * 60_000)
    if (reason === 'device') h.usage.weekly!.resetsAt = new Date(h.usage.weekly!.resetsAt!.getTime() - 1000)
    if (reason === 'foreground') h.state.used = true
    if (reason === 'login') h.state.loginPending = true
    if (reason === 'deleted') h.accounts.length = 0
    await h.worker.check(); expect(h.calls).toHaveLength(0)
  })
  test('failures retain diagnostics and wait another random interval without blocking other accounts', async () => {
    const h = harness(); h.state.failure = new Error('quota network unavailable')
    await h.worker.check(); h.advance(30 * 60_000); await h.worker.check()
    expect(h.worker.error('account')).toBe('quota network unavailable')
    expect(h.state.used).toBe(false)
    h.advance(30 * 60_000 - 1); await h.worker.check(); expect(h.calls).toHaveLength(1)
    h.state.failure = null; h.advance(1); await h.worker.check(); expect(h.calls).toHaveLength(2)
    expect(h.worker.error('account')).toBeUndefined()
  })
  test('successful tokens followed by refresh failure never repeat the inference', async () => {
    const h = harness(); h.state.successfulButRefreshFailed = true
    await h.worker.check(); h.advance(30 * 60_000); await h.worker.check()
    expect(h.worker.error('account')).toContain('request succeeded')
    h.advance(60 * 60_000); await h.worker.check(); expect(h.calls).toHaveLength(1)
    expect(h.worker.error('account')).toContain('request succeeded')
    h.usage.weekly!.percent = 0.1
    await h.worker.check(); expect(h.worker.error('account')).toContain('refresh failed')
    h.state.used = false
    h.usage.weekly!.percent = 0
    h.usage.fetchedAt += 7 * 86400_000
    h.usage.weekly!.resetsAt = new Date(h.usage.weekly!.resetsAt!.getTime() + 7 * 86400_000)
    await h.worker.check(); expect(h.worker.error('account')).toBeUndefined()
    h.advance(30 * 60_000); await h.worker.check(); expect(h.calls).toHaveLength(2)
  })
  test('concurrent scans coalesce; shutdown aborts admission and waits for cleanup', async () => {
    const h = harness(); await h.worker.check(); h.advance(30 * 60_000)
    let release!: () => void
    h.state.barrier = new Promise<void>(resolve => { release = resolve })
    const pending = h.worker.check()
    expect(h.worker.check()).toBe(pending)
    expect(h.calls).toHaveLength(1)
    const stopping = h.worker.stop()
    expect(h.calls[0].signal.aborted).toBe(true)
    release(); await stopping
    expect(h.state.used).toBe(false)
    await h.worker.check(); expect(h.calls).toHaveLength(1)
  })
  test('changing login during the final read invalidates eligibility', async () => {
    const h = harness(); await h.worker.check(); h.advance(30 * 60_000)
    let release!: () => void
    h.state.barrier = new Promise<void>(resolve => { release = resolve })
    const pending = h.worker.check()
    h.accounts[0].revision = 'login2'
    release(); await pending
    expect(h.state.used).toBe(false)
  })
})
