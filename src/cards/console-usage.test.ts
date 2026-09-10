import { describe, expect, test } from 'bun:test'
import { consoleUnifiedUsageContent, unifiedUsageSummary } from './console'

describe('consoleUnifiedUsageContent(额度渲染)', () => {
  test('只展示额度窗口和数值，不附加套餐说明', () => {
    const out = consoleUnifiedUsageContent({
      state: 'ok',
      planLabel: 'max 套餐',
      windows: [
        { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
        { kind: 'monthly', label: '月度工具', percent: 7, used: 290, total: 4000, resetsAt: new Date(Date.now() + 86400_000 * 15) },
      ],
      fetchedAt: Date.now(),
    })
    expect(out).not.toContain('max 套餐')
    expect(out).toContain('5h 窗口')
    expect(out).toContain('月度工具')
    expect(out).toContain('290/4000')
    expect(out).not.toContain('undefined')  // 回归锁:glmWindowToUnified 曾漏 label → undefined 上卡
  })

  test('glm source 集成:readUsage 直渲染无 undefined', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: {
        level: 'max',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 11, nextResetTime: Date.now() + 3600_000 },
          { type: 'TIME_LIMIT', percentage: 7, currentValue: 290, usage: 4000, nextResetTime: Date.now() + 86400_000 },
        ],
      },
    }), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    try {
      await import('../token-source-glm')
      const { tokenSourceFactories } = await import('../token-source')
      const factory = tokenSourceFactories().find(candidate => candidate.kind === 'glm-coding-plan')
      expect(factory).toBeDefined()
      const glm = factory!.build({
        base_url: 'https://open.bigmodel.cn/api/anthropic',
        auth_token: 'test-token',
      })
      expect(glm.enabled).toBe(true)

      const snap = await glm.readUsage()
      expect(snap.state).toBe('ok')
      if (snap.state !== 'ok') throw new Error(`expected ok usage snapshot, got ${snap.state}`)
      const out = consoleUnifiedUsageContent(snap)
      expect(out).not.toContain('undefined')
      expect(out).toMatch(/5h 窗口|月度工具/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('余额使用单一标签，不混入额度或附加说明', () => {
    const out = consoleUnifiedUsageContent({
      state: 'ok',
      kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' },
      windows: [],
      fetchedAt: Date.now(),
    })
    expect(out).toBe('**📊 余额** ¥12.34')
  })

  test('限额和余额保持语义，缺失数据明确 MISS', () => {
    expect(unifiedUsageSummary({ state: 'ok', kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' }, windows: [] })).toBe('额度 $3.00 / $10.00')
    expect(unifiedUsageSummary({ state: 'ok', kind: 'quota', quota: { remaining: null, limit: null, currency: 'USD' }, windows: [] })).toBe('额度 未设上限')
    expect(unifiedUsageSummary({ state: 'network', kind: 'balance', windows: [], reason: 'HTTP 503' })).toBe('余额 MISS')
    expect(unifiedUsageSummary({ state: 'ok', windows: [], planLabel: '不能作为余额' })).toBe('额度 MISS')
  })
})
