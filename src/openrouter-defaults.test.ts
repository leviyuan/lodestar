import { expect, test } from 'bun:test'
import { openRouterModelPreset, openRouterModelVisibilityKey, selectOpenRouterDefaultModels } from './openrouter-defaults'

test('OpenRouter selects numeric family upgrades from authoritative IDs in curated order', () => {
  const catalog = [
    'meituan/longcat-2.0', 'meituan/longcat-2.1',
    'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.6-pro',
    'google/gemini-3.9-flash', 'google/gemini-3.10-flash',
    'meta/muse-spark-1.2', 'meta/muse-spark-1.3',
    'bytedance-seed/seed-2-1-turbo', 'bytedance-seed/seed-2-10-turbo',
    'tencent/hy3', 'tencent/hy4-preview',
  ]
  const expected = ['tencent/hy4-preview', 'google/gemini-3.10-flash', 'meta/muse-spark-1.3',
    'xiaomi/mimo-v2.6-pro', 'bytedance-seed/seed-2-10-turbo', 'meituan/longcat-2.1']
  expect(selectOpenRouterDefaultModels(catalog)).toEqual(expected)
  expect(selectOpenRouterDefaultModels([...catalog].reverse())).toEqual(expected)
  expect(selectOpenRouterDefaultModels([])).toEqual([])
})

test('preview policy, date revisions and aliases do not distort version ordering', () => {
  expect(selectOpenRouterDefaultModels(['tencent/hy4-preview', 'tencent/hy4'])).toEqual(['tencent/hy4'])
  expect(selectOpenRouterDefaultModels(['tencent/hy4', 'tencent/hy5-preview'])).toEqual(['tencent/hy5-preview'])
  expect(selectOpenRouterDefaultModels(['tencent/hy4-preview-20261009', 'tencent/hy4-20261001'])).toEqual(['tencent/hy4-20261001'])
  expect(selectOpenRouterDefaultModels([
    'google/gemini-3-20261009-flash', 'google/gemini-3.8-flash-20261001', 'google/gemini-3.8-flash-20261009',
    'meta/muse-spark-1-20261009', 'meta/muse-spark-1.3', 'meta/muse-spark-1.3-20261001',
  ])).toEqual(['google/gemini-3.8-flash-20261009', 'meta/muse-spark-1.3-20261001'])
  const aliases = ['bytedance-seed/seed-2-1-turbo', 'bytedance-seed/seed-2.1-turbo']
  expect(selectOpenRouterDefaultModels(aliases)).toEqual(selectOpenRouterDefaultModels([...aliases].reverse()))
})

test('unrelated tiers, authors and route variants are never automatic replacements', () => {
  expect(selectOpenRouterDefaultModels([
    'tencent/hy9-turbo', 'google/gemini-9-flash-lite', 'google/gemini-9-pro', 'google/gemini-9-flash-preview',
    'google/gemini-9-flash:free', 'google/gemini-9-flash[1m]', 'meta/muse-spark-9:extended',
    'xiaomi/mimo-v9-pro-ultraspeed', 'xiaomi/mimo-v9-flash', 'bytedance-seed/seed-9-code',
    'meituan/longcat-9-thinking', 'other/muse-spark-9', 'fake/google/gemini-9-flash',
    'openrouter/auto', 'openai/gpt-9',
  ])).toEqual([])
})

test('family preferences and hiding keys follow upgrades without merging unrelated tiers', () => {
  expect(openRouterModelPreset('meta/muse-spark-1.3')?.effort).toBe('xhigh')
  expect(openRouterModelPreset('google/gemini-3.10-flash')?.effort).toBe('high')
  expect(openRouterModelPreset('xiaomi/mimo-v2.6-pro')?.effort).toBe('default')
  expect(openRouterModelPreset('google/gemini-4-flash-lite')).toBeUndefined()
  expect(openRouterModelVisibilityKey('google/gemini-3.8-flash[1m]')).toBe(openRouterModelVisibilityKey('google/gemini-4-flash'))
  expect(openRouterModelVisibilityKey('meta/muse-spark-1.3')).toBe('family:muse-spark')
  expect(openRouterModelVisibilityKey('google/gemini-3.8-flash')).not.toBe(openRouterModelVisibilityKey('google/gemini-3.8-pro'))
})
