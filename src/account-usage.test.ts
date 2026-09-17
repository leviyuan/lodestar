import { expect, test } from 'bun:test'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('hi aggregates all accounts, merges Agent views and reuses its snapshot without extending freshness', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    let now = Date.now(), codexReads = 0
    Date.now = () => now
    const mainUsage = () => ({ state: 'ok', fetchedAt: now, weekly: { percent: 20, resetsAt: null }, fiveHour: null, resetCredits: 0 })
    mock.module('./src/codex-account-usage', () => ({ readAllCodexUsage: async () => {
      codexReads++
      return { entries: [
        { account: { id: 'default', name: '默认' }, usage: mainUsage() },
        { account: { id: 'second', name: '工作' }, usage: mainUsage() },
        { account: { id: 'alias', name: '重复备注' }, duplicateOf: '默认', usage: mainUsage() },
      ] }
    } }))
    const registry = await import('./src/token-source')
    const { codexAccounts } = await import('./src/codex-accounts')
    codexAccounts.list = () => [{ id: 'default', name: '默认' }, { id: 'second', name: '工作' }]
    const calls = {}
    const source = (id, kind = id, enabled = true) => ({ id, kind, enabled, display: id,
      agent: 'claude', models: [], defaultModel: '', refreshModels: async () => {}, spawnEnv: env => env,
      resolveSpawnModel: model => model, readUsage: async () => {
        calls[id] = (calls[id] ?? 0) + 1
        if (id === 'claude-sub') throw new Error('subscription unavailable')
        return { state: 'ok', kind: 'balance', windows: [], balance: { currency: 'USD', remaining: 3 }, fetchedAt: now }
      },
    })
    registry.resetTokenSourceRegistry()
    for (const item of [source('codex-sub', 'codex-subscription', false), source('glm'), source('dsh-glm'),
      source('deepseek'), source('deepseek-harness'), source('claude-sub', 'claude-subscription'), source('openrouter'), source('disabled', 'disabled', false)]) registry.registerTokenSource(item)
    const { readAllAccountUsage, peekAllAccountUsage } = await import('./src/account-usage')
    assert.equal(peekAllAccountUsage(), undefined)
    const [first, simultaneous] = await Promise.all([readAllAccountUsage(), readAllAccountUsage()])
    assert.equal(first, simultaneous)
    assert.deepEqual(first.map(row => row.label), ['Codex·默认', 'Codex·工作', 'Claude 订阅', 'GLM Coding Plan', 'DeepSeek', 'openrouter'])
    assert.equal(first.find(row => row.id === 'claude-sub').usage.state, 'network')
    assert.equal(calls['dsh-glm'], undefined)
    assert.equal(calls['deepseek-harness'], undefined)
    assert.equal(calls.disabled, undefined)
    assert.equal(codexReads, 1)
    now += 59_999
    assert.equal(await readAllAccountUsage(), first)
    assert.equal(peekAllAccountUsage(), first)
    now++
    assert.equal(peekAllAccountUsage(), undefined)
    assert.notEqual(await readAllAccountUsage(), first)
    assert.equal(codexReads, 2)
    const { invalidateCodexUsage } = await import('./src/usage')
    invalidateCodexUsage('default')
    assert.equal(peekAllAccountUsage(), undefined)
  `)
})

test('shared DeepSeek and GLM configuration makes both Agents read the same quota once', () => {
  isolated(`
    import assert from 'node:assert/strict'
    const { config } = await import('./src/config')
    config.token_sources = {
      glm: { auth_token: 'glm-shared-test', base_url: 'https://api.z.ai/api/anthropic', model: 'GLM-5.3' },
      deepseek: { api_key: 'deepseek-shared-test', model: 'deepseek-v4-pro' },
      'dsh-glm': { model: 'glm-5.3', effort: 'high' },
      'deepseek-harness': { model: 'deepseek-v4-flash', effort: 'xhigh' },
    }
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('deepseek-harness').enabled, true)
    assert.equal(registry.getTokenSource('dsh-glm').enabled, true)
    const claudeDeepseek = registry.getTokenSource('deepseek').spawnEnv({})
    const harnessDeepseek = registry.getTokenSource('deepseek-harness').spawnEnv({})
    assert.equal(claudeDeepseek.ANTHROPIC_API_KEY, harnessDeepseek.DEEPSEEK_API_KEY)
    assert.equal(claudeDeepseek.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
    assert.equal(harnessDeepseek.DEEPSEEK_BASE_URL, 'https://api.deepseek.com')
    assert.equal(registry.getTokenSource('glm').spawnEnv({}).ANTHROPIC_AUTH_TOKEN,
      registry.getTokenSource('dsh-glm').spawnEnv({}).LODESTAR_DSH_GLM_API_KEY)
    const requests = []
    globalThis.fetch = async url => {
      requests.push(String(url))
      if (String(url).includes('/quota/limit')) return Response.json({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: Date.now() + 3600_000 },
      ] } })
      return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] })
    }
    const ids = ['glm', 'dsh-glm', 'deepseek', 'deepseek-harness']
    const results = await Promise.all(ids.map(id => registry.getTokenSource(id).readUsage()))
    assert.ok(results.every(usage => usage.state === 'ok'))
    assert.equal(requests.length, 2)
    assert.equal(requests.filter(url => url.includes('/quota/limit')).length, 1)
    assert.equal(requests.filter(url => url.includes('/user/balance')).length, 1)
    buildTokenSourcesFromConfig()
    await Promise.all(ids.map(id => registry.getTokenSource(id).readUsage()))
    assert.equal(requests.length, 2)
    config.token_sources.deepseek.api_key = 'new-shared-account'
    buildTokenSourcesFromConfig()
    await Promise.all(['deepseek', 'deepseek-harness'].map(id => registry.getTokenSource(id).readUsage()))
    assert.equal(requests.length, 3)
  `)
})

test('Packy model tokens and both Agents use one wallet row and identical real balance footers', () => {
  isolated(`
    import assert from 'node:assert/strict'
    const registry = await import('./src/token-source')
    await import('./src/token-source-packy')
    const { sharedTokenSourceConfigs } = await import('./src/token-source-accounts')
    const { unifiedUsageSummary } = await import('./src/cards/console')
    const { compactAccountUsage } = await import('./src/cards/account-usage')
    const cfg = sharedTokenSourceConfigs({
      packy: { api_key: 'model-one', management_token: 'system-account', management_user_id: '123' },
      'packy-secondary': { api_key: 'model-two', billing_source: 'packy' },
    })
    registry.resetTokenSourceRegistry()
    for (const id of ['packy', 'packy-secondary', 'packy-codex']) {
      registry.registerTokenSource(registry.tokenSourceFactories().find(def => def.kind === id).build(cfg[id]))
    }
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push(String(url))
      if (String(url).endsWith('/api/status')) return Response.json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer system-account')
      return Response.json({ success: true, data: { id: 123, quota: 49834851 } })
    }
    const { readAllAccountUsage } = await import('./src/account-usage')
    const [rows, ...footers] = await Promise.all([readAllAccountUsage(), ...registry.listTokenSources().map(source => source.readUsage())])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].label, 'PackyAPI')
    assert.equal(compactAccountUsage(rows[0].usage), '余额 $ 99.67')
    assert.ok(footers.every(usage => unifiedUsageSummary(usage) === '余额 $99.67'))
    assert.equal(requests.length, 2)
  `)
})
