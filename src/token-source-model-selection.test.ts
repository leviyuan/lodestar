import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 真配置读写和真实 source factory，只在 HTTP 与其他来源构建边界隔离。 */
function runSelectionTest(work: string): void {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-model-selection-'))
  const file = join(root, 'config.toml')
  writeFileSync(file, '[feishu]\napp_id = "test"\napp_secret = "test"\n[token_source.openrouter]\napi_key = "test-key"\n', { mode: 0o600 })
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, name))
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { readFileSync } from 'node:fs'
    const registry = await import(${modulePath('token-source.ts')})
    await import(${modulePath('token-source-openrouter.ts')})
    const { OPENROUTER_DEFAULT_MODELS } = await import(${modulePath('openrouter-defaults.ts')})
    const { config } = await import(${modulePath('config.ts')})
    const factory = registry.tokenSourceFactories().find(f => f.kind === 'openrouter')
    const { cachedTokenSource } = await import(${modulePath('token-source-cache.ts')})
    const { withModelVisibility } = await import(${modulePath('token-source-visibility.ts')})
    const rebuild = () => {
      const cfg = config.token_sources.openrouter
      const previous = registry.getTokenSource('openrouter')
      const source = cachedTokenSource(() => withModelVisibility(factory.build(cfg), cfg), cfg, 'fixture-openrouter', JSON.stringify(cfg), previous)
      registry.resetTokenSourceRegistry()
      registry.registerTokenSource(source)
      return 1
    }
    mock.module(${modulePath('token-source-builtins.ts')}, () => ({ buildTokenSourcesFromConfig: rebuild }))
    const defaults = OPENROUTER_DEFAULT_MODELS.map(entry => entry.model)
    let httpFailure = false
    globalThis.fetch = async () => httpFailure ? Response.json({ error: { message: 'catalog down' } }, { status: 503 })
      : Response.json({ data: [...defaults, 'qwen/extra-a', 'google/extra-b', 'openai/excluded'].map(id => ({
        id, name: id, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'],
        reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
      })) })
    const { addTokenSource, editTokenSourceModels } = await import(${modulePath('token-source-config.ts')})
    rebuild()
    await registry.refreshAllTokenSourceModels()
    const source = () => registry.getTokenSource('openrouter')
    ${work}
  `
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: file, LODESTAR_DATA_DIR: join(root, 'state') }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('concurrent model additions preserve all defaults and both new selections', () => {
  runSelectionTest(`
    await Promise.all([
      editTokenSourceModels('openrouter', 'qwen/extra-a', 'add'),
      editTokenSourceModels('openrouter', 'google/extra-b', 'add'),
    ])
    assert.deepEqual(source().modelSelection.modelIds, [...defaults, 'qwen/extra-a', 'google/extra-b'])
    assert.equal(config.token_sources.openrouter.api_key, 'test-key')
    await assert.rejects(editTokenSourceModels('openrouter', 'openai/excluded', 'add'), /允许添加/)
    await assert.rejects(editTokenSourceModels('openrouter', 'unknown/model', 'add'), /允许添加/)
    await assert.rejects(editTokenSourceModels('openrouter', 'qwen/extra-a', 'add'), /已在/)
    assert.equal(source().models.length, defaults.length + 2)
  `)
})

test('hiding the last model persists an empty list while keeping defaults and slots usable', () => {
  runSelectionTest(`
    await addTokenSource('openrouter', { models: 'qwen/extra-a', model: 'qwen/extra-a', effort: 'high', slots: 'haiku=qwen/extra-a', default: false })
    await editTokenSourceModels('openrouter', 'qwen/extra-a', 'remove')
    assert.equal(config.token_sources.openrouter.models, '')
    assert.equal(config.token_sources.openrouter.model, 'qwen/extra-a')
    assert.equal(config.token_sources.openrouter.effort, 'high')
    assert.equal(config.token_sources.openrouter.slots, 'haiku=qwen/extra-a')
    assert.equal(config.token_sources.openrouter.default, false)
    assert.equal(source().models.length, 0)
    assert.ok(source().modelSelection.availableModels.length > 0)
    assert.equal(source().modelEnvironmentRevision('qwen/extra-a'), 'effort-level')
    assert.equal(registry.tokenSourceRuntimeModel(source(), 'qwen/extra-a').defaultEffort, 'high')
    assert.equal(source().spawnEnv({}).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen/extra-a')
    await addTokenSource('openrouter', { api_key: 'rotated-test-key' })
    assert.equal(source().models.length, 0)
    assert.equal(config.token_sources.openrouter.models, '')
    await editTokenSourceModels('openrouter', 'google/extra-b', 'add')
    assert.deepEqual(source().modelSelection.modelIds, ['google/extra-b'])
    assert.equal(config.token_sources.openrouter.api_key, 'rotated-test-key')
  `)
})

test('a local edit uses cached models while background refresh errors remain visible', () => {
  runSelectionTest(`
    httpFailure = true
    await editTokenSourceModels('openrouter', 'qwen/extra-a', 'add')
    await assert.rejects(source().refreshModels(), /catalog down/)
    assert.ok(config.token_sources.openrouter.models.includes('qwen/extra-a'))
    assert.equal(source().modelCatalogState.status, 'ready')
    assert.ok(source().modelCatalogState.error.includes('catalog down'))
    assert.equal(source().models.length, defaults.length + 1)
    httpFailure = false
    await source().refreshModels()
    assert.equal(source().models.length, defaults.length + 1)
  `)
})

test('hiding a context-annotated model preserves its configured route and metadata', () => {
  runSelectionTest(`
    await addTokenSource('openrouter', { models: 'qwen/extra-a[1m]', model: 'qwen/extra-a[1m]', effort: 'high', slots: 'haiku=qwen/extra-a' })
    await editTokenSourceModels('openrouter', 'qwen/extra-a[1m]', 'remove')
    assert.equal(config.token_sources.openrouter.slots, 'haiku=qwen/extra-a')
    assert.equal(config.token_sources.openrouter.model, 'qwen/extra-a[1m]')
    assert.equal(registry.tokenSourceRuntimeModel(source(), 'qwen/extra-a[1m]').defaultEffort, 'high')
    assert.deepEqual(source().modelSelection.modelIds, [])
  `)
})

test('the MD panel adds and removes models, rejects forged actions and keeps an empty list editable', () => {
  runSelectionTest(`
    await import(${JSON.stringify(join(import.meta.dir, 'feishu-test-mock.ts'))})
    const { Session } = await import(${JSON.stringify(join(import.meta.dir, 'session.ts'))})
    const session = new Session('model-selection-test', 'chat-test')
    const peer = new Session('model-selection-peer', 'chat-peer')
    session.modelPanels.set('panel', { models: [] })
    peer.modelPanels.set('other', { models: [] })
    const first = await session.onProviderSelect('openrouter', 'panel')
    await peer.onProviderSelect('openrouter', 'other')
    assert.equal(first.ok, true)
    assert.ok(JSON.stringify(first.card).includes('model_remove'))
    assert.equal((await session.onModelAddOpen('panel', 'openrouter')).ok, true)
    assert.equal(session.modelPanels.get('panel').models.length, 2)
    assert.equal((await session.onModelSelect('qwen/extra-a', 'panel', '', { provider: 'claude' })).ok, false)
    assert.equal((await session.onModelListEdit('panel', 'openrouter', 'openai/excluded', 'add')).ok, false)
    assert.equal((await session.onModelListEdit('panel', 'openrouter', 'qwen/extra-a', 'add')).ok, true)
    assert.equal(peer.modelPanels.has('other'), false)
    assert.equal(source().models.length, defaults.length + 1)
    session.selectedProvider = 'claude'
    session.selectedTokenSourceId = 'openrouter'
    session.selectedModel = 'qwen/extra-a'
    session.selectedEffort = 'high'
    assert.equal((await session.onModelListEdit('panel', 'openrouter', 'qwen/extra-a', 'remove')).ok, true)
    assert.equal(session.selectedModel, 'qwen/extra-a')
    assert.equal(session.selectedEffort, 'high')
    for (const model of defaults) assert.equal((await session.onModelListEdit('panel', 'openrouter', model, 'remove')).ok, true)
    assert.equal(source().models.length, 0)
    const empty = await session.onProviderSelect('openrouter', 'panel')
    assert.ok(JSON.stringify(empty.card).includes('model_list_open'))
    assert.ok(JSON.stringify(empty.card).includes('openrouter'))
    assert.equal((await session.onModelAddOpen('panel', 'openrouter')).ok, true)
    assert.equal((await session.onModelListEdit('panel', 'openrouter', 'google/extra-b', 'add')).ok, true)
    assert.deepEqual(source().modelSelection.modelIds, ['google/extra-b'])
    session.dispose(); peer.dispose()
  `)
})
