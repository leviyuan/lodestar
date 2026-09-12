import { expect, test } from 'bun:test'
import { codexBucketsToUnified } from './token-source-codex'
import { consoleUnifiedUsageContent } from './cards/console'

test('hi preserves a Plus full-window annotation through unified bucket conversion', () => {
  const windows = codexBucketsToUnified({ state: 'ok', fiveHour: null, weekly: null, fetchedAt: 1,
    defaultLimitId: 'codex', buckets: [{ limitId: 'codex', limitName: null, weekly: null,
      fiveHour: { percent: 0, resetsAt: null, unreportedFull: true } }],
  })!
  expect(windows[0]).toMatchObject({ label: '默认配额 5h', percent: 0, resetsAt: null, unreportedFull: true })
  const content = consoleUnifiedUsageContent({ state: 'ok', windows })
  expect(content).toContain('满窗 · 0.15 份')
  expect(content).not.toContain('重置')
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
