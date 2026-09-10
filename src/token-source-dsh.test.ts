import { describe, expect, test } from 'bun:test'
import { tokenSourceFactories } from './token-source'
import './token-source-dsh'

const factory = () => tokenSourceFactories().find(entry => entry.kind === 'deepseek-harness')!
describe('DeepSeek Harness source isolation', () => {
  test('requires its own explicit credential and does not enable the legacy Claude source', async () => {
    const source = factory().build({})
    expect(source.agent).toBe('dsh')
    expect(source.enabled).toBe(false)
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('disabled')
    expect(source.models).toEqual([])
    expect(() => source.spawnEnv({ DEEPSEEK_API_KEY: 'ambient-key' })).toThrow('missing')
  })
  test('replaces account and Harness overrides while retaining the caller capability', () => {
    const source = factory().build({ api_key: 'configured-key', base_url: 'http://127.0.0.1:1234', bin: '/explicit/node' })
    const env = source.spawnEnv({ ANTHROPIC_API_KEY: 'old', ANTHROPIC_BASE_URL: 'old',
      DEEPSEEK_API_KEY: 'old', DSH_HOME: '/foreign/home', LODESTAR_AGENT_CAPABILITY: 'caller', PATH: '/bin' })
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'configured-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234',
      LODESTAR_DSH_NODE: '/explicit/node', LODESTAR_AGENT_CAPABILITY: 'caller', PATH: '/bin' })
  })
  test('registers the independent setup command', () => {
    expect(factory().setup?.commandSuffix).toBe('deepseek-harness')
    expect(factory().setup?.parseArgs('test-key')).toEqual({ config: { agent: 'dsh', api_key: 'test-key' } })
  })
})
