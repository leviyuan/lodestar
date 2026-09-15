import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentCards, type AgentCardsDeps } from './agent-cards'
import { agentCardsDeps } from './agent-cards-runtime'
import { requireAgentDescription } from './agent-run-types'
import * as feishu from './feishu'
import { config } from './config'
import { getAgentIdentityCatalog, type AgentIdentity } from './agent-identities'
import { AgentWorkerFailure, startAgentWorker, type AgentWorkerHandle } from './agent-runner'
import { agentApiUrl } from './agent-runtime'
import type {
  AgentAnswerRequest,
  AgentFollowUpRequest,
  AgentRunRequest,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStep,
  AgentWorkerResult,
} from './agent-run-types'
import { AGENT_RUNS_DIR, MANAGED_CLAUDE_PLUGIN_DIR } from './paths'
import { writeJsonStateAtomic, writeStateFileAtomic } from './state-store'
import { log } from './log'
import type { Session } from './session'
import type { AgentReasoningEffort } from './agent-process'

const GLOBAL_AGENT_CONCURRENCY = 8
// Local delegation policy, not an upstream API quota. Shared across all Sessions/models.
const TOKEN_SOURCE_AGENT_CONCURRENCY = new Map<string, number>([['openrouter', 2]])
const NESTED_DELEGATION_ERROR = 'Delegated Agents cannot delegate again; ask the main Agent to assign additional work.'
const MAX_CACHED_RUN_ARTIFACTS = 512
const MAX_WORKER_STEPS = 50
const MAX_SESSION_ACTIVE_RUNS = 64
const MAX_GLOBAL_INFLIGHT_WORKERS = 128

export type AgentPrincipal =
  | { kind: 'session'; session: Session; depth: -1 }
  | { kind: 'worker'; session: Session; runId: string; identityId: string; depth: number }

interface AgentRunRecord {
  snapshot: AgentRunSnapshot
  session: Session | null
  handles: Map<string, AgentWorkerHandle>
  slotOwners: Map<string, string>
  capabilityByIdentity: Map<string, string>
  progressTimers: Map<string, ReturnType<typeof setTimeout>>
  children: Set<string>
  cancelled: boolean
  finalizing: boolean
  finalized: boolean
  persistedArtifacts: Set<string>
  artifactsUnloaded: boolean
}

interface CreateRunOptions {
  parentRunId?: string
  parentKind?: 'follow_up'
  cancellationEpoch: number
  resumeWorker?: AgentWorkerResult
}

export interface AgentServiceDeps extends AgentCardsDeps {
  getCatalog: typeof getAgentIdentityCatalog
  startWorker: typeof startAgentWorker
  sendTextRaw(chatId: string, text: string): Promise<unknown>
  writeArtifact(path: string, value: unknown): void
  writeTextArtifact(path: string, value: string): void
  readTextArtifact(name: string, label: string): string
  loadArtifacts(): AgentRunSnapshot[]
}

const DEFAULT_DEPS: AgentServiceDeps = {
  ...agentCardsDeps,
  getCatalog: getAgentIdentityCatalog,
  startWorker: startAgentWorker,
  sendTextRaw: feishu.sendTextRaw,
  writeArtifact: writeJsonStateAtomic,
  writeTextArtifact: writeStateFileAtomic,
  readTextArtifact,
  loadArtifacts: loadAgentRunArtifacts,
}

export class AgentService {
  readonly presentation: AgentCards
  private readonly runs = new Map<string, AgentRunRecord>()
  private readonly capabilities = new Map<string, AgentPrincipal>()
  private activeTurns = 0
  private readonly activeTurnsBySource = new Map<string, number>()
  private readonly slotWaiters: Array<{ tokenSourceId: string; resolve: () => void }> = []
  private readonly cancellationEpochBySession = new Map<string, number>()
  private startingWorkers = 0
  private readonly startingRunsBySession = new Map<string, number>()
  private readonly startingNativeSessions = new Set<string>()

  constructor(private readonly deps: AgentServiceDeps = DEFAULT_DEPS) {
    this.presentation = new AgentCards(deps)
    this.loadDurableRuns()
  }

  rootPrincipal(session: Session): AgentPrincipal {
    return { kind: 'session', session, depth: -1 }
  }

  principalForCapability(capability: string): AgentPrincipal | null {
    return this.capabilities.get(capability) ?? null
  }

  async startRun(principal: AgentPrincipal, request: AgentRunRequest): Promise<AgentRunSnapshot> {
    if (principal.kind !== 'session') throw new Error(NESTED_DELEGATION_ERROR)
    requireAgentDescription(request.description)
    if (request.sessionId !== undefined) {
      if (!request.sessionId.trim()) throw new Error('agent session_id must be a non-empty string')
      if (request.identityIds.length > 1) throw new Error('agent session continuation accepts at most one identity_id')
      const { run, worker } = this.requireSessionRun(principal, request.sessionId, request.identityIds[0])
      return this.followUp(principal, run.snapshot.runId, {
        identityId: worker.identityId, description: request.description, prompt: request.prompt, effort: request.effort,
      })
    }
    const release = this.reserveCapacity(principal, request.identityIds.length)
    try {
      return await this.createRun(principal.session, request, {
        cancellationEpoch: this.currentCancellationEpoch(principal.session),
      })
    } finally {
      release()
    }
  }

  async followUp(
    principal: AgentPrincipal,
    runId: string,
    request: AgentFollowUpRequest,
  ): Promise<AgentRunSnapshot> {
    if (principal.kind !== 'session') throw new Error(NESTED_DELEGATION_ERROR)
    requireAgentDescription(request.description)
    const source = this.requireMutableDescendant(principal, runId)
    if (!isTerminal(source.snapshot.status)) throw new Error('agent follow-up requires a terminal source run')
    const worker = selectWorker(source.snapshot, request.identityId)
    if (source.handles.get(worker.identityId)?.isAlive?.()) {
      throw new Error('Agent process has not stopped; cannot start follow-up yet')
    }
    if (!worker.sessionId) throw new Error(`${worker.identityName} has no resumable native session id`)
    const effort = request.effort ?? worker.effort
    const release = this.reserveCapacity(principal, 1)
    let releaseSession: (() => void) | undefined
    try {
      releaseSession = this.reserveNativeSession(worker)
      return await this.createRun(principal.session, {
        identityIds: [worker.identityId],
        description: request.description,
        prompt: request.prompt,
        effort,
      }, {
        parentRunId: source.snapshot.runId,
        parentKind: 'follow_up',
        cancellationEpoch: this.currentCancellationEpoch(principal.session),
        resumeWorker: worker,
      })
    } finally {
      releaseSession?.()
      release()
    }
  }

  async answer(
    principal: AgentPrincipal,
    runId: string,
    request: AgentAnswerRequest,
  ): Promise<AgentRunSnapshot> {
    const run = this.requireMutableDescendant(principal, runId)
    const worker = selectWorker(run.snapshot, request.identityId)
    if (worker.status !== 'needs_input' || !worker.pendingInput) {
      throw new Error(`${worker.identityName} is not waiting for input`)
    }
    if (worker.pendingInput.requestId !== request.requestId) {
      throw new Error(`input request mismatch: expected ${worker.pendingInput.requestId}`)
    }
    const handle = run.handles.get(worker.identityId)
    if (!handle) throw new Error('waiting agent process is no longer alive; start a follow-up run')
    handle.answer(request.requestId, request.answers)
    const nextInput = handle.pendingInput()
    worker.status = nextInput ? 'needs_input' : 'running'
    if (nextInput) worker.pendingInput = nextInput
    else delete worker.pendingInput
    delete worker.queuedReason
    this.refreshNonterminalStatus(run)
    this.persist(run)
    await this.updateWorkerCard(run, worker)
    return this.readSnapshot(run)
  }

  getRun(principal: AgentPrincipal, runId: string): AgentRunSnapshot {
    return this.readSnapshot(this.requireAccessibleRun(principal, runId))
  }

  async cancelRun(principal: AgentPrincipal, runId: string, reason = 'agent run cancelled'): Promise<boolean> {
    const run = this.requireMutableDescendant(principal, runId)
    if (!this.treeHasActiveRun(run)) return false
    await this.cancelTree(run, reason)
    return true
  }

  async cancelSessionRuns(sessionName: string, chatId: string, reason: string): Promise<void> {
    this.bumpCancellationEpoch(sessionName, chatId)
    const roots = [...this.runs.values()].filter(run =>
      run.snapshot.sessionName === sessionName
      && run.snapshot.chatId === chatId
      && !run.snapshot.parentRunId
      && this.treeHasActiveRun(run))
    const results = await Promise.allSettled(roots.map(run => this.cancelTree(run, reason)))
    throwCancellationFailures(results)
  }

  async shutdown(reason: string): Promise<void> {
    const sessions = new Set([...this.runs.values()].map(run => `${run.snapshot.sessionName}\u0000${run.snapshot.chatId}`))
    for (const key of sessions) {
      const [sessionName, chatId] = key.split('\u0000')
      this.bumpCancellationEpoch(sessionName, chatId)
    }
    const roots = [...this.runs.values()].filter(run => !run.snapshot.parentRunId && this.treeHasActiveRun(run))
    const results = await Promise.allSettled(roots.map(run => this.cancelTree(run, reason)))
    const remaining = [...this.runs.values()].flatMap(run => [...run.handles.values()])
    const remainingResults = results.some(result => result.status === 'rejected')
      ? [] : await Promise.allSettled(remaining.map(handle => handle.cancel(reason)))
    throwCancellationFailures([...results, ...remainingResults])
    for (const chatId of new Set([...this.runs.values()].map(run => run.snapshot.chatId))) {
      await this.presentation.closeChat(chatId)
    }
  }

  private async createRun(
    session: Session,
    request: AgentRunRequest,
    options: CreateRunOptions,
  ): Promise<AgentRunSnapshot> {
    let parent: AgentRunRecord | undefined
    if (options.parentRunId) {
      parent = this.runs.get(options.parentRunId)
      if (!parent) throw new Error(`parent agent run not found: ${options.parentRunId}`)
      this.assertSameSession(parent, session)
    }
    const codexAccountId = session.codexAccountId()
    const catalog = this.deps.getCatalog(codexAccountId)
    const identities = request.identityIds.map(id => {
      const identity = catalog.identities.find(item => item.id === id)
      if (!identity) throw new Error(`agent identity not found: ${id}`)
      if (identity.status !== 'ready') throw new Error(`${identity.displayName}: ${identity.reason ?? identity.status}`)
      const previous = options.resumeWorker
      if (previous && (identity.id !== previous.identityId || identity.provider !== previous.provider
        || identity.tokenSourceId !== previous.tokenSourceId || identity.model !== previous.model)) {
        throw new Error('agent session identity changed; cannot resume with a different provider, source or model')
      }
      return identity
    })
    const workers = identities.map(identity => workerSnapshot(
      identity,
      resolveEffort(identity, request.effort),
      options.resumeWorker?.sessionId,
    ))
    const runId = `agent_${randomUUID()}`
    const snapshot: AgentRunSnapshot = {
      runId,
      codexAccountId,
      sessionName: session.sessionName,
      chatId: session.chatId,
      workDir: session.workDir,
      prompt: request.prompt,
      description: requireAgentDescription(request.description),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.parentKind ? { parentKind: options.parentKind } : {}),
      depth: 0,
      status: 'queued',
      workers,
      createdAt: new Date().toISOString(),
    }
    const run: AgentRunRecord = {
      snapshot,
      session,
      handles: new Map(),
      slotOwners: new Map(),
      capabilityByIdentity: new Map(),
      progressTimers: new Map(),
      children: new Set(),
      cancelled: false,
      finalizing: false,
      finalized: false,
      persistedArtifacts: new Set(),
      artifactsUnloaded: false,
    }
    try {
      await this.presentation.add(snapshot)
    } catch (error) {
      this.runs.set(runId, run)
      if (options.parentRunId) parent?.children.add(runId)
      const reason = `Agent 卡片初始化失败，Agent 未启动: ${messageOf(error)}`
      for (const worker of workers) {
        worker.status = 'failed'
        worker.error = reason
      }
      await this.finalizeRun(run, 'failed', reason)
      await this.deps.sendTextRaw(session.chatId, `❌ ${reason}`)
      throw error
    }
    this.runs.set(runId, run)
    if (options.parentRunId) parent?.children.add(runId)
    const invalidated = this.currentCancellationEpoch(session) !== options.cancellationEpoch
    if (invalidated) {
      run.cancelled = true
      const reason = '任务已在启动前取消'
      for (const worker of run.snapshot.workers) {
        worker.status = 'cancelled'
        worker.error = reason
        worker.finishedAt = new Date().toISOString()
      }
      this.persist(run)
      await Promise.all(run.snapshot.workers.map(worker => this.updateWorkerCard(run, worker)))
      await this.finalizeRun(run, 'cancelled', reason)
      return this.readSnapshot(run)
    }
    this.persist(run)
    for (const identity of identities) {
      const resumeSessionId = options.resumeWorker?.sessionId
      void this.executeWorker(run, identity, request.prompt, resumeSessionId).catch(error => {
        log(`agent: run=${runId} worker=${identity.id} crashed: ${messageOf(error)}`)
      })
    }
    return this.readSnapshot(run)
  }

  private async executeWorker(
    run: AgentRunRecord,
    identity: AgentIdentity,
    prompt: string,
    resumeSessionId?: string,
  ): Promise<void> {
    const worker = run.snapshot.workers.find(item => item.identityId === identity.id)!
    await this.acquireSlot(identity, reason => {
      worker.queuedReason = reason
      this.persist(run)
      void this.updateWorkerCard(run, worker)
    })
    run.slotOwners.set(identity.id, identity.tokenSourceId)
    if (run.cancelled) {
      this.releaseWorkerSlot(run, identity.id)
      return
    }
    let capability = ''
    try {
      capability = randomBytes(32).toString('base64url')
      this.capabilities.set(capability, {
        kind: 'worker',
        session: run.session!,
        runId: run.snapshot.runId,
        identityId: identity.id,
        depth: run.snapshot.depth,
      })
      run.capabilityByIdentity.set(identity.id, capability)
      worker.status = 'running'
      worker.startedAt = new Date().toISOString()
      delete worker.queuedReason
      this.refreshNonterminalStatus(run)
      this.persist(run)
      await this.updateWorkerCard(run, worker)
      if (run.cancelled) return
      const handle = this.deps.startWorker({
        identity,
        codexAccountId: run.snapshot.codexAccountId,
        effort: worker.effort as AgentReasoningEffort,
        workDir: run.snapshot.workDir,
        prompt,
        resumeSessionId,
        developerInstructions: run.session!.delegatedAgentDeveloperInstructions(identity.provider),
        profile: fullAgentProfile(feishu.projectProfile(run.session!.worktreeProjectName())),
        ...(process.env.LODESTAR_DISABLE_SKILL_SYNC === '1' ? {} : { managedSkillPluginPath: MANAGED_CLAUDE_PLUGIN_DIR }),
        hostEnv: {
          LODESTAR_AGENT_URL: agentApiUrl(config.notify.bind, config.notify.port),
          LODESTAR_AGENT_CAPABILITY: capability,
          LODESTAR_AGENT_SESSION: run.snapshot.sessionName,
        },
        callbacks: {
          onNeedsInput: request => {
            if (run.cancelled) return
            worker.status = 'needs_input'
            worker.pendingInput = request
            this.refreshNonterminalStatus(run)
            this.persist(run)
            void this.updateWorkerCard(run, worker)
          },
          onProgress: step => this.recordStep(run, worker, step),
          onCodexAccount: accountId => {
            if (run.cancelled) return
            worker.codexAccountId = accountId
            this.persist(run)
          },
          onSession: sessionId => {
            if (worker.sessionId === sessionId) return
            worker.sessionId = sessionId
            this.persist(run)
          },
        },
      })
      run.handles.set(identity.id, handle)
      const result = await handle.done
      if (run.cancelled) return
      this.clearProgressTimer(run, identity.id)
      worker.status = 'completed'
      worker.output = result.output
      worker.outputTruncated = result.outputTruncated
      worker.sessionId = result.sessionId
      worker.checkpointId = result.checkpointId
      worker.durationMs = result.durationMs
      worker.usage = result.usage
      worker.finishedAt = new Date().toISOString()
      delete worker.pendingInput
      this.persist(run)
      await this.updateWorkerCard(run, worker)
    } catch (error) {
      if (error instanceof AgentWorkerFailure) {
        worker.output = error.output
        worker.outputTruncated = false
        if (error.sessionId) worker.sessionId = error.sessionId
        this.persist(run)
      }
      if (!run.cancelled) {
        this.clearProgressTimer(run, identity.id)
        worker.status = 'failed'
        worker.error = messageOf(error)
        worker.finishedAt = new Date().toISOString()
        if (worker.startedAt) worker.durationMs = Date.now() - Date.parse(worker.startedAt)
        delete worker.pendingInput
        this.persist(run)
        await this.updateWorkerCard(run, worker)
      }
    } finally {
      if (!run.handles.get(identity.id)?.isAlive?.()) {
        run.handles.delete(identity.id)
        this.releaseWorkerSlot(run, identity.id)
      }
      if (capability) this.capabilities.delete(capability)
      run.capabilityByIdentity.delete(identity.id)
      this.recomputeRun(run)
    }
  }

  private recordStep(run: AgentRunRecord, worker: AgentWorkerResult, step: AgentStep): void {
    if (run.cancelled || run.finalizing || run.finalized || isWorkerTerminal(worker.status)) return
    worker.steps.push(step)
    if (worker.steps.length > MAX_WORKER_STEPS) worker.steps.splice(0, worker.steps.length - MAX_WORKER_STEPS)
    if (run.progressTimers.has(worker.identityId)) return
    const timer = setTimeout(() => {
      run.progressTimers.delete(worker.identityId)
      void this.updateWorkerCard(run, worker)
    }, 250)
    run.progressTimers.set(worker.identityId, timer)
  }

  private clearProgressTimer(run: AgentRunRecord, identityId: string): void {
    const timer = run.progressTimers.get(identityId)
    if (timer) clearTimeout(timer)
    run.progressTimers.delete(identityId)
  }

  private refreshNonterminalStatus(run: AgentRunRecord): void {
    if (run.cancelled) return
    if (run.snapshot.workers.some(worker => worker.status === 'needs_input')) run.snapshot.status = 'needs_input'
    else if (run.snapshot.workers.some(worker => worker.status === 'running')) run.snapshot.status = 'running'
    else run.snapshot.status = 'queued'
    delete run.snapshot.finishedAt
  }

  private recomputeRun(run: AgentRunRecord): void {
    if (run.cancelled || run.finalized || run.finalizing) return
    const workers = run.snapshot.workers
    if (workers.some(worker => worker.status === 'needs_input' || worker.status === 'running' || worker.status === 'queued')) {
      this.refreshNonterminalStatus(run)
      this.persist(run)
      return
    }
    const status: AgentRunStatus = workers.some(worker => worker.status === 'failed') ? 'failed' : 'completed'
    void this.finalizeRun(run, status, status === 'failed' ? '一个或多个 Agent 失败' : undefined).catch(error => {
      run.finalizing = false
      run.finalized = false
      run.snapshot.status = 'failed'
      run.snapshot.error = `Agent terminal persistence failed: ${messageOf(error)}`
      log(`agent: terminal finalization failed run=${run.snapshot.runId}: ${messageOf(error)}`)
      void this.deps.sendTextRaw(run.snapshot.chatId, `❌ agent ${run.snapshot.runId} 收尾失败: ${messageOf(error)}`)
        .catch(deliveryError => log(`agent: terminal failure delivery failed: ${messageOf(deliveryError)}`))
    })
  }

  private async cancelTree(run: AgentRunRecord, reason: string): Promise<void> {
    const activeSelf = (!isTerminal(run.snapshot.status) && !run.cancelled) || run.handles.size > 0
    const failures: PromiseSettledResult<void>[] = []
    if (activeSelf) {
      run.cancelled = true
      for (const identityId of [...run.progressTimers.keys()]) this.clearProgressTimer(run, identityId)
      for (const capability of run.capabilityByIdentity.values()) this.capabilities.delete(capability)
      run.capabilityByIdentity.clear()
    }
    while (true) {
      const children = [...run.children]
        .map(childId => this.runs.get(childId))
        .filter((child): child is AgentRunRecord => !!child && this.treeHasActiveRun(child))
      if (children.length === 0) break
      const results = await Promise.allSettled(children.map(child => this.cancelTree(child, reason)))
      failures.push(...results)
      if (results.some(result => result.status === 'rejected')) break
    }
    if (!activeSelf) { throwCancellationFailures(failures); return }
    failures.push(...await Promise.allSettled([...run.handles].map(async ([identityId, handle]) => {
      await handle.cancel(reason)
      if (handle.isAlive?.()) throw new Error(`${identityId}: Agent process is still alive after cancellation`)
      run.handles.delete(identityId)
      this.releaseWorkerSlot(run, identityId)
    })))
    if (failures.some(result => result.status === 'rejected')) {
      const error = cancellationError(failures)
      run.snapshot.status = 'failed'
      run.snapshot.error = error.message
      this.persist(run)
      await this.deps.sendTextRaw(run.snapshot.chatId, `❌ Agent 取消未完成: ${error.message}`)
        .catch(deliveryError => log(`agent: cancellation failure notice failed: ${messageOf(deliveryError)}`))
      throw error
    }
    const cancelledWorkers: AgentWorkerResult[] = []
    for (const worker of run.snapshot.workers) {
      if (!isWorkerTerminal(worker.status)) {
        worker.status = 'cancelled'
        worker.error = reason
        worker.finishedAt = new Date().toISOString()
        delete worker.pendingInput
        cancelledWorkers.push(worker)
      }
    }
    await Promise.all(cancelledWorkers.map(worker => this.updateWorkerCard(run, worker)))
    await this.finalizeRun(run, 'cancelled', reason)
  }

  private async finalizeRun(run: AgentRunRecord, status: AgentRunStatus, error?: string): Promise<void> {
    if (run.finalized || run.finalizing) return
    run.finalizing = true
    for (const identityId of [...run.progressTimers.keys()]) this.clearProgressTimer(run, identityId)
    run.snapshot.status = status
    run.snapshot.finishedAt = new Date().toISOString()
    if (error) run.snapshot.error = error
    try {
      await this.presentation.update(run.snapshot, true)
    } catch (presentationError) {
      this.recordPresentationError(run, `agent card finalization failed: ${messageOf(presentationError)}`)
    }
    run.finalizing = false
    this.persist(run)
    run.finalized = true
    this.pruneRunArtifacts()
    if (run.snapshot.presentationErrors?.length) {
      const details = run.snapshot.presentationErrors.map((detail, index) => `${index + 1}. ${detail}`).join('\n')
      const preview = details.length > 3000 ? `${details.slice(0, 3000)}\n…完整错误已保存在任务记录中。` : details
      await this.deps.sendTextRaw(
        run.snapshot.chatId,
        `⚠️ 委派卡片出现更新错误 · ${run.snapshot.description ?? run.snapshot.runId}\n结果已保存，卡片更新期间出现 ${run.snapshot.presentationErrors.length} 个错误：\n${preview}\n任务：${run.snapshot.runId}`,
      ).catch(error => log(`agent: warning delivery failed run=${run.snapshot.runId}: ${messageOf(error)}`))
    }
  }

  private async updateWorkerCard(run: AgentRunRecord, worker: AgentWorkerResult): Promise<void> {
    if (run.finalized) return
    const previousMessageId = run.snapshot.cardMessageId
    try {
      await this.presentation.update(run.snapshot)
    } catch (error) {
      this.recordPresentationError(run, `agent worker card update failed (${worker.identityName}): ${messageOf(error)}`)
    } finally {
      if (run.snapshot.cardMessageId !== previousMessageId) this.persist(run)
    }
  }

  private recordPresentationError(run: AgentRunRecord, detail: string): void {
    const errors = run.snapshot.presentationErrors ?? []
    if (!errors.includes(detail)) errors.push(detail)
    run.snapshot.presentationErrors = errors
    log(`agent: ${detail} run=${run.snapshot.runId}`)
  }

  private persist(run: AgentRunRecord): void {
    if (!run.snapshot.promptArtifact) run.snapshot.promptArtifact = `${run.snapshot.runId}.prompt.txt`
    this.persistTextArtifact(run, run.snapshot.promptArtifact, run.snapshot.prompt)
    for (const worker of run.snapshot.workers) {
      if (!worker.output) continue
      if (!worker.outputArtifact) {
        const identityHash = createHash('sha256').update(worker.identityId).digest('hex').slice(0, 16)
        worker.outputArtifact = `${run.snapshot.runId}.${identityHash}.output.txt`
      }
      this.persistTextArtifact(run, worker.outputArtifact, worker.output)
    }
    const durable = cloneSnapshot(run.snapshot)
    durable.prompt = ''
    for (const worker of durable.workers) worker.output = ''
    this.deps.writeArtifact(join(AGENT_RUNS_DIR, `${run.snapshot.runId}.json`), durable)
  }

  private persistTextArtifact(run: AgentRunRecord, name: string, value: string): void {
    if (run.persistedArtifacts.has(name)) return
    assertArtifactName(name)
    this.deps.writeTextArtifact(join(AGENT_RUNS_DIR, name), value)
    run.persistedArtifacts.add(name)
  }

  private readSnapshot(run: AgentRunRecord): AgentRunSnapshot {
    const snapshot = cloneSnapshot(run.snapshot)
    if (run.artifactsUnloaded) hydrateSnapshotArtifacts(snapshot, snapshot.runId, this.deps.readTextArtifact)
    return snapshot
  }

  private requireAccessibleRun(principal: AgentPrincipal, runId: string): AgentRunRecord {
    const run = this.runs.get(runId)
    if (!run || !this.canAccess(principal, run)) throw new Error(`agent run not found: ${runId}`)
    this.assertSameSession(run, principal.session)
    if (!run.session) run.session = principal.session
    return run
  }

  private requireSessionRun(principal: AgentPrincipal, sessionId: string, identityId?: string): {
    run: AgentRunRecord; worker: AgentWorkerResult
  } {
    const matches = [...this.runs.values()].flatMap(run => {
      if (!this.canAccess(principal, run) || run.snapshot.workDir !== principal.session.workDir) return []
      return run.snapshot.workers
        .filter(worker => worker.sessionId === sessionId && (!identityId || worker.identityId === identityId))
        .map(worker => ({ run, worker }))
    })
    if (!matches.length) throw new Error(`agent session not found in this Session${identityId ? ' for the requested identity' : ''}: ${sessionId}`)
    if (new Set(matches.map(({ worker }) => worker.identityId)).size > 1) {
      throw new Error('agent session id matches multiple identities; specify identity_id')
    }
    // Follow-up lineage breaks timestamp ties, including after durable history is reloaded.
    const parents = new Set(matches.map(({ run }) => run.snapshot.parentRunId))
    const latest = matches.filter(({ run }) => !parents.has(run.snapshot.runId))
      .sort((a, b) => Date.parse(b.run.snapshot.createdAt) - Date.parse(a.run.snapshot.createdAt))[0]
    if (!latest) throw new Error(`agent session history has no latest run: ${sessionId}`)
    return latest
  }

  private reserveNativeSession(worker: AgentWorkerResult): () => void {
    const key = JSON.stringify([worker.provider, worker.sessionId])
    const occupied = [...this.runs.values()].some(run => run.snapshot.workers.some(other => {
      if (other.provider !== worker.provider || other.sessionId !== worker.sessionId) return false
      const handle = run.handles.get(other.identityId)
      return !isWorkerTerminal(other.status) || !!handle && handle.isAlive?.() !== false
    }))
    if (this.startingNativeSessions.has(key) || occupied) {
      throw new Error('agent session is already running or starting; wait for the current turn to finish')
    }
    // Reserve before card creation's first await; queued runs keep the session occupied afterward.
    this.startingNativeSessions.add(key)
    return () => { this.startingNativeSessions.delete(key) }
  }

  private requireMutableDescendant(principal: AgentPrincipal, runId: string): AgentRunRecord {
    const run = this.requireAccessibleRun(principal, runId)
    if (principal.kind === 'worker' && run.snapshot.runId === principal.runId) {
      throw new Error('worker capability cannot mutate its containing run')
    }
    return run
  }

  private canAccess(principal: AgentPrincipal, target: AgentRunRecord): boolean {
    if (target.snapshot.sessionName !== principal.session.sessionName || target.snapshot.chatId !== principal.session.chatId) return false
    if (principal.kind === 'session') return true
    let current: AgentRunRecord | undefined = target
    while (current) {
      if (current.snapshot.runId === principal.runId) return true
      current = current.snapshot.parentRunId ? this.runs.get(current.snapshot.parentRunId) : undefined
    }
    return false
  }

  private assertSameSession(run: AgentRunRecord, session: Session): void {
    if (
      run.snapshot.sessionName !== session.sessionName
      || run.snapshot.chatId !== session.chatId
      || run.snapshot.workDir !== session.workDir
    ) throw new Error('agent run belongs to a different Session')
  }

  private treeHasActiveRun(run: AgentRunRecord): boolean {
    if (run.handles.size > 0) return true
    if (!isTerminal(run.snapshot.status)) return true
    for (const childId of run.children) {
      const child = this.runs.get(childId)
      if (child && this.treeHasActiveRun(child)) return true
    }
    return false
  }

  private reserveCapacity(principal: AgentPrincipal, workerCount: number): () => void {
    const sessionKey = this.sessionKey(principal.session.sessionName, principal.session.chatId)
    const activeSessionRuns = [...this.runs.values()].filter(run =>
      this.sessionKey(run.snapshot.sessionName, run.snapshot.chatId) === sessionKey
      && (!isTerminal(run.snapshot.status) || run.handles.size > 0)).length
    const startingSessionRuns = this.startingRunsBySession.get(sessionKey) ?? 0
    if (activeSessionRuns + startingSessionRuns >= MAX_SESSION_ACTIVE_RUNS) {
      throw new Error(`Session has reached ${MAX_SESSION_ACTIVE_RUNS} active Agent runs`)
    }
    const inflightWorkers = [...this.runs.values()].reduce((sum, run) =>
      sum + run.snapshot.workers.filter(worker =>
        !isWorkerTerminal(worker.status) || run.handles.get(worker.identityId)?.isAlive?.(),
      ).length, 0)
    if (inflightWorkers + this.startingWorkers + workerCount > MAX_GLOBAL_INFLIGHT_WORKERS) {
      throw new Error(`global Agent worker limit ${MAX_GLOBAL_INFLIGHT_WORKERS} would be exceeded`)
    }
    this.startingWorkers += workerCount
    this.startingRunsBySession.set(sessionKey, startingSessionRuns + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.startingWorkers = Math.max(0, this.startingWorkers - workerCount)
      decrementMap(this.startingRunsBySession, sessionKey)
    }
  }

  private sessionKey(sessionName: string, chatId: string): string {
    return `${sessionName}\u0000${chatId}`
  }

  private currentCancellationEpoch(session: Session): number {
    return this.cancellationEpochBySession.get(this.sessionKey(session.sessionName, session.chatId)) ?? 0
  }

  private bumpCancellationEpoch(sessionName: string, chatId: string): void {
    const key = this.sessionKey(sessionName, chatId)
    this.cancellationEpochBySession.set(key, (this.cancellationEpochBySession.get(key) ?? 0) + 1)
  }

  private tryAcquireSlot(tokenSourceId: string): boolean {
    const sourceLimit = TOKEN_SOURCE_AGENT_CONCURRENCY.get(tokenSourceId)
    const sourceTurns = this.activeTurnsBySource.get(tokenSourceId) ?? 0
    if (this.activeTurns >= GLOBAL_AGENT_CONCURRENCY
      || (sourceLimit !== undefined && sourceTurns >= sourceLimit)) return false
    this.activeTurns++
    this.activeTurnsBySource.set(tokenSourceId, sourceTurns + 1)
    return true
  }

  private acquireSlot(identity: AgentIdentity, onQueued: (reason: string) => void): Promise<void> {
    if (this.tryAcquireSlot(identity.tokenSourceId)) return Promise.resolve()
    const sourceLimit = TOKEN_SOURCE_AGENT_CONCURRENCY.get(identity.tokenSourceId)
    onQueued(sourceLimit !== undefined
      ? `等待 ${identity.tokenSourceDisplay} 执行名额（同一来源最多同时运行 ${sourceLimit} 个 Agent）`
      : `等待执行名额（最多同时运行 ${GLOBAL_AGENT_CONCURRENCY} 个 Agent）`)
    return new Promise(resolve => this.slotWaiters.push({ tokenSourceId: identity.tokenSourceId, resolve }))
  }

  private releaseSlot(tokenSourceId: string): void {
    this.activeTurns--
    decrementMap(this.activeTurnsBySource, tokenSourceId)
    // A saturated source must not block other sources from using free global slots.
    for (let i = 0; i < this.slotWaiters.length && this.activeTurns < GLOBAL_AGENT_CONCURRENCY;) {
      const next = this.slotWaiters[i]!
      if (!this.tryAcquireSlot(next.tokenSourceId)) { i++; continue }
      this.slotWaiters.splice(i, 1)
      next.resolve()
    }
  }

  private releaseWorkerSlot(run: AgentRunRecord, identityId: string): void {
    const tokenSourceId = run.slotOwners.get(identityId)
    if (tokenSourceId === undefined) return
    run.slotOwners.delete(identityId)
    this.releaseSlot(tokenSourceId)
  }

  private loadDurableRuns(): void {
    for (const snapshot of this.deps.loadArtifacts()) {
      if (!isTerminal(snapshot.status)) {
        snapshot.status = 'failed'
        snapshot.error = 'daemon restarted before this Agent run reached a terminal state'
        snapshot.finishedAt = new Date().toISOString()
        for (const worker of snapshot.workers) {
          if (!isWorkerTerminal(worker.status)) {
            worker.status = 'failed'
            worker.error = snapshot.error
            worker.finishedAt = snapshot.finishedAt
            delete worker.pendingInput
          }
        }
      }
      const record: AgentRunRecord = {
        snapshot,
        session: null,
        handles: new Map(),
        slotOwners: new Map(),
        capabilityByIdentity: new Map(),
        progressTimers: new Map(),
        children: new Set(),
        cancelled: snapshot.status === 'cancelled',
        finalizing: false,
        finalized: true,
        artifactsUnloaded: false,
        persistedArtifacts: new Set([
          ...(snapshot.promptArtifact ? [snapshot.promptArtifact] : []),
          ...snapshot.workers.flatMap(worker => worker.outputArtifact ? [worker.outputArtifact] : []),
        ]),
      }
      this.runs.set(snapshot.runId, record)
      this.persist(record)
    }
    for (const run of this.runs.values()) {
      if (run.snapshot.parentRunId) this.runs.get(run.snapshot.parentRunId)?.children.add(run.snapshot.runId)
    }
    this.pruneRunArtifacts()
  }

  private pruneRunArtifacts(): void {
    if (this.runs.size <= MAX_CACHED_RUN_ARTIFACTS) return
    const terminal = [...this.runs.values()]
      .filter(run => !run.artifactsUnloaded && run.finalized && !run.finalizing && isTerminal(run.snapshot.status)
        && run.handles.size === 0 && run.slotOwners.size === 0)
      .sort((a, b) => Date.parse(a.snapshot.finishedAt ?? a.snapshot.createdAt) - Date.parse(b.snapshot.finishedAt ?? b.snapshot.createdAt))
    // The run map is the continuation index and cancellation tree, not a cache.
    // Keep every record and link; only evict text already saved in artifacts.
    for (const run of terminal.slice(0, Math.max(0, terminal.length - MAX_CACHED_RUN_ARTIFACTS))) {
      run.snapshot.prompt = ''
      for (const worker of run.snapshot.workers) worker.output = ''
      run.artifactsUnloaded = true
    }
  }
}

function workerSnapshot(
  identity: AgentIdentity,
  effort: AgentReasoningEffort,
  resumeSessionId?: string,
): AgentWorkerResult {
  return {
    identityId: identity.id,
    identityName: identity.displayName,
    tokenSourceId: identity.tokenSourceId,
    provider: identity.provider,
    model: identity.model,
    effort,
    status: 'queued',
    output: '',
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    steps: [],
  }
}

function resolveEffort(identity: AgentIdentity, raw: string | undefined): AgentReasoningEffort {
  const effort = raw ?? identity.defaultEffort
  if (!effort) throw new Error(`${identity.displayName} default effort MISS; specify effort explicitly`)
  if (!identity.supportedEfforts.includes(effort as AgentReasoningEffort)) {
    throw new Error(`${identity.displayName} does not support effort ${effort}`)
  }
  return effort as AgentReasoningEffort
}

function selectWorker(snapshot: AgentRunSnapshot, identityId?: string): AgentWorkerResult {
  if (identityId) {
    const worker = snapshot.workers.find(item => item.identityId === identityId)
    if (!worker) throw new Error(`agent identity is not part of run ${snapshot.runId}: ${identityId}`)
    return worker
  }
  if (snapshot.workers.length !== 1) throw new Error('run has multiple Agents; specify identity_id')
  return snapshot.workers[0]
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isWorkerTerminal(status: AgentWorkerResult['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function cloneSnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as AgentRunSnapshot
}

function loadAgentRunArtifacts(): AgentRunSnapshot[] {
  if (!existsSync(AGENT_RUNS_DIR)) return []
  const snapshots: AgentRunSnapshot[] = []
  for (const name of readdirSync(AGENT_RUNS_DIR).filter(name => name.endsWith('.json')).sort()) {
    const path = join(AGENT_RUNS_DIR, name)
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) { throw new Error(`agent run artifact is unreadable (${path}): ${messageOf(error)}`) }
    if (!isAgentRunSnapshot(value)) throw new Error(`agent run artifact is invalid: ${path}`)
    hydrateSnapshotArtifacts(value, path)
    snapshots.push(value)
  }
  return snapshots
}

function isAgentRunSnapshot(value: unknown): value is AgentRunSnapshot {
  if (!value || typeof value !== 'object') return false
  const run = value as Partial<AgentRunSnapshot>
  return typeof run.runId === 'string'
    && run.runId.startsWith('agent_')
    && typeof run.sessionName === 'string'
    && typeof run.chatId === 'string'
    && typeof run.workDir === 'string'
    && typeof run.prompt === 'string'
    && (run.description === undefined || typeof run.description === 'string')
    && typeof run.depth === 'number'
    && typeof run.status === 'string'
    && Array.isArray(run.workers)
    && typeof run.createdAt === 'string'
}

function cancellationError(results: PromiseSettledResult<void>[]): AggregateError {
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  return new AggregateError(failures, `Agent cancellation failed: ${failures.map(messageOf).join('; ')}`)
}

function throwCancellationFailures(results: PromiseSettledResult<void>[]): void {
  if (results.some(result => result.status === 'rejected')) throw cancellationError(results)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fullAgentProfile(profile: ReturnType<typeof feishu.projectProfile>): ReturnType<typeof feishu.projectProfile> {
  return profile
    ? { ...profile, tools: undefined, strictMcp: false, loadProjectMcp: true }
    : { strictMcp: false, loadProjectMcp: true }
}

function hydrateSnapshotArtifacts(
  snapshot: AgentRunSnapshot,
  snapshotPath: string,
  read: AgentServiceDeps['readTextArtifact'] = readTextArtifact,
): void {
  if (snapshot.promptArtifact) snapshot.prompt = read(snapshot.promptArtifact, `prompt for ${snapshotPath}`)
  for (const worker of snapshot.workers) {
    if (worker.outputArtifact) worker.output = read(worker.outputArtifact, `output for ${snapshotPath}`)
  }
}

function readTextArtifact(name: string, label: string): string {
  assertArtifactName(name)
  try { return readFileSync(join(AGENT_RUNS_DIR, name), 'utf8') }
  catch (error) { throw new Error(`${label} is unreadable (${name}): ${messageOf(error)}`) }
}

function assertArtifactName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid Agent artifact name: ${name}`)
}

function decrementMap<TKey>(map: Map<TKey, number>, key: TKey): void {
  const next = (map.get(key) ?? 0) - 1
  if (next > 0) map.set(key, next)
  else map.delete(key)
}
