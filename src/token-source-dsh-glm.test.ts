import { expect, test } from 'bun:test'
import { tokenSourceFactories } from './token-source'
import { glmCodingBaseUrl } from './token-source-dsh-glm'
import { dshProviderPatches } from './dsh-runtime'

test('DSH GLM uses Coding Plan routes and rejects unrelated hosts', () => {
  expect(glmCodingBaseUrl('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
  expect(glmCodingBaseUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/coding/paas/v4')
  expect(() => glmCodingBaseUrl('https://open.bigmodel.cn.evil.example/api')).toThrow('Coding Plan')
})

test('DSH GLM takes explicit credentials over the linked account and clears foreign backend routes', () => {
  const factory = tokenSourceFactories().find(f => f.kind === 'dsh-glm')!
  const source = factory.build({ api_key: 'own-key', base_url: 'https://api.z.ai/api/coding/paas/v4' },
    { api_key: 'linked-key', base_url: 'https://open.bigmodel.cn/api/anthropic' })
  expect(source.agent).toBe('dsh')
  const env = source.spawnEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'foreign', ANTHROPIC_AUTH_TOKEN: 'foreign',
    DSH_HOME: '/foreign', LODESTAR_DSH_PROVIDER: 'foreign', LODESTAR_DSH_GLM_API_KEY: 'foreign',
    ZAI_API_KEY: 'foreign', LODESTAR_AGENT_CAPABILITY: 'caller' })
  expect(env).toEqual({ PATH: '/bin', LODESTAR_DSH_PROVIDER: 'zai', LODESTAR_DSH_GLM_API_KEY: 'own-key',
    LODESTAR_DSH_BASE_URL: 'https://api.z.ai/api/coding/paas/v4', LODESTAR_DSH_DEFAULT_MODEL: '', LODESTAR_AGENT_CAPABILITY: 'caller' })
  const patches = dshProviderPatches(env)
  expect(JSON.stringify(patches)).not.toContain('own-key')
  expect(patches).toContainEqual({ id: 'llm-deepseek', disabled: true })
  expect(() => dshProviderPatches({ LODESTAR_DSH_PROVIDER: 'unknown' })).toThrow('Unsupported')
  expect(factory.setup?.parseArgs('key')).toEqual({ config: { agent: 'dsh', api_key: 'key', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4' } })
})
