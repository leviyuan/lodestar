import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFeishuMock } from './feishu-test-mock'
import { Session } from './session'
import { bindProcessClaudeAccount, claudeAccounts, ClaudeAccounts, processClaudeAccount } from './claude-accounts'
import * as selection from './claude-account-selection'
import * as commands from './session-claude-accounts'
import * as codexCommands from './session-codex-accounts'
import { pendingSourceCommands } from './session-commands'
import { getTokenSource, getTokenSourceForAccount, listTokenSources, registerTokenSource, resetTokenSourceRegistry, type TokenSource } from './token-source'
import { listClaudeSessions } from './session-temp'
import { sessionActivity } from './session-activity'

const spies: Array<{ mockRestore(): void }> = []
const sessions: Session[] = []
let root: string
let store: ClaudeAccounts
let accountA: string
let accountB: string
let previous: TokenSource[]
const accountInfo = (email: string) => ({ email, organization: 'test', subscriptionType: 'max', apiProvider: 'firstParty' as const })

function source(id = 'default'): TokenSource {
  return { id: 'claude-sub', accountId: id, kind: 'claude-subscription', agent: 'claude', display: 'Claude 订阅',
    enabled: true, models: [{ model: 'opus', display: 'Opus', efforts: ['high'], defaultEffort: 'high' }],
    defaultModel: 'opus', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'ok', windows: [] }), spawnRevision: `account-${id}` }
}

class Proc extends EventEmitter {
  provider = 'claude' as const
  tokenSourceId = 'claude-sub'
  sessionId = 'test-shared-session'
  lastModel = 'opus'
  lastEffort = 'high' as const
  alive = true
  killCalls = 0
  isAlive() { return this.alive }
  sendInitialize() {}
  async kill() { this.killCalls++; this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
}
function session(chatId = 'chat-claude-account'): any {
  const s = new Session(`claude-account-test-${sessions.length}`, chatId) as any
  s.selectedProvider = 'claude'; s.selectedTokenSourceId = 'claude-sub'
  s.selectedModel = 'opus'; s.selectedEffort = 'high'
  sessions.push(s)
  return s
}
function running(s: any, id: string): Proc {
  const proc = new Proc()
  bindProcessClaudeAccount(proc as any, id)
  s.proc = proc; s.status = 'idle'
  s.lastSessionRef = { provider: 'claude', sessionId: proc.sessionId, cwd: s.workDir }
  s.lastSessionId = proc.sessionId
  return proc
}

beforeEach(async () => {
  resetFeishuMock()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'session-claude-accounts-')))
  const home = join(root, 'home')
  for (const d of ['.claude', '.claude-accounts/A', '.claude-accounts/B']) mkdirSync(join(home, d), { recursive: true })
  store = new ClaudeAccounts({ home, stateFile: join(root, 'accounts.json'), env: {} })
  accountA = (await store.enroll('A', async () => accountInfo('a@example.test'))).id
  accountB = (await store.enroll('B', async () => accountInfo('b@example.test'))).id
  for (const key of ['list', 'get', 'find', 'candidate', 'revision', 'assertReady', 'sharedConfigDir', 'prepareShared', 'env', 'acquireUse'] as const) {
    spies.push(spyOn(claudeAccounts, key).mockImplementation((...args: any[]) => (store[key] as any)(...args)))
  }
  previous = listTokenSources(); resetTokenSourceRegistry()
  const primary = source()
  const children = new Map(store.list().map(account => [account.id, source(account.id)]))
  primary.forAccount = id => children.get(id)!
  registerTokenSource(primary)
})
afterEach(async () => {
  await Promise.allSettled(pendingSourceCommands())
  for (const s of sessions.splice(0)) { s.proc = null; s.dispose() }
  for (const spy of spies.splice(0)) spy.mockRestore()
  resetTokenSourceRegistry(); for (const item of previous) registerTokenSource(item)
  rmSync(root, { recursive: true, force: true })
})

describe('Claude named hi integration', () => {
  test('Claude hi routes to Claude and leaves the Codex entry untouched', async () => {
    const s = session()
    const claude = spyOn(commands, 'runClaudeNamedHi').mockResolvedValue(undefined)
    const codex = spyOn(codexCommands, 'runCodexNamedHi').mockResolvedValue(undefined)
    spies.push(claude, codex)
    expect(await s.runCommand('hi A')).toBe(true)
    await Promise.all(pendingSourceCommands())
    expect(claude).toHaveBeenCalledWith(s, 'A')
    expect(codex).not.toHaveBeenCalled()
    s.selectedProvider = 'codex'
    await s.runCommand('hi Codex号')
    expect(codex).toHaveBeenCalledWith(s, 'Codex号')
  })
  test('first discovery starts the requested account once without persisting a preference', async () => {
    const s = session()
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountB)
    const observed: unknown[] = []
    const start = spyOn(s, 'startUnlocked').mockImplementation(async () => {
      observed.push(s.claudeStartAccountOverride)
      expect(s.currentTokenSource().accountId).toBe(accountB)
      return true
    })
    spies.push(enroll, start)
    expect(await s.startWithClaudeAccount('B')).toBe(true)
    expect(enroll).toHaveBeenCalledWith('B', expect.any(Function))
    expect(observed).toEqual([accountB])
    expect(s.claudeStartAccountOverride).toBeUndefined()
  })
  test('named hi keeps its progress card open and the old account alive until initial sync completes', async () => {
    const s = session(), proc = running(s, accountA)
    let complete!: () => void
    const waiting = new Promise<void>(resolve => { complete = resolve })
    const card = { title: 'Claude 订阅账号', cardId: 'sync-status-card' }
    const updates: string[] = []
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockImplementation(async (_name, onProgress) => {
      await onProgress?.('authenticating')
      await onProgress?.('syncing')
      await waiting
      return accountB
    })
    const close = spyOn(s, 'closeStatusCard').mockResolvedValue(undefined)
    const restart = spyOn(s, 'restartUnlocked').mockResolvedValue(true)
    spies.push(enroll, close, restart,
      spyOn(s, 'openStatusCard').mockResolvedValue(card),
      spyOn(s, 'setStatusCard').mockImplementation((_card: unknown, value: string) => { updates.push(value) }),
      spyOn(s, 'showConsole').mockResolvedValue(undefined))
    const pending = commands.runClaudeNamedHi(s, 'B')
    try {
      for (let i = 0; i < 20 && !updates.some(value => value.includes('正在完成首次同步')); i++) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      expect(updates.some(value => value.includes('已登录，正在完成首次同步'))).toBe(true)
      expect(close).not.toHaveBeenCalled()
      expect(restart).not.toHaveBeenCalled()
      expect(proc.killCalls).toBe(0)
      expect(s.claudeStartAccountOverride).toBeUndefined()
    } finally { complete(); await pending }
    expect(restart).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(card, '✅ Claude 订阅「B」已就绪 · 本次指定')
  })
  test('failed initial sync presents the retry instruction without switching the running account', async () => {
    const s = session(), proc = running(s, accountA)
    const card = { title: 'Claude 订阅账号', cardId: 'failed-sync-status-card' }
    const close = spyOn(s, 'closeStatusCard').mockResolvedValue(undefined)
    const restart = spyOn(s, 'restartUnlocked').mockResolvedValue(true)
    spies.push(close, restart,
      spyOn(s, 'openStatusCard').mockResolvedValue(card),
      spyOn(s, 'setStatusCard').mockImplementation(() => {}),
      spyOn(selection, 'enrollClaudeAccount').mockImplementation(async (_name, onProgress) => {
        await onProgress?.('syncing')
        throw new Error('首次同步未完成，请稍后重试 hi B')
      }))
    await commands.runClaudeNamedHi(s, 'B')
    expect(close).toHaveBeenCalledWith(card, '❌ 首次同步未完成，请稍后重试 hi B')
    expect(restart).not.toHaveBeenCalled()
    expect(proc.killCalls).toBe(0)
    expect(s.claudeStartAccountOverride).toBeUndefined()
  })
  test('invalid discovery does not start or switch anything', async () => {
    const s = session()
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockRejectedValue(new Error('未登录'))
    const start = spyOn(s, 'startUnlocked').mockResolvedValue(true)
    spies.push(enroll, start)
    await expect(s.startWithClaudeAccount('missing')).rejects.toThrow('未登录')
    expect(start).not.toHaveBeenCalled()
    expect(s.claudeStartAccountOverride).toBeUndefined()
    expect(s.selectedTokenSourceId).toBe('claude-sub')
  })
  test('an unauthenticated default account does not prevent discovering a valid extra account', async () => {
    const s = session(), rootSource = getTokenSource('claude-sub')!
    rootSource.enabled = false
    rootSource.modelCatalogState = { status: 'disabled', updatedAt: 1, error: '默认账号未登录' }
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountB)
    const start = spyOn(s, 'startUnlocked').mockResolvedValue(true)
    spies.push(enroll, start)
    expect(await s.startWithClaudeAccount('B')).toBe(true)
    expect(enroll).toHaveBeenCalledWith('B', expect.any(Function))
    expect(start).toHaveBeenCalledTimes(1)
  })
  test('an existing same-account process is reused even while working', async () => {
    const s = session(), proc = running(s, accountA)
    s.currentTurn = {} as any
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountA)
    spies.push(enroll)
    expect(await s.startWithClaudeAccount('a')).toBe(true)
    expect(enroll).not.toHaveBeenCalled()
    expect(proc.killCalls).toBe(0)
    s.currentTurn = null
  })
  test.each(['currentTurn', 'openingTurn', 'pendingUserMessageCount'])('busy %s prevents another account before discovery', async field => {
    const s = session(), proc = running(s, accountA)
    s[field] = field === 'currentTurn' ? {} : field === 'openingTurn' ? true : 1
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountB)
    spies.push(enroll)
    await expect(s.startWithClaudeAccount('B')).rejects.toThrow('当前任务尚未结束')
    expect(enroll).not.toHaveBeenCalled()
    expect(proc.killCalls).toBe(0)
    s[field] = field === 'currentTurn' ? null : field === 'openingTurn' ? false : 0
  })
  test('explicit idle switch resumes the shared conversation and keeps one-launch routing', async () => {
    const s = session(); running(s, accountA)
    const original = s.lastSessionRef
    const enroll = spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountB)
    const restart = spyOn(s, 'restartUnlocked').mockImplementation(async (resume: unknown) => {
      expect(resume).toBe(true)
      expect(s.claudeStartAccountOverride).toBe(accountB)
      expect(s.lastSessionRef).toEqual(original)
      return true
    })
    spies.push(enroll, restart)
    expect(await s.startWithClaudeAccount('B')).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(s.claudeStartAccountOverride).toBeUndefined()
  })
  test('failed switch clears one-launch override and does not replace the old resume reference', async () => {
    const s = session(); running(s, accountA)
    const original = s.lastSessionRef
    spies.push(spyOn(selection, 'enrollClaudeAccount').mockResolvedValue(accountB),
      spyOn(s, 'restartUnlocked').mockRejectedValue(new Error('旧进程退出未确认')))
    await expect(s.startWithClaudeAccount('B')).rejects.toThrow('退出未确认')
    expect(s.claudeStartAccountOverride).toBeUndefined()
    expect(s.lastSessionRef).toEqual(original)
  })
  test('current account source and peer label follow the actual process, not the default account', () => {
    const s = session(); running(s, accountB)
    expect(s.currentTokenSource().accountId).toBe(accountB)
    expect(s.tokenSourceAccountId('claude-sub')).toBe(accountB)
    expect(s.peerSnapshot().claudeAccountName).toBe('B')
    expect(s.conversationRouting().claudeAccountId).toBe(accountB)
    expect(s.claudeHistoryOptions()).toEqual({ configDir: store.sharedConfigDir() })
  })
  test('temporary session inherits account for its first start', () => {
    const original = session(); running(original, accountA)
    const target = session()
    target.applyConversationRouting(original.conversationRouting())
    expect(target.claudeStartAccountOverride).toBe(accountA)
    expect(target.currentTokenSource().accountId).toBe(accountA)
  })
  test('the shared launch binds the automatic account and holds its lease until confirmed exit', async () => {
    const s = session()
    Object.defineProperty(s, 'workDir', { value: root, configurable: true })
    const choose = spyOn(selection, 'selectClaudeAccount').mockReturnValue(accountB)
    spies.push(choose)
    const proc = s.spawnAgent()
    try {
      expect(choose).toHaveBeenCalledWith({ model: 'opus', effort: 'high', preferred: null, activeSessions: new Map() })
      expect(processClaudeAccount(proc)).toBe(accountB)
      await expect(store.enroll('B', async () => accountInfo('b@example.test'))).rejects.toThrow('使用')
    } finally { await proc.kill() }
    expect((await store.enroll('B', async () => accountInfo('b@example.test'))).id).toBe(accountB)
  })
  test('Session spawn forwards actual active-account counts and the next synchronous launch sees the first binding', async () => {
    const executing = session('active-A'); running(executing, accountA); executing.status = 'working'
    const recent = session('recent-A'); running(recent, accountA)
    const existingB = session('active-B'); running(existingB, accountB); existingB.status = 'working'
    const thirdParty = session('third-party'); running(thirdParty, accountA)
    thirdParty.proc.tokenSourceId = 'packy'; thirdParty.status = 'working'
    const target = session('first-target'), secondTarget = session('second-target')
    // The current chat must never be counted once as its old binding and again as the new launch.
    const old = running(target, accountA); target.status = 'working'
    for (const s of [target, secondTarget]) Object.defineProperty(s, 'workDir', { value: root, configurable: true })
    const messageTimes = spyOn(sessionActivity, 'lastUserMessageAt').mockImplementation(chatId =>
      chatId === recent.chatId ? Date.now() - 60_000 : undefined)
    const snapshots: Array<Array<[string, number]>> = []
    const choose = spyOn(selection, 'selectClaudeAccount').mockImplementation(options => {
      const counts = options.activeSessions ?? new Map<string, number>()
      snapshots.push([...counts].sort(([a], [b]) => a.localeCompare(b)))
      return (counts.get(accountA) ?? 0) <= (counts.get(accountB) ?? 0) ? accountA : accountB
    })
    spies.push(messageTimes, choose)
    // Constructors are inert until sendInitialize; this exercises the real shared launch and binding only.
    const first = target.spawnAgent()
    let second: NonNullable<Session['proc']> | undefined
    try {
      expect(new Map(snapshots[0])).toEqual(new Map([[accountA, 2], [accountB, 1]]))
      expect(processClaudeAccount(first)).toBe(accountB)
      old.alive = false
      target.attachProc(first)
      target.status = 'starting'
      second = secondTarget.spawnAgent()
      expect(new Map(snapshots[1])).toEqual(new Map([[accountA, 2], [accountB, 2]]))
      expect(processClaudeAccount(second)).toBe(accountA)
      expect(choose).toHaveBeenCalledTimes(2)
      expect(snapshots[0]).not.toEqual(snapshots[1])
    } finally {
      target.detachProc(first)
      await first.kill()
      await second?.kill()
    }
  })
  test('a named launch passes its explicit account once; the next launch asks for automatic selection', async () => {
    const s = session()
    Object.defineProperty(s, 'workDir', { value: root, configurable: true })
    const choose = spyOn(selection, 'selectClaudeAccount').mockReturnValue(accountA)
    spies.push(choose)
    s.claudeStartAccountOverride = accountA
    const first = s.spawnAgent()
    expect(choose.mock.calls[0][0].preferred).toBe(accountA)
    expect(s.claudeStartAccountOverride).toBeUndefined()
    await first.kill()
    choose.mockReturnValue(accountB)
    const next = s.spawnAgent()
    try {
      expect(choose.mock.calls[1][0].preferred).toBeNull()
      expect(processClaudeAccount(next)).toBe(accountB)
    } finally { await next.kill() }
  })
  test('history listing reads shared project storage while account configuration differs', () => {
    const project = join(root, 'project'); mkdirSync(project)
    const encoded = project.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(store.sharedConfigDir(), 'projects', encoded); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'shared-history.jsonl'), JSON.stringify({ type: 'user', message: { content: 'shared history marker' } }) + '\n')
    const a = listClaudeSessions(project, { configDir: store.get(accountA).configDir })
    const b = listClaudeSessions(project, { configDir: store.get(accountB).configDir })
    expect(a.map(x => x.sessionId)).toEqual(['shared-history'])
    expect(b).toEqual(a)
  })
  test('history listing separates encoded cwd collisions and excludes orphan and sidechain records', () => {
    const first = join(root, 'project.a'), other = join(root, 'project-a')
    mkdirSync(first); mkdirSync(other)
    const dir = join(store.sharedConfigDir(), 'projects', first.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const line = (cwd: string, isSidechain = false) => JSON.stringify({ cwd, isSidechain,
      type: 'user', message: { content: 'correct project marker' } }) + '\n'
    writeFileSync(join(dir, 'mine.jsonl'), line(first))
    writeFileSync(join(dir, 'other.jsonl'), line(other))
    writeFileSync(join(dir, 'child.jsonl'), line(first, true))
    writeFileSync(join(dir, 'mine.orphaned-123-a.jsonl'), line(first))
    expect(listClaudeSessions(first, { configDir: store.sharedConfigDir() }).map(x => x.sessionId)).toEqual(['mine'])
    expect(listClaudeSessions(other, { configDir: store.sharedConfigDir() }).map(x => x.sessionId)).toEqual(['other'])
  })
  test.each([false, true])('native authentication is awaited before declaring %s ready, and its revision is captured once', async resume => {
    const s = session(), proc = new Proc()
    Object.defineProperty(s, 'workDir', { value: root, configurable: true })
    bindProcessClaudeAccount(proc as any, accountB)
    let ready!: () => void
    const init = new Promise<void>(resolve => { ready = resolve })
    Object.assign(proc, { initializationPromise: () => init })
    const child = getTokenSourceForAccount('claude-sub', accountB)!
    const spawn = spyOn(s, 'spawnAgent').mockImplementation(() => {
      s.procSourceRevisions.set(proc, child.spawnRevision)
      return proc
    })
    spies.push(spawn)
    if (resume) {
      s.lastSessionRef = { provider: 'claude', sessionId: proc.sessionId, cwd: root }
      s.lastSessionId = proc.sessionId
    }
    let settled = false
    const start = (resume ? s.restart(true, { announce: false }) : s.start({ announce: false }))
      .then((value: boolean) => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 280))
    expect(settled).toBe(false)
    child.spawnRevision = 'newly-verified-identity'
    ready()
    expect(await start).toBe(true)
    expect(s.processSourceMatches(child)).toBe(true)
    child.spawnRevision = 'later-unverified-identity'
    expect(s.processSourceMatches(child)).toBe(false)
    await proc.kill()
  })
})
