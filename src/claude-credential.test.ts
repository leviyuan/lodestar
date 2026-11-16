import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeAuthStatusFormatError, claudeCredentialExpiry, invalidateClaudeCredentialExpiry, parseClaudeAuthStatus, readClaudeAuthStatus,
} from './claude-credential'

const DAY = 86_400_000
let dir: string
let executable: string
let callLog: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-credential-'))
  executable = join(dir, 'claude')
  callLog = join(dir, 'calls.log')
  // Stands in for the native CLI: records its arguments and environment, then prints the given status.
  writeFileSync(executable, [
    '#!/bin/sh',
    'printf "%s|%s|%s\\n" "$*" "${CLAUDE_CONFIG_DIR-unset}" "${FAKE_UNDEFINED-unset}" >> "$FAKE_LOG"',
    'if [ -n "$FAKE_SLEEP" ]; then exec sleep "$FAKE_SLEEP"; fi',
    'if [ -n "$FAKE_HUGE" ]; then exec head -c "$FAKE_HUGE" /dev/zero; fi',
    'if [ -n "$FAKE_DELAY" ]; then sleep "$FAKE_DELAY"; fi',
    'printf "%s" "$FAKE_OUTPUT"',
    'exit "${FAKE_EXIT:-0}"',
    '',
  ].join('\n'), { mode: 0o755 })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => rmSync(callLog, { force: true }))

const status = (fields: object) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...fields })
const ending = (at: number) => status({ loginExpiresAt: new Date(at).toISOString() })
const env = (extra: Record<string, string | undefined> = {}) => ({ PATH: process.env.PATH, FAKE_LOG: callLog, ...extra })
const calls = () => existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []
const failure = (promise: Promise<unknown>) => promise.then(() => new Error('expected a rejection'), error => error as Error)
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  return check()
}

describe('parseClaudeAuthStatus', () => {
  test('reads the native latest login end; signed out or dateless logins are unknown', () => {
    const at = '2027-03-13T00:55:22.008Z'
    expect(parseClaudeAuthStatus(JSON.parse(status({ loginExpiresAt: at })))).toBe(Date.parse(at))
    expect(parseClaudeAuthStatus({ loggedIn: false, authMethod: 'none', loginExpiresAt: null })).toBeNull()
    expect(parseClaudeAuthStatus({ loggedIn: true, loginExpiresAt: null })).toBeNull()
  })

  test('older or malformed native output is a format error, never a guessed date', () => {
    expect(() => parseClaudeAuthStatus({ loggedIn: true, authMethod: 'claude.ai' })).toThrow(/loginExpiresAt/)
    for (const value of ['soon', '', 1_794_000_000_000]) {
      expect(() => parseClaudeAuthStatus({ loggedIn: true, loginExpiresAt: value })).toThrow(/无效/)
    }
    for (const raw of [null, [], 'text', { loginExpiresAt: '2027-03-13T00:55:22.008Z' }, { loggedIn: true }]) {
      expect(() => parseClaudeAuthStatus(raw)).toThrow(ClaudeAuthStatusFormatError)
    }
  })
})

// The stand-in CLI is a POSIX shell script, as in the reclaude and launcher tests.
describe.skipIf(process.platform === 'win32')('readClaudeAuthStatus', () => {
  test('runs only `auth status --json` with the session settings and environment; the JSON decides over the exit code', async () => {
    const exits: string[] = []
    const at = '2027-03-13T00:55:22.008Z'
    const settings = { env: { ANTHROPIC_API_KEY: '' }, apiKeyHelper: '', forceLoginMethod: 'claudeai' }
    expect(await readClaudeAuthStatus(executable, env({ CLAUDE_CONFIG_DIR: '/accounts/a', FAKE_UNDEFINED: undefined,
      FAKE_OUTPUT: status({ loginExpiresAt: at }) }), { settings, onExit: () => exits.push('signed-in') })).toBe(Date.parse(at))
    // Signed out: the native CLI exits 1 but still prints the full status.
    expect(await readClaudeAuthStatus(executable, env({ FAKE_EXIT: '1',
      FAKE_OUTPUT: JSON.stringify({ loggedIn: false, authMethod: 'none', loginExpiresAt: null }) }),
    { onExit: () => exits.push('signed-out') })).toBeNull()
    // --settings is a global option: it has to precede the subcommand.
    expect(calls()).toEqual([`--settings ${JSON.stringify(settings)} auth status --json|/accounts/a|unset`,
      'auth status --json|unset|unset'])
    expect(exits).toEqual(['signed-in', 'signed-out'])
  })

  test('unusable answers are format errors; a missing program is not; every exit is still reported', async () => {
    const exits: string[] = []
    const read = (extra: Record<string, string>, label: string) =>
      failure(readClaudeAuthStatus(executable, env(extra), { onExit: () => exits.push(label) }))
    for (const [extra, label, message] of [
      [{ FAKE_EXIT: '1' }, 'empty', /无输出.*退出码 1/],
      [{ FAKE_OUTPUT: 'Error: configuration file not found' }, 'text', /不是有效 JSON/],
      [{ FAKE_OUTPUT: status({}) }, 'old', /loginExpiresAt/],
      // Generated by the stand-in itself: Linux caps one environment string at 128 KiB.
      [{ FAKE_HUGE: String(300 * 1024) }, 'huge', /输出过大/],
    ] as const) {
      const error = await read(extra, label)
      expect(error).toBeInstanceOf(ClaudeAuthStatusFormatError)
      expect(error.message).toMatch(message)
    }
    const missing = await failure(readClaudeAuthStatus(join(dir, 'missing'), env(), { onExit: () => exits.push('missing') }))
    expect(missing).toBeInstanceOf(Error)
    expect(missing).not.toBeInstanceOf(ClaudeAuthStatusFormatError)
    expect(await until(() => exits.length === 5)).toBe(true)
    expect(exits.sort()).toEqual(['empty', 'huge', 'missing', 'old', 'text'])
  })

  test('a hung native process is killed at the timeout and its exit still releases the caller', async () => {
    let exited = false
    const started = Date.now()
    const error = await failure(readClaudeAuthStatus(executable, env({ FAKE_SLEEP: '5' }),
      { timeoutMs: 200, onExit: () => { exited = true } }))
    expect(error.message).toMatch(/超时/)
    expect(error).not.toBeInstanceOf(ClaudeAuthStatusFormatError)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await until(() => exited)).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('claudeCredentialExpiry', () => {
  test('a date beyond the warning window is re-read at most every 5 minutes; nearer dates on every refresh', async () => {
    let now = 1_900_000_000_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let output = ending(now + 27 * DAY)
      const read = () => claudeCredentialExpiry({ accountId: 'cadence', revision: 'r1' },
        () => ({ env: env({ FAKE_OUTPUT: output }) }), { executable: () => executable })
      const settled = now + 27 * DAY
      expect(await read()).toBe(settled)
      now += 5 * 60_000 - 1
      expect(await read()).toBe(settled)
      expect(calls()).toHaveLength(1)
      // After a new sign-in the next five-minute read picks up the new date.
      now += 1
      const near = now + 9 * DAY
      output = ending(near)
      expect(await read()).toBe(near)
      expect(await read()).toBe(near)
      expect(calls()).toHaveLength(3)
      output = JSON.stringify({ loggedIn: false, loginExpiresAt: null })
      expect(await read()).toBeNull()
      expect(await read()).toBeNull()
      expect(calls()).toHaveLength(5)
    } finally {
      clock.mockRestore()
      invalidateClaudeCredentialExpiry('cadence')
    }
  })

  test('transient failures keep the same revision value; unusable answers show MISS instead of an older date', async () => {
    const at = Date.now() + 5 * DAY
    const read = (revision: string, extra: Record<string, string>) => claudeCredentialExpiry({ accountId: 'fallback', revision },
      () => ({ env: env(extra) }), { executable: () => executable, timeoutMs: 200 })
    expect(await read('r1', { FAKE_OUTPUT: ending(at) })).toBe(at)
    expect(await read('r1', { FAKE_SLEEP: '5' })).toBe(at)
    expect(await read('r2', { FAKE_SLEEP: '5' })).toBeNull()
    expect(await read('r1', { FAKE_OUTPUT: ending(at) })).toBe(at)
    // An incompatible native answer (e.g. after an update) must not keep showing the old date.
    expect(await read('r1', { FAKE_OUTPUT: status({}) })).toBeNull()
    expect(await read('r1', { FAKE_SLEEP: '5' })).toBeNull()
    expect(calls()).toHaveLength(6)
    invalidateClaudeCredentialExpiry('fallback')
  })

  test('invalidation during a read keeps the late result out of the cache', async () => {
    const late = Date.now() + 28 * DAY, fresh = Date.now() + 27 * DAY
    const read = (extra: Record<string, string>) => claudeCredentialExpiry({ accountId: 'race', revision: 'r1' },
      () => ({ env: env(extra) }), { executable: () => executable })
    const slow = read({ FAKE_DELAY: '0.4', FAKE_OUTPUT: ending(late) })
    expect(await until(() => calls().length === 1)).toBe(true)
    invalidateClaudeCredentialExpiry('race')
    expect(await read({ FAKE_OUTPUT: ending(fresh) })).toBe(fresh)
    // The superseded caller still gets its own answer, but the cache keeps the newer one.
    expect(await slow).toBe(late)
    expect(await read({ FAKE_OUTPUT: 'unused' })).toBe(fresh)
    expect(calls()).toHaveLength(2)
    invalidateClaudeCredentialExpiry('race')
  })

  test('the account lease spans the native process; a busy account or broken environment runs nothing', async () => {
    const events: string[] = []
    const at = Date.now() + 27 * DAY
    expect(await claudeCredentialExpiry({ accountId: 'lease', revision: 'r1' }, () => ({
      env: env({ FAKE_OUTPUT: ending(at) }), settings: { apiKeyHelper: '' },
      acquireUse: () => {
        events.push(`acquire after ${calls().length} runs`)
        return () => events.push(`release after ${calls().length} runs`)
      },
    }), { executable: () => executable })).toBe(at)
    expect(events).toEqual(['acquire after 0 runs', 'release after 1 runs'])
    expect(calls()).toEqual(['--settings {"apiKeyHelper":""} auth status --json|unset|unset'])
    expect(await claudeCredentialExpiry({ accountId: 'busy', revision: 'r1' }, () => ({
      env: env({ FAKE_OUTPUT: ending(at) }),
      acquireUse: () => { throw new Error('Claude 账号正在收录，不能同时启动任务或额度查询') },
    }), { executable: () => executable })).toBeNull()
    expect(await claudeCredentialExpiry({ accountId: 'broken', revision: 'r1' }, () => {
      throw new Error('Claude 默认账号 settings.json 格式无效，无法确认认证目录')
    }, { executable: () => executable })).toBeNull()
    expect(calls()).toHaveLength(1)
    for (const id of ['lease', 'busy', 'broken']) invalidateClaudeCredentialExpiry(id)
  })

  test('concurrent refreshes of one account share a single native process', async () => {
    const at = Date.now() + 5 * DAY
    const read = () => claudeCredentialExpiry({ accountId: 'shared', revision: 'r1' },
      () => ({ env: env({ FAKE_OUTPUT: ending(at) }) }), { executable: () => executable })
    expect(await Promise.all([read(), read()])).toEqual([at, at])
    expect(calls()).toHaveLength(1)
    invalidateClaudeCredentialExpiry('shared')
  })
})

test('a spawn that never started is not signalled, and its error still releases the caller', () => {
  // Under Node an EMFILE spawn has no pid and no stdout, and kill() would signal pid 0: the daemon's own group.
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    const kills = []
    mock.module('cross-spawn', () => ({ spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: null,
        kill: signal => { kills.push(signal); return true } })
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })))
      return child
    } }))
    const { readClaudeAuthStatus } = await import('./src/claude-credential')
    let exits = 0
    const error = await readClaudeAuthStatus('/unused/claude', {}, { timeoutMs: 50, onExit: () => { exits++ } })
      .then(() => null, error => error)
    assert.match(String(error?.message), /无法读取输出/)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(exits, 1)
    assert.deepEqual(kills, [])
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('tests never start the real Claude Code unless an executable is injected', async () => {
  let probed = false
  expect(await claudeCredentialExpiry({ accountId: 'test-env', revision: 'r1' }, () => {
    probed = true
    return { env: {} }
  })).toBeUndefined()
  expect(probed).toBe(false)
})
