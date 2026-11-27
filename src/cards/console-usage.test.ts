import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { consoleUnifiedUsageContent, consoleUsageContent, consoleUsageElement, unifiedUsageSummary } from './console'
import { accountUsageBlock, accountUsageError } from './account-usage'
import { fmtCountdown } from './usage'
import { codexUsageToUnified } from '../token-source-codex'
import { snapshotFromReadResponse } from '../usage'

/** Six-cell usage bar, colored by the displayed percent. */
const bar = (cells: number, color = 'green') => `<font color='${color}'>${'▰'.repeat(cells)}${'▱'.repeat(6 - cells)}</font>`
const grey = (text: string) => `<font color='grey'>${text}</font>`

describe('clear account quota detail', () => {
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
    expect(consoleUnifiedUsageContent(usage)).toBe(`周　${bar(1)} 24%　${grey('3.0d')}`)
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
    }))).split('\n')
    const weekly = `周　${bar(1)} 24%　${grey('3.0d')}`
    expect(render(main.primary)).toEqual([`5h　${bar(0)} 0%　${grey('1.0h')}`, weekly])
    expect(render({ usedPercent: 0, windowDurationMins: 300 })).toEqual([`5h　${bar(0)} 0%　${grey('重置时间 MISS')}`, weekly])
    // A wholly unknown window says MISS once.
    expect(render({ windowDurationMins: 300 })).toEqual(['5h　MISS', weekly])
  })

  test('main consumable credits and reset cards lead the detail, alongside unchanged percentages', () => {
    const main = { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: '62500.25' } }
    const usage = codexUsageToUnified(snapshotFromReadResponse({ rateLimits: main,
      rateLimitsByLimitId: { codex: main, spark: { ...main, limitId: 'spark',
        credits: { hasCredits: true, unlimited: false, balance: '999999' } } },
      rateLimitResetCredits: { availableCount: 2 } }))
    const exhausted = `周　${bar(6, 'red')} <font color='red'>100%</font>　${grey('重置时间 MISS')}`
    expect(consoleUnifiedUsageContent(usage)).toBe(`积分 62.5k · 重置卡 2\n${exhausted}`)
    expect(unifiedUsageSummary(usage)).toBe('额度 周配额 已用 100% · 积分 62.5k')
    for (const [balance, label] of [
      [62500.25, '62.5k'], [1_250_000, '1.3m'], [1000, '1k'], [1_000_000, '1m'],
      [999.94, '999.9'], [999.95, '1k'], [999_949, '999.9k'], [999_950, '1m'],
      [12.34, '12.3'], [12, '12'], [0.0001, '<0.1'], [0.05, '0.1'],
    ] as const) {
      const snapshot = { ...usage, credits: { hasCredits: true, unlimited: false, balance } }
      expect(consoleUnifiedUsageContent(snapshot)).toBe(`积分 ${label} · 重置卡 2\n${exhausted}`)
      expect(unifiedUsageSummary(snapshot)).toBe(`额度 周配额 已用 100% · 积分 ${label}`)
    }
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: false, unlimited: false, balance: 0 } })).not.toContain('积分')
    expect(consoleUnifiedUsageContent({ ...usage, credits: null })).toContain('积分 MISS')
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: true, unlimited: true, balance: null } })).toContain('积分 无限')
    expect(consoleUnifiedUsageContent({ ...usage, credits: { hasCredits: true, unlimited: false, balance: null } })).toContain('积分 MISS')
    // The 1:1 panel puts the same facts after the account name.
    expect(accountUsageBlock({ id: 'codex:default', label: 'Codex·默认', usage }))
      .toBe(`**Codex·默认**　积分 62.5k · 重置卡 2\n${exhausted}`)
  })

  test('the group panel shows only this project\'s account, one line per window; the 1:1 panel names each account', () => {
    const usage = { state: 'ok' as const, resetCredits: 0, windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
      { kind: 'weekly', label: '周配额', percent: 24, resetsAt: new Date(Date.now() + 3 * 86400_000) },
    ] }
    const lines = [`5h　${bar(1)} 11%　${grey('1.0h')}`, `周　${bar(1)} 24%　${grey('3.0d')}`]
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle',
      account: { id: 'codex:default', label: 'Codex·默认', usage } }) as any
    expect(panel.element_id).toBe('console_usage')
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(true)
    expect(panel.header.title.content).toBe('📊 账号额度')
    expect(panel.header.background_color).toBe('blue-50')
    expect(panel.elements).toEqual([{ tag: 'markdown', content: lines.join('\n') }])
    // The account name is on the project block above, not repeated in the panel.
    expect(JSON.stringify(panel)).not.toContain('Codex·默认')
    expect(accountUsageBlock({ id: 'codex:default', label: 'Codex·默认', usage })).toBe(['**Codex·默认**', ...lines].join('\n'))
    expect(accountUsageBlock({ id: 'deepseek', label: 'DeepSeek',
      usage: { state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] } })).toBe('**DeepSeek**　余额 ¥12.34')
    // Not started, or no settled account yet: no quota to show, and the panel says which.
    const content = (opts: object) => (consoleUsageElement({ sessionName: 'test', status: 'idle', ...opts }) as any).elements[0].content
    expect(content({ account: null })).toBe(grey('账号未确定'))
    expect(content({ account: null, status: 'stopped' })).toBe(grey('未启动'))
    expect(content({})).toBe('加载中…')
  })

  test('a failed account keeps only MISS inline and folds the reason into a collapsed panel', () => {
    const panel = consoleUsageElement({ sessionName: 'test', status: 'idle',
      account: { id: 'glm', label: 'GLM', usage: { state: 'network', reason: 'upstream offline', windows: [] } } }) as any
    expect(panel.elements[0]).toEqual({ tag: 'markdown', content: "<font color='red'>MISS</font>" })
    const details = panel.elements[1]
    expect(details.tag).toBe('collapsible_panel')
    expect(details.expanded).toBe(false)
    expect(details.header.title.content).toBe('⚠️ 额度读取失败')
    expect(details.elements[0].content).toBe('upstream offline')
    // 正常账号不出现错误面板。
    expect((consoleUsageElement({ sessionName: 'test', status: 'idle', account: { id: 'glm', label: 'GLM',
      usage: { state: 'ok', kind: 'balance', balance: { remaining: 3, currency: 'CNY' }, windows: [] } } }) as any).elements).toHaveLength(1)
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
    expect(content).toBe(`积分 MISS · 重置卡 3\n周　${bar(1)} 12%　${grey('重置时间 MISS')}`)
    expect(content).not.toMatch(/Spark|reserve/)
  })

  test('GLM monthly tools only show percent while other windows retain countdowns', () => {
    const out = consoleUnifiedUsageContent({ state: 'ok', planLabel: 'Max', windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
      { kind: 'weekly', label: '周配额', percent: 17, resetsAt: new Date(Date.now() + 86400_000) },
      { kind: 'monthly', label: '月度工具', percent: 7, used: 290, total: 4000, resetsAt: new Date(Date.now() + 15 * 86400_000) },
    ] })
    // The total week is always the last line, after 5h and the monthly tool bucket.
    expect(out.split('\n')).toEqual([
      `5h　${bar(1)} 11%　${grey('1.0h')}`,
      `月工具　${bar(0)} 7%`,
      `周　${bar(1)} 17%　${grey('1.0d')}`,
    ])
    expect(out).not.toMatch(/290|4000|15.0d|Max/)
  })

  test('missing or failed data stays visible without displaying stale windows', () => {
    for (const percent of [null, NaN, -1, 101]) {
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [
        { kind: 'fiveHour', label: '5h', percent, resetsAt: null },
      ] })).toBe('5h　MISS')
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [
        { kind: 'fiveHour', label: '5h', percent, resetsAt: new Date(Date.now() + 3600_000) },
      ] })).toBe(`5h　MISS　${grey('1.0h')}`)
    }
    // A reset time already reached reads as such rather than as a countdown.
    expect(consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'fiveHour', label: '5h', percent: 40, resetsAt: new Date(Date.now() - 1000) },
    ] })).toBe(`5h　${bar(2)} 40%　${grey('已重置')}`)
    // 行内只留 MISS，完整原因交给默认折叠的错误详情。
    const offline = { state: 'network', reason: 'upstream offline', windows: [
      { kind: 'fiveHour', label: 'stale', percent: 10, resetsAt: null },
    ] } as any
    expect(consoleUnifiedUsageContent(offline)).toBe("<font color='red'>MISS</font>")
    expect(accountUsageError(offline)).toBe('upstream offline')
    expect(consoleUnifiedUsageContent({ state: 'rate_limited', windows: [] })).toBe("<font color='red'>MISS</font>")
    expect(accountUsageError({ state: 'rate_limited', windows: [] })).toBe('API 限频')
    expect(accountUsageError({ state: 'ok', windows: [], resetCredits: null })).toBeNull()
    expect(consoleUnifiedUsageContent({ state: 'not_applicable', windows: [] })).toBe(grey('无额度查询'))
    // No window at all is a MISS of the whole quota, with any account-level facts after it.
    expect(consoleUnifiedUsageContent({ state: 'ok', windows: [], resetCredits: null })).toBe('额度 MISS · 重置卡 MISS')
    expect(consoleUnifiedUsageContent(undefined)).toBe('加载中…')
  })

  test('quota colors follow the displayed percent on both the bar and the number', () => {
    const content = consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: 80, resetsAt: null },
      { kind: 'seven_day_sonnet', label: 'Sonnet 周额度', percent: 100, resetsAt: null },
    ] })
    expect(content.split('\n')).toEqual([
      `Opus　${bar(5, 'orange')} <font color='orange'>80%</font>　${grey('重置时间 MISS')}`,
      `Sonnet　${bar(6, 'red')} <font color='red'>100%</font>　${grey('重置时间 MISS')}`,
    ])
    // Colors follow the displayed percent, so one label never shows with and without a color.
    const shown = (value: number) => consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind: 'weekly', label: '周额度', percent: value, resetsAt: null }] })
    const missing = `　${grey('重置时间 MISS')}`
    expect(shown(79.4)).toBe(`周　${bar(5)} 79%${missing}`)
    expect(shown(79.6)).toBe(`周　${bar(5, 'orange')} <font color='orange'>80%</font>${missing}`)
    expect(shown(99.4)).toBe(`周　${bar(6, 'orange')} <font color='orange'>99%</font>${missing}`)
    expect(shown(99.6)).toBe(`周　${bar(6, 'red')} <font color='red'>100%</font>${missing}`)
  })

  test('relay script windows with unparsed dates or unlisted kinds render without breaking the panel', () => {
    // Relay balance scripts pass raw JSON through, so dates arrive as strings.
    const relay = { state: 'ok', windows: [
      { kind: 'monthly', label: '月度工具', percent: 5, resetsAt: '2026-12-01T00:00:00Z' },
      { kind: 'daily', label: '日额度', percent: 12, resetsAt: '2026-12-01T00:00:00Z' },
      { kind: 'proWeekly', label: 'Pro 周额度', percent: 30, resetsAt: new Date(Date.now() + 86400_000) },
    ] } as any
    const relayLines = [
      `月工具　${bar(0)} 5%`,
      `日额度　${bar(1)} 12%　${grey('重置时间 MISS')}`,
      `Pro 周额度　${bar(2)} 30%　${grey('1.0d')}`,
    ]
    expect(consoleUnifiedUsageContent(relay).split('\n')).toEqual(relayLines)
    // Windows without a string kind, label, currency or reason are just unlisted, never a thrown panel.
    for (const kind of [undefined, null, 7]) {
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind, label: '日额度', percent: 12, resetsAt: null }] } as any))
        .toBe(`日额度　${bar(1)} 12%　${grey('重置时间 MISS')}`)
    }
    expect(consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind: 'x', label: 3, percent: 12, resetsAt: null }] } as any))
      .toBe(`额度　${bar(1)} 12%　${grey('重置时间 MISS')}`)
    // A missing or non-string currency leaves just the amount, never `undefined`.
    for (const currency of [7, undefined, null, '  ']) {
      expect(consoleUnifiedUsageContent({ state: 'ok', kind: 'balance', balance: { remaining: 5, currency }, windows: [] } as any))
        .toBe('余额 5.00')
      expect(consoleUnifiedUsageContent({ state: 'ok', kind: 'quota', quota: { remaining: 1, limit: 2, currency }, windows: [] } as any))
        .toBe('剩余 1.00 / 2.00')
    }
    expect(consoleUnifiedUsageContent({ state: 'network', reason: 404, windows: [] } as any)).toBe("<font color='red'>MISS</font>")
    expect(accountUsageError({ state: 'network', reason: 404, windows: [] } as any)).toBe('404')
    // A window entry that is not an object is a wholly unknown window; the other windows still show.
    expect(consoleUnifiedUsageContent({ state: 'ok', windows: [null, 3, { kind: 'weekly', label: '周', percent: 50, resetsAt: null }] } as any)
      .split('\n')).toEqual(['额度　MISS', '额度　MISS', `周　${bar(3)} 50%　${grey('重置时间 MISS')}`])
    // Reset card counts other than a non-negative integer are MISS, so script text never reaches the card.
    for (const resetCredits of ['<at id=all></at>', 1.5, -1, NaN]) {
      expect(consoleUnifiedUsageContent({ state: 'ok', windows: [], resetCredits } as any)).toBe('额度 MISS · 重置卡 MISS')
    }
    // A date-like object is not a Date: the reset is unknown, nothing throws.
    expect(consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind: 'weekly', percent: 5, resetsAt: { getTime: 1 } }] } as any))
      .toBe(`周　${bar(0)} 5%　${grey('重置时间 MISS')}`)
    // Anything else malformed costs only this account a MISS, never the whole panel.
    const malformed = { state: 'ok', windows: 'x' } as any
    expect(consoleUnifiedUsageContent(malformed)).toBe("<font color='red'>MISS</font>")
    expect(accountUsageError(malformed)).toBe('额度数据格式无效')
    expect(accountUsageBlock({ id: 'relay:z', label: 'z', usage: malformed })).toBe("**z**　<font color='red'>MISS</font>")
    expect(accountUsageBlock({ id: 'relay:x', label: 'x', usage: relay })).toBe(['**x**', ...relayLines].join('\n'))
    expect(accountUsageBlock({ id: 'relay:y', label: 'y', usage: { state: 'ok', windows: [{ label: '日额度', percent: 12, resetsAt: null }] } as any }))
      .toBe(`**y**\n日额度　${bar(1)} 12%　${grey('重置时间 MISS')}`)
  })

  test('model weekly buckets read by model name above the total week and each carries its own reset', () => {
    const DAY = 86400_000
    const total = new Date(Date.now() + 2.2 * DAY)
    const render = (fable: Date | null, weekly: Date | null = total) => consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'weekly', label: '周额度', percent: 100, resetsAt: weekly },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 47, resetsAt: fable },
      { kind: 'seven_day_oauth_apps', label: 'OAuth 应用周额度', percent: 5, resetsAt: weekly },
    ] }).split('\n')
    const exhausted = `周　${bar(6, 'red')} <font color='red'>100%</font>`
    const reset = (date: Date | null) => grey(date ? `${fmtCountdown(date.getTime() - Date.now())}` : '重置时间 MISS')
    // The total week always comes last; model buckets above it drop the redundant 周.
    expect(render(total)).toEqual([
      `Fable　${bar(3)} 47%　${reset(total)}`, `OAuth 应用　${bar(0)} 5%　${reset(total)}`, `${exhausted}　${reset(total)}`,
    ])
    expect(reset(total)).toBe(grey('2.2d'))
    const later = new Date(Date.now() + 3.1 * DAY)
    expect(render(later)[0]).toBe(`Fable　${bar(3)} 47%　${grey('3.1d')}`)
    // A missing reset is never borrowed from another window, and `<name>　MISS` only ever means nothing is known.
    expect(render(null)[0]).toBe(`Fable　${bar(3)} 47%　${grey('重置时间 MISS')}`)
    expect(render(total, null)).toEqual([
      `Fable　${bar(3)} 47%　${reset(total)}`, `OAuth 应用　${bar(0)} 5%　${grey('重置时间 MISS')}`,
      `${exhausted}　${grey('重置时间 MISS')}`,
    ])
    const unknownFable = consoleUnifiedUsageContent({ state: 'ok', windows: [
      { kind: 'weekly', label: '周额度', percent: 10, resetsAt: total },
      { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: null, resetsAt: total },
      { kind: 'seven_day_opus', label: 'Opus 周额度', percent: null, resetsAt: null },
      { kind: 'modelWeekly:Muse', label: '', percent: 3, resetsAt: total },
    ] }).split('\n')
    expect(unknownFable).toEqual([
      `Fable　MISS　${reset(total)}`, 'Opus　MISS', `Muse　${bar(0)} 3%　${reset(total)}`, `周　${bar(1)} 10%　${reset(total)}`,
    ])
    // The full Claude block in the 1:1 panel, including the login end.
    expect(accountUsageBlock({ id: 'claude:default', label: 'Claude·默认',
      usage: { state: 'ok', windows: [
        { kind: 'weekly', label: '周额度', percent: 100, resetsAt: total },
        { kind: 'modelWeekly:Fable', label: 'Fable 周额度', percent: 47, resetsAt: total },
      ], credentialExpiresAt: Date.now() + 26.2 * DAY } }).split('\n')).toEqual([
      '**Claude·默认**　凭据剩余 23.2d', `Fable　${bar(3)} 47%　${reset(total)}`, `${exhausted}　${reset(total)}`,
    ])
  })

  test('account names and remote errors cannot inject card markup or extra rows', () => {
    const block = accountUsageBlock({ id: 'test', label: '<at id=all>\nname', usage: { state: 'network', reason: '**bad**\n<at id=all>', windows: [] } })
    expect(block).not.toContain('<at')
    expect(block).not.toContain('\n')
    expect(block).not.toContain('**bad**')
    const window = consoleUnifiedUsageContent({ state: 'ok', windows: [{ kind: 'x', label: '<at id=all>**日**', percent: 1, resetsAt: null }] })
    expect(window).not.toContain('<at')
    expect(window).not.toContain('**日**')
  })

  test('Claude subscription accounts lead with the time left to the earliest native login end, colored like native warnings', () => {
    const DAY = 86400_000
    const base = { state: 'ok' as const, windows: [
      { kind: 'weekly', label: '周额度', percent: 17, resetsAt: new Date(Date.now() + 6.9 * DAY) },
    ] }
    const weekly = `周　${bar(1)} 17%　${grey('6.9d')}`
    const render = (days: number | null) => consoleUnifiedUsageContent({ ...base,
      credentialExpiresAt: days === null ? null : Date.now() + days * DAY })
    const row = (fact: string) => `${fact}\n${weekly}`
    // loginExpiresAt is the latest end and the login may end 3 days earlier: count down to that earliest end,
    // in the same format as window resets.
    expect(render(27.3)).toBe(row('凭据剩余 24.3d'))
    expect(render(26.2)).toBe(row('凭据剩余 23.2d'))
    expect(render(11)).toBe(row('凭据剩余 8.0d'))
    // Native warns from 10 days before the latest end, i.e. 7.0d shown. The color follows the displayed value,
    // so one label never shows with and without it.
    expect(render(10.06)).toBe(row('凭据剩余 7.1d'))
    expect(render(10.04)).toBe(row("<font color='orange'>凭据剩余 7.0d</font>"))
    expect(render(10)).toBe(row("<font color='orange'>凭据剩余 7.0d</font>"))
    expect(render(4)).toBe(row("<font color='orange'>凭据剩余 1.0d</font>"))
    // Just under a day still reads 1.0d, and the same text keeps the same color.
    expect(render(3 + 23.97 / 24)).toBe(row("<font color='orange'>凭据剩余 1.0d</font>"))
    // Under a day to the earliest end the login may end any moment: hours or minutes, in red.
    expect(render(3.9)).toBe(row("<font color='red'>凭据剩余 21.6h</font>"))
    expect(render(3.5)).toBe(row("<font color='red'>凭据剩余 12.0h</font>"))
    expect(render(3 + 10 * 60_000 / DAY)).toBe(row("<font color='red'>凭据剩余 10m</font>"))
    // Past the earliest end the login may already be over, up to and beyond the latest end.
    for (const days of [3, 0.5, 0, -30]) expect(render(days)).toBe(row("<font color='red'>凭据可能已到期</font>"))
    expect(render(null)).toBe(row('凭据 MISS'))
    // Other sources carry no login end; failed rows keep only their reason; the footer never shows it.
    expect(consoleUnifiedUsageContent(base)).toBe(weekly)
    const loggedOut = { state: 'no_credentials', windows: [], credentialExpiresAt: Date.now() + 20 * DAY } as any
    expect(consoleUnifiedUsageContent(loggedOut)).toBe("<font color='red'>MISS</font>")
    expect(accountUsageError(loggedOut)).toBe('未登录或未配置')
    expect(unifiedUsageSummary({ ...base, credentialExpiresAt: Date.now() + DAY })).not.toContain('凭据')
    expect(accountUsageBlock({ id: 'claude:default', label: 'Claude·默认', usage: { ...base, credentialExpiresAt: Date.now() + 27.3 * DAY } }))
      .toBe(`**Claude·默认**　凭据剩余 24.3d\n${weekly}`)
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

  test('reset card counts lead the detail, are omitted at zero like credits, and never enter the footer summary', () => {
    const snapshot = { state: 'ok' as const, windows: [{ kind: 'weekly', label: '周配额', percent: 22, resetsAt: null }], resetCredits: 2 }
    const weekly = `周　${bar(1)} 22%　${grey('重置时间 MISS')}`
    expect(consoleUnifiedUsageContent(snapshot)).toBe(`重置卡 2\n${weekly}`)
    expect(consoleUnifiedUsageContent({ ...snapshot, resetCredits: 0 })).toBe(weekly)
    expect(consoleUnifiedUsageContent({ ...snapshot, resetCredits: null })).toBe(`重置卡 MISS\n${weekly}`)
    expect(unifiedUsageSummary(snapshot)).not.toContain('重置')
  })

  test('hi money matches the footer: symbol against the amount, codes spaced', () => {
    const row = (usage: object) => consoleUnifiedUsageContent({ state: 'ok', windows: [], ...usage } as any)
    expect(row({ kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' } })).toBe('余额 ¥12.34')
    expect(row({ kind: 'balance', balance: { remaining: 99.67, currency: 'USD' } })).toBe('余额 $99.67')
    expect(row({ kind: 'balance', balance: { remaining: 5, currency: 'EUR' } })).toBe('余额 EUR 5.00')
    expect(row({ kind: 'balance', balance: { remaining: NaN, currency: 'USD' } })).toBe('余额 MISS')
    // Key quotas report what is left of the limit; say so, so it is not read as usage.
    expect(row({ kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' } })).toBe('剩余 $3.00 / $10.00')
    expect(row({ kind: 'quota', quota: { remaining: 3, limit: null, currency: 'USD' } })).toBe('额度 未设上限')
    expect(row({ kind: 'quota', quota: { remaining: null, limit: 10, currency: 'USD' } })).toBe('额度 MISS')
  })

  test('footer balance and quota match hi: balance as is, key quota as what is left of the limit', () => {
    expect(unifiedUsageSummary({ state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] })).toBe('余额 ¥12.34')
    expect(unifiedUsageSummary({ state: 'ok', kind: 'quota', quota: { remaining: 3, limit: 10, currency: 'USD' }, windows: [] })).toBe('剩余 $3.00 / $10.00')
    expect(unifiedUsageSummary({ state: 'network', kind: 'balance', windows: [], reason: 'HTTP 503' })).toBe('余额 MISS')
  })
})
