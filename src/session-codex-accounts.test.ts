import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFeishuMock, sentCards, sentTexts } from './feishu-test-mock'
import { Session } from './session'
import { bindProcessCodexAccount, codexAccounts, CodexAccounts, reserveCodexLogin } from './codex-accounts'
import { codexLogins } from './codex-login'
import * as loginModule from './codex-login'
import * as accountCommands from './session-codex-accounts'
import { CodexAccountCard } from './codex-account-card'
import type { CodexAccountCardView } from './cards/codex-account'
import { getTokenSourceForAccount, listTokenSources, refreshAllTokenSourceModels, registerTokenSource, resetTokenSourceRegistry, type TokenSource } from './token-source'
import { peekUsage, peekSuccessfulUsage, refreshUsageFromConnection } from './usage'
import * as usageModule from './usage'
import { codexAccountScheduler } from './codex-account-scheduler'
import { codexAccountCard } from './cards/codex-account'

let root: string
let quotaNow: number
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
  usageModule.invalidateCodexUsage('default')
  quotaNow = Date.now()
  spies.push(spyOn(Date, 'now').mockImplementation(() => quotaNow))
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
  usageModule.invalidateCodexUsage('default')
  for (const proc of procs.splice(0)) if (proc.isAlive()) await proc.kill()
  for (const s of sessions.splice(0)) s.dispose()
  for (const spy of spies.splice(0)) spy.mockRestore()
  resetTokenSourceRegistry(); for (const s of previous) registerTokenSource(s)
  rmSync(root, { recursive: true, force: true })
})

describe('bare Codex account commands', () => {
  test('account list shows a logged-in named account even when the default account has no model', async () => {
    const account = store.ensure('新登录账号')
    const native = getTokenSourceForAccount('codex-sub')!
    native.enabled = false; native.models = []; native.defaultModel = ''
    native.modelCatalogState = { status: 'disabled', updatedAt: 1, error: 'Codex 订阅未登录' }
    const s = session(); s.selectedProvider = 'claude'; s.selectedTokenSourceId = 'glm'
    const read = spyOn(usageModule, 'readUsage').mockImplementation(async id => id === account.id
      ? { state: 'ok', subscriptionType: 'plus', fiveHour: { percent: 7, resetsAt: null }, weekly: null,
        resetCredits: 0, fetchedAt: 1, accountFingerprint: 'named-identity' }
      : { state: 'no_credentials' })
    const choose = spyOn(codexAccountScheduler, 'choose').mockResolvedValue({ selected: null, candidates: [] })
    spies.push(read, choose)
    await s.runCommand('codex-accounts', 'owner')
    expect(read.mock.calls.map(([id]) => id)).toEqual(['default', account.id])
    expect(choose).not.toHaveBeenCalled()
    const view = cardViews.at(-1)!
    expect(view.phase).toBe('accounts')
    expect(view.scheduling).toBeUndefined()
    expect(view.message).toContain('调度顺序 MISS')
    expect(view.details).toContain('默认'); expect(view.details).toContain('未登录')
    const card = JSON.stringify(codexAccountCard(view))
    expect(card).toContain('新登录账号'); expect(card).toContain('5h · 7%')
    expect(card).toContain('调度顺序 MISS'); expect(card).not.toContain('可调度 0')
    expect(store.preferred(s.sessionName)).toBeNull(); expect(s.proc).toBeNull()
  })

  test('account list uses the selected named catalog while the current provider is Claude', async () => {
    const account = store.ensure('已指定账号')
    const s = session(); s.selectedProvider = 'claude'; s.selectedTokenSourceId = 'glm'
    store.select(s.sessionName, account.id)
    getTokenSourceForAccount('codex-sub', account.id)!.defaultModel = 'named-model'
    const choose = spyOn(codexAccountScheduler, 'choose').mockResolvedValue({ selected: null, candidates: [] })
    spies.push(choose)
    await s.runCommand('codex-accounts', 'owner')
    expect(choose).toHaveBeenCalledWith({ model: 'named-model', effort: undefined })
    expect(cardViews.at(-1)?.phase).toBe('accounts')
    expect(s.selectedProvider).toBe('claude')
  })

  test('account list refreshes a missing model and reports persistent catalog errors alongside quota', async () => {
    const s = session(); s.selectedModel = null
    const native = getTokenSourceForAccount('codex-sub')!
    native.defaultModel = ''; native.models = []; native.modelCatalogState = { status: 'failed', updatedAt: 1, error: 'old timeout' }
    const refresh = spyOn(native, 'refreshModels').mockImplementation(async () => {
      native.defaultModel = 'recovered-model'; native.modelCatalogState = { status: 'ready', updatedAt: 2 }
    })
    const choose = spyOn(codexAccountScheduler, 'choose').mockResolvedValue({ selected: null, candidates: [] })
    const read = spyOn(usageModule, 'readUsage').mockResolvedValue({ state: 'network', reason: 'quota HTTP 503' })
    spies.push(refresh, choose, read)
    await s.runCommand('codex-accounts', 'owner')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(choose).toHaveBeenCalledWith({ model: 'recovered-model', effort: 'high' })
    expect(read).not.toHaveBeenCalled()
    native.defaultModel = ''
    refresh.mockImplementation(async () => { throw new Error('catalog HTTP 503 after 3 attempts') })
    await s.runCommand('codex-accounts', 'owner')
    const view = cardViews.at(-1)!
    expect(view.phase).toBe('accounts'); expect(view.details).toContain('catalog HTTP 503 after 3 attempts')
    expect(view.message).toContain('调度顺序 MISS')
    expect(JSON.stringify(codexAccountCard(view))).toContain('quota HTTP 503')
    expect(choose).toHaveBeenCalledTimes(1)
  })

  test('account list waits for an existing catalog refresh before resolving its model', async () => {
    const s = session(); s.selectedModel = null
    const native = getTokenSourceForAccount('codex-sub')!
    native.defaultModel = ''
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const refresh = spyOn(native, 'refreshModels').mockImplementation(async () => {
      await gate
      native.defaultModel = 'loaded-model'; native.modelCatalogState = { status: 'ready', updatedAt: 2 }
    })
    const choose = spyOn(codexAccountScheduler, 'choose').mockResolvedValue({ selected: null, candidates: [] })
    spies.push(refresh, choose)
    const loading = refreshAllTokenSourceModels()
    const command = s.runCommand('codex-accounts', 'owner')
    await new Promise(resolve => setTimeout(resolve, 0))
    const waiting = cardViews.at(-1)?.phase
    release(); await loading; await command
    expect(waiting).toBe('checking')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(choose).toHaveBeenCalledWith({ model: 'loaded-model', effort: 'high' })
  })

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

  test('footer retains the live account quota across failed refreshes and updates it after recovery', async () => {
    const account = store.ensure('footer-cache')
    const next = store.ensure('footer-next')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    bindProcessCodexAccount(proc, account.id)
    s.proc = proc
    store.select(s.sessionName, next.id)
    const response = (percent: number) => ({ rateLimits: {
      primary: { usedPercent: percent, windowDurationMins: 300 },
      secondary: { usedPercent: 23, windowDurationMins: 10080 },
    } })
    const cached = await refreshUsageFromConnection(async () => response(11), account.id)
    await refreshUsageFromConnection(async () => response(99), next.id)
    let reads = 0
    proc.readRateLimits = async () => { reads++; throw new Error('quota read failed') }
    try {
      expect(await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null)).toBe('  |  11%·[23%]')
      expect(reads).toBe(0)
      quotaNow += 60_000
      for (let attempt = 0; attempt < 2; attempt++) {
        const suffix = await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null)
        expect(suffix).toBe('  |  11%·[23%]')
        expect(peekUsage(account.id)).toBeNull()
        expect(cached).toBe(peekSuccessfulUsage(account.id))
      }
      expect(reads).toBe(1)
      proc.readRateLimits = async () => response(15)
      quotaNow += 60_000
      expect(await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null))
        .toBe('  |  15%·[23%]')
    } finally {
      usageModule.invalidateCodexUsage(account.id)
      usageModule.invalidateCodexUsage(next.id)
    }
  })

  test('footer keeps MISS for cold caches, invalidated logins and malformed fresh percentages', async () => {
    const account = store.ensure('footer-missing')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    bindProcessCodexAccount(proc, account.id); s.proc = proc
    const read = () => s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null)
    try {
      proc.readRateLimits = async () => { throw new Error('quota read failed') }
      expect(await read()).toBe('  |  额度 MISS')
      quotaNow += 60_000
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 11, windowDurationMins: 300 },
      } }), account.id)
      proc.readRateLimits = async () => { throw new Error('HTTP 401 unauthorized') }
      quotaNow += 60_000
      expect(await read()).toBe('  |  额度 MISS')
      proc.readRateLimits = async () => ({ rateLimits: {
        primary: { usedPercent: null, windowDurationMins: 300 },
      } })
      quotaNow += 60_000
      expect(await read()).toBe('  |  MISS')
    } finally { usageModule.invalidateCodexUsage(account.id) }
  })

  test('a closing footer keeps its original account when the process switches before quota rendering', async () => {
    const account = store.ensure('footer-old')
    const next = store.ensure('footer-new')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    bindProcessCodexAccount(proc, account.id); s.proc = proc
    let reads = 0
    proc.readRateLimits = async () => { reads++; throw new Error('must not read the replacement account') }
    try {
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 11, windowDurationMins: 300 },
      } }), account.id)
      const cache = usageModule.captureCodexUsageCache(account.id)
      bindProcessCodexAccount(proc, next.id)
      expect(await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), cache))
        .toBe('  |  11%')
      expect(reads).toBe(0)
      usageModule.invalidateCodexUsage(account.id)
      expect(await s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), cache))
        .toBe('  |  额度 MISS')
    } finally { usageModule.invalidateCodexUsage(account.id) }
  })

  test('a quota reset during a footer refresh invalidates its old cache and late response', async () => {
    const account = store.ensure('footer-reset')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    bindProcessCodexAccount(proc, account.id); s.proc = proc
    const response = { rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300 } } }
    await refreshUsageFromConnection(async () => response, account.id)
    quotaNow += 60_000
    let release!: (value: any) => void
    proc.readRateLimits = () => new Promise(resolve => { release = resolve })
    const pending = s.footerUsageSuffix('codex', proc, 'codex-sub', s.currentTokenSource(), null)
    await Promise.resolve()
    try {
      usageModule.invalidateCodexUsage(account.id)
      await refreshUsageFromConnection(async () => ({ rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300 },
      } }), account.id)
      release(response)
      expect(await pending).toBe('  |  额度 MISS')
      expect(peekSuccessfulUsage(account.id)?.fiveHour?.percent).toBe(0)
    } finally {
      release(response)
      await pending
      usageModule.invalidateCodexUsage(account.id)
    }
  })

  test('hi peer account names follow the live Codex process, including automatic switches', () => {
    const active = store.ensure('实际账号')
    const pending = store.ensure('下次账号')
    const s = session()
    const proc = new Proc() as any; procs.push(proc)
    s.proc = proc
    proc.codexAccountSelectionMode = () => null
    expect(s.peerSnapshot().codexAccountName).toBeUndefined()
    proc.codexAccountSelectionMode = () => 'automatic'
    bindProcessCodexAccount(proc, active.id)
    store.select(s.sessionName, pending.id)
    expect(s.peerSnapshot().codexAccountName).toBe('实际账号')
    bindProcessCodexAccount(proc, 'default')
    expect(s.peerSnapshot().codexAccountName).toBe('默认')
    proc.turnRetry = { reason: 'quota', phase: 'waiting' }
    expect(s.peerSnapshot().codexAccountName).toBeUndefined()
    proc.turnRetry = null
    for (const provider of ['claude', 'dsh']) {
      proc.provider = provider
      expect(s.peerSnapshot().codexAccountName).toBeUndefined()
    }
    proc.provider = 'codex'
    proc.alive = false
    expect(s.peerSnapshot().codexAccountName).toBeUndefined()
    proc.alive = true
  })

  test('only codex-prefixed commands enter account management', async () => {
    const s = session()
    const dispatch = spyOn(accountCommands, 'runCodexAccountCommand').mockResolvedValue(undefined)
    spies.push(dispatch)
    for (const raw of ['login', 'login 工作', 'accounts', 'account', 'account default',
      'login-cancel', 'login-cancel 工作', 'codex-login\n工作', 'codex-login 工作\n继续解释',
      'account-delete 工作', 'codex-account-delete 工作\n继续解释', 'reset', 'codex-reset 工作\n继续解释']) {
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
      ['codex-reset', 'reset', ''],
      [' CODEX-RESET\t工作 订阅 ', 'reset', '工作 订阅'],
    ]
    for (const [raw, command, argument] of commands) {
      expect(await s.runCommand(raw, 'owner', 'message-123')).toBe(true)
      expect(dispatch).toHaveBeenLastCalledWith(s, command, argument, 'owner', 'message-123')
    }
    expect(sentTexts).toHaveLength(0)
    expect(sentCards).toHaveLength(0)
  })

  test('reset targets the running account during a turn and keeps message retries idempotent', async () => {
    const s = session()
    const active = store.ensure('当前账号'); const next = store.ensure('下次账号')
    const proc = new Proc(); procs.push(proc); bindProcessCodexAccount(proc, active.id)
    s.proc = proc; s.turnActive = true; store.select(s.sessionName, next.id)
    const consume = spyOn(usageModule, 'consumeCodexResetCredit').mockResolvedValue({ outcome: 'reset',
      usage: { state: 'ok', fiveHour: null, weekly: { percent: 3, resetsAt: null }, resetCredits: 0, fetchedAt: 1 } })
    spies.push(consume)
    expect(await s.runCommand('codex-reset', 'owner', 'same-message')).toBe(true)
    const key = consume.mock.calls[0][1]
    expect(consume).toHaveBeenLastCalledWith(active.id, key)
    expect(cardViews.at(-1)).toMatchObject({ phase: 'success', name: active.name, title: '额度已重置', resetUsage: { resetCredits: 0 } })
    await s.runCommand('codex-reset', 'owner', 'same-message')
    expect(consume).toHaveBeenLastCalledWith(active.id, key)
    await s.runCommand('codex-reset', 'owner', 'new-message')
    expect(consume.mock.calls[2][1]).not.toBe(key)
    expect(store.preferred(s.sessionName)).toBe(next.id)
    expect(proc.killCalls).toBe(0); expect(s.proc).toBe(proc)
    s.turnActive = false
  })

  test('explicit reset works without a current process and reports every service outcome', async () => {
    const s = session(); const account = store.ensure('工作 订阅')
    const consume = spyOn(usageModule, 'consumeCodexResetCredit'); spies.push(consume)
    for (const [outcome, phase, title] of [
      ['alreadyRedeemed', 'success', '本次重置已完成'], ['nothingToReset', 'current', '无需重置'], ['noCredit', 'warning', '没有可用重置卡'],
    ] as const) {
      consume.mockResolvedValue({ outcome, usage: { state: 'ok', fiveHour: null, weekly: null, resetCredits: 0, fetchedAt: 1 } })
      await s.runCommand('codex-reset 工作 订阅', 'owner', outcome)
      expect(consume.mock.calls.at(-1)?.[0]).toBe(account.id)
      expect(cardViews.at(-1)).toMatchObject({ phase, title, name: account.name })
    }
    await s.runCommand('codex-reset default', 'owner', 'default-message')
    expect(consume.mock.calls.at(-1)?.[0]).toBe('default')
    expect(s.proc).toBeNull(); expect(store.preferred(s.sessionName)).toBeNull()
  })

  test('reset refuses an unknown target, missing message ID, or unknown current account', async () => {
    const s = session()
    const consume = spyOn(usageModule, 'consumeCodexResetCredit'); spies.push(consume)
    await s.runCommand('codex-reset', 'owner', 'not-running')
    expect(JSON.stringify(sentCards.at(-1))).toContain('没有正在使用')
    await s.runCommand('codex-reset default', 'owner')
    expect(JSON.stringify(sentCards.at(-1))).toContain('缺少消息 ID')
    await s.runCommand('codex-reset missing', 'owner', 'unknown-name')
    expect(JSON.stringify(sentCards.at(-1))).toContain('不存在')
    const proc = new Proc() as any; procs.push(proc); s.proc = proc
    proc.provider = 'claude'
    await s.runCommand('codex-reset', 'owner', 'wrong-provider')
    proc.provider = 'codex'; proc.codexAccountSelectionMode = () => null
    await s.runCommand('codex-reset', 'owner', 'selecting')
    proc.codexAccountSelectionMode = () => 'automatic'; proc.turnRetry = { reason: 'quota', phase: 'waiting' }
    await s.runCommand('codex-reset', 'owner', 'quota-wait')
    expect(consume).not.toHaveBeenCalled()
  })

  test('confirmed reset remains visible when quota refresh or connection cleanup fails', async () => {
    const s = session()
    const consume = spyOn(usageModule, 'consumeCodexResetCredit').mockResolvedValue({ outcome: 'reset',
      usage: { state: 'network', reason: 'quota offline' }, cleanupError: 'close rejected' })
    spies.push(consume)
    await s.runCommand('codex-reset default', 'owner', 'confirmed')
    expect(cardViews.at(-1)).toMatchObject({ phase: 'warning', title: '额度已重置', message: '已使用 1 次重置卡。' })
    expect(cardViews.at(-1)?.details).toContain('quota offline')
    expect(cardViews.at(-1)?.details).toContain('close rejected')
    consume.mockRejectedValue(new Error('upstream rejected reset'))
    await s.runCommand('codex-reset default', 'owner', 'failed')
    expect(cardViews.at(-1)).toMatchObject({ phase: 'error', message: 'upstream rejected reset' })
  })

  test('receipt delivery failure propagates without replacing a confirmed redemption with an error card', async () => {
    const s = session()
    spies.push(spyOn(usageModule, 'consumeCodexResetCredit').mockResolvedValue({ outcome: 'reset',
      usage: { state: 'ok', fiveHour: null, weekly: null, resetCredits: 0, fetchedAt: 1 } }))
    const attempts: CodexAccountCardView[] = []
    spies.push(spyOn(CodexAccountCard, 'open').mockResolvedValue({
      finish: async (view: CodexAccountCardView) => { attempts.push(view); throw new Error('receipt write rejected') },
    } as unknown as CodexAccountCard))
    await expect(s.runCommand('codex-reset default', 'owner', 'receipt-failed')).rejects.toThrow('receipt write rejected')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ phase: 'success', title: '额度已重置' })
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
    quotaNow += 60_000
    let release!: (value: any) => void
    const pending = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), account.id)
    await Promise.resolve()

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

  test('named login refuses a missing or unconfirmed default before creating records or requesting a code', async () => {
    const s = session()
    const existing = store.ensure('已存在账号')
    const before = store.list()
    const check = spyOn(loginModule, 'requireDefaultCodexLogin')
    const start = spyOn(codexLogins, 'start').mockRejectedValue(new Error('must not request a device code'))
    spies.push(check, start)
    for (const message of ['默认账号未登录 ChatGPT，请先发送不带备注的 codex-login 完成登录，再添加额外账号。',
      '默认账号正在登录，请先完成默认账号授权，再添加额外账号。',
      '默认账号登录检查失败：native account read rejected']) {
      check.mockRejectedValue(new Error(message))
      for (const name of ['新增账号', existing.name]) {
        await s.runCommand(`codex-login ${name}`, 'owner')
        expect(cardViews.at(-1)).toMatchObject({ phase: 'error', message })
        expect(store.list()).toEqual(before)
      }
    }
    expect(start).not.toHaveBeenCalled()
    expect(cardViews.some(view => view.verification)).toBe(false)
    expect(s.proc).toBeNull()
  })

  test('named login creates its record only after default auth is confirmed, even if its catalog is unavailable', async () => {
    const s = session()
    const native = getTokenSourceForAccount('codex-sub')!
    native.enabled = false; native.models = []; native.defaultModel = ''
    native.modelCatalogState = { status: 'failed', updatedAt: 1, error: 'model catalog offline' }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const check = spyOn(loginModule, 'requireDefaultCodexLogin').mockReturnValue(gate)
    let cancel!: (error: Error) => void
    const done = new Promise<any>((_resolve, reject) => { cancel = reject })
    const start = spyOn(codexLogins, 'start').mockImplementation(async id => ({
      accountId: id, loginId: 'named-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', done,
    }))
    spies.push(check, start)
    const command = s.runCommand('codex-login 新账号', 'owner')
    await new Promise(resolve => setTimeout(resolve, 0))
    const before = store.list()
    const startedEarly = start.mock.calls.length
    release(); await command
    try {
      expect(before).toEqual([{ id: 'default', name: '默认' }]); expect(startedEarly).toBe(0)
      expect(check).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledWith(store.find('新账号').id, { chatId: s.chatId, userOpenId: 'owner' })
      expect(cardViews.at(-1)).toMatchObject({ phase: 'waiting', name: '新账号', verification: { code: 'TEST-CODE' } })
    } finally {
      cancel(new Error('test cancellation'))
      await accountCommands.settleCodexAccountCards()
    }
  })

  test('default login and its aliases do not require an existing default login', async () => {
    const s = session()
    const check = spyOn(loginModule, 'requireDefaultCodexLogin').mockRejectedValue(new Error('not logged in'))
    const start = spyOn(codexLogins, 'start').mockRejectedValue(new Error('device-code sentinel'))
    spies.push(check, start)
    for (const command of ['codex-login', 'codex-login default', 'codex-login DEFAULT', 'codex-login 默认']) {
      await s.runCommand(command, 'owner')
      expect(cardViews.at(-1)?.message).toBe('device-code sentinel')
    }
    expect(check).not.toHaveBeenCalled()
    expect(start.mock.calls.map(([id]) => id)).toEqual(['default', 'default', 'default', 'default'])
    expect(store.list()).toEqual([{ id: 'default', name: '默认' }])
  })

  test('login replies update cards with instructions and terminal cancellation', async () => {
    const s = session()
    spies.push(spyOn(loginModule, 'requireDefaultCodexLogin').mockResolvedValue(undefined))
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
