import { afterEach, describe, expect, test } from 'bun:test'
import {
  consumeCodexResetCredit, invalidateCodexUsage, peekSuccessfulUsage, peekUsage, refreshUsageFromConnection,
} from './usage'

const ACCOUNT = 'reset-test-account'
const OTHER = 'reset-test-other'
const limits = (used: number, count: number) => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 1_900_000_000 } },
  rateLimitResetCredits: { availableCount: count },
})

class ResetApp {
  calls: Array<{ method: string; params?: any }> = []
  account: any = { type: 'chatgpt', planType: 'pro' }
  response: any = { outcome: 'reset' }
  limits: any = limits(7, 0)
  consumeErrors: Error[] = []
  readError?: Error
  closeError?: Error
  afterConsume?: () => Promise<void>
  async initialize(name: string) { this.calls.push({ method: 'initialize', params: name }) }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params })
    if (method === 'account/read') return { account: this.account }
    if (method === 'account/rateLimitResetCredit/consume') {
      const error = this.consumeErrors.shift()
      if (error) throw error
      await this.afterConsume?.()
      return this.response
    }
    if (method === 'account/rateLimits/read') {
      if (this.readError) throw this.readError
      return this.limits
    }
    throw new Error(`Unexpected method: ${method}`)
  }
  async close() {
    this.calls.push({ method: 'close' })
    if (this.closeError) throw this.closeError
  }
}
afterEach(() => { invalidateCodexUsage(ACCOUNT); invalidateCodexUsage(OTHER) })

describe('Codex earned reset redemption', () => {
  test('uses the selected account and refreshes authoritative quota, including a real zero card count', async () => {
    await refreshUsageFromConnection(async () => limits(99, 1), ACCOUNT)
    const other = await refreshUsageFromConnection(async () => limits(62, 4), OTHER)
    const app = new ResetApp()
    const result = await consumeCodexResetCredit(ACCOUNT, 'attempt-1', id => { expect(id).toBe(ACCOUNT); return app })
    expect(app.calls.map(c => c.method)).toEqual([
      'initialize', 'account/read', 'account/rateLimitResetCredit/consume', 'account/rateLimits/read', 'close',
    ])
    expect(app.calls[2].params).toEqual({ idempotencyKey: 'attempt-1' })
    expect(result).toMatchObject({ outcome: 'reset', usage: { state: 'ok', resetCredits: 0, weekly: { percent: 7 }, subscriptionType: 'pro' } })
    if (result.usage.state !== 'ok') throw new Error('Expected a successful quota read')
    expect(peekUsage(ACCOUNT)).toBe(result.usage)
    expect(peekSuccessfulUsage(ACCOUNT)).toBe(result.usage)
    expect(peekUsage(OTHER)).toBe(other)
  })

  test('keeps all four service outcomes distinct and reads limits after each outcome', async () => {
    for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'] as const) {
      const app = new ResetApp(); app.response = { outcome }
      const result = await consumeCodexResetCredit(ACCOUNT, outcome, () => app)
      expect(result.outcome).toBe(outcome)
      expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1)
      expect(app.calls.filter(c => c.method === 'account/rateLimits/read')).toHaveLength(1)
    }
  })

  test('a transient redemption failure reuses the exact key and accepts alreadyRedeemed', async () => {
    const app = new ResetApp()
    app.consumeErrors = [new Error('HTTP 503')]
    app.response = { outcome: 'alreadyRedeemed' }
    expect((await consumeCodexResetCredit(ACCOUNT, 'same-attempt', () => app)).outcome).toBe('alreadyRedeemed')
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume').map(c => c.params))
      .toEqual([{ idempotencyKey: 'same-attempt' }, { idempotencyKey: 'same-attempt' }])
  })

  test('persistent redemption failures stay visible after bounded retries and clear old quota', async () => {
    await refreshUsageFromConnection(async () => limits(99, 1), ACCOUNT)
    const app = new ResetApp(); app.consumeErrors = Array.from({ length: 3 }, () => new Error('HTTP 503'))
    await expect(consumeCodexResetCredit(ACCOUNT, 'failed-attempt', () => app))
      .rejects.toThrow('Codex 重置卡请求失败（已尝试 3 次）：HTTP 503')
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(3)
    expect(app.calls.at(-1)?.method).toBe('close')
    expect(peekUsage(ACCOUNT)).toBeNull(); expect(peekSuccessfulUsage(ACCOUNT)).toBeNull()
  }, 10_000)

  test('failed quota readback enters cooldown and preserves the confirmed redemption and original error', async () => {
    const app = new ResetApp()
    app.readError = new Error(JSON.stringify({ code: -32603,
      message: 'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)' }))
    const result = await consumeCodexResetCredit(ACCOUNT, 'quota-network-failed', () => app)
    expect(result).toMatchObject({ outcome: 'reset', usage: { state: 'network',
      reason: app.readError.message } })
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1)
    expect(app.calls.filter(c => c.method === 'account/rateLimits/read')).toHaveLength(1)
    expect(app.calls.at(-1)?.method).toBe('close')
    expect(peekUsage(ACCOUNT)).toEqual(result.usage)
    expect(peekSuccessfulUsage(ACCOUNT)).toBeNull()
  }, 10_000)

  test('unknown outcomes and authentication errors never become successful redemptions', async () => {
    for (const response of [undefined, {}, { outcome: 'unexpected' }]) {
      const app = new ResetApp(); app.response = response
      await expect(consumeCodexResetCredit(ACCOUNT, 'unknown', () => app)).rejects.toThrow('未知结果')
      expect(app.calls.at(-1)?.method).toBe('close')
      expect(app.calls.some(c => c.method === 'account/rateLimits/read')).toBe(false)
    }
    const app = new ResetApp(); app.consumeErrors = [new Error('HTTP 401 unauthorized')]
    await expect(consumeCodexResetCredit(ACCOUNT, 'unauthorized', () => app)).rejects.toThrow('HTTP 401')
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1)
  })

  test('missing keys and non-subscription authentication cannot consume a credit', async () => {
    let created = false
    await expect(consumeCodexResetCredit(ACCOUNT, ' ', () => { created = true; return new ResetApp() })).rejects.toThrow('幂等标识')
    expect(created).toBe(false)
    for (const account of [null, { type: 'apiKey' }]) {
      const app = new ResetApp(); app.account = account
      await expect(consumeCodexResetCredit(ACCOUNT, 'not-chatgpt', () => app)).rejects.toThrow('未登录 ChatGPT')
      expect(app.calls.map(c => c.method)).toEqual(['initialize', 'account/read', 'close'])
    }
  })

  test('readback and cleanup failures preserve a confirmed redemption with visible errors', async () => {
    const app = new ResetApp(); app.readError = new Error('HTTP 401 quota access denied'); app.closeError = new Error('SIGTERM rejected')
    const result = await consumeCodexResetCredit(ACCOUNT, 'confirmed', () => app)
    expect(result).toMatchObject({ outcome: 'reset', usage: { state: 'network', reason: 'HTTP 401 quota access denied' }, cleanupError: '控制连接关闭失败：SIGTERM rejected' })
    expect(peekUsage(ACCOUNT)).toEqual(result.usage)
    expect(peekSuccessfulUsage(ACCOUNT)).toBeNull()
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1)
  })

  test('simultaneous requests for one account share the same attempt and reject a different one', async () => {
    const app = new ResetApp()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    app.afterConsume = () => gate
    const first = consumeCodexResetCredit(ACCOUNT, 'pending', () => app)
    try {
      expect(consumeCodexResetCredit(ACCOUNT, 'pending', () => { throw new Error('must not create a second client') })).toBe(first)
      await expect(consumeCodexResetCredit(ACCOUNT, 'different', () => app)).rejects.toThrow('正在使用重置卡')
      const other = new ResetApp()
      expect((await consumeCodexResetCredit(OTHER, 'independent', () => other)).outcome).toBe('reset')
    } finally { release(); await first }
    expect(app.calls.filter(c => c.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1)
  })

  test('a quota response started during redemption cannot overwrite the refreshed cache', async () => {
    const app = new ResetApp()
    let release!: (value: any) => void
    let stale!: Promise<unknown>
    app.afterConsume = async () => {
      stale = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), ACCOUNT)
    }
    const result = await consumeCodexResetCredit(ACCOUNT, 'new-generation', () => app)
    release(limits(100, 1))
    expect(await stale).toBeNull()
    expect(peekUsage(ACCOUNT)).toBe(result.usage)
  })
})
