import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 配置模块在 import 时读取文件；子进程同时隔离模块 mock 和真实配置。
function runConfigUpdate(work: string): void {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-source-config-'))
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, [
    '[feishu]',
    'app_id = "test"',
    'app_secret = "test"',
    '[token_source.glm]',
    'slots = "opus=GLM-5.3[1m],sonnet=GLM-5.3[1m]"',
    'auth_token = "old-token"',
    '[notify]',
    'port = 9876',
    '',
  ].join('\n'))
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { readFileSync, rmSync } from 'node:fs'
    let rebuilds = 0
    let refreshes = 0
    let releaseRefresh, rejectRefresh
    const refresh = new Promise((resolve, reject) => { releaseRefresh = resolve; rejectRefresh = reject })
    mock.module(${JSON.stringify(join(import.meta.dir, 'token-source-builtins.ts'))}, () => ({
      buildTokenSourcesFromConfig: () => { rebuilds++ },
    }))
    mock.module(${JSON.stringify(join(import.meta.dir, 'token-source.ts'))}, () => ({
      refreshAllTokenSourceModels: () => { refreshes++; return refresh },
      getTokenSourceForAccount: () => undefined,
    }))
    const { addTokenSource, configureTokenSource, saveTokenSourceConfigs, TokenSourceSetupError } = await import(${JSON.stringify(join(import.meta.dir, 'token-source-config.ts'))})
    const { config } = await import(${JSON.stringify(join(import.meta.dir, 'config.ts'))})
    const configFile = ${JSON.stringify(configFile)}
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: configFile },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('updates credentials without losing slots or adjacent sections and waits for one catalog refresh', () => {
  runConfigUpdate(`
    let completed = false
    const pending = addTokenSource('glm', { auth_token: 'new-token' }).then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    assert.equal(rebuilds, 1)
    assert.equal(refreshes, 1)
    const saved = readFileSync(configFile, 'utf8')
    assert.equal((saved.match(/\\[token_source\\.glm\\]/g) || []).length, 1)
    assert.ok(saved.includes('slots = "opus=GLM-5.3[1m],sonnet=GLM-5.3[1m]"'))
    assert.ok(saved.includes('[notify]\\nport = 9876'))
    assert.ok(!saved.includes('old-token'))
    assert.equal(config.token_sources.glm.auth_token, 'new-token')
    releaseRefresh()
    await pending
    assert.equal(completed, true)
    assert.equal(refreshes, 1)
  `)
})

test('batch migration saves both Packy keys and the OpenRouter shortlist without duplicating shared secrets', () => {
  runConfigUpdate(`
    saveTokenSourceConfigs({
      packy: { api_key: 'primary-private-test', model: 'MiniMax-M3', management_token: 'balance-private-test', management_user_id: '123', management_url: 'https://www.packyapi.ai' },
      'packy-secondary': { api_key: 'secondary-private-test', model: 'qwen3.8-max-0902', billing_source: 'packy' },
      'packy-codex': { model: 'kimi-k3', effort: 'medium' },
      openrouter: { models: 'tencent/hy4-preview,xiaomi/mimo-v2.5-pro,meta/muse-spark-1.2,bytedance-seed/seed-2-1-turbo,meituan/longcat-2.0' },
    })
    const saved = readFileSync(configFile, 'utf8')
    assert.equal(saved.split('primary-private-test').length - 1, 1)
    assert.equal(saved.split('secondary-private-test').length - 1, 1)
    assert.equal(saved.split('balance-private-test').length - 1, 1)
    assert.ok(saved.includes('[notify]\\nport = 9876'))
    assert.ok(saved.includes('auth_token = "old-token"'))
    const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, 'config.ts'))})
    const result = loadConfig().token_sources
    assert.equal(result.openrouter.models.split(',').length, 5)
    assert.equal(result['packy-codex'].api_key, undefined)
    assert.equal(result['packy-codex'].model, 'kimi-k3')
    assert.equal(result['packy-codex'].management_token, undefined)
    assert.equal(result['packy-secondary'].management_token, undefined)
    assert.equal(result['packy-secondary'].billing_source, 'packy')
    assert.equal(result.packy.management_user_id, '123')
    assert.equal(result.packy.management_url, 'https://www.packyapi.ai')
    assert.equal(rebuilds, 0)
    assert.equal(refreshes, 0)
  `)
})

test('invalid billing references fail before atomic save', () => {
  runConfigUpdate(`
    const before = readFileSync(configFile, 'utf8')
    assert.throws(() => saveTokenSourceConfigs({ packy: { billing_source: 'openrouter' } }), /不存在/)
    assert.equal(readFileSync(configFile, 'utf8'), before)
    assert.throws(() => saveTokenSourceConfigs({
      packy: { billing_source: 'packy-secondary' }, 'packy-secondary': { billing_source: 'packy' },
    }), /循环/)
    assert.equal(readFileSync(configFile, 'utf8'), before)
  `)
})

test('credential validation failure never writes, reloads or clears the active catalog', () => {
  runConfigUpdate(`
    const before = readFileSync(configFile, 'utf8')
    const previous = config.token_sources.glm
    const def = { configSectionId: 'glm', setup: { validate: async candidate => {
      assert.equal(candidate.auth_token, 'invalid-token')
      assert.equal(candidate.slots, previous.slots)
      throw new Error('HTTP 401 invalid key')
    } } }
    await assert.rejects(configureTokenSource(def, { auth_token: 'invalid-token' }), error => {
      assert.ok(error instanceof TokenSourceSetupError)
      assert.equal(error.saved, false)
      return /HTTP 401/.test(error.message)
    })
    assert.equal(readFileSync(configFile, 'utf8'), before)
    assert.equal(config.token_sources.glm, previous)
    assert.equal(rebuilds, 0)
    assert.equal(refreshes, 0)
  `)
})

test('queued credential checks complete before writing and allow retry after rejection', () => {
  runConfigUpdate(`
    const before = readFileSync(configFile, 'utf8')
    const seen = []
    let rejectValidation
    const validation = new Promise((_, reject) => { rejectValidation = reject })
    const def = { configSectionId: 'glm', setup: { validate: async candidate => {
      seen.push(candidate.auth_token)
      if (candidate.auth_token === 'invalid-token') await validation
    } } }
    const first = configureTokenSource(def, { auth_token: 'invalid-token' })
    const rejected = assert.rejects(first, /invalid key/)
    const next = configureTokenSource(def, { auth_token: 'valid-token' })
    await Promise.resolve()
    assert.deepEqual(seen, ['invalid-token'])
    assert.equal(readFileSync(configFile, 'utf8'), before)
    rejectValidation(new Error('invalid key'))
    await rejected
    releaseRefresh()
    await next
    assert.deepEqual(seen, ['invalid-token', 'valid-token'])
    assert.equal(config.token_sources.glm.auth_token, 'valid-token')
    assert.equal(rebuilds, 1)
    assert.equal(refreshes, 1)
  `)
})

test('post-save reload failures keep the fact that credentials were already saved', () => {
  runConfigUpdate(`
    const def = { configSectionId: 'glm', setup: { validate: async () => {} } }
    const pending = configureTokenSource(def, { auth_token: 'valid-token' })
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.saved, true)
      return /refresh failed/.test(error.message)
    })
    await Promise.resolve()
    await Promise.resolve()
    rejectRefresh(new Error('refresh failed'))
    await rejected
    assert.equal(config.token_sources.glm.auth_token, 'valid-token')
    assert.ok(readFileSync(configFile, 'utf8').includes('valid-token'))
  `)
})

test('does not rebuild or refresh when reading the configuration fails', () => {
  runConfigUpdate(`
    rmSync(configFile)
    await assert.rejects(addTokenSource('glm', { auth_token: 'new-token' }), /ENOENT/)
    assert.equal(rebuilds, 0)
    assert.equal(refreshes, 0)
  `)
})

test('persists the Claude subscription switch across later model edits and preserves other sources', () => {
  runConfigUpdate(`
    releaseRefresh()
    await addTokenSource('claude-sub', { enabled: false, model: 'sonnet', hidden_models: 'opus' })
    await addTokenSource('claude-sub', { effort: 'high' })
    assert.deepEqual(config.token_sources['claude-sub'], { enabled: false, model: 'sonnet', hidden_models: 'opus', effort: 'high' })
    assert.ok(readFileSync(configFile, 'utf8').includes('enabled = false'))
    await addTokenSource('claude-sub', { enabled: true })
    assert.deepEqual(config.token_sources['claude-sub'], { enabled: true, model: 'sonnet', hidden_models: 'opus', effort: 'high' })
    assert.equal(config.token_sources.glm.auth_token, 'old-token')
    assert.equal(config.token_sources.glm.slots, 'opus=GLM-5.3[1m],sonnet=GLM-5.3[1m]')
  `)
})

test('persists an OpenRouter account and reloads its catalog settings', () => {
  runConfigUpdate(`
    releaseRefresh()
    await addTokenSource('openrouter', { agent: 'claude', api_key: 'openrouter-test-key',
      model: 'anthropic/test-model', effort: 'medium', models: 'anthropic/test-model' })
    assert.deepEqual(config.token_sources.openrouter, { agent: 'claude', api_key: 'openrouter-test-key',
      model: 'anthropic/test-model', effort: 'medium', models: 'anthropic/test-model' })
    assert.equal(rebuilds, 1)
    assert.equal(refreshes, 1)
    assert.ok(readFileSync(configFile, 'utf8').includes('[token_source.glm]'))
  `)
})
