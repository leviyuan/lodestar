import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildRelayTokenSource, relaySourceId } from './token-source-relay'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ data: [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B', reasoning: { supported_efforts: ['high', 'medium'], default_effort: 'medium' } },
  ] })) as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = originalFetch })

describe('generic relay token sources', () => {
  test('anthropic endpoints expose a Claude source and scrub ambient credentials', async () => {
    const source = buildRelayTokenSource('site-a', {
      display: '站点 A', api_key: 'relay-key', base_url: 'https://gateway.test/v1', protocol: 'anthropic',
    }, 'claude')
    expect(source.id).toBe(relaySourceId('site-a', 'claude'))
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('ready')
    expect(source.models.map(model => model.model)).toEqual(['model-a', 'model-b'])
    const env = source.spawnEnv({ ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_BASE_URL: 'old' }, 'model-a')
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.test', ANTHROPIC_AUTH_TOKEN: 'relay-key', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'model-a' })
  })

  test('openai endpoints create independent Codex and DSH views', async () => {
    const cfg = { display: 'OpenAI 站点', api_key: 'relay-key', base_url: 'https://gateway.test/v1', protocol: 'openai' }
    const codex = buildRelayTokenSource('site-b', cfg, 'codex')
    const dsh = buildRelayTokenSource('site-b', cfg, 'dsh')
    await codex.refreshModels()
    expect(codex.codexApiProvider?.baseUrl).toBe('https://gateway.test/v1')
    expect(codex.spawnEnv({ OPENAI_API_KEY: 'old' }, 'model-a')).toMatchObject({ LODESTAR_RELAY_API_KEY: 'relay-key' })
    expect(dsh.spawnEnv({ OPENAI_API_KEY: 'old' }, 'model-a')).toMatchObject({
      LODESTAR_DSH_PROVIDER: 'openai-relay', LODESTAR_DSH_OPENAI_API_KEY: 'relay-key',
      LODESTAR_DSH_BASE_URL: 'https://gateway.test/v1', LODESTAR_DSH_DEFAULT_MODEL: 'model-a',
    })
    expect(dsh.spawnEnv({ OPENAI_API_KEY: 'old' }, 'model-a').OPENAI_API_KEY).toBeUndefined()
  })

  test('invalid relay addresses stay disabled and expose a diagnostic', () => {
    const source = buildRelayTokenSource('bad', { api_key: 'key', base_url: 'not a url', protocol: 'openai' }, 'codex')
    expect(source.enabled).toBe(false)
    expect(source.modelCatalogState?.error).toContain('中转站地址')
  })
})
