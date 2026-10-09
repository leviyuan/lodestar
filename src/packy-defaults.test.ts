import { expect, test } from 'bun:test'
import { packyModelVisibilityKey, selectPackyDefaultModels } from './packy-defaults'

test('curated families compare numeric versions and release dates, retaining authoritative IDs', () => {
  const catalog = [
    'MiniMax-M3', 'MiniMax-M3.1', 'claude-opus-5', 'claude-opus-5-5', 'anthropic/claude-opus-5-10',
    'claude-opus-5-20260901', 'claude-opus-5-5-20261009', 'claude-fable-5-1', 'claude-fable-5-2',
    'qwen3.8-max-0902', 'qwen3.8-max-1008', 'qwen3.9-max', 'qwen3.9-max-1001',
    'kimi-k3', 'kimi-k3.1', 'grok-4.6', 'grok-4.10',
  ]
  expect(selectPackyDefaultModels(catalog)).toEqual([
    'MiniMax-M3.1', 'anthropic/claude-opus-5-10', 'claude-fable-5-2', 'qwen3.9-max-1001',
  ])
  expect(selectPackyDefaultModels(catalog, 'packy-secondary')).toEqual(selectPackyDefaultModels(catalog))
  expect(selectPackyDefaultModels(catalog, 'packy-codex')).toEqual(['kimi-k3.1', 'grok-4.10'])
})

test('same-version aliases have a deterministic winner and variants require explicit display', () => {
  const aliases = ['anthropic/claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5.5']
  const variants = ['claude-opus-6-thinking', 'claude-opus-6-preview', 'claude-opus-6[1m]',
    'claude-opus-latest', 'qwen4-max-thinking', 'MiniMax-M4-highspeed', 'grok-5-fast', 'unrelated-99']
  expect(selectPackyDefaultModels(aliases)).toEqual(selectPackyDefaultModels([...aliases].reverse()))
  expect(selectPackyDefaultModels(variants)).toEqual([])
  expect(selectPackyDefaultModels(['claude-opus-5-5-20261008', 'claude-opus-5-5-20261009']))
    .toEqual(['claude-opus-5-5-20261009'])
  expect(selectPackyDefaultModels([])).toEqual([])
})

test('hiding a curated family covers future versions without hiding unrelated models', () => {
  expect(packyModelVisibilityKey('claude-opus-5', 'packy')).toBe(packyModelVisibilityKey('anthropic/claude-opus-5-5', 'packy'))
  expect(packyModelVisibilityKey('claude-fable-5-1', 'packy')).not.toBe(packyModelVisibilityKey('claude-opus-5-5', 'packy'))
  expect(packyModelVisibilityKey('gemini-3.8-flash', 'packy')).not.toBe(packyModelVisibilityKey('gemini-3.9-flash', 'packy'))
})
