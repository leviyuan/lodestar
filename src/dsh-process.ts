import { EventEmitter } from 'node:events'
import { join, isAbsolute, extname, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AgentModel, AgentProcess, AgentReasoningEffort, DshReasoningEffort } from './agent-process'
import { isDshReasoningEffort, NothingToCompactError } from './agent-process'
import type { CodexResultMeta, CodexUsage } from './codex-process'
import type { ConversationLaunch } from './conversation'
import { validateConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'
import { DshRuntime, type DshRuntimeOptions } from './dsh-runtime'
import type { DshModel, DshNotification } from './dsh-protocol'
import { log } from './log'

export interface DshSpawnOptions {
  workDir: string
  tokenSourceId: string | null
  model: string
  effort: DshReasoningEffort
  launch?: ConversationLaunch
  developerInstructions?: string
  allowDelegation?: boolean
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv?: Record<string, string | undefined>
  transformEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  /** Isolated native-runtime checks supply a private home and a local model overlay. */
  runtimeOptions?: Partial<Pick<DshRuntimeOptions, 'home' | 'patches'>>
}

const emptyResult = (): CodexResultMeta => ({ cost_usd: null, cost_delta_usd: null, duration_ms: null,
  num_turns: null, usage: null, subtype: null, is_error: false })
const toolAliases: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep' }

/** Feishu image downloads use .png names even when the payload is JPEG. */
function imageMediaType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  const signature = bytes.subarray(0, 12).toString('ascii')
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') return 'image/webp'
  throw new Error('DSH image input has unsupported or invalid raster bytes')
}

/** Maps the native Harness events to Lodestar's existing session/card contract. */
export class DshProcess extends EventEmitter implements AgentProcess {
  readonly provider = 'dsh' as const
  readonly tokenSourceId: string | null
  readonly launchKind: 'fresh' | 'resume' | 'fork'
  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastCompletedTurnId: string | null = null
  lastModel: string | null
  lastEffort: AgentReasoningEffort | null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult = emptyResult()
  lastContextWindow: number | null = null
  lastContextTokens: number | null = null
  private runtime: DshRuntime
  private ready?: Promise<void>
  private models: DshModel[] = []
  private busy = false
  private closing = false
  private startedAt = 0
  private questionInputs = new Map<string, any[]>()
  private frames = new Map<string, { revision: number; nextIndex: number }>()
  private toolInputs = new Map<string, { name: string; input: any }>()
  private children = new Set<string>()
  private settledChildren = new Set<string>()
  private childText = new Map<string, string>()
  private earlyNotifications: DshNotification[] = []
  private pendingInputs = 0
  private terminalError: Error | null = null
  private failedUnexpectedly = false

  constructor(private readonly opts: DshSpawnOptions) {
    super()
    this.tokenSourceId = opts.tokenSourceId
    this.lastModel = opts.model
    this.lastEffort = opts.effort
    const launch = opts.launch ?? { kind: 'fresh' }
    validateConversationLaunch(launch, 'dsh', opts.workDir)
    this.launchKind = launch.kind
    const base = { ...process.env, ...opts.hostEnv }
    this.runtime = new DshRuntime({ cwd: opts.workDir,
      env: opts.transformEnv ? opts.transformEnv(base) : base,
      profile: opts.profile,
      ...(opts.managedSkillPluginPath ? { managedSkillDir: join(opts.managedSkillPluginPath, 'skills') } : {}),
      ...opts.runtimeOptions })
    this.runtime.on('notification', (notification: DshNotification) => {
      if (!this.sessionId && notification.method !== 'failure') { this.earlyNotifications.push(notification); return }
      if (this.terminalError) return
      try { this.onNotification(notification) }
      catch (error) { this.fail(error) }
    })
    this.runtime.on('failure', error => this.fail(error))
    this.runtime.on('exit', event => this.emit('exit', { ...event, expected: event.expected && !this.failedUnexpectedly }))
  }
  sendInitialize(): void { void this.initializationPromise().catch(error => this.fail(error)) }
  initializationPromise(): Promise<void> {
    return this.ready ??= (async () => {
      await this.runtime.initialize()
      const result = await this.runtime.request('session/open', {
        cwd: this.opts.workDir, model: this.opts.model, effort: this.opts.effort,
        launch: this.opts.launch ?? { kind: 'fresh' },
        developerInstructions: this.opts.developerInstructions ?? '',
        allowDelegation: this.opts.allowDelegation !== false,
        ...(this.opts.profile?.tools ? { allowedTools: this.opts.profile.tools.split(',').map(t => {
          const name = t.trim(); return Object.keys(toolAliases).find(key => toolAliases[key] === name) ?? name
        }) } : {}),
      })
      if (typeof result.sessionId !== 'string' || !Array.isArray(result.models)) throw new Error('invalid DSH session/open response')
      this.sessionId = result.sessionId
      this.models = result.models
      this.lastContextWindow = this.models.find(m => m.model === this.lastModel)?.contextWindow ?? null
      this.emit('init', { session_id: this.sessionId })
      for (const notification of this.earlyNotifications.splice(0)) this.onNotification(notification)
    })()
  }
  isAlive(): boolean { return this.runtime.isAlive() }
  isConversationResumable(): boolean { return this.sessionId !== null }
  kill(timeoutMs?: number): Promise<void> { this.closing = true; return this.runtime.close(timeoutMs) }
  sendUserText(text: string, files: string[] = []): void {
    if (!this.isAlive() || this.closing) throw new Error('DSH process is closed')
    if (files.some(file => !isAbsolute(file))) throw new Error('DSH file inputs must use absolute paths')
    if (this.terminalError) throw this.terminalError
    this.pendingInputs++
    void this.initializationPromise().then(async () => {
      const content: object[] = [{ type: 'text', text: [text, ...files.map(file => `[file: ${file}]`)].join('\n') }]
      const referenced = new Set([...files, ...Array.from(text.matchAll(/\[file: ([^\]\r\n]+)\]/g), match => match[1])])
      const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
      for (const path of referenced) {
        if (!imageExtensions.has(extname(path).toLowerCase())) continue
        const bytes = await readFile(path)
        content.push({ type: 'image', mediaType: imageMediaType(bytes), name: basename(path), data: bytes.toString('base64') })
      }
      await this.runtime.request('session/prompt', {
        mode: 'auto', content,
      })
      this.pendingInputs--
    }).catch(error => this.fail(error))
  }
  sendInterrupt(): void { void this.runtime.request('session/cancel').catch(error => this.fail(error)) }
  sendPermissionResponse(requestId: string | number, decision: 'allow' | 'deny', payload?: { updatedInput?: Record<string, unknown>; denyMessage?: string }): void {
    const id = String(requestId)
    const questions = this.questionInputs.get(id)
    if (!questions) throw new Error(`unknown DSH question: ${id}`)
    const values = payload?.updatedInput?.answers as Record<string, string> | undefined
    const answers = decision === 'allow' ? questions.map(q => {
      // Session cards answer by displayed text; delegated workers expose the
      // native question id. Both are explicit keys in the host protocol.
      const value = values?.[q.question] ?? values?.[q.id]
      if (typeof value !== 'string') throw new Error(`missing answer to DSH question: ${q.question}`)
      const option = q.options?.find((entry: any) => entry.label === value)
      return { id: q.id, selected: option ? [value] : [], ...(option ? {} : { custom: value }) }
    }) : undefined
    void this.runtime.request('question/answer', { id, answers,
      ...(decision === 'deny' ? { error: payload?.denyMessage ?? 'User declined the question' } : {}) }).then(() => {
      this.questionInputs.delete(id)
      this.emit('tool_result', { tool_use_id: id, content: JSON.stringify({ answers }), is_error: decision === 'deny', parentToolUseId: null })
    }).catch(error => this.fail(error))
  }
  sendHookResponse(): void { throw new Error('DSH does not issue hook callback requests') }
  async listModels(): Promise<AgentModel[]> {
    await this.runtime.initialize()
    this.models = await this.runtime.request('model/list', { models: [this.lastModel ?? this.opts.model] })
    return this.models.map(m => ({ id: m.model, model: m.model, displayName: m.display, description: 'DeepSeek Harness',
      hidden: false, isDefault: m.isDefault, defaultReasoningEffort: m.defaultEffort,
      supportedReasoningEfforts: m.efforts.map(reasoningEffort => ({ reasoningEffort, description: '' })) }))
  }
  async setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void> {
    if (!isDshReasoningEffort(effort)) throw new Error(`invalid DSH effort: ${effort}`)
    await this.initializationPromise()
    // This mutation cannot be cancelled by dropping its RPC response. Session
    // presents a pending state while retaining the eventual acknowledgement.
    await this.runtime.request('session/model', { model, effort }, null)
    if (!this.busy) { this.lastModel = model; this.lastEffort = effort }
  }
  async compactThread(): Promise<void> {
    await this.initializationPromise()
    const result = await this.runtime.request('session/compact', {}, null)
    if (result === null) throw new NothingToCompactError()
  }
  private fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    if (this.terminalError) return
    this.failedUnexpectedly = !this.closing
    this.terminalError = error
    this.emit('error', error)
    for (const child of this.children) {
      if (this.settledChildren.has(child)) continue
      this.settledChildren.add(child)
      this.emit('bg_task_settled', { task_id: child, status: 'failed', summary: error.message })
    }
    if (this.busy || this.pendingInputs > 0) {
      this.busy = false
      this.lastResult = { ...emptyResult(), is_error: true, subtype: 'error' }
      this.emit('result', { errors: [error.message], error: error.message, ...this.lastResult })
    }
    void this.kill().catch(closeError => this.emit('error', closeError))
  }
  private onNotification({ method, params }: DshNotification): void {
    const sub = params.sessionId !== this.sessionId
    switch (method) {
      case 'failure': this.fail(new Error(params.message)); return
      case 'agent.error': this.emit('error', new Error(params.message)); return
      case 'subagent.started':
        this.children.add(params.sessionId)
        this.emit('bg_task_started', { task_id: params.sessionId, description: 'DeepSeek Harness 子 Agent', task_type: 'agent', tool_use_id: params.sessionId })
        return
      case 'subagent.disposed':
        if (this.children.has(params.sessionId) && !this.settledChildren.has(params.sessionId)) {
          this.emit('bg_task_settled', { task_id: params.sessionId, status: 'stopped', summary: this.childText.get(params.sessionId) ?? '' })
        }
        this.children.delete(params.sessionId)
        this.settledChildren.delete(params.sessionId)
        this.childText.delete(params.sessionId)
        for (const key of this.frames.keys()) if (key.startsWith(`${params.sessionId}:`)) this.frames.delete(key)
        return
      case 'session.status': return
      case 'question': {
        this.questionInputs.set(params.id, params.questions)
        const input = { questions: params.questions.map((q: any) => ({ ...q, question: q.detail ? `${q.question}\n\n${q.detail}` : q.question })) }
        // Keep the exact displayed question as the answer key used by Session.
        this.questionInputs.set(params.id, input.questions)
        this.emit('tool_use', { id: params.id, name: 'AskUserQuestion', input, parentToolUseId: null })
        this.emit('can_use_tool', { request_id: params.id, tool_use_id: params.id, tool_name: 'AskUserQuestion', input })
        return
      }
      case 'question.cancelled':
        this.questionInputs.delete(params.id)
        this.emit('tool_result', { tool_use_id: params.id, content: 'Question cancelled', is_error: true, parentToolUseId: null })
        return
      case 'assistant.frame': {
        const frame = params.frame
        const key = `${params.sessionId}:${frame.attemptId}`
        if (frame.type === 'start') { this.frames.set(key, { revision: frame.revision, nextIndex: 0 }); return }
        const state = this.frames.get(key)
        if (!state || state.revision + 1 !== frame.revision || state.nextIndex !== frame.index) throw new Error('DSH assistant stream sequence mismatch')
        state.revision = frame.revision
        if (frame.type === 'end') {
          this.frames.delete(key)
          if (!sub) this.emit('assistant_block_stop', { parentToolUseId: null })
          return
        }
        if (frame.type !== 'chunk') throw new Error(`unknown DSH assistant frame: ${frame.type}`)
        state.nextIndex++
        const chunk = frame.chunk
        if (chunk.type === 'text-delta') {
          if (sub) this.childText.set(params.sessionId, (this.childText.get(params.sessionId) ?? '') + chunk.text)
          this.emit('assistant_text', { text: chunk.text, parentToolUseId: sub ? params.sessionId : null })
        } else if (chunk.type === 'block-end' && chunk.block.type === 'text' && !sub) {
          this.emit('assistant_block_stop', { parentToolUseId: null })
        } else if (chunk.type === 'usage' && !sub) this.observeUsage(chunk.usage)
        return
      }
      case 'session.event': {
        const e = params.event
        const data = e.data
        if (!e || !data || typeof e.type !== 'string') throw new Error('invalid DSH session event')
        if (e.type === 'turn/start' && !sub) {
          this.busy = true; this.startedAt = Date.now(); this.lastUsage = null
          this.lastResult = emptyResult()
          this.emit('scheduled_turn_input', { text: 'DeepSeek Harness 继续执行', promptId: `dsh-turn-${data.turn}` })
          this.emit('turn_started', { turn_id: String(data.turn), thread_id: this.sessionId })
        } else if (e.type === 'turn/start' && sub && this.settledChildren.delete(params.sessionId)) {
          this.emit('bg_task_started', { task_id: params.sessionId, description: 'DeepSeek Harness 子 Agent', task_type: 'agent', tool_use_id: params.sessionId })
        } else if (e.type === 'request/header' && !sub && data.header?.config) {
          this.lastModel = data.header.config.model; this.lastEffort = data.header.config.reasoningEffort
          this.lastContextWindow = this.models.find(m => m.model === this.lastModel)?.contextWindow ?? null
        } else if (e.type === 'tool/call') {
          const input = JSON.parse(data.arguments)
          const name = toolAliases[data.name] ?? data.name
          if (['read', 'write', 'edit'].includes(data.name) && input.path) input.file_path = input.path
          this.toolInputs.set(data.callId, { name, input })
          this.emit('tool_use', { id: data.callId, name, input, parentToolUseId: sub ? params.sessionId : null })
        } else if (e.type === 'tool/result') {
          const block = data.message?.content?.[0]
          if (block?.type !== 'tool-result' || typeof block.toolCallId !== 'string') throw new Error('invalid DSH tool result')
          this.emit('tool_result', { tool_use_id: block.toolCallId, content: block.content,
            is_error: block.isError === true, parentToolUseId: sub ? params.sessionId : null })
          this.toolInputs.delete(block.toolCallId)
        } else if (e.type === 'todo/write' && !sub) {
          this.emit('turn_plan_updated', { threadId: this.sessionId, explanation: null,
            plan: data.todos.map((item: any) => ({ step: item.content, status: item.status === 'in_progress' ? 'inProgress' : item.status })) })
        } else if (e.type === 'compaction/start' && !sub) {
          this.emit('context_compacted', { threadId: this.sessionId, phase: 'start', sourceType: 'dsh' })
        } else if (e.type === 'compaction/end' && !sub) {
          if (data.error) this.emit('error', new Error(`DSH compaction: ${data.error}`))
          else this.emit('context_compacted', { threadId: this.sessionId, phase: 'end', sourceType: 'dsh' })
        } else if (e.type === 'goal/change' && !sub) {
          if (data.operation === 'clear') this.emit('thread_goal_cleared', { threadId: this.sessionId })
          else this.emit('thread_goal_updated', { threadId: this.sessionId, objective: data.goal.objective,
            status: data.goal.phase, tokenBudget: null, tokensUsed: Number.NaN, timeUsedSeconds: Number.NaN })
        } else if (e.type === 'turn/end' && sub && this.children.has(params.sessionId)) {
          this.settledChildren.add(params.sessionId)
          this.emit('bg_task_settled', { task_id: params.sessionId,
            status: data.reason.kind === 'completed' ? 'completed' : data.reason.kind === 'aborted' ? 'stopped' : 'failed',
            summary: this.childText.get(params.sessionId) ?? '' })
          this.childText.delete(params.sessionId)
        }
        return
      }
      case 'settled': {
        if (sub) throw new Error('DSH settled a different root session')
        this.busy = false
        const event = params.event
        const reason = event.data.reason
        this.lastCompletedTurnId = String(event.seq)
        this.lastResult = { ...emptyResult(), duration_ms: Date.now() - this.startedAt, num_turns: 1,
          usage: this.lastUsage, subtype: reason.kind, is_error: reason.kind !== 'completed' }
        this.emit('result', { ...this.lastResult,
          ...(reason.kind !== 'completed' ? { error: reason.error?.message ?? `DSH turn ended: ${reason.kind}`,
            errors: [reason.error?.message ?? `DSH turn ended: ${reason.kind}`] } : {}),
          checkpoint: { provider: 'dsh', kind: 'event', id: String(event.seq),
            source: { provider: 'dsh', sessionId: this.sessionId, cwd: this.opts.workDir } } })
        return
      }
      default: log(`dsh: unknown notification ${method}`)
    }
  }
  private observeUsage(u: any): void {
    if (!Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens)) throw new Error('invalid DSH token usage')
    const usage: CodexUsage = { input_tokens: u.inputTokens, output_tokens: u.outputTokens,
      total_tokens: u.totalTokens, cache_read_input_tokens: u.cacheReadTokens,
      cache_creation_input_tokens: u.cacheWriteTokens, reasoning_output_tokens: u.reasoningTokens }
    this.lastUsage = usage
    const total = { ...this.lastTotalUsage }
    for (const [key, value] of Object.entries(usage)) {
      if (value !== undefined) { const k = key as keyof CodexUsage; total[k] = (total[k] ?? 0) + value }
    }
    this.lastTotalUsage = total
    this.lastContextTokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
    this.emit('token_usage', { usage, totalUsage: total, contextWindow: this.lastContextWindow, threadId: this.sessionId })
  }
}
