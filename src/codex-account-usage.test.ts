import { describe, expect, test } from 'bun:test'
import { aggregateCodexUsage, type CodexAccountUsage } from './codex-account-usage'
import { codexAccountCard } from './cards/codex-account'

function entry(id: string, short: number | null, weekly: number | null, fingerprint: string | null = id): CodexAccountUsage {
  return { account: { id, name: id }, fingerprint, usage: { state: 'ok', subscriptionType: 'pro',
    fiveHour: { percent: short, resetsAt: new Date('2030-01-01'), durationMins: 300 },
    weekly: { percent: weekly, resetsAt: new Date('2030-01-07'), durationMins: 10080 }, resetCredits: 2, fetchedAt: 1 } }
}
describe('Codex account usage aggregation', () => {
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
