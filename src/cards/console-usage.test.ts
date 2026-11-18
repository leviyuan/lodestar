import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { consoleUnifiedUsageContent, consoleUsageContent, consoleUsageElement, unifiedUsageSummary } from './console'
import { fmtCountdown } from './usage'
import { codexUsageToUnified } from '../token-source-codex'
import { snapshotFromReadResponse } from '../usage'

describe('compact hi account quota panel', () => {
  let clock: ReturnType<typeof spyOn>
  // Fixtures and countdown formatting must observe the same hour/day boundary.
  beforeEach(() => { clock = spyOn(Date, 'now').mockReturnValue(1_900_000_000_000) })
  afterEach(() => { clock.mockRestore() })

  test.each(['plus', 'prolite', 'pro'])('omits an absent short window from %s hi and legacy summaries', planType => {
    const raw = snapshotFromReadResponse({ rateLimits: { limitId: 'codex', planType,
      primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: (Date.now() + 3 * 86400_000) / 1000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    }, rateLimitResetCredits: { availableCount: 0 } })
    const usage = codexUsageToUnified(raw)
    expect(consoleUnifiedUsageContent(usage)).toBe('周 24%/3.0d')
    expect(consoleUsageContent(raw)).not.toMatch(/5h|满窗/)
    expect(unifiedUsageSummary(usage)).not.toMatch(/5h|满窗/)
  })

  test('reported short windows retain real zero usage and missing field diagnostics', () => {
    const main = { limitId: 'codex', planType: 'plus',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: (Date.now() + 3600_000) / 1000 },
      secondary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: (Date.now() + 3 * 86400_000) / 1000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    }
    const render = (primary: object) => consoleUnifiedUsageContent(codexUsageToUnified(snapshotFromReadResponse({
      rateLimits: { ...main, primary }, rateLimitResetCredits: { availableCount: 0 },
    })))
    expect(render(main.primary)).toBe('5h 0%/1.0h · 周 24%/3.0d')
    expect(render({ usedPercent: 0, windowDurationMins: 300 })).toBe('5h 0%/MISS · 周 24%/3.0d')
    // A wholly unknown window says MISS once.
    expect(render({ windowDurationMins: 300 })).toBe('5h MISS · 周 24%/3.0d')
  })

  test('hi and unified summaries show main consumable credits alongside unchanged percentages', () => {
    const main = { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: '62500.25' } }
    const usage = codexUsageToUnified(snapshotFromReadResponse({ rateLimits: main,
      rateLimitsByLimitId: { codex: main, spark: { ...main, limitId: 'spark',
        credits: { hasCredits: true, unlimited: false, balance: '999999' } } },
      rateLimitResetCredits: { availableCount: 2 } }))
    expect(consoleUnifiedUsageContent(usage)).toBe("周 <font color='red'>100%</font>/MISS · 积分 62.5k · 重置 2")
    expect(unifiedUsageSummary(usage)).toBe('额度 周配额 已用 100% · 积分 62.5k')
    for (const [balance, label] of [
      [62500.25, '62.5k'], [1_250_000, '1.3m'], [1000, '1k'], [1_000_000, '1m'],
      [999.94, '999.9'], [999.95, '1k'], [999_949, '999.9k'], [999_950, '1m'],
      [12.34, '12.3'], [12, '12'], [0.0001, '<0.1'], [0.05, '0.1'],
    ] as const) {
      const snapshot = { ...usage, credits: { hasCredits: true, unlimited: false, balance } }
      expect(consoleUnifiedUsageContent(snapshot)).toBe(`周 <font color='red'>100%</font>/MISS · 积分 ${label} · 重置 2`)
      expect(unifiedUsageSummary(snapshot)).toBe(`额度 周配额 已用 100% · 积分 ${label}`)
    }
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: false, unlimited: false, balance: 0 } })).not.toContain('积分')
    expect(consoleUnifiedUsageContent({ ...usage, credits: null })).toContain('积分 MISS')
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: true, unlimited: true, balance: null } })).toContain('积分 无限')
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: true, unlimited: false, balance: null } })).toContain('积分 MISS')
  })

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
      content: '**Codex·默认**　5h 11%/1.0h · 周 24%/3.0d' })
    expect(panel.elements[1].content).toBe('**DeepSeek**　余额 ¥12.34')
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
    expect(content).toBe('周 12%/MISS · 积分 MISS · 重置 3')
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
      ] })).toBe('5h MISS')
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [
        { kind: 'fiveHour', label: '5h', percent, resetsAt: new Date(Date.now() + 3600_000) },
      ] })).toBe('5h MISS/1.0h')
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
    expect(content).toBe("Opus <font color='orange'>80%</font>/MISS · Sonnet <font color='red'>100%</font>/MISS")
    // Colors follow the displayed percent, so one label never shows with and without a color.
    const shown = (value: number) => consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind: 'weekly', label: '周额度', percent: value, resetsAt: null }] })
    expect(shown(79.4)).toBe('周 79%/MISS')
    expect(shown(79.6)).toBe("周 <font color='orange'>80%</font>/MISS")
    expect(shown(99.4)).toBe("周 <font color='orange'>99%</font>/MISS")
    expect(shown(99.6)).toBe("周 <font color='red'>100%</font>/MISS")
  })

  test('relay script windows with unparsed dates or unlisted weekly kinds render without breaking the panel', () => {
    // Relay balance scripts pass raw JSON through, so dates arrive as strings.
    const relay = { state: 'ok', windows: [
      { kind: 'monthly', label: '月度工具', percent: 5, resetsAt: '2026-12-01T00:00:00Z' },
      { kind: 'daily', label: '日额度', percent: 12, resetsAt: '2026-12-01T00:00:00Z' },
      { kind: 'proWeekly', label: 'Pro 周额度', percent: 30, resetsAt: new Date(Date.now() + 86400_000) },
    ] } as any
    expect(consoleUnifiedUsageContent(relay)).toBe('月工具 5% · 日额度 12%/MISS · Pro周 30%/1.0d')
    // Windows without a string kind are just unlisted windows.
    for (const kind of [undefined, null, 7]) {
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind, label: '日额度', percent: 12, resetsAt: null }] } as any))
        .toBe('日额度 12%/MISS')
    }
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [
      { id: 'relay:x', label: 'x', usage: relay },
      { id: 'relay:y', label: 'y', usage: { state: 'ok', windows: [{ label: '日额度', percent: 12, resetsAt: null }] } as any },
      { id: 'deepseek', label: 'DeepSeek', usage: { state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] } },
    ] }) as any
    expect(panel.elements.map((element: any) => element.content)).toEqual([
      '**x**　月工具 5% · 日额度 12%/MISS · Pro周 30%/1.0d', '**y**　日额度 12%/MISS', '**DeepSeek**　余额 ¥12.34',
    ])
  })

  test('model weekly buckets carry only the model name and reuse the total weekly countdown', () => {
    const DAY = 86400_000
    const total = new Date(Date.now() + 2.2 * DAY)
    const render = (fable: Date | null, weekly: Date | null = total) => consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'weekly', label: '周额度', percent: 100, resetsAt: weekly },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 47, resetsAt: fable },
      { kind: 'seven_day_oauth_apps', label: 'OAuth 应用周额度', percent: 5, resetsAt: weekly },
    ] })
    const exhausted = "周 <font color='red'>100%</font>"
    expect(render(total)).toBe(`${exhausted}/2.2d · Fable 47% · OAuth 5%`)
    // Same displayed countdown counts as the same reset; a different one stays on the bucket.
    expect(render(new Date(total.getTime() + 60_000))).toBe(`${exhausted}/2.2d · Fable 47% · OAuth 5%`)
    expect(render(new Date(Date.now() + 3.1 * DAY))).toBe(`${exhausted}/2.2d · Fable 47%/3.1d · OAuth 5%`)
    // A missing reset is never folded into another window's, and `name MISS` only ever means nothing is known.
    expect(render(null)).toBe(`${exhausted}/2.2d · Fable 47%/MISS · OAuth 5%`)
    const unknownFable = consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'weekly', label: '周额度', percent: 10, resetsAt: total },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: null, resetsAt: total },
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: null, resetsAt: null },
    ] })
    expect(unknownFable).toBe('周 10%/2.2d · Fable MISS/2.2d · Opus MISS')
    expect(render(total, null)).toBe(`${exhausted}/MISS · Fable 47%/2.2d · OAuth 5%/MISS`)
    expect(render(null, null)).toBe(`${exhausted}/MISS · Fable 47%/MISS · OAuth 5%/MISS`)
    // The full Claude row from the hi panel, including the login end.
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [{ id: 'claude:default', label: 'Claude·默认',
      usage: { state: 'ok', windows: [
        { kind: 'weekly', label: '周额度', percent: 100, resetsAt: total },
        { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 47, resetsAt: total },
      ], credentialExpiresAt: Date.now() + 26.2 * DAY } }] }) as any
    expect(panel.elements[0].content).toBe(`**Claude·默认**　${exhausted}/2.2d · Fable 47% · 凭据 23.2d`)
  })

  test('account names and remote errors cannot inject card markup or extra rows', () => {
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [
      { id: 'test', label: '<at id=all>\nname', usage: { state: 'network', reason: '**bad**\n<at id=all>', windows: [] } },
    ] }) as any
    expect(panel.elements[0].content).not.toContain('<at')
    expect(panel.elements[0].content).not.toContain('\n')
    expect(panel.elements[0].content).not.toContain('**bad**')
  })

  test('Claude subscription rows end with a countdown to the earliest native login end, colored like native warnings', () => {
    const DAY = 86400_000
    const base = { state: 'ok' as const, windows: [
      { kind: 'weekly', label: '周额度', percent: 17, resetsAt: new Date(Date.now() + 6.9 * DAY) },
    ] }
    const render = (days: number | null) => consoleUnifiedUsageContent({ ...base,
      credentialExpiresAt: days === null ? null : Date.now() + days * DAY })
    // loginExpiresAt is the latest end and the login may end 3 days earlier: count down to that earliest end,
    // in the same format as window resets.
    expect(render(27.3)).toBe('周 17%/6.9d · 凭据 24.3d')
    expect(render(26.2)).toBe('周 17%/6.9d · 凭据 23.2d')
    expect(render(11)).toBe('周 17%/6.9d · 凭据 8.0d')
    // Native warns from 10 days before the latest end, i.e. 7.0d shown. The color follows the displayed value,
    // so one label never shows with and without it.
    expect(render(10.06)).toBe('周 17%/6.9d · 凭据 7.1d')
    expect(render(10.04)).toBe("周 17%/6.9d · <font color='orange'>凭据 7.0d</font>")
    expect(render(10)).toBe("周 17%/6.9d · <font color='orange'>凭据 7.0d</font>")
    expect(render(4)).toBe("周 17%/6.9d · <font color='orange'>凭据 1.0d</font>")
    // Just under a day still reads 1.0d, and the same text keeps the same color.
    expect(render(3 + 23.97 / 24)).toBe("周 17%/6.9d · <font color='orange'>凭据 1.0d</font>")
    // Under a day to the earliest end the login may end any moment: hours or minutes, in red.
    expect(render(3.9)).toBe("周 17%/6.9d · <font color='red'>凭据 21.6h</font>")
    expect(render(3.5)).toBe("周 17%/6.9d · <font color='red'>凭据 12.0h</font>")
    expect(render(3 + 10 * 60_000 / DAY)).toBe("周 17%/6.9d · <font color='red'>凭据 10m</font>")
    // Past the earliest end the login may already be over, up to and beyond the latest end.
    expect(render(3)).toBe("周 17%/6.9d · <font color='red'>凭据 可能已到期</font>")
    expect(render(0.5)).toBe("周 17%/6.9d · <font color='red'>凭据 可能已到期</font>")
    expect(render(0)).toBe("周 17%/6.9d · <font color='red'>凭据 可能已到期</font>")
    expect(render(-30)).toBe("周 17%/6.9d · <font color='red'>凭据 可能已到期</font>")
    expect(render(null)).toBe('周 17%/6.9d · 凭据 MISS')
    // Other sources carry no login end; failed rows keep only their reason; the footer never shows it.
    expect(consoleUnifiedUsageContent(base)).toBe('周 17%/6.9d')
    expect(consoleUnifiedUsageContent({ state: 'no_credentials', windows: [], credentialExpiresAt: Date.now() + 20 * DAY }))
      .toBe("<font color='red'>MISS · 未登录或未配置</font>")
    expect(unifiedUsageSummary({ ...base, credentialExpiresAt: Date.now() + DAY })).not.toContain('凭据')
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle', accountUsages: [
      { id: 'claude:default', label: 'Claude·默认', usage: { ...base, credentialExpiresAt: Date.now() + 27.3 * DAY } },
    ] }) as any
    expect(panel.elements[0].content).toBe('**Claude·默认**　周 17%/6.9d · 凭据 24.3d')
  })

  test('countdowns pick their unit from the rounded value', () => {
    const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000
    expect(fmtCountdown(1)).toBe('1m')
    expect(fmtCountdown(59.4 * MIN)).toBe('59m')
    expect(fmtCountdown(59.5 * MIN)).toBe('1.0h')
    expect(fmtCountdown(4.1 * HOUR)).toBe('4.1h')
    expect(fmtCountdown(23.94 * HOUR)).toBe('23.9h')
    expect(fmtCountdown(23.97 * HOUR)).toBe('1.0d')
    expect(fmtCountdown(2.2 * DAY)).toBe('2.2d')
  })

  test('reset credit counts are compact in hi, omitted at zero like credits, and never enter the footer summary', () => {
    const snapshot = { state: 'ok' as const, windows: [{ kind: 'weekly', label: '周配额', percent: 22, resetsAt: null }], resetCredits: 2 }
    expect(consoleUnifiedUsageContent(snapshot)).toBe('周 22%/MISS · 重置 2')
    expect(consoleUnifiedUsageContent({ ...snapshot, resetCredits: 0 })).toBe('周 22%/MISS')
    expect(consoleUnifiedUsageContent({ ...snapshot, resetCredits: null })).toBe('周 22%/MISS · 重置 MISS')
    expect(unifiedUsageSummary(snapshot)).not.toContain('重置')
  })

  test('hi money matches the footer: symbol against the amount, codes spaced', () => {
    const row = (usage: object) => consoleUnifiedUsageContent({ state: 'ok', windows: [], ...usage } as any)
    expect(row({ kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' } })).toBe('余额 ¥12.34')
    expect(row({ kind: 'balance', balance: { remaining: 99.67, currency: 'USD' } })).toBe('余额 $99.67')
    expect(row({ kind: 'balance', balance: { remaining: 5, currency: 'EUR' } })).toBe('余额 EUR 5.00')
    expect(row({ kind: 'balance', balance: { remaining: NaN, currency: 'USD' } })).toBe('余额 MISS')
    // Key quotas report what is left of the limit; say so under the 已用/距重置 header.
    expect(row({ kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' } })).toBe('剩余 $3.00 / $10.00')
    expect(row({ kind: 'quota', quota: { remaining: 3, limit: null, currency: 'USD' } })).toBe('额度 未设上限')
  })

  test('footer balance and quota match hi: balance as is, key quota as what is left of the limit', () => {
    expect(unifiedUsageSummary({ state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] })).toBe('余额 ¥12.34')
    expect(unifiedUsageSummary({ state: 'ok', kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' }, windows: [] })).toBe('剩余 $3.00 / $10.00')
    expect(unifiedUsageSummary({ state: 'network', kind: 'balance', windows: [], reason: 'HTTP 503' })).toBe('余额 MISS')
  })
})
