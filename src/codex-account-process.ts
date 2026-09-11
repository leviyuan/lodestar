import { EventEmitter } from 'node:events'
import type { AgentModel, AgentProcess, AgentReasoningEffort, AgentTurnRetry } from './agent-process'
import type { CodexResultMeta } from './codex-process'
import type { ConversationLaunch } from './conversation'
import { bindProcessCodexAccount } from './codex-accounts'
import { codexAccountScheduler, type CodexAccountCandidate, type CodexAccountDecision, type CodexSelectionOptions } from './codex-account-scheduler'
import type { CodexQuotaFailure } from './codex-quota'
import { refreshUsageFromConnection } from './usage'
import { log } from './log'

const CONTINUE_TASK = '上一轮因当前账号额度耗尽而中断，现已切换账号。请基于本会话已有记录继续完成用户尚未完成的任务，保留已完成的修改和工具结果。执行有副作用的操作前先确认现状，不要重复已完成的操作。'
const FORWARDED_EVENTS = ['error', 'conversation_materialized', 'conversation_materialization_failed',
  'token_usage', 'turn_plan_updated', 'plan_delta', 'context_compacted', 'rate_limits_updated',
  'thread_goal_updated', 'thread_goal_cleared', 'assistant_text', 'assistant_block_stop',
  'tool_use', 'tool_result', 'can_use_tool', 'hook_callback', 'bg_task_started', 'bg_task_progress',
  'bg_task_updated', 'bg_task_settled', 'subagent_step', 'raw'] as const

const emptyResult = (): CodexResultMeta => ({ cost_usd: null, cost_delta_usd: null, duration_ms: null,
  num_turns: null, usage: null, subtype: null, is_error: false })

/** One AgentProcess owner, one native app-server at a time. Model/tools/permissions/host capability
 * stay identical; failover only replaces authentication and resumes the native thread. */
export class CodexAccountProcess extends EventEmitter implements AgentProcess {
  readonly provider = 'codex' as const
  readonly tokenSourceId = 'codex-sub'
  readonly launchKind: 'fresh' | 'resume' | 'fork'
  private inner: AgentProcess | null = null
  private selected: CodexAccountCandidate | null = null
  private revision: string | null = null
  private ready: Promise<void> | null = null
  private recovery: Promise<void> | null = null
  private shutdown: Promise<void> | null = null
  private readonly lifetime = new AbortController()
  private closed = false
  private initialized = false
  private starting = false
  private retryTurn = false
  private retryCount = 0
  private ownRetry: AgentTurnRetry | null = null
  private result: CodexResultMeta | null = null
  private fault: Error | null = null
  private readonly inputs: Array<{ text: string; files: string[] }> = []
  private lastSession: string | null = null
  private readonly backgroundTasks = new Set<string>()
  private resolveQuotaWait!: () => void
  private readonly quotaWait = new Promise<void>(resolve => { this.resolveQuotaWait = resolve })

  constructor(private readonly opts: {
    model: string
    effort?: AgentReasoningEffort
    preferred?: string | null
    launch: ConversationLaunch
    workDir: string
    create: (accountId: string, launch: ConversationLaunch, manual: boolean,
      model?: string, effort?: AgentReasoningEffort) => { process: AgentProcess; sourceRevision: string | null }
    scheduler?: Pick<typeof codexAccountScheduler, 'choose' | 'block'>
    wait?: (ms: number, signal: AbortSignal) => Promise<void>
  }) {
    super()
    this.launchKind = opts.launch.kind
    this.on('error', () => {})
  }

  get sessionId() { return this.inner?.sessionId ?? this.lastSession }
  get lastAssistantUuid() { return this.inner?.lastAssistantUuid ?? null }
  get lastCompletedTurnId() { return this.result || this.ownRetry ? null : this.inner?.lastCompletedTurnId ?? null }
  get lastModel() { return this.inner?.lastModel ?? this.opts.model }
  get lastEffort() { return this.inner?.lastEffort ?? this.opts.effort ?? null }
  get lastThinkingTokens() { return this.inner?.lastThinkingTokens ?? null }
  get lastUsage() { return this.inner?.lastUsage ?? null }
  get lastTotalUsage() { return this.inner?.lastTotalUsage ?? null }
  get lastResult() { return this.result ?? this.inner?.lastResult ?? emptyResult() }
  get lastContextWindow() { return this.inner?.lastContextWindow ?? null }
  get lastContextTokens() { return this.inner?.lastContextTokens ?? null }
  get turnRetry() { return this.ownRetry ?? this.inner?.turnRetry ?? null }
  sourceRevision() { return this.revision }
  codexAccountSelectionMode(): 'automatic' | 'manual' | null {
    return this.selected ? this.selected.state === 'manual' ? 'manual' : 'automatic' : null
  }
  isAlive() { return !this.closed }
  isConversationResumable() { return this.inner?.isConversationResumable?.() === true }
  conversationMaterializationBarrier() { return this.inner?.conversationMaterializationBarrier?.() ?? null }
  conversationMaterializationFailure() { return this.inner?.conversationMaterializationFailure?.() ?? null }
  initializationPromise() { if (!this.ready) this.sendInitialize(); return this.ready! }
  quotaWaitPromise() { return this.quotaWait }

  sendInitialize(): void {
    if (this.ready) return
    this.ready = this.launch(this.opts.launch, this.opts.preferred)
    // The exact transaction is still rejected for Session; workers also need a terminal result.
    void this.ready.catch(error => { if (!this.lifetime.signal.aborted) this.fail(error) })
  }

  private scheduler() { return this.opts.scheduler ?? codexAccountScheduler }
  private notice(message: string, delayMs = 0): void {
    this.ownRetry = { reason: 'quota', phase: delayMs ? 'waiting' : 'retrying', attempt: this.retryCount, delayMs, message }
    log(`codex account: ${message}`)
    this.emit('turn_retry', this.ownRetry)
  }
  private async choose(preferred?: string | null, failedAccountId?: string): Promise<CodexAccountDecision & { selected: CodexAccountCandidate }> {
    const options: CodexSelectionOptions = { model: this.opts.model || this.lastModel || '', effort: this.opts.effort ?? this.lastEffort ?? undefined,
      preferred, failedAccountId, preferCachedUsage: true, signal: this.lifetime.signal }
    while (true) {
      const decision = await this.scheduler().choose(options)
      delete options.failedAccountId
      this.lifetime.signal.throwIfAborted()
      if (decision.selected) return { ...decision, selected: decision.selected }
      options.preferCachedUsage = false
      const detail = decision.candidates.map(c => `${c.account.name}：${c.reason ?? c.state}`).join('；')
      if (decision.retryAt === undefined) throw new Error(`没有可用的 Codex 账号；${detail}`)
      const delay = Math.max(1000, Math.min(60_000, decision.retryAt - Date.now()))
      const missing = decision.candidates.filter(c => c.state === 'miss' && !c.duplicateOf).length
      log(`codex account: waiting for quota: ${detail}`)
      this.notice(`暂无可用账号 · 自动等待恢复${missing ? ` · ${missing} 个 MISS` : ''}`, delay)
      this.resolveQuotaWait()
      await (this.opts.wait ?? waitForQuota)(delay, this.lifetime.signal)
    }
  }

  private async launch(launch: ConversationLaunch, preferred?: string | null, failedAccountId?: string): Promise<void> {
    this.starting = true
    const decision = await this.choose(preferred, failedAccountId)
    this.lifetime.signal.throwIfAborted()
    const previousAccountId = this.selected?.account.id ?? null
    const { process: child, sourceRevision } = this.opts.create(decision.selected.account.id, launch,
      decision.selected.state === 'manual', this.opts.model || this.lastModel || undefined, this.opts.effort ?? this.lastEffort ?? undefined)
    this.inner = child
    this.selected = decision.selected
    this.revision = sourceRevision
    // The native child owns the login exclusion. A logical task waiting for quota owns no auth writer.
    bindProcessCodexAccount(this, decision.selected.account.id, false)
    this.wire(child)
    this.emit('codex_account_changed', { accountId: decision.selected.account.id, previousAccountId,
      diagnostics: decision.candidates.filter(c => c.usage !== null && c.state === 'miss' && !c.duplicateOf)
        .map(c => `${c.account.name}：${c.reason}`) })
    this.lifetime.signal.throwIfAborted()
    child.sendInitialize()
    const initialized = child.initializationPromise?.()
    if (!initialized) throw new Error('Codex 初始化未提供确认事务')
    await initialized
    this.lifetime.signal.throwIfAborted()
    this.lastSession = child.sessionId
    this.starting = false
    this.ownRetry = null
    if (!this.initialized) {
      this.initialized = true
      this.emit('init', { session_id: child.sessionId })
    }
    // Recovery submits its continuation before accepting queued steering input.
    if (!this.recovery) this.drainInputs()
  }

  private wire(child: AgentProcess): void {
    for (const name of FORWARDED_EVENTS) child.on(name, (...args) => {
      if (this.inner === child && !this.closed) {
        if (name === 'bg_task_started') this.backgroundTasks.add(args[0].task_id)
        if (name === 'bg_task_settled') this.backgroundTasks.delete(args[0].task_id)
        this.emit(name, ...args)
      }
    })
    child.on('turn_retry', event => { if (this.inner === child && !this.closed) this.emit('turn_retry', event) })
    child.on('turn_started', event => {
      if (this.inner !== child || this.closed) return
      this.result = null
      this.ownRetry = null
      const retry = this.retryTurn || event.retry
      this.retryTurn = false
      this.emit('turn_started', { ...event, ...(retry ? { retry: true } : {}) })
    })
    child.on('result', (result: any) => {
      if (this.inner !== child || this.closed || this.lifetime.signal.aborted) return
      if (result?.is_error && result.codexQuotaFailure && !this.recovery) {
        this.retryCount++
        // Defer the transaction one microtask so cancellation in a synchronous event listener wins.
        const recovery = Promise.resolve().then(() => this.recover(child, result.codexQuotaFailure))
          .catch(error => { if (!this.lifetime.signal.aborted) this.fail(error) })
          .finally(() => { if (this.recovery === recovery) this.recovery = null })
        this.recovery = recovery
        this.notice(`「${this.selected?.account.name ?? 'MISS'}」额度耗尽 · 正在换号续跑`)
        return
      }
      if (this.recovery) return
      this.retryCount = 0
      this.result = null
      this.emit('result', result)
    })
    child.on('exit', event => {
      if (this.inner !== child || this.closed) return
      if ((this.recovery || this.shutdown) && event.expected) return
      this.lifetime.abort(new Error('Codex 进程退出'))
      this.closed = true
      this.emit('exit', event)
    })
  }

  private async recover(child: AgentProcess, failure: CodexQuotaFailure): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (!this.selected) throw new Error('额度耗尽时未记录运行账号')
    if (child.readRateLimits) {
      const fresh = await refreshUsageFromConnection(() => child.readRateLimits!(), this.selected.account.id)
      this.lifetime.signal.throwIfAborted()
      if (fresh?.state === 'ok') this.selected = { ...this.selected, usage: fresh,
        identity: fresh.accountFingerprint ?? this.selected.identity }
      else this.notice('已确认额度耗尽 · 用量读取 MISS，正在换号')
    }
    const failedAccountId = this.selected.usage === null ? this.selected.account.id : undefined
    if (this.selected.usage) this.scheduler().block(this.selected, this.lastModel ?? this.opts.model)
    const barrier = child.conversationMaterializationBarrier?.()
    if (barrier) await barrier
    this.lifetime.signal.throwIfAborted()
    const resumable = child.isConversationResumable?.() === true && child.sessionId
    if (failure.accepted && !resumable) throw new Error('额度耗尽后未确认原会话落盘，不能重放已执行的任务')
    if (!failure.accepted && typeof failure.rejectedInput !== 'string') throw new Error('额度耗尽的拒绝响应缺少原始输入')
    const launch: ConversationLaunch = resumable
      ? { kind: 'resume', source: { provider: 'codex', sessionId: child.sessionId!, cwd: this.opts.workDir } }
      : this.opts.launch
    await child.kill()
    if (child.isAlive()) throw new Error('旧 Codex 进程退出未确认，不能启动下一账号')
    for (const task_id of this.backgroundTasks) this.emit('bg_task_settled', {
      task_id, status: 'failed', summary: '账号额度耗尽，原进程已退出；主任务换号后继续',
    })
    this.backgroundTasks.clear()
    this.lifetime.signal.throwIfAborted()
    await this.launch(launch, undefined, failedAccountId)
    this.lifetime.signal.throwIfAborted()
    this.retryTurn = true
    this.notice(`已切换「${this.selected.account.name}」· 继续原任务`)
    this.lifetime.signal.throwIfAborted()
    const text = failure.accepted ? CONTINUE_TASK : failure.rejectedInput!
    // Release ownership before send: native test transports can emit a terminal event synchronously.
    this.recovery = null
    this.inner!.sendUserText(text)
    this.drainInputs()
  }

  private fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    this.fault = error
    this.ownRetry = null
    this.inputs.length = 0
    this.result = { ...emptyResult(), is_error: true, subtype: 'codex_account_failed' }
    this.emit('error', error)
    this.emit('result', { ...this.result, error: error.message, checkpoint: null })
  }
  sendUserText(text: string, files: string[] = []): void {
    if (this.fault) throw this.fault
    if (this.closed || this.lifetime.signal.aborted) throw new Error('Codex 进程已关闭')
    this.result = null
    this.inputs.push({ text, files: [...files] })
    if (!this.ready) this.sendInitialize()
    if (!this.starting && !this.recovery) this.drainInputs()
  }
  private drainInputs(): void {
    if (!this.inner || this.starting || this.recovery || this.lifetime.signal.aborted) return
    while (this.inputs.length) { const input = this.inputs.shift()!; this.inner.sendUserText(input.text, input.files) }
  }
  sendInterrupt(): void {
    this.inputs.length = 0
    if (!this.recovery && !this.starting) { this.inner?.sendInterrupt(); return }
    this.lifetime.abort(new Error('用户已停止额度恢复'))
    this.ownRetry = null
    this.result = { ...emptyResult(), subtype: 'interrupted' }
    this.emit('result', { ...this.result, checkpoint: null })
    void this.kill().catch(error => this.emit('error', error))
  }
  kill(timeoutMs?: number): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.lifetime.abort(new Error('Codex 已停止'))
    this.inputs.length = 0
    this.ownRetry = null
    this.shutdown = Promise.resolve().then(async () => {
      await this.inner?.kill(timeoutMs)
      if (this.inner?.isAlive()) throw new Error('Codex 退出未确认')
      if (!this.closed) { this.closed = true; this.emit('exit', { code: 0, signal: null, expected: true }) }
    }).catch(error => { this.shutdown = null; throw error })
    return this.shutdown
  }
  private active(): AgentProcess {
    if (!this.inner || this.starting || this.recovery || !this.inner.isAlive()) throw new Error('Codex 正在选择或恢复账号')
    return this.inner
  }
  async listModels(): Promise<AgentModel[]> { await this.initializationPromise(); return this.active().listModels() }
  async setModelSettings(model: string, effort: AgentReasoningEffort) { await this.active().setModelSettings(model, effort) }
  async compactThread() { await this.active().compactThread() }
  async readRateLimits() {
    const child = this.active()
    if (!child.readRateLimits) throw new Error('Codex 额度接口 MISS')
    return child.readRateLimits()
  }
  private respondingChild(): AgentProcess {
    if (!this.inner?.isAlive() || this.lifetime.signal.aborted) throw new Error('Codex 请求所属进程已退出')
    return this.inner
  }
  sendPermissionResponse(...args: Parameters<AgentProcess['sendPermissionResponse']>) { this.respondingChild().sendPermissionResponse(...args) }
  sendHookResponse(...args: Parameters<AgentProcess['sendHookResponse']>) { this.respondingChild().sendHookResponse(...args) }
}

function waitForQuota(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(signal.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
