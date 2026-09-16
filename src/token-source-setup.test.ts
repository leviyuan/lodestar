import { expect, test } from 'bun:test'

test('all API key setup commands validate before saving and report post-save runtime failures separately', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { readFileSync } from 'node:fs'
    const { sentTexts } = await import('./src/feishu-test-mock')
    const { config } = await import('./src/config')
    const { CONFIG_FILE } = await import('./src/paths')
    const registry = await import('./src/token-source')
    const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
    let rebuilds = 0, unavailable = false
    for (const factory of registry.tokenSourceFactories()) {
      const build = factory.build.bind(factory)
      factory.build = (...args) => {
        rebuilds++
        const source = build(...args)
        source.refreshModels = async () => {
          source.modelCatalogState = { status: unavailable && source.id === 'dsh-glm' ? 'failed' : 'ready', updatedAt: 0,
            ...(unavailable && source.id === 'dsh-glm' ? { error: 'dsh runtime 未安装，请运行 lodestar-update --agents-only' } : {}) }
        }
        return source
      }
    }
    buildTokenSourcesFromConfig()
    const { runCommand } = await import('./src/session-commands')
    const { onTokenSourceEnable } = await import('./src/token-source-setup')
    const session = { chatId: 'test-chat' }
    const sources = ['glm', 'deepseek', 'openrouter', 'deepseek-harness', 'dsh-glm']
    let valid = false, requests = []
    globalThis.fetch = async (url, init) => {
      requests.push(String(url))
      const key = new Headers(init.headers).get('Authorization').replace('Bearer ', '')
      if (!valid) return Response.json({ code: 401, success: false, msg: 'invalid token ' + key })
      if (String(url).includes('openrouter')) return Response.json({ data: [{ id: 'anthropic/test-model', name: 'Test Model',
        architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] }] })
      return Response.json({ data: [{ id: 'test-model', display_name: 'Test Model' }] })
    }
    for (const id of sources) {
      const before = readFileSync(CONFIG_FILE, 'utf8')
      const old = registry.getTokenSource(id)
      const beforeRebuild = rebuilds
      assert.equal(await runCommand(session, id + '-setup private-invalid-key'), true)
      assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before)
      assert.equal(registry.getTokenSource(id), old)
      assert.equal(rebuilds, beforeRebuild)
      assert.match(sentTexts.at(-1), /未保存.*认证失败/)
      assert.match(sentTexts.at(-1), /code=401/)
      assert.doesNotMatch(sentTexts.at(-1), /private-invalid-key/)
    }
    assert.equal(requests.length, sources.length)
    assert.ok(requests.includes('https://api.deepseek.com/models'))
    assert.ok(requests.includes('https://open.bigmodel.cn/api/coding/paas/v4/models'))

    const beforeBadArgs = readFileSync(CONFIG_FILE, 'utf8')
    requests = []
    for (const command of ['glm-setup', 'glm-setup https://open.bigmodel.cn/api/anthropic',
      'glm-setup https://wrong.example/api private-key', 'glm-setup https://open.bigmodel.cn/api/coding/paas/v4 private-key',
      'glm-setup https://open.bigmodel.cn/api/anthropic key extra', 'deepseek-setup one two three']) {
      assert.equal(await runCommand(session, command), true)
    }
    assert.equal(requests.length, 0)
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), beforeBadArgs)

    valid = true
    for (const id of sources) {
      assert.equal(await runCommand(session, id + '-setup private-valid-key'), true)
      assert.match(sentTexts.at(-1), /校验通过，配置已保存/)
      assert.equal(config.token_sources[id][id === 'glm' ? 'auth_token' : 'api_key'], 'private-valid-key')
    }
    assert.equal(await runCommand(session, 'glm-setup https://api.z.ai/api/anthropic international-test-key'), true)
    assert.equal(config.token_sources.glm.base_url, 'https://api.z.ai/api/anthropic')
    assert.ok(requests.includes('https://api.z.ai/api/anthropic/v1/models'))

    unavailable = true
    await runCommand(session, 'dsh-glm-setup valid-without-runtime')
    assert.equal(config.token_sources['dsh-glm'].api_key, 'valid-without-runtime')
    assert.match(sentTexts.at(-1), /校验通过、配置已保存，但暂不可用.*runtime 未安装/)
    assert.doesNotMatch(sentTexts.at(-1), /认证失败|未保存/)
    await onTokenSourceEnable(session, 'dsh-glm')
    assert.match(sentTexts.at(-1), /当前不可用.*runtime 未安装/)
    assert.match(sentTexts.at(-1), /dsh-glm-setup/)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('Claude subscription commands persist a global switch and report auth and save failures', () => {
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
