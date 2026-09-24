import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodexModelCompatibility, CodexAccountScheduler } from './codex-account-scheduler'
import { compareCodexQuota, isCodexQuotaError, rankCodexQuota } from './codex-quota'
import type { AgentReasoningEffort } from './agent-process'
import type { TokenSource, TokenSourceModel } from './token-source'
import type { UsageSnapshot } from './usage'

const NOW = 1_800_000_000_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function quota(plan: string, used = 0, hours = 24): Extract<UsageSnapshot, { state: 'ok' }> {
  return { state: 'ok', subscriptionType: plan, fiveHour: null,
    weekly: { percent: used, resetsAt: new Date(NOW + hours * 3_600_000), durationMins: 10080 }, fetchedAt: NOW }
}
function harness(input: Record<string, UsageSnapshot>, cached: Record<string, UsageSnapshot> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-scheduling-')); roots.push(root)
  const stateFile = join(root, 'blocks.json')
  const unavailable = new Map<string, string>()
  const pending = new Set<string>()
  const scheduler = new CodexAccountScheduler({ accounts: () => Object.keys(input).map(id => ({ id, name: id })),
    usage: async id => input[id], cachedUsage: id => cached[id] ?? null,
    identity: id => id, compatible: async id => unavailable.get(id) ?? null,
    pendingLogin: id => pending.has(id), now: () => NOW, stateFile })
  return { scheduler, input, unavailable, pending, stateFile }
}

describe('weekly quota scheduling', () => {
  test('an untouched complete week precedes expiring accounts, which precede numeric scores', async () => {
    const h = harness({ high: quota('pro', 0, 5.01), expiring: quota('pro', 99, 4), unused: quota('prolite', 0, 168) })
    const choice = await h.scheduler.choose({ model: 'model' })
    expect(choice.selected?.account.id).toBe('unused')
    expect(choice.candidates.slice().sort(compareCodexQuota).map(c => c.account.id)).toEqual(['unused', 'expiring', 'high'])
    expect(choice.candidates[1]).toMatchObject({ state: 'ready', priority: 'expiring', score: null, weeklyScore: null, hours: 4 })
    expect(choice.candidates[2]).toMatchObject({ priority: 'unused' })
    expect(choice.candidates[2].score).toBeCloseTo(5 / 163)
    expect(choice.candidates[0].score).toBeCloseTo(20 / 0.01)
  })
  test('unused priority requires an exact zero and a whole native week at observation time', () => {
    const full = quota('pro', 0, 168)
    full.fetchedAt += 999 // Native resetsAt only has second precision.
    expect(rankCodexQuota(full, 'model', NOW + 1000).priority).toBe('unused')
    for (const usage of [quota('pro', 0.001, 168), quota('pro', 0, 167.999), quota('pro', 0, 168.001)]) {
      expect(rankCodexQuota(usage, 'model', NOW).priority).toBeUndefined()
    }
    full.weekly!.durationMins = null
    expect(rankCodexQuota(full, 'model', NOW).priority).toBeUndefined()
    full.weekly!.durationMins = 10080
    full.fetchedAt = NaN
    expect(rankCodexQuota(full, 'model', NOW).priority).toBeUndefined()
    full.readStartedAt = NOW
    full.fetchedAt = NOW + 5000
    expect(rankCodexQuota(full, 'model', NOW + 5000).priority).toBe('unused')
    full.readStartedAt = NOW + 1000
    expect(rankCodexQuota(full, 'model', NOW + 5000).priority).toBeUndefined()
  })
  test('reading or choosing does not consume unused priority; actual use prevents stale-cache reuse', async () => {
    const input = { unused: quota('prolite', 0, 168), urgent: quota('pro', 99, 2) }
    const h = harness(input, input)
    for (const preferCachedUsage of [false, true, false]) {
      expect((await h.scheduler.choose({ model: 'model', preferCachedUsage })).selected?.account.id).toBe('unused')
    }
    h.scheduler.recordUsage('unused', 'model')
    for (const preferCachedUsage of [true, false]) {
      const choice = await h.scheduler.choose({ model: 'model', preferCachedUsage })
      expect(choice.selected?.account.id).toBe('urgent')
      expect(choice.candidates[0].priority).toBeUndefined()
    }
    // The same 0% window remains used on a later read; only a genuinely new complete week qualifies again.
    input.unused.fetchedAt = NOW + 60_000
    const clock = spyOn((h.scheduler as any).deps, 'now').mockReturnValue(NOW + 60_000)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('urgent')
    input.unused.weekly!.resetsAt = new Date(NOW + 60_000 + 168 * 3_600_000)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('unused')
    clock.mockRestore()
  })
  test('actual usage observations are shared by aliases but isolated by native quota meter and identity', async () => {
    const full = quota('pro', 0, 168)
    full.accountFingerprint = 'shared'
    full.buckets = [{ limitId: 'spark', limitName: 'spark', fiveHour: null, weekly: full.weekly }]
    const alias = { ...full }
    const other = { ...full, accountFingerprint: 'different' }
    const input = { original: full, alias, other }
    const h = harness(input, input)
    h.scheduler.recordUsage('original', 'model')
    const main = await h.scheduler.choose({ model: 'model' })
    expect(main.candidates[0].priority).toBeUndefined()
    expect(main.candidates[1].priority).toBeUndefined()
    expect(main.candidates[2].priority).toBe('unused')
    expect((await h.scheduler.choose({ model: 'spark' })).candidates[0].priority).toBe('unused')
  })
  test('last five hours are explicit priority, including Plus, with earliest reset first and no infinite score', async () => {
    const h = harness({ normal: quota('pro', 0, 5.001), five: quota('pro', 0, 5), two: quota('plus', 50, 2) })
    const choice = await h.scheduler.choose({ model: 'model' })
    expect(choice.selected?.account.id).toBe('two')
    expect(choice.candidates.slice().sort(compareCodexQuota).map(c => c.account.id)).toEqual(['two', 'five', 'normal'])
    expect(choice.candidates.slice(1).every(c => c.priority === 'expiring' && c.score === null)).toBe(true)
    expect(rankCodexQuota(quota('pro', 0, 0), 'model', NOW)).toMatchObject({ state: 'miss', score: null })
    const oldFullWeek = quota('pro', 0, 168)
    expect(rankCodexQuota(oldFullWeek, 'model', NOW + 164 * 3_600_000)).toMatchObject({
      state: 'ready', priority: 'expiring', score: null, hours: 4,
    })
  })
  test('priority never bypasses Ultra eligibility, exhausted short windows or model compatibility', async () => {
    const plus = quota('plus', 0, 168)
    const small = quota('pro', 99, 1)
    const blocked = quota('pro', 0, 168)
    blocked.fiveHour = { percent: 100, resetsAt: new Date(NOW + 3600_000) }
    const h = harness({ plus, small, blocked, incompatible: quota('pro', 0, 168), eligible: quota('pro', 50, 24) })
    h.unavailable.set('incompatible', 'model not available')
    expect((await h.scheduler.choose({ model: 'model', effort: 'ultra' })).selected?.account.id).toBe('eligible')
  })
  test('startup ranks successful caches without querying quota or waiting for uncached accounts', async () => {
    const cached = { plus: quota('plus'), pro: { ...quota('pro'), fetchedAt: NOW - 12 * 3600_000 } }
    const h = harness({ plus: { state: 'network' }, pro: { state: 'network' }, cold: { state: 'network' } }, cached)
    const reader = spyOn((h.scheduler as any).deps, 'usage').mockRejectedValue(new Error('quota endpoint unavailable'))
    const choice = await h.scheduler.choose({ model: 'model', preferCachedUsage: true })
    expect(choice.selected?.account.id).toBe('pro')
    expect(choice.selected?.usage).toBe(cached.pro)
    expect(choice.candidates.find(c => c.account.id === 'cold')?.usage).toBeNull()
    expect(reader).not.toHaveBeenCalled()
  })
  test('explicit quota queries still refresh and report errors despite a successful startup cache', async () => {
    const h = harness({ pro: { state: 'network', reason: 'quota request failed' } }, { pro: quota('pro') })
    const reader = spyOn((h.scheduler as any).deps, 'usage')
    const choice = await h.scheduler.choose({ model: 'model' })
    expect(reader).toHaveBeenCalledTimes(1)
    expect(choice.selected).toBeNull()
    expect(choice.candidates[0]).toMatchObject({ state: 'miss', reason: 'quota request failed' })
  })
  test('missing, expired or exhausted caches refresh when none can supply a launch candidate', async () => {
    const cases: Array<Record<string, UsageSnapshot>> = [{}, { pro: quota('pro', 0, 0) }, { pro: quota('pro', 100) }]
    for (const cached of cases) {
      const h = harness({ pro: quota('pro') }, cached)
      const reader = spyOn((h.scheduler as any).deps, 'usage')
      expect((await h.scheduler.choose({ model: 'model', preferCachedUsage: true })).selected?.account.id).toBe('pro')
      expect(reader).toHaveBeenCalledTimes(1)
    }
  })
  test('cached quota cannot clear confirmed exhaustion, even if its old percentage is lower', async () => {
    const h = harness({ pro: quota('pro', 80), plus: quota('plus') }, { pro: quota('pro', 10), plus: quota('plus') })
    h.scheduler.block((await h.scheduler.choose({ model: 'model' })).selected!, 'model')
    const reader = spyOn((h.scheduler as any).deps, 'usage')
    const cached = await h.scheduler.choose({ model: 'model', preferCachedUsage: true })
    expect(cached.selected?.account.id).toBe('plus')
    expect(cached.candidates[0].state).toBe('exhausted')
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).blocks).toHaveLength(1)
    expect(reader).not.toHaveBeenCalled()
    h.input.pro = quota('pro', 10)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('pro')
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).blocks).toEqual([])
  })
  test('cached startup still checks login, identity, model compatibility and Ultra eligibility', async () => {
    const cached = { one: { ...quota('pro'), accountFingerprint: 'same' },
      alias: { ...quota('pro'), accountFingerprint: 'same' }, badModel: quota('pro'), loggingIn: quota('pro'), plus: quota('plus') }
    const h = harness(cached, cached)
    h.unavailable.set('badModel', 'effort unavailable'); h.pending.add('loggingIn')
    const choice = await h.scheduler.choose({ model: 'model', effort: 'ultra', preferCachedUsage: true })
    expect(choice.selected?.account.id).toBe('one')
    expect(choice.candidates.map(c => c.state)).toEqual(['ready', 'miss', 'miss', 'miss', 'excluded'])
  })
  test('weights quota by 1 / 5 / 20, caps Plus by its short window, and always picks the highest score', async () => {
    const { scheduler } = harness({ plus: quota('plus', 0, 10), five: quota('prolite', 50, 10), twenty: quota('pro', 75, 10) })
    const normal = await scheduler.choose({ model: 'gpt-6-astra', effort: 'max' })
    expect(normal.selected?.account.id).toBe('twenty')
    expect(normal.candidates.map(c => c.score)).toEqual([0.03, 0.5, 1])
    expect((await scheduler.choose({ model: 'gpt-6-astra', effort: 'ultra' })).selected?.account.id).toBe('twenty')
  })
  test('time to reset, not elapsed time or total plan size, determines ranking', async () => {
    const { scheduler } = harness({ plus: quota('plus', 50, 1), pro: quota('pro', 90, 160) })
    expect((await scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
  })
  test('5-hour exhaustion excludes even an otherwise highest-scoring account, including Pro', async () => {
    const full = quota('pro', 0, 1)
    full.fiveHour = { percent: 100, resetsAt: new Date(NOW + 7200_000), durationMins: 300 }
    const { scheduler } = harness({ full, plus: quota('plus') })
    const choice = await scheduler.choose({ model: 'model' })
    expect(choice.selected?.account.id).toBe('plus')
    expect(choice.candidates[0]).toMatchObject({ state: 'exhausted', retryAt: NOW + 7200_000, score: null })
  })
  test('Plus without a short window has a full 0.15-share / 5h allowance', () => {
    expect(rankCodexQuota(quota('plus'), 'model', NOW)).toMatchObject({ state: 'ready',
      fiveHourRemaining: 0.15, fiveHourHours: 5, score: 0.03 })
  })
  test('Ultra never selects zero or negative availability', async () => {
    const { scheduler } = harness({ empty: quota('plus', 100), available: quota('pro', 95) })
    expect((await scheduler.choose({ model: 'model', effort: 'ultra' })).selected?.account.id).toBe('available')
  })
  test('unknown plans, failed reads, missing percentages and expired resets remain MISS', async () => {
    const missing = quota('plus'); missing.weekly!.percent = null
    const { scheduler } = harness({ unknown: quota('future'), missing, stale: quota('plus', 0, 0),
      auth: { state: 'auth_failed' }, network: { state: 'network', reason: 'timeout' } })
    const choice = await scheduler.choose({ model: 'model' })
    expect(choice.selected).toBeNull()
    expect(choice.retryAt).toBeUndefined()
    expect(choice.candidates.every(c => c.state === 'miss' && c.score === null)).toBe(true)
  })
  test('all exhausted windows must reset; choose the first account that can recover', async () => {
    const plus = quota('plus', 100, 20)
    plus.fiveHour = { percent: 100, resetsAt: new Date(NOW + 3600_000), durationMins: 300 }
    const { scheduler } = harness({ plus, pro: quota('pro', 100, 4) })
    const choice = await scheduler.choose({ model: 'model' })
    expect(choice.selected).toBeNull()
    expect(choice.candidates[0].retryAt).toBe(NOW + 20 * 3600_000)
    expect(choice.retryAt).toBe(NOW + 4 * 3600_000)
  })
  test('manual selection ignores quotas, plan, model, duplicate identities and stored exhaustion without any reads', async () => {
    const { scheduler, input, stateFile, unavailable } = harness({ plus: quota('plus'), pro: quota('pro') })
    const reader = spyOn((scheduler as any).deps, 'usage').mockRejectedValue(new Error('must not read'))
    const compatibility = spyOn((scheduler as any).deps, 'compatible').mockRejectedValue(new Error('must not validate'))
    unavailable.set('plus', 'ultra unsupported')
    writeFileSync(stateFile, 'corrupted quota state')
    expect((await scheduler.choose({ model: 'model', preferred: 'plus' })).selected?.account.id).toBe('plus')
    input.plus = quota('plus', 100)
    expect((await scheduler.choose({ model: 'model', effort: 'ultra', preferred: 'plus' })).selected).toMatchObject({
      state: 'manual', usage: null, account: { id: 'plus' } })
    input.plus = { state: 'network', reason: 'broken' }
    expect((await scheduler.choose({ model: 'model', preferred: 'plus' })).selected?.account.id).toBe('plus')
    expect(reader).not.toHaveBeenCalled(); expect(compatibility).not.toHaveBeenCalled()
    await expect(scheduler.choose({ model: 'model', preferred: 'unknown' })).rejects.toThrow('不存在')
  })
  test('OS-keyring account ids deduplicate aliases; model and login constraints are applied', async () => {
    const { scheduler, unavailable, pending } = harness({ one: { ...quota('pro'), accountFingerprint: 'same' },
      alias: { ...quota('pro'), accountFingerprint: 'same' }, badModel: quota('pro'), loggingIn: quota('pro'), plus: quota('plus') })
    unavailable.set('badModel', 'effort unavailable'); pending.add('loggingIn')
    const choice = await scheduler.choose({ model: 'model' })
    expect(choice.candidates[1].duplicateOf).toBe('one')
    expect(choice.candidates.filter(c => c.state === 'ready').map(c => c.account.id)).toEqual(['one', 'plus'])
  })
  test('confirmed exhaustion persists across scheduler instances and clears only on observed recovery', async () => {
    const h = harness({ pro: quota('pro', 80), plus: quota('plus') })
    const choice = await h.scheduler.choose({ model: 'model' })
    h.scheduler.block(choice.selected!, 'model')
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).blocks).toHaveLength(1)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
    h.input.pro = quota('pro', 80, 24.01) // moving reset timestamps without recovery must not trigger a loop
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
    h.input.pro = quota('pro', 90) // stale/non-reset progress must not clear the native failure
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
    h.input.pro = quota('pro', 10, 168)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('pro')
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).blocks).toEqual([])
  })
  test('Spark quota does not exhaust ordinary models; the requested meter is authoritative', () => {
    const usage = quota('pro')
    usage.buckets = [{ limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
      fiveHour: { percent: 100, resetsAt: new Date(NOW + 3600_000) }, weekly: usage.weekly }]
    expect(rankCodexQuota(usage, 'gpt-6-astra', NOW).state).toBe('ready')
    expect(rankCodexQuota(usage, 'gpt-5.3-codex-spark', NOW).state).toBe('exhausted')
  })
  test('confirmed exhaustion follows the shared meter across model changes, preserving independent Spark capacity', async () => {
    const usage = quota('pro')
    usage.buckets = [{ limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', fiveHour: null, weekly: usage.weekly }]
    const h = harness({ pro: usage, plus: quota('plus') })
    const choice = await h.scheduler.choose({ model: 'gpt-6-astra' })
    h.scheduler.block(choice.selected!, 'gpt-6-astra')
    expect((await h.scheduler.choose({ model: 'gpt-5.6-sol' })).selected?.account.id).toBe('plus')
    expect((await h.scheduler.choose({ model: 'gpt-5.3-codex-spark' })).selected?.account.id).toBe('pro')
  })
  test('authoritative ordinaryUsageAllowed and spend controls exclude accounts even below 100%', () => {
    expect(rankCodexQuota({ ...quota('pro'), ordinaryUsageAllowed: false }, 'model', NOW).state).toBe('exhausted')
    expect(rankCodexQuota({ ...quota('pro'), rateLimitReachedType: 'rate_limit_reached' }, 'model', NOW).state).toBe('exhausted')
  })
  test('corrupt durable state cannot be silently reset', async () => {
    const h = harness({ pro: quota('pro') }); writeFileSync(h.stateFile, '{"version":1,"blocks":[{}]}')
    await expect(h.scheduler.choose({ model: 'model' })).rejects.toThrow('格式无效')
  })
  test('cancellation during reads prevents a subsequent selection', async () => {
    const h = harness({ pro: quota('pro') }); const abort = new AbortController(); abort.abort()
    await expect(h.scheduler.choose({ model: 'model', signal: abort.signal })).rejects.toThrow()
  })
  test('Plus scores the more restrictive of weekly and short rates, without counting the short allowance twice', () => {
    const plus = quota('plus', 20, 80)
    plus.fiveHour = { percent: 90, resetsAt: new Date(NOW + 3 * 3600_000), durationMins: 300 }
    const rank = rankCodexQuota(plus, 'model', NOW)
    expect(rank.weeklyScore).toBeCloseTo(0.8 / 75)
    expect(rank.fiveHourRemaining).toBeCloseTo(0.015)
    expect(rank.score).toBeCloseTo(0.005)
    expect(rank.availableNow).toBeCloseTo(0.015)
    plus.fiveHour.percent = 0
    expect(rankCodexQuota(plus, 'model', NOW).score).toBeCloseTo(0.8 / 75)
  })
  test('provided but malformed short-window data stays MISS, never a full allowance', () => {
    const plus = quota('plus')
    plus.fiveHour = { percent: null, resetsAt: new Date(NOW + 3600_000) }
    expect(rankCodexQuota(plus, 'model', NOW).state).toBe('miss')
    plus.fiveHour = { percent: 50, resetsAt: null }
    expect(rankCodexQuota(plus, 'model', NOW).state).toBe('miss')
  })
  test('Ultra excludes Plus, accepts exactly 0.5 weekly shares, and waits below that threshold', async () => {
    const h = harness({ plus: quota('plus'), five: quota('prolite', 90), twenty: quota('pro', 97.5) })
    const choice = await h.scheduler.choose({ model: 'model', effort: 'ultra' })
    expect(choice.candidates[0].state).toBe('excluded')
    expect(choice.candidates.slice(1).every(c => c.state === 'ready' && c.remaining === 0.5)).toBe(true)
    h.input.five = quota('prolite', 90.001, 20)
    h.input.twenty = quota('pro', 97.501, 30)
    const wait = await h.scheduler.choose({ model: 'model', effort: 'ultra' })
    expect(wait.selected).toBeNull()
    expect(wait.candidates.slice(1).every(c => c.state === 'waiting')).toBe(true)
    expect(wait.retryAt).toBe(NOW + 20 * 3600_000)
    expect((await h.scheduler.choose({ model: 'model', effort: 'max' })).selected).not.toBeNull()
  })
  test('short-window recovery is observed when Plus stops reporting an exhausted 5h window', async () => {
    const plus = quota('plus', 20, 80)
    plus.fiveHour = { percent: 100, resetsAt: new Date(NOW + 3600_000), durationMins: 300 }
    const h = harness({ plus })
    const failed = (await h.scheduler.choose({ model: 'model' })).candidates[0]
    h.scheduler.block(failed, 'model')
    h.input.plus = quota('plus', 20, 80)
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
  })
  test('manual-account exhaustion gets a durable block before choosing an automatic replacement', async () => {
    const h = harness({ pro: quota('pro'), plus: quota('plus') })
    const replacement = await h.scheduler.choose({ model: 'model', failedAccountId: 'pro' })
    expect(replacement.selected?.account.id).toBe('plus')
    expect((await h.scheduler.choose({ model: 'model' })).selected?.account.id).toBe('plus')
  })
})

describe('account model catalog checks', () => {
  const model = (efforts: AgentReasoningEffort[] = ['high', 'max']): TokenSourceModel => ({
    model: 'new-model', display: 'New model', efforts, defaultEffort: efforts[0],
  })
  function catalog(models: TokenSourceModel[]) {
    const refresh = mock(async (): Promise<void> => { throw new Error('unexpected catalog query') })
    const source: TokenSource = {
      id: 'codex-sub', kind: 'codex-subscription', agent: 'codex', display: 'Codex', enabled: true,
      models, defaultModel: 'new-model', modelCatalogState: { status: 'ready', updatedAt: NOW - 3600_000 },
      refreshModels: refresh, spawnEnv: env => env, resolveSpawnModel: value => value,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    }
    return { source, refresh }
  }

  test('refreshing a named account restores its missing model before quota ranking', async () => {
    const primary = catalog([model()])
    const secondary = catalog([])
    secondary.refresh.mockImplementation(async () => { secondary.source.models = [model()] })
    const quotas = { primary: quota('plus'), secondary: quota('pro') }
    const h = harness(quotas, quotas)
    const reader = spyOn((h.scheduler as any).deps, 'usage')
    spyOn((h.scheduler as any).deps, 'compatible').mockImplementation((id: string, requested: string, effort?: AgentReasoningEffort) =>
      checkCodexModelCompatibility(id === 'primary' ? primary.source : secondary.source, requested, effort, NOW))
    const choice = await h.scheduler.choose({ model: 'new-model', effort: 'max', preferCachedUsage: true })
    expect(choice.selected?.account.id).toBe('secondary')
    expect(choice.candidates.every(c => c.state === 'ready')).toBe(true)
    expect(secondary.refresh).toHaveBeenCalledTimes(1)
    expect(primary.refresh).not.toHaveBeenCalled()
    expect(reader).not.toHaveBeenCalled()
  })

  test('an updated effort catalog makes the original requested effort eligible', async () => {
    const { source, refresh } = catalog([model(['high'])])
    refresh.mockImplementation(async () => { source.models = [model()] })
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('account rollout mismatches are cached for five minutes without extending on hits', async () => {
    for (const [models, reason] of [
      [[], '模型目录缺少 new-model'],
      [[model(['high'])], 'new-model 缺少推理档位 max（目录档位：high）'],
    ] as Array<[TokenSourceModel[], string]>) {
      const { source, refresh } = catalog(models)
      let now = NOW
      refresh.mockImplementation(async () => { source.modelCatalogState = { status: 'ready', updatedAt: now } })
      const quotas = { secondary: quota('pro') }
      const h = harness(quotas, quotas)
      spyOn((h.scheduler as any).deps, 'compatible').mockImplementation((_id: string, requested: string, effort?: AgentReasoningEffort) =>
        checkCodexModelCompatibility(source, requested, effort, now))
      const choice = await h.scheduler.choose({ model: 'new-model', effort: 'max', preferCachedUsage: true })
      expect(choice.selected).toBeNull()
      expect(choice.candidates[0]).toMatchObject({ state: 'miss', reason })
      expect(refresh).toHaveBeenCalledTimes(1)
      for (const elapsed of [1, 4 * 60_000, 5 * 60_000 - 1]) {
        now = NOW + elapsed
        const cached = await h.scheduler.choose({ model: 'new-model', effort: 'max', preferCachedUsage: true })
        expect(cached.selected).toBeNull()
        expect(cached.candidates[0]).toMatchObject({ state: 'miss', reason })
        expect(refresh).toHaveBeenCalledTimes(1)
      }
      // A later account rollout becomes visible on the first selection at expiry.
      refresh.mockImplementation(async () => {
        source.models = [model()]
        source.modelCatalogState = { status: 'ready', updatedAt: now }
      })
      now = NOW + 5 * 60_000
      expect((await h.scheduler.choose({ model: 'new-model', effort: 'max' })).selected?.account.id).toBe('secondary')
      expect(refresh).toHaveBeenCalledTimes(2)
    }
  })

  test('fresh missing-model catalogs are reused per account and manual refresh takes effect immediately', async () => {
    const fresh = catalog([])
    const stale = catalog([])
    fresh.source.modelCatalogState = { status: 'ready', updatedAt: NOW }
    stale.refresh.mockImplementation(async () => {
      stale.source.models = [model()]
      stale.source.modelCatalogState = { status: 'ready', updatedAt: NOW }
    })
    expect(await checkCodexModelCompatibility(fresh.source, 'new-model', 'max', NOW)).toBe('模型目录缺少 new-model')
    expect(await checkCodexModelCompatibility(stale.source, 'new-model', 'max', NOW)).toBeNull()
    expect(fresh.refresh).not.toHaveBeenCalled()
    expect(stale.refresh).toHaveBeenCalledTimes(1)
    // md refreshes the source directly, even during the automatic check's cache window.
    fresh.refresh.mockImplementation(async () => {
      fresh.source.models = [model()]
      fresh.source.modelCatalogState = { status: 'ready', updatedAt: NOW + 1 }
    })
    await fresh.source.refreshModels()
    expect(await checkCodexModelCompatibility(fresh.source, 'new-model', 'max', NOW + 1)).toBeNull()
    expect(fresh.refresh).toHaveBeenCalledTimes(1)
  })

  test('a query failure is not cached as an account rollout restriction', async () => {
    const { source, refresh } = catalog([])
    refresh.mockImplementationOnce(async () => {
      source.modelCatalogState = { status: 'failed', updatedAt: NOW, error: 'model/list timed out' }
    }).mockImplementation(async () => {
      source.models = [model()]
      source.modelCatalogState = { status: 'ready', updatedAt: NOW + 1 }
    })
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBe('模型目录查询失败：model/list timed out')
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW + 1)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test('a future catalog timestamp cannot indefinitely cache a missing model after a clock change', async () => {
    const { source, refresh } = catalog([])
    source.modelCatalogState = { status: 'ready', updatedAt: NOW + 60_000 }
    refresh.mockImplementation(async () => { source.models = [model()] })
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each(['throw', 'failed', 'disabled'] as const)('catalog %s preserves the real query error', async failure => {
    const { source, refresh } = catalog([])
    refresh.mockImplementation(async () => {
      source.models = [model()]
      if (failure === 'throw') throw new Error('account/read timed out')
      source.modelCatalogState = { status: failure, updatedAt: NOW, error: 'account/read timed out' }
      source.enabled = failure !== 'disabled'
    })
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBe('模型目录查询失败：account/read timed out')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('concurrent checks share one refresh and cannot borrow a different account catalog', async () => {
    const secondary = catalog([])
    const primary = catalog([model()])
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    secondary.refresh.mockImplementation(async () => { await pending })
    const checks = [checkCodexModelCompatibility(secondary.source, 'new-model', 'max', NOW),
      checkCodexModelCompatibility(secondary.source, 'new-model', 'high', NOW)]
    expect(await checkCodexModelCompatibility(primary.source, 'new-model', 'max', NOW)).toBeNull()
    expect(secondary.refresh).toHaveBeenCalledTimes(1)
    finish()
    expect(await Promise.all(checks)).toEqual(['模型目录缺少 new-model', '模型目录缺少 new-model'])
    expect(primary.refresh).not.toHaveBeenCalled()
  })

  test('a cold catalog is queried once and explicit model rejection keeps its reason', async () => {
    const { source, refresh } = catalog([])
    source.modelCatalogState = { status: 'idle', updatedAt: null }
    refresh.mockImplementation(async () => {
      source.models = [{ ...model(), unavailableReason: 'account restriction' }]
      source.modelCatalogState = { status: 'ready', updatedAt: NOW }
    })
    expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBe('new-model 不可用：account restriction')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('hidden catalog entries and explicit custom models remain valid without a refresh', async () => {
    for (const origin of ['upstream', 'custom'] as const) {
      const { source, refresh } = catalog([])
      source.modelSelection = { mode: 'catalog', modelIds: [], availableModels: [{ ...model(), origin }] }
      expect(await checkCodexModelCompatibility(source, 'new-model', 'max', NOW)).toBeNull()
      expect(refresh).not.toHaveBeenCalled()
    }
  })
})

test('only confirmed Codex usage failures trigger account replacement', () => {
  for (const error of [{ codexErrorInfo: 'usageLimitExceeded' }, { code: 'usage_limit_reached' },
    { message: "You've hit your usage limit. Try again later." }]) expect(isCodexQuotaError(error)).toBe(true)
  for (const error of [{ message: '429 Too Many Requests' }, { message: 'Selected model is at capacity' },
    { message: 'ETIMEDOUT' }, { message: 'Usage API failed' }, { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
    { message: '401 Unauthorized' }, null]) expect(isCodexQuotaError(error)).toBe(false)
})
