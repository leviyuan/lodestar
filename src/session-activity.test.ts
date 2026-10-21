import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProcess } from './agent-process'
import { bindProcessClaudeAccount } from './claude-accounts'
import { countActiveClaudeSessions, SessionActivityStore, USER_ACTIVITY_WINDOW_MS } from './session-activity'
import * as stateStore from './state-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-session-activity-')); roots.push(root)
  const file = join(root, 'state', 'activity.json')
  return { root, file, activity: new SessionActivityStore(file) }
}
const now = Date.parse('2030-01-02T03:04:05Z')
function session(chatId: string, accountId: string | null = 'A', executing = false) {
  const proc = { provider: 'claude', tokenSourceId: 'claude-sub', isAlive: () => true } as AgentProcess
  if (accountId) bindProcessClaudeAccount(proc, accountId)
  return { chatId, proc: proc as AgentProcess | null, hasActiveConversationWork: () => executing }
}

test('real user timestamps persist privately across restart, preserve event time and never move backwards', () => {
  const { root, file, activity } = fixture()
  expect(activity.lastUserMessageAt('chat')).toBeUndefined()
  expect(readdirSync(root)).toEqual([])
  activity.recordUserMessage('chat', now - 20_000, now)
  activity.recordUserMessage('chat', now - 30_000, now + 500_000)
  const restarted = new SessionActivityStore(file)
  expect(restarted.lastUserMessageAt('chat')).toBe(now - 20_000)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, chats: { chat: now - 20_000 } })
  if (process.platform !== 'win32') {
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700)
  }
})

test('invalid event time uses original receipt time, never the eventual queue execution time', () => {
  const { activity } = fixture()
  for (const [i, invalid] of [0, -1, NaN, Infinity].entries()) {
    activity.recordUserMessage(`chat-${i}`, invalid, now - 300_000)
    expect(activity.lastUserMessageAt(`chat-${i}`)).toBe(now - 300_000)
  }
  expect(() => activity.recordUserMessage('chat', NaN, NaN)).toThrow('均无效')
  expect(() => activity.recordUserMessage('', now, now)).toThrow('chatId')
})

test('future event timestamps are capped at receipt and cannot extend activity past thirty minutes', () => {
  const { activity, file } = fixture()
  activity.recordUserMessage('future-chat', now + 365 * 24 * 60 * 60_000, now)
  expect(activity.lastUserMessageAt('future-chat')).toBe(now)
  expect(new SessionActivityStore(file).lastUserMessageAt('future-chat')).toBe(now)
  expect([...countActiveClaudeSessions([session('future-chat')], {
    activity, now: now + USER_ACTIVITY_WINDOW_MS + 1,
  })]).toEqual([])
})

test('corrupt state and failed atomic writes are explicit and never commit optimistic activity', () => {
  const { activity, file } = fixture()
  activity.recordUserMessage('chat', now - 1000, now)
  const before = readFileSync(file, 'utf8')
  const write = spyOn(stateStore, 'writeJsonStateAtomic').mockImplementation(() => { throw new Error('synthetic disk full') })
  try { expect(() => activity.recordUserMessage('chat', now, now)).toThrow('synthetic disk full') }
  finally { write.mockRestore() }
  expect(activity.lastUserMessageAt('chat')).toBe(now - 1000)
  expect(readFileSync(file, 'utf8')).toBe(before)
  for (const corrupt of ['{broken', '{"version":1,"chats":{"chat":-1}}', '{"version":2,"chats":{}}']) {
    writeFileSync(file, corrupt)
    expect(() => new SessionActivityStore(file).recordUserMessage('chat', now, now)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(corrupt)
  }
})

test('active work or a user message within thirty minutes counts each chat once across main, BTW, FK and WT', () => {
  const { activity } = fixture()
  const main = session('main'), btw = session('btw'), fk = session('fk'), wt = session('wt', 'B', true)
  activity.recordUserMessage('main', now - USER_ACTIVITY_WINDOW_MS, now)
  activity.recordUserMessage('btw', now - 1000, now)
  activity.recordUserMessage('fk', now - USER_ACTIVITY_WINDOW_MS - 1, now)
  const counts = countActiveClaudeSessions([main, main, btw, fk, wt], { activity, now })
  expect([...counts]).toEqual([['A', 2], ['B', 1]])
  expect([...countActiveClaudeSessions([main, btw, fk, wt], { activity, now, excludeChatId: 'main' })])
    .toEqual([['A', 1], ['B', 1]])
  expect([...countActiveClaudeSessions([main, btw, fk], { activity, now: now + USER_ACTIVITY_WINDOW_MS + 1 })]).toEqual([])
})

test('only actual live Claude subscription bindings reserve: absent, dead, unbound and third-party processes do not', () => {
  const { activity, file } = fixture()
  const absent = session('absent', 'A', true); absent.proc = null
  const dead = session('dead', 'A', true); dead.proc!.isAlive = () => false
  const unbound = session('unbound', null, true)
  const thirdParty = session('third-party', 'A', true); Object.assign(thirdParty.proc!, { tokenSourceId: 'packy' })
  const codex = session('codex', 'A', true); Object.assign(codex.proc!, { provider: 'codex' })
  // A control query can have the same native account but never belongs to this Session registry.
  const control = session('unregistered-control', 'A', true)
  expect(control.proc).toBeDefined()
  expect([...countActiveClaudeSessions([absent, dead, unbound, thirdParty, codex], { activity, now })]).toEqual([])
  expect(existsSync(file)).toBe(false)
})

test('account replacement and daemon restart recompute one live binding rather than retaining old counts', () => {
  const { activity, file } = fixture()
  activity.recordUserMessage('chat', now - 1000, now)
  const chat = session('chat')
  expect([...countActiveClaudeSessions([chat], { activity, now })]).toEqual([['A', 1]])
  chat.proc = null
  expect([...countActiveClaudeSessions([chat], { activity, now })]).toEqual([])
  chat.proc = session('replacement', 'B').proc
  expect([...countActiveClaudeSessions([chat], { activity, now })]).toEqual([['B', 1]])
  expect([...countActiveClaudeSessions([session('chat', 'B')], { activity: new SessionActivityStore(file), now })])
    .toEqual([['B', 1]])
  expect([...countActiveClaudeSessions([chat], { activity, now, excludeChatId: 'chat' })]).toEqual([])
})

test('actual Session execution flags cover startup, turn, opening, queues and background work without recording synthetic input', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { Session } from './src/session'
    import { sessionActivity } from './src/session-activity'
    const s = new Session('activity-fixture', 'activity-fixture-chat')
    try {
      assert.equal(s.hasActiveConversationWork(), false)
      for (const status of ['starting', 'working', 'awaiting_permission']) {
        s.status = status; assert.equal(s.hasActiveConversationWork(), true)
      }
      s.status = 'idle'
      for (const [key, value, empty] of [
        ['currentTurn', {}, null], ['openingTurn', true, false], ['pendingUserMessageCount', 1, 0],
        ['pendingMidTurnMsgs', [{}], []], ['pendingTurnInputs', ['input'], []],
        ['backgroundTasks', [{status:'running'}], []], ['pendingBgTasks', [{}], []],
        ['backgroundSync', Promise.resolve(), null], ['bgResumeCardless', true, false],
      ]) {
        s[key] = value; assert.equal(s.hasActiveConversationWork(), true, key)
        s[key] = empty; assert.equal(s.hasActiveConversationWork(), false, key)
      }
      s.backgroundTasks = [{status:'completed'}, {status:'failed'}, {status:'killed'}]
      assert.equal(s.hasActiveConversationWork(), false)
      assert.equal(sessionActivity.lastUserMessageAt(s.chatId), undefined)
    } finally { s.proc = null; s.dispose() }
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
