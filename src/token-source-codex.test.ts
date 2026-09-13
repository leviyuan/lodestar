import { expect, test } from 'bun:test'
import { codexUsageToUnified } from './token-source-codex'
import { consoleUnifiedUsageContent, consoleUsageElement, unifiedUsageSummary } from './cards/console'
import type { UsageSnapshot } from './usage'

test('hi preserves a Plus main full-window annotation through unified conversion', () => {
  const snapshot = codexUsageToUnified({ state: 'ok', weekly: null, fetchedAt: 1,
    fiveHour: { percent: 0, resetsAt: null, unreportedFull: true },
    defaultLimitId: 'codex', buckets: [{ limitId: 'codex', limitName: null, weekly: null,
      fiveHour: { percent: 0, resetsAt: null, unreportedFull: true } }],
  })
  expect(snapshot.windows[0]).toMatchObject({ label: '5h 窗口', percent: 0, resetsAt: null, unreportedFull: true })
  const content = consoleUnifiedUsageContent(snapshot)
  expect(content).toContain('满窗 · 0.15 份')
  expect(content).not.toContain('重置时间')
})

test('Codex quota displays only main windows, regardless of model-specific buckets', () => {
  const main = {
    limitId: 'codex', limitName: null,
    fiveHour: { percent: 0, resetsAt: null }, weekly: { percent: 24, resetsAt: null },
  }
  const snapshot: Extract<UsageSnapshot, { state: 'ok' }> = {
    state: 'ok', fiveHour: main.fiveHour, weekly: main.weekly, resetCredits: 2, fetchedAt: 1,
    defaultLimitId: 'codex', buckets: [
      { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
        fiveHour: { percent: 11, resetsAt: null }, weekly: { percent: 25, resetsAt: null } },
      main,
      { limitId: 'another-model', limitName: 'Another model', fiveHour: { percent: 99, resetsAt: null }, weekly: null },
    ],
  }
  for (const fiveHour of [main.fiveHour, null]) {
    const unified = codexUsageToUnified({ ...snapshot, fiveHour })
    expect(unified.windows.map(w => [w.kind, w.percent])).toEqual(fiveHour ? [['fiveHour', 0], ['weekly', 24]] : [['weekly', 24]])
    expect(unified.resetCredits).toBe(2)
    for (const content of [consoleUnifiedUsageContent(unified), unifiedUsageSummary(unified),
      JSON.stringify(consoleUsageElement({ sessionName: 'test', status: 'idle', unifiedUsage: unified }))]) {
      expect(content).toContain('24%')
      expect(content).not.toMatch(/Spark|5\.3|bengalfox|Another model|11%|25%|99%/)
    }
  }
  // Missing main quota stays MISS; auxiliary meters cannot stand in for it.
  const missing = codexUsageToUnified({ ...snapshot, fiveHour: null, weekly: null })
  expect(missing.windows).toEqual([])
  expect(unifiedUsageSummary(missing)).toBe('额度 MISS')
  expect(snapshot.buckets).toHaveLength(3)
  expect(snapshot.buckets![0].fiveHour?.percent).toBe(11)
})

test('native default auth works without auth.json while missing named credentials remain isolated', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let authorized = true
    const calls = []
    mock.module('./src/token-source-models', () => ({ fetchCodexModels: async id => {
      calls.push(id)
      if (!authorized) throw Object.assign(new Error('not authenticated'), { code: 'CODEX_AUTH_MISSING' })
      return [{ model: 'test-model', display: 'Test', efforts: ['high'], defaultEffort: 'high' }]
    } }))
    const { codexAccounts } = await import('./src/codex-accounts')
    const { tokenSourceFactories } = await import('./src/token-source')
    await import('./src/token-source-codex')
    const source = tokenSourceFactories().find(f => f.kind === 'codex-subscription').build({})
    await source.refreshModels()
    assert.equal(source.enabled, true)
    assert.equal(source.modelCatalogState.status, 'ready')
    const named = codexAccounts.ensure('not-logged-in')
    const extra = source.forAccount(named.id)
    await extra.refreshModels()
    assert.equal(extra.enabled, false)
    assert.equal(extra.models.length, 0)
    assert.deepEqual(calls, ['default'])
    authorized = false
    await source.refreshModels()
    assert.equal(source.enabled, false)
    assert.equal(source.modelCatalogState.status, 'disabled')
    assert.equal(source.models.length, 0)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
