import type { AgentProcess, AgentReasoningEffort, AgentTurnRetry } from './agent-process'
import { processUsesClaudeTranslation } from './agent-process'
import { assertAgentIdentityIdAllowed, assertAgentSourceAllowed, type AgentIdentity } from './agent-identities'
import { createAgentProcess } from './agent-launch'
import { rememberAgentSession } from './agent-session-registry'
import type { AgentInputQuestion, AgentInputRequest, AgentStep } from './agent-run-types'
import { PROJECT_AGENT_INPUT_ERROR } from './agent-run-types'
import type { ConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'
import { getTokenSourceForAccount } from './token-source'
import { DELEGATED_AGENT_INSTRUCTIONS, PROJECT_AGENT_INSTRUCTIONS } from './agent-skill'
import { shellCommandPresentation } from './cards/shell-command'

export interface AgentWorkerResult {
  output: string
  displayOutput?: string
  outputTruncated: boolean
  sessionId: string
  checkpointId?: string
  durationMs: number
  usage: Record<string, number | undefined> | null
}

/** Failed work may still contain useful output. Preserve it with the actual
 * failure instead of dropping everything that preceded an error or cancel. */
export class AgentWorkerFailure extends Error {
  constructor(cause: Error, readonly output: string, readonly sessionId: string | null, readonly displayOutput?: string,
    readonly displayError?: string) {
    super(cause.message, { cause })
    this.name = 'AgentWorkerFailure'
  }
}

export interface AgentWorkerCallbacks {
  onNeedsInput?(request: AgentInputRequest, displayRequest?: AgentInputRequest): void
  /** False rejects presentation, for example when the owning run was cancelled. */
  onDisplayContext?(context: { description: string; prompt: string }): boolean | void
  onProgress?(step: AgentStep): void
  onSession?(sessionId: string): void
  onCodexAccount?(accountId: string): void
}

export interface AgentWorkerHandle {
  done: Promise<AgentWorkerResult>
  isAlive?(): boolean
  pendingInput(): AgentInputRequest | null
  displayPendingInput?(): AgentInputRequest | null
  answer(requestId: string, answers: Record<string, string>): void
  cancel(reason?: string): Promise<void>
}

export function startAgentWorker(opts: {
  projectBound?: boolean
  identity: AgentIdentity
  codexAccountId?: string
  effort: AgentReasoningEffort
  workDir: string
  prompt: string
  description?: string
  resumeSessionId?: string
  developerInstructions?: string
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv: Record<string, string | undefined>
  callbacks?: AgentWorkerCallbacks
}): AgentWorkerHandle {
  const source = getTokenSourceForAccount(opts.identity.tokenSourceId, opts.codexAccountId)
  if (!source) throw new Error(`agent token source not found: ${opts.identity.tokenSourceId}`)
  if (opts.identity.spawnRevision && source.spawnRevision !== opts.identity.spawnRevision) {
    throw new Error(`agent token source changed after identity discovery: ${source.id}`)
  }
  assertAgentIdentityIdAllowed(opts.identity.id)
  assertAgentSourceAllowed(opts.identity.tokenSourceId)
  assertAgentSourceAllowed(source.kind === 'claude-subscription' ? 'claude-sub' : source.id)
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
    codexAccountId: opts.codexAccountId,
    ...(opts.identity.provider === 'codex' && opts.identity.tokenSourceId === 'codex-sub'
      ? { codexAccountPreference: null } : {}),
    model: opts.identity.model,
    effort: opts.effort,
    launch,
    developerInstructions: [opts.developerInstructions, opts.projectBound ? PROJECT_AGENT_INSTRUCTIONS : DELEGATED_AGENT_INSTRUCTIONS].filter(Boolean).join('\n\n'),
    allowUserInput: !opts.projectBound,
    profile: opts.profile,
    managedSkillPluginPath: opts.managedSkillPluginPath,
    hostEnv: { ...opts.hostEnv, LODESTAR_AGENT_ROLE: 'worker' },
    serviceName: 'lodestar-agent',
  })
  return collectAgentTurn(proc, opts.prompt, opts.callbacks, undefined, opts.resumeSessionId, !opts.projectBound,
    opts.description ? { description: opts.description, prompt: opts.prompt } : undefined)
}

export function collectAgentTurn(
  proc: AgentProcess,
  prompt: string,
  callbacks: AgentWorkerCallbacks = {},
  remember: typeof rememberAgentSession = rememberAgentSession,
  expectedSessionId?: string,
  allowUserInput = true,
  presentationContext?: { description: string; prompt: string },
): AgentWorkerHandle {
  const output: string[] = []
  const displayOutput: string[] = []
  const requiresTranslation = processUsesClaudeTranslation(proc)
  let hasDisplayOutput = requiresTranslation
  let lastError: Error | null = null
  let settled = false
  let finishing: Promise<void> | null = null
  let closeError: Error | null = null
  const presentationController = new AbortController()
  const waiting: Array<{ request: AgentInputRequest; displayRequest?: AgentInputRequest; originalInput: Record<string, unknown> }> = []
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
      // Resuming an existing conversation does not make it a newly delegated one.
      // Preserve its original visibility in the main rs/fk history.
      if (!expectedSessionId || sessionId !== expectedSessionId) remember(proc.provider, sessionId)
      if (expectedSessionId && sessionId !== expectedSessionId) {
        throw new Error(`native resume returned session ${sessionId}, expected ${expectedSessionId}; refusing to treat it as a resumed conversation`)
      }
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
    proc.off('codex_account_changed', onAccount)
    proc.off('result', onResult)
    proc.off('exit', onExit)
  }
  const finish = (error?: Error, result?: { checkpoint?: any; displayError?: string }): Promise<void> => {
    if (finishing) return finishing
    settled = true
    presentationController.abort(new Error('delegated agent turn ended'))
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
        rejectDone(new AgentWorkerFailure(failure, output.join('').trim(), proc.sessionId,
          hasDisplayOutput ? displayOutput.join('').trim() : undefined,
          result?.displayError === undefined ? undefined
            : [result.displayError, ...failures.filter(value => value !== error).map(value => value.message)].join('; ')))
        return
      }
      const sessionId = proc.sessionId
      if (!sessionId) {
        rejectDone(new AgentWorkerFailure(
          new Error('delegated agent completed without a native session id'), output.join('').trim(), null,
          hasDisplayOutput ? displayOutput.join('').trim() : undefined,
        ))
        return
      }
      const text = output.join('').trim()
      const checkpointId = checkpointIdFrom(result?.checkpoint, proc)
      resolveDone({
        output: text,
        ...(hasDisplayOutput ? { displayOutput: displayOutput.join('').trim() } : {}),
        outputTruncated: false,
        sessionId,
        ...(checkpointId ? { checkpointId } : {}),
        durationMs: Date.now() - startedAt,
        usage: proc.lastUsage ? { ...proc.lastUsage } : null,
      })
    })
    return finishing
  }
  const onText = (event: { text?: string; displayText?: string; parentToolUseId?: string | null }) => {
    if (settled || event?.parentToolUseId || typeof event?.text !== 'string') return
    output.push(event.text)
    if (requiresTranslation && typeof event.displayText !== 'string') {
      void finish(new Error('Claude subscription delegated output is missing verified translation'))
      return
    }
    hasDisplayOutput ||= typeof event.displayText === 'string'
    displayOutput.push(event.displayText ?? event.text)
  }
  const emitProgress = (step: AgentStep) => {
    if (settled) return
    try { callbacks.onProgress?.(step) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onToolUse = (event: { name?: string; input?: Record<string, unknown>; displayInput?: Record<string, unknown> }) => emitProgress({
    at: new Date().toISOString(), phase: 'started', tool: String(event?.name ?? 'tool'),
    detail: event.displayInput ? toolProgressDescription(event.input) : '',
    ...(event.displayInput ? { displayDetail: toolProgressDescription(event.displayInput) } : {}),
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
    originalInput?: Record<string, unknown>
  }) => {
    if (settled) return
    if (request.tool_name !== 'AskUserQuestion') {
      try { proc.sendPermissionResponse(request.request_id, 'allow', { updatedInput: request.input ?? {} }) }
      catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    let normalized: AgentInputRequest
    let displayRequest: AgentInputRequest | undefined
    try {
      normalized = normalizeInputRequest({ ...request, input: request.originalInput ?? request.input })
      if (request.originalInput) {
        displayRequest = normalizeInputRequest(request)
        if (displayRequest.questions.length !== normalized.questions.length) throw new Error('translated question count does not match native questions')
        displayRequest.questions = displayRequest.questions.map((question, index) => ({ ...question, id: normalized.questions[index]!.id }))
      } else if (requiresTranslation) {
        throw new Error('Claude subscription delegated question is missing verified translation')
      }
      if (!allowUserInput) {
        throw new Error(`${PROJECT_AGENT_INPUT_ERROR}: ${normalized.questions.map(question => question.question).join('; ')}`)
      }
    }
    catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (waiting.some(pending => pending.request.requestId === normalized.requestId)) return
    waiting.push({ request: normalized, displayRequest, originalInput: request.originalInput ?? request.input ?? {} })
    try { if (waiting.length === 1) callbacks.onNeedsInput?.(normalized, displayRequest) }
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
  const onAccount = (event: { accountId: string; diagnostics: string[] }) => {
    if (settled) return
    try { callbacks.onCodexAccount?.(event.accountId) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onRetry = (retry: AgentTurnRetry) => {
    const tool = retry.reason === 'quota' ? 'Codex 额度换号'
      : retry.reason === 'stream_disconnected' ? 'Codex 连接中断重试'
      : retry.reason === 'compact_connection_failed' ? 'Codex 压缩连接中断重试'
      : retry.reason === 'transient_error' ? 'Codex 临时故障重试' : 'Codex 容量重试'
    emitProgress({
      at: new Date().toISOString(), phase: 'info', tool,
      detail: retry.phase === 'waiting'
        ? `${retry.message} · ${retry.delayMs / 1000}s 后重试 #${retry.attempt}`
        : `正在重试 #${retry.attempt}`,
    })
  }
  const onResult = (result: { is_error?: boolean; error?: unknown; subtype?: unknown; checkpoint?: unknown; displayError?: string }) => {
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
  proc.on('codex_account_changed', onAccount)
  proc.on('result', onResult)
  proc.on('exit', onExit)
  if (requiresTranslation) proc.setTranslationPresentationPolicy?.(event => {
    if (settled) return 'hidden'
    if (event.kind === 'assistant_text') return event.parentToolUseId ? 'hidden' : 'worker'
    if (event.kind === 'tool_input') return 'worker'
    return 'hidden'
  })
  try {
    proc.sendInitialize()
    if (requiresTranslation && presentationContext) {
      void (async () => {
        if (!proc.translateDisplayFields) throw new Error('Claude subscription delegated context translation is unavailable')
        await proc.translateDisplayFields(
          [presentationContext.description, presentationContext.prompt], presentationController.signal,
          translated => {
            if (settled || !callbacks.onDisplayContext) return false
            if (translated.length !== 2 || translated.some(text => typeof text !== 'string')) {
              throw new Error('Claude subscription delegated context translation returned invalid fields')
            }
            if (callbacks.onDisplayContext({ description: translated[0]!, prompt: translated[1]! }) === false) {
              throw new Error('Delegated task display was not accepted')
            }
            return !settled
          },
        )
        if (settled) return
        proc.sendUserText(prompt)
      })().catch(error => { if (!settled) void finish(error instanceof Error ? error : new Error(String(error))) })
    } else proc.sendUserText(prompt)
  } catch (error) {
    void finish(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    done,
    isAlive: () => proc.isAlive(),
    pendingInput: () => waiting[0]?.request ?? null,
    displayPendingInput: () => waiting[0]?.displayRequest ?? null,
    answer(requestId: string, answers: Record<string, string>): void {
      const pending = waiting[0]
      if (!pending) throw new Error('delegated agent is not waiting for input')
      if (pending.request.requestId !== requestId) {
        throw new Error(`delegated agent input request mismatch: expected ${pending.request.requestId}`)
      }
      proc.sendPermissionResponse(requestId, 'allow', { updatedInput: { ...pending.originalInput, answers } })
      waiting.shift()
      if (waiting[0]) callbacks.onNeedsInput?.(waiting[0].request, waiting[0].displayRequest)
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

function toolProgressDescription(input?: Record<string, unknown>): string {
  // Only explicit presentation input is safe to show here. Never echo command
  // output, arbitrary tool arguments, credentials, or unverified source prose.
  if (!input) return ''
  if (typeof input.__displayDescription === 'string') return input.__displayDescription
  if (typeof input.description === 'string') return input.description
  const command = input.command ?? input.cmd ?? input.script
  if (typeof command === 'string') return shellCommandPresentation(command).description
  if (typeof input.subject === 'string') return input.subject
  return ''
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
