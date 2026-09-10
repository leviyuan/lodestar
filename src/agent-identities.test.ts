import { describe, expect, test } from 'bun:test'
import { agentIdentityId, buildAgentIdentityCatalog } from './agent-identities'
import type { TokenSource } from './token-source'

function source(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    id: 'glm', kind: 'glm', agent: 'claude', display: 'GLM', enabled: true,
    models: [
      { model: 'GLM-5.3', display: 'GLM-5.3', efforts: ['low', 'max'], defaultEffort: 'max' },
      { model: 'GLM-Air', display: 'GLM-Air', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ],
    defaultModel: 'GLM-5.3',
    refreshModels: async () => {},
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    modelCatalogState: { status: 'ready', updatedAt: Date.now() },
    ...overrides,
  }
}

describe('Agent identity catalog', () => {
  test('exposes every model with its real default effort instead of forcing max', () => {
    const catalog = buildAgentIdentityCatalog([source()])
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.identities[1]).toMatchObject({
      id: agentIdentityId('glm', 'GLM-Air'), defaultEffort: 'medium', status: 'ready',
    })
  })

  test('keeps disabled models visible but uncallable', () => {
    const catalog = buildAgentIdentityCatalog([source({ enabled: false, modelCatalogState: { status: 'disabled', updatedAt: 1 } })])
    expect(catalog.identities.every(identity => identity.status === 'source_disabled')).toBe(true)
    expect(catalog.sourceFailures[0].status).toBe('disabled')
  })

  test('keeps missing effort visible and uncallable without a fabricated default', () => {
    const catalog = buildAgentIdentityCatalog([source({
      models: [{ model: 'missing-effort', display: 'Missing effort', efforts: [], defaultEffort: null }],
    })])
    expect(catalog.identities[0]).toMatchObject({
      status: 'model_unavailable', defaultEffort: null, supportedEfforts: [], reason: expect.stringContaining('MISS'),
    })
  })
})
