import type { AgentProcess, AgentReasoningEffort, AgentTurnRetry } from './agent-process'
import type { AgentIdentity } from './agent-identities'
import { createAgentProcess } from './agent-launch'
import { rememberAgentSession } from './agent-session-registry'
import type { AgentInputQuestion, AgentInputRequest, AgentStep } from './agent-run-types'
import type { ConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'
import { getTokenSource } from './token-source'
import { DELEGATED_AGENT_INSTRUCTIONS } from './agent-skill'

export interface AgentWorkerResult {
  output: string
  outputTruncated: boolean
  sessionId: string
  checkpointId?: string
  durationMs: number
  usage: Record<string, number | undefined> | null
}

/** Failed work may still contain useful output. Preserve it with the actual
 * failure instead of dropping everything that preceded an error or cancel. */
export class AgentWorkerFailure extends Error {
  constructor(cause: Error, readonly output: string, readonly sessionId: string | null) {
    super(cause.message, { cause })
    this.name = 'AgentWorkerFailure'
  }
}

export interface AgentWorkerCallbacks {
  onNeedsInput?(request: AgentInputRequest): void
  onProgress?(step: AgentStep): void
  onSession?(sessionId: string): void
}

export interface AgentWorkerHandle {
  done: Promise<AgentWorkerResult>
  isAlive?(): boolean
  pendingInput(): AgentInputRequest | null
  answer(requestId: string, answers: Record<string, string>): void
  cancel(reason?: string): Promise<void>
}

export function startAgentWorker(opts: {
  identity: AgentIdentity
  effort: AgentReasoningEffort
  workDir: string
  prompt: string
  resumeSessionId?: string
  developerInstructions?: string
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv: Record<string, string | undefined>
  callbacks?: AgentWorkerCallbacks
}): AgentWorkerHandle {
  const source = getTokenSource(opts.identity.tokenSourceId)
  if (!source) throw new Error(`agent token source not found: ${opts.identity.tokenSourceId}`)
  if (opts.identity.spawnRevision && source.spawnRevision !== opts.identity.spawnRevision) {
    throw new Error(`agent token source changed after identity discovery: ${source.id}`)
  }
  if (!opts.identity.supportedEfforts.includes(opts.effort)) {
    throw new Error(`${opts.identity.displayName} does not support effort ${opts.effort}`)
  }
  const launch: ConversationLaunch = opts.resumeSessionId
    ? { kind: 'resume', source: { provider: opts.identity.provider, sessionId: opts.resumeSessionId, cwd: opts.workDir } }
    : { kind: 'fresh' }
  const { process: proc } = createAgentProcess({
    provider: opts.identity.provider,
    workDir: opts.workDir,
    tokenSourceId: opts.identity.tokenSourceId,
    model: opts.identity.model,
    effort: opts.effort,
    launch,
    developerInstructions: [opts.developerInstructions, DELEGATED_AGENT_INSTRUCTIONS].filter(Boolean).join('\n\n'),
    allowDelegation: false,
    profile: opts.profile,
    managedSkillPluginPath: opts.managedSkillPluginPath,
    hostEnv: { ...opts.hostEnv, LODESTAR_AGENT_ROLE: 'worker' },
    serviceName: 'lodestar-agent',
  })
  return collectAgentTurn(proc, opts.prompt, opts.callbacks)
}

export function collectAgentTurn(
  proc: AgentProcess,
  prompt: string,
  callbacks: AgentWorkerCallbacks = {},
  remember: typeof rememberAgentSession = rememberAgentSession,
): AgentWorkerHandle {
  const output: string[] = []
  let lastError: Error | null = null
  let settled = false
  let finishing: Promise<void> | null = null
  let closeError: Error | null = null
  const waiting: Array<{ request: AgentInputRequest; originalInput: Record<string, unknown> }> = []
  let resolveDone!: (value: AgentWorkerResult) => void
  let rejectDone!: (error: Error) => void
  const startedAt = Date.now()
  const done = new Promise<AgentWorkerResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const rememberSession = (sessionId: string | null | undefined): Error | null => {
    if (!sessionId) return null
    try {
      remember(proc.provider, sessionId)
      callbacks.onSession?.(sessionId)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }
  const cleanupListeners = () => {
    proc.off('assistant_text', onText)
    proc.off('tool_use', onToolUse)
    proc.off('tool_result', onToolResult)
    proc.off('subagent_step', onSubagentStep)
    proc.off('can_use_tool', onPermission)
    proc.off('hook_callback', onHook)
    proc.off('init', onInit)
    if (!proc.isAlive()) proc.off('error', onError)
    proc.off('turn_retry', onRetry)
    proc.off('result', onResult)
    proc.off('exit', onExit)
  }
  const finish = (error?: Error, result?: { checkpoint?: any }): Promise<void> => {
    if (finishing) return finishing
    settled = true
    waiting.length = 0
    finishing = Promise.resolve().then(async () => {
      const registryError = rememberSession(proc.sessionId)
      try { await proc.kill(3000) }
      catch (cause) { closeError = cause instanceof Error ? cause : new Error(String(cause)) }
      cleanupListeners()
      const failures = [error, registryError, closeError].filter((value): value is Error => !!value)
      const failure = failures.length > 1
        ? new AggregateError(failures, failures.map(value => value.message).join('; '))
        : failures[0]
      if (failure) {
        rejectDone(new AgentWorkerFailure(failure, output.join('').trim(), proc.sessionId))
        return
      }
      const sessionId = proc.sessionId
      if (!sessionId) {
        rejectDone(new AgentWorkerFailure(
          new Error('delegated agent completed without a native session id'), output.join('').trim(), null,
        ))
        return
      }
      const text = output.join('').trim()
      const checkpointId = checkpointIdFrom(result?.checkpoint, proc)
      resolveDone({
        output: text,
        outputTruncated: false,
        sessionId,
        ...(checkpointId ? { checkpointId } : {}),
        durationMs: Date.now() - startedAt,
        usage: proc.lastUsage ? { ...proc.lastUsage } : null,
      })
    })
    return finishing
  }
  const onText = (event: { text?: string; parentToolUseId?: string | null }) => {
    if (settled || event?.parentToolUseId || typeof event?.text !== 'string') return
    output.push(event.text)
  }
  const emitProgress = (step: AgentStep) => {
    if (settled) return
    try { callbacks.onProgress?.(step) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onToolUse = (event: { name?: string }) => emitProgress({
    at: new Date().toISOString(), phase: 'started', tool: String(event?.name ?? 'tool'), detail: '',
  })
  const onToolResult = (event: { is_error?: boolean }) => emitProgress({
    at: new Date().toISOString(), phase: 'completed', tool: event?.is_error ? 'tool error' : 'tool result', detail: '',
  })
  const onSubagentStep = (event: { tool?: string; phase?: 'started' | 'completed' }) => emitProgress({
    at: new Date().toISOString(), phase: event?.phase ?? 'info', tool: String(event?.tool ?? 'subagent'), detail: '',
  })
  const onPermission = (request: {
    request_id: string | number
    tool_name?: string
    tool_use_id?: string
    input?: Record<string, unknown>
  }) => {
    if (settled) return
    if (request.tool_name !== 'AskUserQuestion') {
      try { proc.sendPermissionResponse(request.request_id, 'allow', { updatedInput: request.input ?? {} }) }
      catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    let normalized: AgentInputRequest
    try { normalized = normalizeInputRequest(request) }
    catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (waiting.some(pending => pending.request.requestId === normalized.requestId)) return
    waiting.push({ request: normalized, originalInput: request.input ?? {} })
    try { if (waiting.length === 1) callbacks.onNeedsInput?.(normalized) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onHook = (request: { request_id: string | number }) => {
    if (settled) return
    try { proc.sendHookResponse(String(request.request_id), {}) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onInit = (event: { session_id?: string }) => {
    const error = rememberSession(event?.session_id ?? proc.sessionId)
    if (error) void finish(error)
  }
  const onError = (error: unknown) => { lastError = error instanceof Error ? error : new Error(String(error)) }
  const onRetry = (retry: AgentTurnRetry) => {
    emitProgress({
      at: new Date().toISOString(), phase: 'info', tool: 'Codex 容量重试',
      detail: retry.phase === 'waiting'
        ? `${retry.message} · ${retry.delayMs / 1000}s 后重试 #${retry.attempt}`
        : `正在重试 #${retry.attempt}`,
    })
  }
  const onResult = (result: { is_error?: boolean; error?: unknown; subtype?: unknown; checkpoint?: unknown }) => {
    const error = result?.is_error
      ? new Error(String(result.error ?? result.subtype ?? proc.lastResult.subtype ?? 'delegated agent failed'))
      : undefined
    void finish(error, result)
  }
  const onExit = (event: { code?: number | null; signal?: string | null }) => {
    if (settled) return
    const detail = `code=${event?.code ?? 'null'} signal=${event?.signal ?? 'null'}`
    void finish(lastError ?? new Error(`delegated agent exited before result (${detail})`))
  }

  proc.on('assistant_text', onText)
  proc.on('tool_use', onToolUse)
  proc.on('tool_result', onToolResult)
  proc.on('subagent_step', onSubagentStep)
  proc.on('can_use_tool', onPermission)
  proc.on('hook_callback', onHook)
  proc.on('init', onInit)
  proc.on('error', onError)
  proc.on('turn_retry', onRetry)
  proc.on('result', onResult)
  proc.on('exit', onExit)
  try {
    proc.sendInitialize()
    proc.sendUserText(prompt)
  } catch (error) {
    void finish(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    done,
    isAlive: () => proc.isAlive(),
    pendingInput: () => waiting[0]?.request ?? null,
    answer(requestId: string, answers: Record<string, string>): void {
      const pending = waiting[0]
      if (!pending) throw new Error('delegated agent is not waiting for input')
      if (pending.request.requestId !== requestId) {
        throw new Error(`delegated agent input request mismatch: expected ${pending.request.requestId}`)
      }
      proc.sendPermissionResponse(requestId, 'allow', { updatedInput: { ...pending.originalInput, answers } })
      waiting.shift()
      if (waiting[0]) callbacks.onNeedsInput?.(waiting[0].request)
    },
    async cancel(reason = 'delegated agent cancelled'): Promise<void> {
      const wasSettled = settled
      await finish(new Error(reason))
      await done.catch(() => {})
      if (wasSettled) {
        if (proc.isAlive()) await proc.kill(3000)
        closeError = null
        cleanupListeners()
      }
      if (closeError) throw closeError
    },
  }
}

function normalizeInputRequest(request: {
  request_id: string | number
  tool_use_id?: string
  input?: Record<string, unknown>
}): AgentInputRequest {
  const input = request.input ?? {}
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [input]
  const questions = rawQuestions.map((raw, index) => normalizeQuestion(raw, index))
  if (questions.length === 0) throw new Error('delegated agent input request contains no questions')
  return {
    requestId: String(request.request_id),
    ...(request.tool_use_id ? { toolUseId: request.tool_use_id } : {}),
    questions,
  }
}

function normalizeQuestion(raw: unknown, index: number): AgentInputQuestion {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = String(value.question ?? value.prompt ?? value.title ?? '').trim()
  if (!question) throw new Error(`delegated agent input question ${index + 1} is empty`)
  const id = String(value.id ?? question)
  const options = Array.isArray(value.options)
    ? value.options.map(option => {
        if (typeof option === 'string') return { label: option }
        const item = option && typeof option === 'object' ? option as Record<string, unknown> : {}
        return { label: String(item.label ?? item.value ?? ''), ...(item.description ? { description: String(item.description) } : {}) }
      }).filter(option => option.label)
    : []
  return { id, ...(value.header ? { header: String(value.header) } : {}), question, options }
}

function checkpointIdFrom(checkpoint: any, proc: AgentProcess): string | undefined {
  if (typeof checkpoint?.id === 'string' && checkpoint.id) return checkpoint.id
  if ((proc.provider === 'codex' || proc.provider === 'dsh') && typeof proc.lastCompletedTurnId === 'string' && proc.lastCompletedTurnId) return proc.lastCompletedTurnId
  if (proc.provider === 'claude' && proc.lastAssistantUuid) return proc.lastAssistantUuid
  return undefined
}
