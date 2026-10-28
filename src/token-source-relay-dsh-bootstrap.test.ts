import { expect, mock, test } from 'bun:test'

let capturedEnv: Record<string, string | undefined> | undefined
mock.module('./dsh-runtime', () => ({
  queryDshRuntime: async (opts: { env: Record<string, string | undefined> }) => {
    capturedEnv = opts.env
    return [{ model: 'model-a', display: 'Model A', efforts: ['high'], defaultEffort: 'high', contextWindow: null, isDefault: true }]
  },
}))

const { buildRelayTokenSource } = await import('./token-source-relay')

test('DSH relay model discovery bootstraps with the first catalog model', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ data: [{ id: 'model-a', name: 'Model A' }] })) as unknown as typeof fetch
  try {
    const source = buildRelayTokenSource('site', {
      api_key: 'key', base_url: 'https://gateway.test/v1', protocol: 'openai',
    }, 'dsh')
    await source.refreshModels()
    expect(source.modelCatalogState?.status).toBe('ready')
    expect(source.defaultModel).toBe('model-a')
    expect(capturedEnv).toMatchObject({ LODESTAR_DSH_PROVIDER: 'openai-relay', LODESTAR_DSH_DEFAULT_MODEL: 'model-a', LODESTAR_DSH_MODELS: '["model-a"]' })
  } finally { globalThis.fetch = originalFetch }
})
