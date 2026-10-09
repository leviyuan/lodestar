import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Packy MD visibility edits persist increments and keep following latest releases after rebuilds', () => {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-packy-selection-'))
  const file = join(root, 'config.toml')
  writeFileSync(file, '[feishu]\napp_id = "test"\napp_secret = "test"\n[token_source.packy]\napi_key = "test-key"\nmodel = "MiniMax-M3"\n', { mode: 0o600 })
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, name))
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const registry = await import(${modulePath('token-source.ts')})
    await import(${modulePath('token-source-packy.ts')})
    const { config, loadConfig } = await import(${modulePath('config.ts')})
    const { cachedTokenSource, disposeCachedTokenSource } = await import(${modulePath('token-source-cache.ts')})
    const { withModelVisibility } = await import(${modulePath('token-source-visibility.ts')})
    const factory = registry.tokenSourceFactories().find(f => f.kind === 'packy')
    const source = () => registry.getTokenSource('packy')
    const rebuild = () => {
      const cfg = config.token_sources.packy
      const previous = source()
      const next = cachedTokenSource(() => withModelVisibility(factory.build(cfg), cfg), cfg, 'packy-fixture', JSON.stringify(cfg), previous)
      registry.resetTokenSourceRegistry()
      registry.registerTokenSource(next)
      if (previous && previous !== next) disposeCachedTokenSource(previous)
      return 1
    }
    mock.module(${modulePath('token-source-builtins.ts')}, () => ({ buildTokenSourcesFromConfig: rebuild }))
    let opus = 'claude-opus-5-5', minimax = 'MiniMax-M3', requests = 0
    globalThis.fetch = async () => {
      requests++
      return Response.json({ data: [...new Set(['MiniMax-M3', minimax, 'claude-opus-5', opus, 'extra-a', 'extra-b'])].map(id => ({ id, supported_endpoint_types: ['anthropic'] })) })
    }
    const { editTokenSourceModels, addTokenSource } = await import(${modulePath('token-source-config.ts')})
    rebuild()
    await source().refreshModels()
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus])
    await Promise.all([editTokenSourceModels('packy', 'extra-a', 'add'), editTokenSourceModels('packy', 'extra-b', 'add')])
    assert.equal(requests, 1)
    assert.equal(config.token_sources.packy.models, undefined)
    assert.equal(loadConfig().token_sources.packy.shown_models, 'extra-a,extra-b')
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus, 'extra-a', 'extra-b'])
    await editTokenSourceModels('packy', 'claude-opus-5', 'add')
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus, 'extra-a', 'extra-b', 'claude-opus-5'])
    await editTokenSourceModels('packy', 'claude-opus-5', 'remove')
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus, 'extra-a', 'extra-b'])
    opus = 'claude-opus-5-10'
    await source().refreshModels()
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus, 'extra-a', 'extra-b'])
    assert.equal(source().defaultModel, 'MiniMax-M3')
    assert.equal(source().spawnEnv({}, 'claude-opus-5').ANTHROPIC_MODEL, 'claude-opus-5')
    await editTokenSourceModels('packy', 'claude-opus-5', 'add')
    await editTokenSourceModels('packy', opus, 'remove')
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', 'extra-a', 'extra-b', 'claude-opus-5'])
    await source().refreshModels()
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', 'extra-a', 'extra-b', 'claude-opus-5'])
    await editTokenSourceModels('packy', 'claude-opus-5', 'remove')
    opus = 'claude-opus-6'
    await source().refreshModels()
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', 'extra-a', 'extra-b'])
    assert.equal(loadConfig().token_sources.packy.hidden_models, 'family:opus,claude-opus-5-10,claude-opus-5')
    await editTokenSourceModels('packy', opus, 'add')
    assert.equal(config.token_sources.packy.hidden_models, 'claude-opus-5-10,claude-opus-5')
    assert.equal(config.token_sources.packy.shown_models, 'extra-a,extra-b')
    assert.deepEqual(source().modelSelection.modelIds, ['MiniMax-M3', opus, 'extra-a', 'extra-b'])
    for (const id of [...source().modelSelection.modelIds]) await editTokenSourceModels('packy', id, 'remove')
    opus = 'claude-opus-7'
    minimax = 'MiniMax-M4'
    await source().refreshModels()
    assert.equal(source().models.length, 0)
    assert.equal(config.token_sources.packy.models, undefined)
    assert.equal(source().spawnEnv({}).ANTHROPIC_MODEL, 'MiniMax-M3')
    await addTokenSource('packy', { models: 'extra-b', hidden_models: '' })
    await editTokenSourceModels('packy', 'extra-b', 'remove')
    assert.equal(loadConfig().token_sources.packy.models, '')
    await source().refreshModels()
    assert.equal(source().models.length, 0)
    disposeCachedTokenSource(source())
  `
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: file, LODESTAR_DATA_DIR: join(root, 'state') }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
