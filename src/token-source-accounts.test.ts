import { expect, test } from 'bun:test'
import { sharedTokenSourceConfigs, tokenSourceConfigUpdates } from './token-source-accounts'

test('one configured account enables both protocol views and preserves per-Agent models', () => {
  const sources = sharedTokenSourceConfigs({
    deepseek: { api_key: 'ds-key', base_url: 'https://api.deepseek.com/anthropic', model: 'claude-model', effort: 'high' },
    'deepseek-harness': { model: 'harness-model', effort: 'xhigh', bin: '/node' },
    glm: { auth_token: 'glm-key', base_url: 'https://api.z.ai/api/anthropic' },
  })
  expect(sources['deepseek-harness']).toMatchObject({ api_key: 'ds-key', base_url: 'https://api.deepseek.com', model: 'harness-model', effort: 'xhigh', bin: '/node' })
  expect(sources.deepseek).toMatchObject({ api_key: 'ds-key', model: 'claude-model', effort: 'high' })
  expect(sources['dsh-glm']).toMatchObject({ api_key: 'glm-key', base_url: 'https://api.z.ai/api/coding/paas/v4' })
})

test('legacy Harness-only credentials and detected accounts feed both Agent views', () => {
  const legacy = sharedTokenSourceConfigs({
    'deepseek-harness': { api_key: 'legacy', base_url: 'https://example.test/custom' },
    'dsh-glm': { api_key: 'z-key', base_url: 'https://api.z.ai/api/coding/paas/v4' },
  })
  expect(legacy.deepseek).toMatchObject({ api_key: 'legacy', base_url: 'https://example.test/custom' })
  expect(legacy.glm).toMatchObject({ auth_token: 'z-key', base_url: 'https://api.z.ai/api/anthropic' })
  expect(sharedTokenSourceConfigs({}, { deepseek: { api_key: 'detected' } })['deepseek-harness'].api_key).toBe('detected')
  expect(sharedTokenSourceConfigs({ 'deepseek-harness': { api_key: 'legacy', base_url: 'https://api.deepseek.com' } }).deepseek.base_url)
    .toBe('https://api.deepseek.com/anthropic')
})

test('conflicting legacy credentials fail visibly instead of silently selecting an account', () => {
  expect(() => sharedTokenSourceConfigs({ deepseek: { api_key: 'a' }, 'deepseek-harness': { api_key: 'b' } })).toThrow('旧账号配置冲突')
  expect(() => sharedTokenSourceConfigs({ glm: { auth_token: 'key', base_url: 'https://open.bigmodel.cn/api/anthropic' },
    'dsh-glm': { api_key: 'key', base_url: 'https://api.z.ai/api/coding/paas/v4' } })).toThrow('旧账号配置冲突')
})

test('either setup alias stores credentials once and preserves both sets of model preferences', () => {
  const original = { glm: { auth_token: 'old', model: 'GLM-5.3', slots: 'opus=GLM-5.3' },
    'dsh-glm': { api_key: 'different-legacy-key', model: 'glm-5.3', effort: 'high', custom_models: 'glm-custom' } }
  const updated = tokenSourceConfigUpdates(original, 'dsh-glm', { api_key: 'new', base_url: 'https://api.z.ai/api/coding/paas/v4' })
  expect(updated.glm).toEqual({ auth_token: 'new', base_url: 'https://api.z.ai/api/anthropic', model: 'GLM-5.3', slots: 'opus=GLM-5.3' })
  expect(updated['dsh-glm']).toEqual({ model: 'glm-5.3', effort: 'high', custom_models: 'glm-custom' })
  expect(JSON.stringify(updated).match(/new/g)).toHaveLength(1)
  expect(sharedTokenSourceConfigs(updated)['dsh-glm'].api_key).toBe('new')
})

test('model edits migrate matching legacy credentials without replacing shared account data', () => {
  const updated = tokenSourceConfigUpdates({ deepseek: { api_key: 'key', model: 'a' },
    'deepseek-harness': { api_key: 'key', model: 'b' } }, 'deepseek-harness', { effort: 'high' })
  expect(updated['deepseek-harness']).toEqual({ model: 'b', effort: 'high' })
  expect(updated.deepseek.api_key).toBe('key')
})

test('custom DeepSeek endpoints keep their supplied protocol path while explicit Anthropic suffixes share the API root', () => {
  const custom = sharedTokenSourceConfigs({ deepseek: { api_key: 'key', base_url: 'https://gateway.test/custom/api' } })
  expect(custom.deepseek.base_url).toBe('https://gateway.test/custom/api')
  expect(custom['deepseek-harness'].base_url).toBe('https://gateway.test/custom/api')
  const paired = sharedTokenSourceConfigs({
    deepseek: { api_key: 'key', base_url: 'https://gateway.test/custom/anthropic' },
    'deepseek-harness': { api_key: 'key', base_url: 'https://gateway.test/custom' },
  })
  expect(paired.deepseek.base_url).toBe('https://gateway.test/custom/anthropic')
  expect(paired['deepseek-harness'].base_url).toBe('https://gateway.test/custom')
})
