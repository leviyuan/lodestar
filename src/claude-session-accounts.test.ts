import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CLAUDE_SESSION_ACCOUNTS_FILE } from './paths'
import { claudeSessionAccount, recordClaudeSessionAccount } from './claude-session-accounts'

function isolated(script: string): void {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

test('records and resolves the account observed for a native session', () => {
  expect(claudeSessionAccount('unrecorded-session')).toBeNull()

  recordClaudeSessionAccount('recorded-session', 'default')
  expect(claudeSessionAccount('recorded-session')).toBe('default')

  // The latest account wins: resuming under another account moves the label.
  recordClaudeSessionAccount('recorded-session', 'claude-work')
  expect(claudeSessionAccount('recorded-session')).toBe('claude-work')
  expect(JSON.parse(readFileSync(CLAUDE_SESSION_ACCOUNTS_FILE, 'utf8'))['recorded-session']).toBe('claude-work')

  // Blank ids are ignored instead of persisting unusable entries.
  recordClaudeSessionAccount('', 'default')
  recordClaudeSessionAccount('blank-account-session', '')
  expect(claudeSessionAccount('blank-account-session')).toBeNull()
  expect(claudeSessionAccount('')).toBeNull()
})

test('loads the persisted map and evicts oldest entries at the bound', () => {
  isolated(`
    import assert from 'node:assert/strict'
    import { writeFileSync } from 'node:fs'
    const { CLAUDE_SESSION_ACCOUNTS_FILE } = await import('./src/paths')
    const seed = {}
    for (let i = 0; i < 2000; i++) seed['old-' + i] = 'default'
    writeFileSync(CLAUDE_SESSION_ACCOUNTS_FILE, JSON.stringify(seed))
    const { claudeSessionAccount, recordClaudeSessionAccount } = await import('./src/claude-session-accounts')
    assert.equal(claudeSessionAccount('old-0'), 'default')
    recordClaudeSessionAccount('new-session', 'claude-work')
    assert.equal(claudeSessionAccount('new-session'), 'claude-work')
    assert.equal(claudeSessionAccount('old-0'), null, 'oldest entry is evicted')
    assert.equal(claudeSessionAccount('old-1'), 'default')
  `)
})
