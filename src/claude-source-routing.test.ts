import { expect, test } from 'bun:test'

test('Claude subscription is the only first-party source across panels, launch, footer and restart', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    import { mock, spyOn } from 'bun:test'
    const feishu = await import('./src/feishu-test-mock')
    const nativeModels = await import('./src/token-source-models')
    const nativeUsage = await import('./src/claude-usage')
    const snapshot = { state: 'ok', windows: [
      { kind: 'fiveHour', label: '5h 窗口', percent: 14, resetsAt: new Date(Date.now() + 3.1 * 3600_000) },
      { kind: 'weekly', label: '周额度', percent: 2, resetsAt: new Date(Date.now() + 4.2 * 86400_000) },
    ] }
    mock.module('./src/token-source-models', () => ({ ...nativeModels,
      fetchNativeClaudeModels: async options => {
        options?.validateAccount?.({ email: 'routing@example.test', organization: 'test-org', subscriptionType: 'max', apiProvider: 'firstParty' })
        return [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }]
      },
    }))
    mock.module('./src/claude-usage', () => ({ ...nativeUsage,
      fetchClaudeSubscriptionUsage: async () => snapshot,
    }))
    const { config } = await import('./src/config')
    config.token_sources = {}
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    const { refreshTokenSourceUsage } = await import('./src/token-source-cache')
    const { readAllAccountUsage } = await import('./src/account-usage')
    const { Session } = await import('./src/session')
    const feishuApi = await import('./src/feishu')
    const launch = await import('./src/agent-launch')
    let launches = 0
    const launchSpy = spyOn(launch, 'createAgentProcess').mockImplementation(() => {
      launches++
      return { process: {}, sourceRevision: null }
    })
    let writeFailure = false
    spyOn(feishuApi, 'bindSessionModelChecked').mockImplementation((name, provider, model, effort, tokenSourceId) => {
      if (writeFailure) throw new Error('routing write failed')
      feishu.modelSelections.set(name, { provider, model, effort, tokenSourceId })
    })
    buildTokenSourcesFromConfig()
    const source = registry.getTokenSource('claude-sub')
    await source.refreshModels()
    await refreshTokenSourceUsage(source)
    assert.equal(registry.getTokenSource('claude-native'), undefined)
    assert.ok(!registry.tokenSourceFactories().some(factory => factory.kind === 'claude-native'))

    const fresh = new Session('new-subscription', 'chat')
    assert.equal(fresh.selectedTokenSourceId, 'claude-sub')
    await fresh.showModelPanel()
    const panel = JSON.stringify(feishu.sentCards.at(-1))
    assert.ok(panel.includes('Claude Code 订阅'))
    assert.ok(!panel.includes('claude-native'))
    const claudeRows = (await readAllAccountUsage()).filter(row => row.id.startsWith('claude'))
    assert.deepEqual(claudeRows.map(row => row.id), ['claude:default'])
    assert.equal((await source.readUsage()).state, 'not_applicable')
    assert.equal(await fresh.footerUsageSuffix('claude', null, source.id, source.forAccount('default'), null, 'opus'),
      '  |  3.1h·14%·[4.2d·2%]')
    writeFailure = true
    assert.throws(() => fresh.spawnAgent(), /routing write failed/)
    assert.equal(launches, 0)
    assert.equal(feishu.modelSelections.has(fresh.sessionName), false)
    writeFailure = false
    fresh.spawnAgent()
    assert.equal(launches, 1)
    assert.equal(feishu.modelSelections.get(fresh.sessionName).tokenSourceId, 'claude-sub')
    feishu.resumeRefs.set(fresh.sessionName + ':claude', { provider: 'claude', sessionId: 'new-sub-resume', cwd: fresh.workDir })
    const reopened = new Session(fresh.sessionName, 'chat')
    assert.equal(reopened.selectedTokenSourceId, 'claude-sub')
    assert.equal(reopened.lastSessionId, 'new-sub-resume')
    reopened.dispose()
    fresh.dispose()

    config.token_sources = { 'claude-sub': { enabled: false } }
    buildTokenSourcesFromConfig()
    const disabled = new Session('new-disabled', 'chat')
    assert.equal(disabled.selectedTokenSourceId, 'claude-sub')
    assert.equal(registry.getTokenSource('claude-native'), undefined)
    await disabled.onUserMessage('do not start', [], 'user', 'disabled-message')
    assert.equal(launches, 1)
    assert.ok(feishu.sentTexts.at(-1).includes('消息未送给 Agent'))
    disabled.dispose()

    config.token_sources = { 'claude-native': { enabled: true }, 'claude-sub': { default: true } }
    buildTokenSourcesFromConfig()
    assert.equal(registry.getTokenSource('claude-native'), undefined)
    const preferred = new Session('new-preferred', 'chat')
    assert.equal(preferred.selectedTokenSourceId, 'claude-sub')
    preferred.dispose()
    config.token_sources = { glm: { auth_token: 'test-token', model: 'GLM-5.2' } }
    buildTokenSourcesFromConfig()
    feishu.modelSelections.set('old-glm', { provider: 'claude', model: 'claude:glm', effort: 'max' })
    const glm = new Session('old-glm', 'chat')
    assert.equal(glm.selectedTokenSourceId, 'glm')
    assert.equal(glm.selectedModel, 'GLM-5.2')
    glm.dispose()
    config.token_sources = { 'claude-native': { enabled: true }, 'claude-sub': { enabled: false },
      deepseek: { api_key: 'test-key' } }
    buildTokenSourcesFromConfig()
    feishu.modelSelections.set('old-deepseek', { provider: 'claude', model: 'deepseek-v4-pro', effort: 'high' })
    const deepseek = new Session('old-deepseek', 'chat')
    assert.equal(deepseek.selectedTokenSourceId, 'deepseek')
    deepseek.dispose()
    launchSpy.mockRestore()
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
