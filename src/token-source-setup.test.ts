import { expect, test } from 'bun:test'

test('Claude subscription commands persist a global switch and report auth, ReClaude and save failures', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { readFileSync, unlinkSync } from 'node:fs'
    import { join } from 'node:path'
    const { sentTexts } = await import('./src/feishu-test-mock')
    const nativeModels = await import('./src/token-source-models')
    let account = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
    let modelQueries = 0
    mock.module('./src/token-source-models', () => ({ ...nativeModels,
      fetchNativeClaudeModels: async options => {
        modelQueries++
        options.validateAccount(account)
        return [{ model: 'sonnet', display: 'Sonnet', efforts: ['high'], defaultEffort: 'high' }]
      },
    }))
    const { config, loadConfig } = await import('./src/config')
    const { CONFIG_FILE } = await import('./src/paths')
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    // 刷新仍走真实 registry；其他来源不访问网络或启动 Agent。
    for (const factory of registry.tokenSourceFactories()) {
      if (factory.kind === 'claude-subscription') continue
      const build = factory.build.bind(factory)
      factory.build = (...args) => {
        const source = build(...args)
        source.refreshModels = async () => {}
        return source
      }
    }
    buildTokenSourcesFromConfig()
    const { runCommand } = await import('./src/session-commands')
    const { onTokenSourceEnable } = await import('./src/token-source-setup')
    const { addTokenSource } = await import('./src/token-source-config')
    const session = { chatId: 'test-chat' }
    const claudeSettings = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
    const previousSettings = readFileSync(claudeSettings, 'utf8')
    const before = readFileSync(CONFIG_FILE, 'utf8')
    assert.equal(await runCommand(session, 'claude-sub'), true)
    assert.match(sentTexts.at(-1), /Lodestar 全局/)
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before)
    assert.equal(modelQueries, 0)
    assert.equal(await runCommand(session, 'claude-sub maybe'), true)
    assert.match(sentTexts.at(-1), /用法/)
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before)

    assert.equal(await runCommand(session, ' CLAUDE-SUB OFF '), true)
    assert.match(sentTexts.at(-1), /已禁用/)
    assert.equal(loadConfig().token_sources['claude-sub'].enabled, false)
    assert.equal(registry.getTokenSource('claude-sub').enabled, false)
    assert.equal(modelQueries, 0)
    await onTokenSourceEnable(session, 'claude-sub')
    assert.match(sentTexts.at(-1), /claude-sub on/)
    assert.doesNotMatch(sentTexts.at(-1), /claude auth login/)

    assert.equal(await runCommand(session, 'claude-sub on'), true)
    assert.equal(loadConfig().token_sources['claude-sub'].enabled, true)
    assert.equal(registry.getTokenSource('claude-sub').modelCatalogState.status, 'ready')
    assert.match(sentTexts.at(-1), /已启用/)
    assert.doesNotMatch(sentTexts.at(-1), /MISS/)
    account = {}
    await runCommand(session, 'claude-sub on')
    assert.match(sentTexts.at(-1), /MISS.*claude auth login/)
    assert.equal(loadConfig().token_sources['claude-sub'].enabled, true)
    assert.equal(registry.getTokenSource('claude-sub').enabled, false)

    await addTokenSource('reclaude', { auth: 'reclaude-login' })
    await runCommand(session, 'claude-sub on')
    assert.match(sentTexts.at(-1), /MISS.*ReClaude/)
    assert.equal(registry.getTokenSource('claude-sub').enabled, false)
    assert.equal(config.token_sources.glm.auth_token, 'test-token')
    assert.equal(readFileSync(claudeSettings, 'utf8'), previousSettings)
    unlinkSync(CONFIG_FILE)
    await runCommand(session, 'claude-sub off')
    assert.match(sentTexts.at(-1), /更新失败.*ENOENT/)
    assert.equal(config.token_sources['claude-sub'].enabled, true)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
