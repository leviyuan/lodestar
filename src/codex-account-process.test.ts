import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { AgentProcess } from './agent-process'
import { CodexAccountProcess } from './codex-account-process'
import type { CodexAccountCandidate, CodexAccountDecision } from './codex-account-scheduler'
import type { ConversationLaunch } from './conversation'
import { bindProcessCodexAccount, codexAccountInUse, processCodexAccount } from './codex-accounts'
import { invalidateCodexUsage } from './usage'
import * as logModule from './log'

const live: CodexAccountProcess[] = []
afterEach(async () => { for (const proc of live.splice(0)) { (proc as any).inner && ((proc as any).inner.failKill = false); await proc.kill() } })
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const candidate = (id: string): CodexAccountCandidate => ({ account: { id, name: id }, identity: id,
  state: 'ready', score: 1, shares: 1, remaining: 1, hours: 1, usage: { state: 'ok', subscriptionType: 'plus',
    weekly: { percent: 0, resetsAt: new Date(Date.now() + 3600_000) }, fiveHour: null, fetchedAt: Date.now() } })
const decision = (id: string): CodexAccountDecision => ({ selected: candidate(id), candidates: [candidate(id)] })
class Child extends EventEmitter {
  provider = 'codex' as const
  tokenSourceId = 'codex-sub'
  sessionId: string | null = null
  lastAssistantUuid = null
  lastCompletedTurnId: string | null = null
  lastModel = 'model'; lastEffort = 'ultra' as const
  lastUsage = null; lastTotalUsage = null; lastContextWindow = null; lastContextTokens = null
  lastResult: any = { is_error: false }
  alive = true; resumable = true; failKill = false
  sent: Array<{ text: string; files?: string[] }> = []
  barrier: Promise<void> | null = null
  constructor(readonly launch: ConversationLaunch, private readonly order: string[], readonly id: string) { super() }
  sendInitialize() { this.sessionId = this.launch.kind === 'fresh' ? 'native-thread' : this.launch.source.sessionId; this.emit('init', { session_id: this.sessionId }) }
  initializationPromise() { return Promise.resolve() }
  isAlive() { return this.alive }
  isConversationResumable() { return this.resumable }
  conversationMaterializationBarrier() { return this.barrier }
  sendUserText(text: string, files?: string[]) { this.sent.push({ text, files }); this.emit('turn_started', { turn_id: 'turn', thread_id: this.sessionId }) }
  sendInterrupt() { this.order.push(`interrupt:${this.id}`) }
  async kill() {
    this.order.push(`kill:${this.id}`)
    if (this.failKill) throw new Error('exit unconfirmed')
    if (!this.alive) return
    this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true })
  }
  quota(accepted = true, rejectedInput?: string) {
    this.lastResult = { is_error: true, subtype: 'quota' }
    this.emit('result', { ...this.lastResult, codexQuotaFailure: { accepted, rejectedInput } })
  }
  success() { this.lastResult = { is_error: false, subtype: 'success' }; this.lastCompletedTurnId = 'done'; this.emit('result', { ...this.lastResult }) }
}
function harness(choices: Array<CodexAccountDecision | Promise<CodexAccountDecision>> = [decision('a'), decision('b'), decision('c')], wait?: (ms: number, signal: AbortSignal) => Promise<void>) {
  const children: Child[] = []; const order: string[] = []; const results: any[] = []; const events: string[] = []
  const options: any[] = []
  const proc = new CodexAccountProcess({ model: 'model', effort: 'ultra', launch: { kind: 'fresh' }, workDir: '/repo', wait,
    scheduler: { choose: async opts => { options.push({ ...opts }); const d = choices.shift(); if (!d) throw new Error('no decision'); return d },
      block: row => { order.push(`block:${row.account.id}`) },
      recordUsage: (id, model) => { order.push(`usage:${id}:${model}`) } },
    create: (id, launch) => { order.push(`spawn:${id}`); const child = new Child(launch, order, id); children.push(child);
      bindProcessCodexAccount(child, id)
      return { process: child as unknown as AgentProcess, sourceRevision: id } },
  })
  proc.on('result', result => results.push(result)); proc.on('init', () => events.push('init')); proc.on('exit', () => events.push('exit'))
  live.push(proc)
  return { proc, children, order, results, events, options }
}

describe('Codex account process ownership and recovery', () => {
  test('only actual current-turn usage consumes an unused-account priority', async () => {
    const h = harness()
    await h.proc.initializationPromise()
    const child = h.children[0]
    const usage = { turnId: 'turn', threadId: child.sessionId, usage: { total_tokens: 1 } }
    child.emit('token_usage', usage) // Native resume can replay history before a new turn.
    h.proc.sendUserText('work')
    child.emit('token_usage', { ...usage, turnId: 'older-turn' })
    child.emit('token_usage', { ...usage, threadId: 'other-thread' })
    child.emit('token_usage', { ...usage, usage: { total_tokens: 0 } })
    expect(h.order).toEqual(['spawn:a'])
    child.lastModel = 'spark'
    child.emit('token_usage', usage)
    expect(h.order).toEqual(['spawn:a', 'usage:a:spark'])
    child.success()
    child.emit('token_usage', usage)
    expect(h.order).toEqual(['spawn:a', 'usage:a:spark'])
  })
  test('failed account checks retain the upstream error instead of reporting no available account', async () => {
    const reason = 'Codex 额度查询失败（已尝试 3 次）：error sending request for url (https://chatgpt.com/backend-api/wham/usage)'
    const row: CodexAccountCandidate = { ...candidate('default'), state: 'miss', score: null,
      usage: { state: 'network', reason }, reason }
    const h = harness([{ selected: null, candidates: [row] }])
    const error = `Codex 账号检查失败，无法自动选账号（MISS）；default：${reason}`
    await expect(h.proc.initializationPromise()).rejects.toThrow(error)
    expect(h.results).toHaveLength(1)
    expect(h.results[0]).toMatchObject({ is_error: true, error })
    expect(h.children).toHaveLength(0)
    expect(h.order).toEqual([])
    expect(h.options).toHaveLength(1)
  })
  test('missing accounts and excluded accounts remain distinct from failed checks', async () => {
    const empty = harness([{ selected: null, candidates: [] }])
    await expect(empty.proc.initializationPromise()).rejects.toThrow('没有配置 Codex 账号')
    const row: CodexAccountCandidate = { ...candidate('plus'), state: 'excluded', score: null,
      reason: 'Ultra 自动选择不使用 Plus' }
    const excluded = harness([{ selected: null, candidates: [row] }])
    await expect(excluded.proc.initializationPromise()).rejects.toThrow('没有符合条件的 Codex 账号；plus：Ultra 自动选择不使用 Plus')
    expect(empty.children).toHaveLength(0)
    expect(excluded.children).toHaveLength(0)
  })
  test('a manually started account can exhaust before any quota read, then selects an automatic replacement', async () => {
    const manual: CodexAccountCandidate = { ...candidate('a'), usage: null, state: 'manual', score: null }
    const h = harness([{ selected: manual, candidates: [] }, decision('b')])
    await h.proc.initializationPromise()
    expect(h.proc.codexAccountSelectionMode()).toBe('manual')
    h.children[0].quota(); await flush()
    expect(h.options[1].failedAccountId).toBe('a')
    expect(h.proc.codexAccountSelectionMode()).toBe('automatic')
    expect(h.children[1].launch.kind).toBe('resume')
    expect(h.results).toEqual([])
  })
  test('accepted quota failure resumes the same thread after confirmed exit, without replaying input/files', async () => {
    const h = harness(); h.proc.sendInitialize(); await h.proc.initializationPromise()
    expect(h.options[0].preferCachedUsage).toBe(true)
    h.proc.sendUserText('perform one irreversible operation', ['/private/input'])
    h.children[0].emit('assistant_text', { text: 'work already done' })
    h.children[0].quota(); await flush()
    expect(h.order).toEqual(['spawn:a', 'block:a', 'kill:a', 'spawn:b'])
    expect(h.children[1].launch).toEqual({ kind: 'resume', source: { provider: 'codex', sessionId: 'native-thread', cwd: '/repo' } })
    expect(h.children[1].sent).toHaveLength(1)
    expect(h.children[1].sent[0].text).toContain('不要重复')
    expect(h.children[1].sent[0].text).not.toContain('irreversible')
    expect(h.children[1].sent[0].text).not.toContain('/private/input')
    expect(h.results).toEqual([]); expect(h.events).toEqual(['init'])
    expect(processCodexAccount(h.proc)).toBe('b'); expect(h.proc.sourceRevision()).toBe('b')
    h.children[1].success(); expect(h.results).toHaveLength(1); expect(h.proc.lastCompletedTurnId).toBe('done')
  })
  test('quota refresh failure during recovery stays in logs while the original task continues', async () => {
    const accountId = 'recovery-refresh-failure'
    const h = harness([decision(accountId), decision('replacement')])
    const notices: string[] = []
    h.proc.on('turn_retry', event => notices.push(event.message))
    const logged = spyOn(logModule, 'log').mockImplementation(() => {})
    try {
      await h.proc.initializationPromise()
      Object.assign(h.children[0], { readRateLimits: async () => { throw new Error('quota probe unavailable') } })
      h.children[0].quota(); await flush()
      expect(h.children).toHaveLength(2)
      expect(h.children[1].launch).toMatchObject({ kind: 'resume', source: { sessionId: 'native-thread' } })
      expect(h.children[1].sent).toHaveLength(1)
      expect(h.results).toEqual([])
      expect(notices.some(message => message.includes('正在换号'))).toBe(true)
      expect(notices.some(message => message.includes('继续原任务'))).toBe(true)
      expect(notices.every(message => !message.includes('MISS') && !message.includes('quota probe unavailable'))).toBe(true)
      expect(logged.mock.calls.some(([line]) => line.includes('quota probe unavailable'))).toBe(true)
    } finally { logged.mockRestore(); invalidateCodexUsage(accountId) }
  })
  test('unaccepted first input can be submitted once with its original file hints', async () => {
    const h = harness(); await h.proc.initializationPromise()
    h.children[0].resumable = false
    h.children[0].quota(false, '[file: /input]\noriginal request'); await flush()
    expect(h.children[1].launch).toEqual({ kind: 'fresh' })
    expect(h.children[1].sent.map(s => s.text)).toEqual(['[file: /input]\noriginal request'])
  })
  test('waits for materialization before stopping or replacing a process', async () => {
    const h = harness(); await h.proc.initializationPromise()
    let release!: () => void
    h.children[0].barrier = new Promise(resolve => { release = resolve })
    h.children[0].quota(); await flush()
    expect(h.order).toEqual(['spawn:a', 'block:a'])
    release(); await flush(); expect(h.children).toHaveLength(2)
  })
  test('missing durable history never becomes fresh replay of accepted work', async () => {
    const h = harness(); await h.proc.initializationPromise(); h.children[0].resumable = false
    h.children[0].quota(); await flush()
    expect(h.children).toHaveLength(1); expect(h.results[0].is_error).toBe(true)
    expect(h.results[0].error).toContain('不能重放'); expect(() => h.proc.sendUserText('continue')).toThrow('不能重放')
  })
  test('failed termination keeps ownership and does not start another account', async () => {
    const h = harness(); await h.proc.initializationPromise(); h.children[0].failKill = true
    h.children[0].quota(); await flush()
    expect(h.children).toHaveLength(1); expect(h.proc.isAlive()).toBe(true)
    expect(h.results[0].error).toContain('exit unconfirmed')
    await expect(h.proc.kill()).rejects.toThrow('exit unconfirmed')
    h.children[0].failKill = false; await h.proc.kill(); expect(h.proc.isAlive()).toBe(false)
  })
  test('consecutive accounts can exhaust without duplicate visible results or overlapping children', async () => {
    const h = harness(); await h.proc.initializationPromise()
    h.children[0].quota(); h.children[0].quota(); await flush()
    h.children[1].quota(); await flush()
    expect(h.children).toHaveLength(3); expect(h.children.filter(c => c.alive)).toHaveLength(1)
    expect(h.children[2].sent).toHaveLength(1); expect(h.results).toEqual([])
    h.children[2].success(); expect(h.results).toHaveLength(1)
  })
  test('ordinary transport/auth/capacity failures remain visible and do not select another account', async () => {
    const h = harness(); await h.proc.initializationPromise()
    for (const error of ['429', '401', 'ETIMEDOUT', 'Selected model is at capacity']) h.children[0].emit('result', { is_error: true, error })
    expect(h.children).toHaveLength(1); expect(h.results).toHaveLength(4)
  })
  test('stop during pending account selection prevents late spawn', async () => {
    let release!: (d: CodexAccountDecision) => void
    const pending = new Promise<CodexAccountDecision>(resolve => { release = resolve })
    const h = harness([pending]); h.proc.sendInitialize(); await h.proc.kill(); release(decision('a')); await flush()
    expect(h.children).toHaveLength(0); expect(h.events).toEqual(['exit']); expect(h.results).toEqual([])
  })
  test('all exhausted at startup exposes a cancellable wait without pretending initialization succeeded', async () => {
    let resume!: () => void
    const wait = () => new Promise<void>(resolve => { resume = resolve })
    const h = harness([{ selected: null, candidates: [], retryAt: Date.now() + 10000 }, decision('a')], wait)
    h.proc.sendUserText('queued original'); await h.proc.quotaWaitPromise()
    expect(h.events).toEqual([]); expect(h.children).toHaveLength(0); expect(h.proc.turnRetry?.reason).toBe('quota')
    resume(); await h.proc.initializationPromise()
    expect(h.options.map(opts => opts.preferCachedUsage)).toEqual([true, false])
    expect(h.events).toEqual(['init']); expect(h.children[0].sent.map(s => s.text)).toEqual(['queued original'])
  })
  test('quota waiting shows recovery status without repeating other account diagnostics', async () => {
    let resume!: () => void
    const reason = '备用账号目录查询失败'
    const rows: CodexAccountCandidate[] = [
      { ...candidate('exhausted'), state: 'exhausted', score: null, reason: '额度耗尽' },
      { ...candidate('unavailable'), state: 'miss', score: null, reason, usage: { state: 'network', reason } },
    ]
    const h = harness([{ selected: null, candidates: rows, retryAt: Date.now() + 10000 }, decision('recovered')],
      () => new Promise<void>(resolve => { resume = resolve }))
    const logged = spyOn(logModule, 'log').mockImplementation(() => {})
    try {
      h.proc.sendUserText('queued original'); await h.proc.quotaWaitPromise()
      expect(h.proc.turnRetry?.message).toBe('暂无可用账号 · 自动等待恢复')
      expect(h.children).toHaveLength(0)
      expect(logged.mock.calls.some(([line]) => line.includes(reason))).toBe(true)
      resume(); await h.proc.initializationPromise()
      expect(h.children[0].sent.map(s => s.text)).toEqual(['queued original'])
    } finally { logged.mockRestore() }
  })
  test('stop while all accounts are exhausted cancels the wait and never resumes later', async () => {
    let resume!: () => void
    const h = harness([decision('a'), { selected: null, candidates: [], retryAt: Date.now() + 10000 }, decision('b')],
      () => new Promise<void>(resolve => { resume = resolve }))
    await h.proc.initializationPromise(); h.children[0].quota(); await flush()
    expect(codexAccountInUse('a')).toBe(false)
    h.proc.sendInterrupt(); resume(); await flush()
    expect(h.children).toHaveLength(1); expect(h.proc.isAlive()).toBe(false)
    expect(h.results).toHaveLength(1); expect(h.results[0].subtype).toBe('interrupted')
  })
  test('synchronous cancellation from the retry notice wins over recovery work', async () => {
    const h = harness(); await h.proc.initializationPromise()
    h.proc.once('turn_retry', () => h.proc.sendInterrupt())
    h.children[0].quota(); await flush()
    expect(h.children).toHaveLength(1); expect(h.order).not.toContain('block:a')
    expect(h.results).toHaveLength(1); expect(h.proc.isAlive()).toBe(false)
  })
  test('stale events from a stopped child cannot change the current account or close its task', async () => {
    const h = harness(); await h.proc.initializationPromise(); h.children[0].quota(); await flush()
    const texts: string[] = []; h.proc.on('assistant_text', event => texts.push(event.text))
    h.children[0].emit('assistant_text', { text: 'late' }); h.children[0].success()
    h.children[1].emit('assistant_text', { text: 'current' })
    expect(texts).toEqual(['current']); expect(h.results).toEqual([])
  })
  test('stop after the replacement initializes but before continuation prevents a new model request', async () => {
    const h = harness(); await h.proc.initializationPromise()
    h.proc.on('turn_retry', event => { if (event.message.startsWith('已切换')) h.proc.sendInterrupt() })
    h.children[0].quota(); await flush()
    expect(h.children).toHaveLength(2)
    expect(h.children[1].sent).toEqual([])
    expect(h.results).toHaveLength(1); expect(h.results[0].subtype).toBe('interrupted')
    expect(h.proc.isAlive()).toBe(false)
  })
})
