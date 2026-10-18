import { expect, test } from 'bun:test'
import { claudeTranslationModeEnabled } from './claude-translation-mode'
import { processUsesClaudeTranslation } from './agent-process'

test('the default configuration disables translation for every source', () => {
  for (const id of ['claude-sub', 'glm', 'deepseek', 'openrouter', 'packy', 'packy-secondary', 'packy-codex', 'deepseek-harness', 'dsh-glm', 'codex-sub', null, undefined]) {
    expect(claudeTranslationModeEnabled(id)).toBe(false)
    expect(claudeTranslationModeEnabled(id, 'any-model')).toBe(false)
  }
})

test('display translation follows the capability of the actual process', () => {
  expect(processUsesClaudeTranslation({})).toBe(false)
  expect(processUsesClaudeTranslation({ translationEnabled: false })).toBe(false)
  expect(processUsesClaudeTranslation({ translationEnabled: true })).toBe(true)
})

test('configured source rules match exact catalog model IDs, including explicit subscription opt-out', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    const { config } = await import('./src/config')
    const { claudeTranslationModeEnabled: enabled } = await import('./src/claude-translation-mode')
    config.claude.safe_mode = { 'claude-sub': [], glm: ['GLM-5.3'], packy: ['*'] }
    assert.equal(enabled('claude-sub', 'claude-opus-4-6'), false)
    assert.equal(enabled('glm', 'GLM-5.3'), true)
    for (const model of ['GLM-5.3-Flash', 'glm-5.3', 'GLM-5.3[1m]', '', null, undefined]) {
      assert.equal(enabled('glm', model), false)
    }
    assert.equal(enabled('packy', 'any-catalog-model'), true)
    assert.equal(enabled('packy'), true)
    for (const source of ['dsh-glm', 'constructor', 'toString', null, undefined]) {
      assert.equal(enabled(source, 'GLM-5.3'), false)
    }
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0)
})

test('main-session instructions use untranslated defaults for every source', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    import { join } from 'node:path'
    const { spawnDeveloperInstructions } = await import('./src/session-worktree')
    const target = join(process.env.LODESTAR_DATA_DIR, 'enabled-workspace')
    const cases = [
      ['alias*0917-1234', target, 'glm', 'claude', false],
      ['configured-name', join(target, 'subdir'), 'glm', 'claude', false],
      ['configured-name[feature]', join(process.env.LODESTAR_DATA_DIR, 'configured-name[feature]'), 'glm', 'claude', false],
      ['codex', target, 'codex-sub', 'codex', false],
      ['subscription', join(target, 'other'), 'claude-sub', 'claude', false],
    ]
    for (const [sessionName, workDir, selectedTokenSourceId, provider, expected] of cases) {
      const text = spawnDeveloperInstructions({ sessionName, workDir, selectedTokenSourceId,
        currentProvider: () => provider })
      assert.equal(text.includes('# desc: <brief description>'), expected)
      assert.equal(text.includes('# desc: <一句中文说明>'), !expected)
    }
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0)
})

test('main-session instructions follow configured models and subscription opt-out', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    const { config } = await import('./src/config')
    const { spawnDeveloperInstructions } = await import('./src/session-worktree')
    config.claude.safe_mode = { 'claude-sub': [], glm: ['GLM-5.3'] }
    const cases = [
      ['glm', 'GLM-5.3', 'claude', true],
      ['glm', 'GLM-5.3-Flash', 'claude', false],
      ['glm', 'GLM-5.3[1m]', 'claude', false],
      ['glm', 'GLM-5.3', 'dsh', false],
      ['claude-sub', 'claude-opus-4-6', 'claude', false],
    ]
    for (const [selectedTokenSourceId, selectedModel, provider, expected] of cases) {
      const text = spawnDeveloperInstructions({ sessionName: 'configured-safe-mode',
        workDir: process.env.LODESTAR_DATA_DIR, selectedTokenSourceId, selectedModel,
        currentProvider: () => provider })
      assert.equal(text.includes('# desc: <brief description>'), expected)
      assert.equal(text.includes('# desc: <一句中文说明>'), !expected)
    }
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0)
})
