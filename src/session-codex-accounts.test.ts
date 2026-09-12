import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFeishuMock, sentCards, sentTexts } from './feishu-test-mock'
import { Session } from './session'
import { bindProcessCodexAccount, codexAccounts, CodexAccounts, reserveCodexLogin } from './codex-accounts'
import { codexLogins } from './codex-login'
import * as accountCommands from './session-codex-accounts'
import { CodexAccountCard } from './codex-account-card'
import type { CodexAccountCardView } from './cards/codex-account'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, type TokenSource } from './token-source'
import { peekUsage, peekSuccessfulUsage, refreshUsageFromConnection } from './usage'

let root: string
let store: CodexAccounts
const spies: Array<{ mockRestore(): void }> = []
let previous: TokenSource[]
const sessions: Session[] = []
const procs: Proc[] = []
const cardViews: CodexAccountCardView[] = []
class Proc extends EventEmitter {
  provider = 'codex' as const
  tokenSourceId = 'codex-sub'
  sessionId = 'shared-thread'
  lastModel = 'shared-model'
  lastEffort = 'high' as const
  alive = true
  killCalls = 0
  launchKind = 'resume'
  isAlive() { return this.alive }
  isConversationResumable() { return true }
  conversationMaterializationBarrier() { return null }
  initializationPromise() { return Promise.resolve() }
  sendInitialize() {}
  async kill() { this.killCalls++; this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
}
function source(): TokenSource {
  return { id: 'codex-sub', kind: 'codex-subscription', agent: 'codex', display: 'Codex 订阅', enabled: true,
    models: [{ model: 'shared-model', display: 'Shared', efforts: ['high'], defaultEffort: 'high' }],
    defaultModel: 'shared-model', modelCatalogState: { status: 'ready', updatedAt: 1 },
    refreshModels: async () => {}, spawnEnv: env => env, resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'ok', windows: [] }) }
}
function session(): any {
  const s = new Session(`account-test-${sessions.length}`, 'chat-account') as any
  s.selectedProvider = 'codex'; s.selectedTokenSourceId = 'codex-sub'
  s.selectedModel = 'shared-model'; s.selectedEffort = 'high'
  sessions.push(s)
  return s
}
beforeEach(() => {
  resetFeishuMock()
  cardViews.length = 0
  spies.push(spyOn(CodexAccountCard, 'open').mockImplementation(async (_chatId, view) => {
    cardViews.push(view)
    return { cardId: 'codex-card-test',
      update: async (next: CodexAccountCardView) => { cardViews.push(next) },
      finish: async (next: CodexAccountCardView) => { cardViews.push(next) },
    } as unknown as CodexAccountCard
  }))
  root = mkdtempSync(join(tmpdir(), 'session-codex-account-'))
  mkdirSync(join(root, 'native'))
  store = new CodexAccounts(join(root, 'native'), join(root, 'accounts'), join(root, 'state.json'))
  for (const key of ['list', 'get', 'find', 'ensure', 'remove', 'selected', 'preferred', 'selectAuto', 'select', 'recordLogin', 'home', 'revision'] as const) {
    spies.push(spyOn(codexAccounts, key).mockImplementation((...args: any[]) => (store[key] as any)(...args)))
  }
  previous = listTokenSources(); resetTokenSourceRegistry()
  const native = source()
  const bound = new Map<string, TokenSource>()
  native.forAccount = id => {
    if (id === 'default') return native
    if (!bound.has(id)) bound.set(id, { ...source(), spawnRevision: id })
    return bound.get(id)!
  }
  registerTokenSource(native)
})
afterEach(async () => {
  for (const proc of procs.splice(0)) if (proc.isAlive()) await proc.kill()
  for (const s of sessions.splice(0)) s.dispose()
  for (const spy of spies.splice(0)) spy.mockRestore()
  resetTokenSourceRegistry(); for (const s of previous) registerTokenSource(s)
  rmSync(root, { recursive: true, force: true })
})

describe('bare Codex account commands', () => {
  test('hi with a remark forces that account for one launch without persisting it or checking its catalog', async () => {
    const account = store.ensure('强制 Plus')
    const s = session(); s.selectedEffort = 'ultra'
    const namedSource = s.tokenSource('codex-sub').forAccount(account.id)
    namedSource.enabled = false; namedSource.models = []; namedSource.modelCatalogState = { status: 'failed', error: 'offline' }
    let override: string | undefined
    s.spawnAgent = () => {
      override = s.codexStartAccountOverride
      const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, override!)
      return proc
    }
    const console = spyOn(s, 'showConsole').mockResolvedValue(undefined); spies.push(console)
    expect(await s.runCommand('HI 强制 Plus', 'owner')).toBe(true)
    expect(override).toBe(account.id)
    expect(s.codexAccountId()).toBe(account.id)
    expect(store.preferred(s.sessionName)).toBeNull()
    expect(s.codexStartAccountOverride).toBeUndefined()
    expect(cardViews.at(-1)).toMatchObject({ phase: 'current', current: account.name })
    expect(console).toHaveBeenCalledTimes(1)
  })
  test('hi named replaces a running account through native resume; unknown names and failed startup do not select another', async () => {
    const account = store.ensure('next')
    const s = session()
    const old = new Proc(); procs.push(old); bindProcessCodexAccount(old, 'default'); s.proc = old; s.wireProc(old)
    let resumed: any
    s.spawnAgent = (ref: any) => {
      resumed = ref
      const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, s.codexStartAccountOverride)
      return proc
    }
    spies.push(spyOn(s, 'showConsole').mockResolvedValue(undefined))
    await s.runCommand('hi next', 'owner')
    expect(resumed.sessionId).toBe('shared-thread'); expect(old.killCalls).toBe(1)
    expect(s.codexAccountId()).toBe(account.id)
    await s.runCommand('hi unknown', 'owner')
    expect(s.codexAccountId()).toBe(account.id); expect(cardViews.at(-1)?.phase).toBe('error')
    await s.stop('cleanup', { announce: false })
    s.spawnAgent = () => { throw new Error('native auth failed') }
    await s.runCommand('hi next', 'owner')
    expect(cardViews.at(-1)?.message).toContain('native auth failed')
    expect(store.preferred(s.sessionName)).toBeNull(); expect(s.codexStartAccountOverride).toBeUndefined()
  })
  test('named hi with embedded newlines is not consumed as an account command', async () => {
    const s = session()
    const dispatch = spyOn(accountCommands, 'runCodexNamedHi').mockResolvedValue(undefined); spies.push(dispatch)
    expect(await s.runCommand('hi remark\ncontinue task', 'owner')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  test('auto clears manual preference and temporary sessions inherit auto without pinning the running account', async () => {
    const account = store.ensure('manual')
    const s = session(); store.select(s.sessionName, account.id)
    await s.runCommand('codex-auto', 'owner')
    expect(store.preferred(s.sessionName)).toBeNull()
    expect(cardViews.at(-1)?.selected).toContain('自动')
    const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, account.id); s.proc = proc
    const routing = s.conversationRouting()
    expect(routing).toMatchObject({ codexAccountId: account.id, codexAccountAutomatic: true })
    const next = session(); store.select(next.sessionName, account.id)
    next.applyConversationRouting(routing)
    expect(store.preferred(next.sessionName)).toBeNull()
  })

  test('quota wait releases startup actor with an explicit waiting state, so stop can cancel', async () => {
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    proc.sessionId = null
    proc.quotaWaitPromise = () => Promise.resolve()
    proc.initializationPromise = () => new Promise(() => {})
    proc.turnRetry = { reason: 'quota', phase: 'waiting', message: '等待额度恢复', attempt: 0, delayMs: 60_000 }
    s.spawnAgent = () => proc
    expect(await s.start({ announce: false })).toBe(true)
    expect(s.status).toBe('starting')
    expect(s.initCount).toBe(0)
    const replacements: string[] = []
    spies.push(spyOn(s, 'replaceStatusCardWithConsole').mockImplementation(async (_card: any, status: string) => { replacements.push(status) }))
    spies.push(spyOn(s, 'openStatusCard').mockResolvedValue(null))
    await s.runCommand('hi', 'owner')
    expect(replacements).toEqual([])
    await s.runCommand('stop', 'owner')
    expect(proc.isAlive()).toBe(false)
  })

  test('footer uses only the live account quota even when a different account is selected for restart', async () => {
    const account = store.ensure('next')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    bindProcessCodexAccount(proc, 'default')
    s.proc = proc
    store.select(s.sessionName, account.id)
    let reads = 0
    proc.readRateLimits = async () => {
      reads++
      return { rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300 }, secondary: { usedPercent: 23, windowDurationMins: 10080 } } }
    }
    const suffix = await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null)
    expect(suffix).toBe('  |  11%·[23%]')
    expect(reads).toBe(1)
    expect(s.codexAccountId()).toBe('default')
    expect(suffix).not.toContain('账号')
    expect(suffix).not.toContain('份额')
  })

  test('only codex-prefixed commands enter account management', async () => {
    const s = session()
    const dispatch = spyOn(accountCommands, 'runCodexAccountCommand').mockResolvedValue(undefined)
    spies.push(dispatch)
    for (const raw of ['login', 'login 工作', 'accounts', 'account', 'account default',
      'login-cancel', 'login-cancel 工作', 'codex-login\n工作', 'codex-login 工作\n继续解释',
      'account-delete 工作', 'codex-account-delete 工作\n继续解释']) {
      expect(await s.runCommand(raw, 'owner')).toBe(false)
    }
    expect(dispatch).not.toHaveBeenCalled()
    const commands = [
      ['codex-login', 'login', ''],
      ['codex-login 工作 订阅', 'login', '工作 订阅'],
      ['codex-login-cancel 工作 订阅', 'login-cancel', '工作 订阅'],
      ['codex-accounts', 'accounts', ''],
      ['codex-account', 'account', ''],
      [' CODEX-ACCOUNT\tdefault ', 'account', 'default'],
      ['codex-account-delete', 'account-delete', ''],
      [' CODEX-ACCOUNT-DELETE\t工作 订阅 ', 'account-delete', '工作 订阅'],
    ]
    for (const [raw, command, argument] of commands) {
      expect(await s.runCommand(raw, 'owner')).toBe(true)
      expect(dispatch).toHaveBeenLastCalledWith(s, command, argument, 'owner')
    }
    expect(sentTexts).toHaveLength(0)
    expect(sentCards).toHaveLength(0)
  })

  test('deletion clears selections and quota caches without requiring a model catalog or touching the live session', async () => {
    const s = session()
    const account = store.ensure('工作 订阅')
    const home = store.prepareHome(account.id)
    writeFileSync(join(home, 'auth.json'), 'temporary test credentials')
    store.select(s.sessionName, account.id)
    store.select('another-group', account.id)
    const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, 'default'); s.proc = proc
    s.tokenSource('codex-sub').models = []
    s.tokenSource('codex-sub').modelCatalogState = { status: 'failed', error: 'offline' }
    await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 15, windowDurationMins: 300 } } }), account.id)
    expect(peekSuccessfulUsage(account.id)).not.toBeNull()
    let release!: (value: any) => void
    const pending = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), account.id)

    expect(await s.runCommand('codex-account-delete 工作 订阅', 'owner')).toBe(true)
    expect(cardViews.at(-1)).toMatchObject({ phase: 'deleted', name: account.name })
    expect(cardViews.at(-1)?.hint).toContain('2 个群')
    expect(existsSync(home)).toBe(false)
    expect(store.preferred(s.sessionName)).toBeNull()
    expect(store.preferred('another-group')).toBeNull()
    expect(proc.killCalls).toBe(0)
    expect(s.proc).toBe(proc)
    expect(peekUsage(account.id)).toBeNull()
    expect(peekSuccessfulUsage(account.id)).toBeNull()
    release({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } })
    expect(await pending).toBeNull()
    expect(peekSuccessfulUsage(account.id)).toBeNull()
    expect(sentTexts).toHaveLength(0)
  })

  test('deletion requires a named account and rejects native, unknown, active, and login accounts', async () => {
    const s = session()
    const account = store.ensure('受保护')
    for (const [raw, message] of [
      ['codex-account-delete', '请指定'],
      ['codex-account-delete default', '默认账号'],
      ['codex-account-delete 默认', '默认账号'],
      ['codex-account-delete missing', '不存在'],
    ]) {
      await s.runCommand(raw, 'owner')
      expect(cardViews.at(-1)?.phase).toBe('error')
      expect(cardViews.at(-1)?.message).toContain(message)
    }
    // A native child can belong to another group or a delegated task, without being this Session's proc.
    const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, account.id)
    await s.runCommand('codex-account-delete 受保护', 'owner')
    expect(cardViews.at(-1)?.message).toBe('账号正在使用中')
    expect(proc.killCalls).toBe(0)
    expect(store.get(account.id)).toEqual(account)
    await proc.kill()
    // Waiting tasks keep an account reference after their native child exits, but may still reauthenticate.
    const waiting = new Proc(); procs.push(waiting); bindProcessCodexAccount(waiting, account.id, false)
    const releaseWaitingLogin = reserveCodexLogin(account.id)
    releaseWaitingLogin()
    await s.runCommand('codex-account-delete 受保护', 'owner')
    expect(cardViews.at(-1)?.message).toBe('账号正在使用中')
    expect(waiting.killCalls).toBe(0)
    await waiting.kill()
    const release = reserveCodexLogin(account.id)
    try {
      await s.runCommand('codex-account-delete 受保护', 'owner')
      expect(cardViews.at(-1)?.message).toBe('账号正在登录')
      expect(store.get(account.id)).toEqual(account)
    } finally { release() }
    await s.runCommand('codex-account-delete 受保护', 'owner')
    expect(cardViews.at(-1)?.phase).toBe('deleted')
    expect(() => store.get(account.id)).toThrow('不存在')
  })

  test('inherited default routing clears a previous named-account selection', () => {
    const account = store.ensure('previous')
    const s = session()
    store.select(s.sessionName, account.id)
    s.applyConversationRouting({ provider: 'codex', tokenSourceId: 'codex-sub', model: 'shared-model', effort: 'high' })
    expect(store.selected(s.sessionName)).toBe('default')
  })

  test('selection stays pending until restart and then resumes the same thread under the named account', async () => {
    const account = store.ensure('工作 订阅')
    const s = session()
    const old = new Proc(); procs.push(old)
    bindProcessCodexAccount(old, 'default')
    s.proc = old; s.wireProc(old)
    expect(await s.runCommand('codex-account 工作 订阅', 'owner')).toBe(true)
    expect(store.selected(s.sessionName)).toBe(account.id)
    expect(s.codexAccountId()).toBe('default')
    expect(old.killCalls).toBe(0)
    expect(sentCards).toHaveLength(0)
    expect(cardViews.at(-1)).toMatchObject({ phase: 'selected', name: '工作 订阅', hint: 'restart 直接使用 · 不检查调度门槛' })
    let resumed: any = null
    s.spawnAgent = (ref: any) => {
      resumed = ref
      const proc = new Proc(); procs.push(proc)
      bindProcessCodexAccount(proc, store.selected(s.sessionName))
      return proc
    }
    expect(await s.restart(true, { announce: false })).toBe(true)
    expect(resumed.sessionId).toBe('shared-thread')
    expect(s.lastSessionId).toBe('shared-thread')
    expect(s.codexAccountId()).toBe(account.id)
    expect(old.killCalls).toBe(1)
    const other = session()
    expect(other.codexAccountId()).toBe('default')
    expect(await s.runCommand('codex-account default', 'owner')).toBe(true)
    expect(s.codexAccountId()).toBe(account.id)
    expect(await s.restart(true, { announce: false })).toBe(true)
    expect(s.codexAccountId()).toBe('default')
    expect(s.lastSessionId).toBe('shared-thread')
    await s.stop('test cleanup', { announce: false })
  })

  test('unknown account is rejected, but explicit selection does not require model availability', async () => {
    const s = session()
    await s.runCommand('codex-account missing', 'owner')
    expect(store.selected(s.sessionName)).toBe('default')
    expect(cardViews.at(-1)?.message).toContain('不存在')
    const a = store.ensure('limited')
    s.tokenSource('codex-sub').forAccount(a.id).models = []
    await s.runCommand('codex-account limited', 'owner')
    expect(store.selected(s.sessionName)).toBe(a.id)
    expect(cardViews.at(-1)?.phase).toBe('selected')
  })

  test('login replies update cards with instructions and terminal cancellation', async () => {
    const s = session()
    const started: string[] = []
    let reject!: (error: Error) => void
    const done = new Promise<any>((_resolve, no) => { reject = no })
    spies.push(spyOn(codexLogins, 'start').mockImplementation(async id => {
      started.push(id)
      return { accountId: id, loginId: 'login-id', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', done }
    }))
    await s.runCommand('codex-login', 'owner')
    await s.runCommand('codex-login 第二订阅', 'owner')
    expect(started).toEqual(['default', store.find('第二订阅').id])
    await s.runCommand('codex-account-delete 第二订阅', 'owner')
    expect(cardViews.at(-1)?.phase).toBe('error')
    expect(cardViews.at(-1)?.message).toContain('尚未结束')
    expect(cardViews.filter(v => v.phase === 'waiting').map(v => v.verification?.code)).toEqual(['TEST-CODE', 'TEST-CODE'])
    expect(cardViews.filter(v => v.phase === 'waiting').every(v => v.verification?.url === 'https://auth.openai.com/codex/device')).toBe(true)
    expect(sentTexts).toHaveLength(0)
    expect(sentCards).toHaveLength(0)
    reject(new Error('test cancellation'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cardViews.filter(view => view.message?.includes('test cancellation'))).toHaveLength(2)
  })

  test('login cannot overwrite credentials used by a live process, including delegated processes', async () => {
    const s = session()
    const proc = new Proc(); procs.push(proc)
    bindProcessCodexAccount(proc, 'default')
    const start = spyOn(codexLogins, 'start'); spies.push(start)
    await s.runCommand('codex-login', 'owner')
    expect(start).not.toHaveBeenCalled()
    expect(cardViews.at(-1)?.message).toBe('账号正在使用中')
    expect(await s.runCommand('codex-login 带备注\n继续解释', 'owner')).toBe(false)
  })
})
