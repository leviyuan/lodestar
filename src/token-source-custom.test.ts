import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('all built-in sources separate custom registration/deletion from upstream visibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lodestar-custom-model-test-'))
  const file = join(dir, 'config.toml')
  const codexHome = join(dir, 'codex')
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'auth.json'), '{}') // Credential discovery is local; model RPC stays mocked below.
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, name))
  writeFileSync(file, `[feishu]
app_id="test"
app_secret="test"
[token_source.glm]
base_url="https://open.bigmodel.cn/api/anthropic"
auth_token="test-key"
[token_source.deepseek]
api_key="test-key"
[token_source.openrouter]
api_key="test-key"
models="vendor/upstream"
[token_source.deepseek-harness]
api_key="test-key"
[token_source.dsh-glm]
api_key="test-key"
`, { mode: 0o600 })
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const model = (id) => ({ model: id, display: id, efforts: ['high'], defaultEffort: 'high' })
    let promoted = false
    mock.module(${modulePath('token-source-models.ts')}, () => ({ CLAUDE_EFFORTS: ['max', 'high'],
      fetchCodexModels: async () => [model('codex-upstream'), ...(promoted ? [model('custom-test')] : [])],
      fetchNativeClaudeModels: async () => [model('opus')], fetchGlmModels: async () => [model('GLM-5.3')],
    }))
    mock.module(${modulePath('dsh-runtime.ts')}, () => ({ DshRuntime: class {}, queryDshRuntime: async (opts) => [
      { ...model(opts.env.LODESTAR_DSH_PROVIDER === 'deepseek-official' ? 'deepseek-v4-flash' : 'glm-5.3'), isDefault: true, contextWindow: 200000 },
    ] }))
    globalThis.fetch = async (input) => {
      const url = String(input)
      return Response.json({ data: url.includes('openrouter') ? [{ id: 'vendor/upstream', name: 'Upstream',
        architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'],
        reasoning: { supported_efforts: ['high'], default_effort: 'high' } }]
        : [{ id: url.includes('bigmodel') ? 'glm-5.3' : 'deepseek-v4-flash' }] })
    }
    const { config } = await import(${modulePath('config.ts')})
    const registry = await import(${modulePath('token-source.ts')})
    const { withModelVisibility } = await import(${modulePath('token-source-visibility.ts')})
    const { sharedTokenSourceConfigs } = await import(${modulePath('token-source-accounts.ts')})
    for (const name of ['codex', 'glm', 'native', 'claude', 'deepseek', 'openrouter', 'dsh', 'dsh-glm']) {
      await import(${JSON.stringify(join(import.meta.dir, 'token-source-'))} + name + '.ts')
    }
    const { cachedTokenSource } = await import(${modulePath('token-source-cache.ts')})
    const rebuild = () => {
      const previous = new Map(registry.listTokenSources().map(source => [source.id, source]))
      registry.resetTokenSourceRegistry()
      const effective = sharedTokenSourceConfigs(config.token_sources)
      for (const factory of registry.tokenSourceFactories()) {
        const cfg = effective[factory.configSectionId] ?? {}
        const source = cachedTokenSource(() => {
          const raw = withModelVisibility(factory.build(cfg), cfg)
          raw.enabled = true
          return raw
        }, cfg, factory.kind, JSON.stringify(cfg), previous.get(factory.configSectionId))
        registry.registerTokenSource(source)
      }
      return registry.listTokenSources().length
    }
    mock.module(${modulePath('token-source-builtins.ts')}, () => ({ buildTokenSourcesFromConfig: rebuild }))
    const { registerCustomTokenSourceModel, removeCustomTokenSourceModel, editTokenSourceModels } = await import(${modulePath('token-source-config.ts')})
    rebuild(); await registry.refreshAllTokenSourceModels()
    const sources = ['codex-sub', 'glm', 'claude-native', 'claude-sub', 'deepseek', 'openrouter', 'deepseek-harness', 'dsh-glm']
    for (const id of sources) {
      const before = registry.getTokenSource(id).models.map(m => m.model)
      const custom = id === 'openrouter' ? 'vendor/custom-test' : 'custom-test'
      await registerCustomTokenSourceModel(id, custom)
      let source = registry.getTokenSource(id)
      const entry = source.models.find(m => m.model === custom)
      assert.equal(entry.origin, 'custom', id)
      assert.ok(config.token_sources[id].custom_models.includes(custom), id)
      assert.ok(entry.efforts.length > 0, id + ' 补录后必须能选择 effort')
      assert.ok(entry.efforts.includes(entry.defaultEffort), id)
      assert.equal(entry.unavailableReason, undefined, id)
      assert.ok(source.resolveSpawnModel(custom), id + ' 补录后必须能解析启动模型')
      await assert.rejects(editTokenSourceModels(id, custom, 'remove'))
      await assert.rejects(removeCustomTokenSourceModel(id, before[0]), /不是补录项/)
      await editTokenSourceModels(id, before[0], 'remove')
      source = registry.getTokenSource(id)
      assert.ok(source.models.some(m => m.model === custom), id)
      assert.ok(!source.models.some(m => m.model === before[0]), id)
      await editTokenSourceModels(id, before[0], 'add')
      await removeCustomTokenSourceModel(id, custom)
      assert.deepEqual(registry.getTokenSource(id).models.map(m => m.model), before, id)
      assert.equal(config.token_sources[id].custom_models, '')
    }
    await assert.rejects(registerCustomTokenSourceModel('openrouter', 'openai/excluded'), /排除/)
    await registerCustomTokenSourceModel('codex-sub', 'custom-test')
    promoted = true
    await registry.getTokenSource('codex-sub').refreshModels()
    const ready = registry.getTokenSource('codex-sub').models.filter(m => m.model === 'custom-test')
    assert.equal(ready.length, 1)
    assert.equal(ready[0].origin, 'upstream')
    await assert.rejects(removeCustomTokenSourceModel('codex-sub', 'custom-test'), /不是补录项/)
    await editTokenSourceModels('codex-sub', 'custom-test', 'remove')
    await editTokenSourceModels('codex-sub', 'custom-test', 'add')
  `
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script],
      env: { ...process.env, CODEX_HOME: codexHome, LODESTAR_CONFIG: file, LODESTAR_DATA_DIR: join(dir, 'state') }, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
