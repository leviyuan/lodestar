import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const path = (name: string) => JSON.stringify(join(import.meta.dir, name))

function run(work: string) {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-visibility-test-'))
  const file = join(root, 'config.toml')
  writeFileSync(file, '[feishu]\napp_id="test"\napp_secret="test"\n[token_source.glm]\nbase_url="https://open.bigmodel.cn/api/anthropic"\nauth_token="private-test-key"\nmodel="GLM-5.3"\neffort="max"\nslots="opus=GLM-5.3"\n', { mode: 0o600 })
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { readFileSync } from 'node:fs'
    const registry = await import(${path('token-source.ts')})
    const { withModelVisibility } = await import(${path('token-source-visibility.ts')})
    await import(${path('token-source-glm.ts')})
    const { config } = await import(${path('config.ts')})
    let ids = ['GLM-5.2', 'GLM-5.3']
    let failed = false
    globalThis.fetch = async () => failed ? new Response('unavailable', { status: 503 })
      : Response.json({ data: ids.map(id => ({ id, display_name: id })) })
    const factory = registry.tokenSourceFactories().find(f => f.kind === 'glm-coding-plan')
    const { cachedTokenSource } = await import(${path('token-source-cache.ts')})
    const rebuild = () => {
      const cfg = config.token_sources.glm
      const previous = registry.getTokenSource('glm')
      const source = cachedTokenSource(() => withModelVisibility(factory.build(cfg), cfg), cfg, 'fixture-glm', JSON.stringify(cfg), previous)
      registry.resetTokenSourceRegistry()
      registry.registerTokenSource(source)
      return 1
    }
    mock.module(${path('token-source-builtins.ts')}, () => ({ buildTokenSourcesFromConfig: rebuild }))
    const { editTokenSourceModels } = await import(${path('token-source-config.ts')})
    const source = () => registry.getTokenSource('glm')
    rebuild(); await registry.refreshAllTokenSourceModels()
    ${work}
  `
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: file, LODESTAR_DATA_DIR: join(root, 'state') }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('hiding persists across refresh, new upstream models appear, and adding restores hidden entries', () => {
  run(`
    await editTokenSourceModels('glm', 'GLM-5.3', 'remove')
    assert.deepEqual(source().models.map(m => m.model), ['GLM-5.2'])
    assert.equal(config.token_sources.glm.hidden_models, 'GLM-5.3')
    assert.equal(config.token_sources.glm.model, 'GLM-5.3')
    assert.equal(config.token_sources.glm.effort, 'max')
    assert.equal(config.token_sources.glm.slots, 'opus=GLM-5.3')
    assert.equal(config.token_sources.glm.auth_token, 'private-test-key')
    assert.equal(config.token_sources.glm.models, undefined)
    assert.ok(registry.tokenSourceRuntimeModels(source()).some(m => m.model === 'GLM-5.3'))
    ids.push('GLM-5.4')
    rebuild(); await registry.refreshAllTokenSourceModels()
    assert.deepEqual(source().models.map(m => m.model), ['GLM-5.2', 'GLM-5.4'])
    await editTokenSourceModels('glm', 'GLM-5.3', 'add')
    assert.deepEqual(source().models.map(m => m.model), ids)
    assert.equal(config.token_sources.glm.hidden_models, '')
    await assert.rejects(editTokenSourceModels('glm', 'forged-model', 'add'), /允许添加/)
  `)
})

test('concurrent hides preserve an editable empty list while failed background refresh retains the cache', () => {
  run(`
    await Promise.all(ids.map(id => editTokenSourceModels('glm', id, 'remove')))
    assert.deepEqual(source().models, [])
    assert.equal(source().modelCatalogState.status, 'ready')
    assert.equal(source().modelSelection.availableModels.length, 2)
    rebuild(); await registry.refreshAllTokenSourceModels()
    assert.deepEqual(source().models, [])
    failed = true
    await editTokenSourceModels('glm', 'GLM-5.3', 'add')
    await assert.rejects(source().refreshModels(), /503/)
    assert.equal(source().modelCatalogState.status, 'ready')
    assert.deepEqual(source().models.map(m => m.model), ['GLM-5.3'])
    assert.equal(source().modelSelection.availableModels.length, 2)
    failed = false
    await source().refreshModels()
    assert.deepEqual(source().models.map(m => m.model), ['GLM-5.3'])
  `)
})

test('MD can hide the currently selected catalog model without switching the session', () => {
  run(`
    await import(${path('feishu-test-mock.ts')})
    const { Session } = await import(${path('session.ts')})
    const session = new Session('visibility-test', 'chat-test')
    session.selectedProvider = 'claude'; session.selectedTokenSourceId = 'glm'
    session.selectedModel = 'GLM-5.3'; session.selectedEffort = 'max'
    session.modelPanels.set('panel', { models: [] })
    assert.equal((await session.onProviderSelect('glm', 'panel')).ok, true)
    assert.equal((await session.onModelListEdit('panel', 'glm', 'GLM-5.3', 'remove')).ok, true)
    assert.equal(session.selectedModel, 'GLM-5.3')
    assert.equal(session.selectedEffort, 'max')
    assert.equal(session.claudeEffortForSpawn(), 'max')
    assert.equal((await session.onModelAddOpen('panel', 'glm')).ok, true)
    assert.deepEqual(session.modelPanels.get('panel').models.map(m => m.model), ['GLM-5.3'])
    assert.equal((await session.onModelListEdit('panel', 'glm', 'GLM-5.3', 'add')).ok, true)
    assert.deepEqual(source().models.map(m => m.model), ids)
    Session.all.delete(session)
  `)
})
