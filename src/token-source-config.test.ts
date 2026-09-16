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
    let releaseRefresh
    const refresh = new Promise(resolve => { releaseRefresh = resolve })
    mock.module(${JSON.stringify(join(import.meta.dir, 'token-source-builtins.ts'))}, () => ({
      buildTokenSourcesFromConfig: () => { rebuilds++ },
    }))
    mock.module(${JSON.stringify(join(import.meta.dir, 'token-source.ts'))}, () => ({
      refreshAllTokenSourceModels: () => { refreshes++; return refresh },
      getTokenSourceForAccount: () => undefined,
    }))
    const { addTokenSource } = await import(${JSON.stringify(join(import.meta.dir, 'token-source-config.ts'))})
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
