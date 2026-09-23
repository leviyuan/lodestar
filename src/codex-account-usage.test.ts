import { describe, expect, test } from 'bun:test'
import { aggregateCodexUsage, readCodexAccountEmails, type CodexAccountUsage } from './codex-account-usage'
import { codexAccountCard } from './cards/codex-account'

function entry(id: string, short: number | null, weekly: number | null, fingerprint: string | null = id): CodexAccountUsage {
  return { account: { id, name: id }, fingerprint, usage: { state: 'ok', subscriptionType: 'pro',
    fiveHour: { percent: short, resetsAt: new Date('2030-01-01'), durationMins: 300 },
    weekly: { percent: weekly, resetsAt: new Date('2030-01-07'), durationMins: 10080 }, resetCredits: 2, fetchedAt: 1 } }
}
describe('Codex account usage aggregation', () => {
  test('account inspection reads each native email even when quota identities are duplicated', async () => {
    const rows = [entry('default', 20, 40, 'same'), entry('named', 20, 40, 'same')]
    rows[0].account.name = '默认'
    rows[1].account.name = 'remark@example.test'
    rows[1].account.email = 'old-login@example.test'
    const total = aggregateCodexUsage(rows)
    const reads: string[] = [], closed: string[] = []
    const inspected = await readCodexAccountEmails(total, id => ({
      initialize: async () => {},
      request: async (method, params) => {
        expect(method).toBe('account/read')
        expect(params).toEqual({ refreshToken: false })
        reads.push(id)
        return { account: { type: 'chatgpt', email: `${id}@actual.example`, planType: 'pro' } }
      },
      close: async () => { closed.push(id) },
    }))
    expect(reads).toEqual(['default', 'named'])
    expect(closed).toEqual(reads)
    expect(inspected.entries.map(row => row.email)).toEqual(['default@actual.example', 'named@actual.example'])
    expect(inspected.entries[1].duplicateOf).toBe('默认')
    expect(inspected.available).toBe(total.available)
    const card = JSON.stringify(codexAccountCard({ phase: 'accounts', total: inspected }))
    expect(card).toContain('备注：默认')
    expect(card).toContain('备注：remark@example.test')
    expect(card).toContain('实际邮箱：default@actual.example')
    expect(card).toContain('实际邮箱：named@actual.example')
    expect(card).toContain('同一账号')
    expect(card).not.toContain('old-login@example.test')
  })
  test('missing emails and native read or close errors stay visible without using recorded emails', async () => {
    const rows = ['missing', 'failed', 'close-failed'].map(id => entry(id, 10, 20))
    for (const row of rows) row.account.email = 'old-login@example.test'
    const closed: string[] = []
    const total = await readCodexAccountEmails(aggregateCodexUsage(rows), id => ({
      initialize: async () => {},
      request: async () => {
        if (id === 'failed') throw new Error('HTTP 401 account access denied')
        return { account: { type: 'chatgpt', email: id === 'missing' ? null : 'current@actual.example' } }
      },
      close: async () => {
        closed.push(id)
        if (id === 'close-failed') throw new Error('SIGTERM rejected')
      },
    }))
    expect(closed.sort()).toEqual(['close-failed', 'failed', 'missing'])
    expect(total.entries[0]).toMatchObject({ email: null, emailError: '原生账号未提供邮箱' })
    expect(total.entries[1]).toMatchObject({ email: null, emailError: 'HTTP 401 account access denied' })
    expect(total.entries[2]).toMatchObject({ email: 'current@actual.example', emailError: '账号查询进程关闭失败：SIGTERM rejected' })
    const card = JSON.stringify(codexAccountCard({ phase: 'accounts', total }))
    expect(card).toContain('实际邮箱：MISS')
    expect(card).toContain('邮箱查询错误')
    expect(card).toContain('HTTP 401 account access denied')
    expect(card).toContain('SIGTERM rejected')
    expect(card).not.toContain('old-login@example.test')
    expect(total.entries.every(row => row.usage.state === 'ok')).toBe(true)
  })
  test('deduplicates aliases, sums fractions and counts real available accounts', () => {
    const total = aggregateCodexUsage([entry('native', 20, 40), entry('work', 60, 80), entry('same-native', 20, 40, 'native')])
    expect(total.available).toBe(2)
    expect(total.resetCredits).toBe(4)
    expect(total.windows[0].remaining).toBeCloseTo(1.2)
    expect(total.windows[1].remaining).toBeCloseTo(0.8)
    expect(total.entries[2].duplicateOf).toBe('native')
  })
  test('independent exhausted windows cannot be combined into a usable account', () => {
    const total = aggregateCodexUsage([entry('a', 100, 0), entry('b', 0, 100)])
    expect(total.available).toBe(0)
    expect(total.windows.map(w => w.remaining)).toEqual([1, 1])
  })
  test('missing data and unknown identities never become zero or a complete sum', () => {
    const missing = entry('b', 30, 40); missing.usage = { state: 'network', reason: 'offline' }
    for (const second of [missing, entry('b', 30, 40, null)]) {
      const total = aggregateCodexUsage([entry('a', 10, 20), second])
      expect(total.complete).toBe(false)
      expect(total.resetCredits).toBeNull()
      expect(total.available).toBeNull()
      expect(total.windows.every(w => w.remaining === null)).toBe(true)
      expect(JSON.stringify(codexAccountCard({ phase: 'accounts', total }))).toContain('汇总不完整')
    }
    const unknown = aggregateCodexUsage([entry('a', null, 20)])
    expect(unknown.available).toBeNull()
    expect(unknown.windows[0].remaining).toBeNull()
  })
})
