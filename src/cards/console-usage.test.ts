import { describe, expect, test } from 'bun:test'
import { consoleUnifiedUsageContent, consoleUsageElement, unifiedUsageSummary } from './console'
import { codexUsageToUnified } from '../token-source-codex'
import { snapshotFromReadResponse } from '../usage'

describe('compact hi account quota panel', () => {
  test('one account occupies one row and includes main windows plus reset credits', () => {
    const usage = { state: 'ok' as const, resetCredits: 0, windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
      { kind: 'weekly', label: '周配额', percent: 24, resetsAt: new Date(Date.now() + 3 * 86400_000) },
    ] }
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [
      { id: 'codex:default', label: 'Codex·默认', usage },
      { id: 'deepseek', label: 'DeepSeek', usage: { state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] } },
    ] }) as any
    expect(panel.element_id).toBe('console_usage')
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(true)
    expect(panel.header.background_color).toBe('blue-50')
    expect(panel.elements).toHaveLength(2)
    expect(panel.elements[0]).toMatchObject({ tag: 'markdown', text_size: 'notation',
      content: '**Codex·默认**　5h 11%/1.0h · 周 24%/3.0d · 重置 0' })
    expect(panel.elements[1].content).toBe('**DeepSeek**　余额 ¥ 12.34')
    expect(JSON.stringify(panel)).not.toContain('▰')
    expect(panel.elements.every((element: any) => !element.content.includes('\n'))).toBe(true)
  })

  test('Spark and reserve remain outside the main quota display', () => {
    const extra = { primary: { usedPercent: 12, windowDurationMins: 10080 } }
    const usage = codexUsageToUnified(snapshotFromReadResponse({
      rateLimits: { limitId: 'codex', ...extra },
      rateLimitsByLimitId: { codex: { limitId: 'codex', ...extra },
        codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', ...extra },
        base_model_inference: { limitId: 'base_model_inference', limitName: 'gpt-reserve', ...extra } },
      rateLimitResetCredits: { availableCount: 3 },
    }))
    const content = consoleUnifiedUsageContent(usage)
    expect(content).toBe('周 12%/MISS · 重置 3')
    expect(content).not.toMatch(/Spark|reserve|重置卡/)
  })

  test('GLM monthly tools only show percent while other windows retain countdowns', () => {
    const out = consoleUnifiedUsageContent({ state: 'ok', planLabel: 'Max', windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
      { kind: 'weekly', label: '周配额', percent: 17, resetsAt: new Date(Date.now() + 86400_000) },
      { kind: 'monthly', label: '月度工具', percent: 7, used: 290, total: 4000, resetsAt: new Date(Date.now() + 15 * 86400_000) },
    ] })
    expect(out).toBe('5h 11%/1.0h · 周 17%/1.0d · 月工具 7%')
    expect(out).not.toMatch(/290|4000|15.0d|Max/)
  })

  test('missing or failed data stays visible without displaying stale windows', () => {
    for (const percent of [null, NaN, -1, 101]) {
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [
        { kind: 'fiveHour', label: '5h', percent, resetsAt: null },
      ] })).toBe('5h MISS/MISS')
    }
    expect(consoleUnifiedUsageContent({ state: 'network', reason: 'upstream offline', windows: [
      { kind: 'fiveHour', label: 'stale', percent: 10, resetsAt: null },
    ] })).toBe("<font color='red'>MISS · upstream offline</font>")
    expect(consoleUnifiedUsageContent({ state: 'rate_limited', windows: [] })).toContain('API 限频')
    expect(consoleUnifiedUsageContent({ state: 'not_applicable', windows: [] })).toBe('—')
    const loading = consoleUsageElement({ sessionName: 'test', status: 'idle' }) as any
    expect(loading.elements[0].content).toBe('加载中…')
  })

  test('quota colors and model-specific Claude windows remain distinct', () => {
    const content = consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: 80, resetsAt: null },
      { kind: 'seven_day_sonnet', label: 'Sonnet 周额度', percent: 100, resetsAt: null },
    ] })
    expect(content).toBe("Opus周 <font color='orange'>80%</font>/MISS · Sonnet周 <font color='red'>100%</font>/MISS")
  })

  test('account names and remote errors cannot inject card markup or extra rows', () => {
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [
      { id: 'test', label: '<at id=all>\nname', usage: { state: 'network', reason: '**bad**\n<at id=all>', windows: [] } },
    ] }) as any
    expect(panel.elements[0].content).not.toContain('<at')
    expect(panel.elements[0].content).not.toContain('\n')
    expect(panel.elements[0].content).not.toContain('**bad**')
  })

  test('reset credit counts are compact in hi and never enter the footer summary', () => {
    const snapshot = { state: 'ok' as const, windows: [{ kind: 'weekly', label: '周配额', percent: 22, resetsAt: null }], resetCredits: 0 }
    expect(consoleUnifiedUsageContent(snapshot)).toContain('重置 0')
    expect(consoleUnifiedUsageContent({ ...snapshot, resetCredits: null })).toContain('重置 MISS')
    expect(unifiedUsageSummary(snapshot)).not.toContain('重置')
  })

  test('footer balance and quota semantics are unchanged', () => {
    expect(unifiedUsageSummary({ state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] })).toBe('余额 ¥12.34')
    expect(unifiedUsageSummary({ state: 'ok', kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' }, windows: [] })).toBe('额度 $3.00 / $10.00')
    expect(unifiedUsageSummary({ state: 'network', kind: 'balance', windows: [], reason: 'HTTP 503' })).toBe('余额 MISS')
  })
})
