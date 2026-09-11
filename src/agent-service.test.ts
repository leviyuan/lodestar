import { describe, expect, test } from 'bun:test'
import { AgentService, type AgentServiceDeps } from './agent-service'
import type { AgentIdentity, AgentIdentityCatalog } from './agent-identities'
import { AgentWorkerFailure, type AgentWorkerHandle, type AgentWorkerResult } from './agent-runner'

function identity(id: string, name = id): AgentIdentity {
  return {
    id: `agent:${id}`, displayName: name, tokenSourceId: id, tokenSourceDisplay: id,
    provider: id === 'codex' ? 'codex' : 'claude', model: `model-${id}`, modelDisplay: name,
    defaultEffort: 'max', supportedEfforts: ['low', 'max'], sourceDefault: true, status: 'ready',
  }
}

const session = {
  sessionName: 'project', chatId: 'chat-1', workDir: '/repo',
  delegatedAgentDeveloperInstructions: () => '',
  worktreeProjectName: () => 'project',
  codexAccountId: () => 'default',
} as any

function result(sessionId: string, output = 'done'): AgentWorkerResult {
  return { output, outputTruncated: false, sessionId, checkpointId: 'checkpoint', durationMs: 10, usage: null }
}

function resolvedHandle(value: AgentWorkerResult): AgentWorkerHandle {
  return {
    done: Promise.resolve(value),
    pendingInput: () => null,
    answer: () => { throw new Error('not waiting') },
    cancel: async () => {},
  }
}

function controlledHandle(): {
  handle: AgentWorkerHandle
  resolve(value: AgentWorkerResult): void
  reject(error: Error): void
} {
  let resolve!: (value: AgentWorkerResult) => void
  let reject!: (error: Error) => void
  let pending: any = null
  const done = new Promise<AgentWorkerResult>((ok, fail) => { resolve = ok; reject = fail })
  return {
    handle: {
      done,
      pendingInput: () => pending,
      answer: () => {},
      async cancel(reason = 'cancelled') { reject(new Error(reason)); await done.catch(() => {}) },
    },
    resolve,
    reject,
  }
}

function harness(opts: {
  identities?: AgentIdentity[]
  startWorker?: AgentServiceDeps['startWorker']
  loadArtifacts?: AgentServiceDeps['loadArtifacts']
  sendCard?: AgentServiceDeps['sendCard']
  patchSettingsChecked?: AgentServiceDeps['patchSettingsChecked']
  replaceElementChecked?: AgentServiceDeps['replaceElementChecked']
} = {}) {
  const identities = opts.identities ?? [identity('a', 'Agent A')]
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', identities, sourceFailures: [] }
  const artifacts: unknown[] = []
  const textArtifacts = new Map<string, string>()
  const deps: AgentServiceDeps = {
    getCatalog: () => catalog,
    startWorker: opts.startWorker ?? (worker => resolvedHandle(result(`sid-${worker.identity.id}`, `output-${worker.identity.id}`))),
    sendCard: opts.sendCard ?? (async () => 'message-1'),
    sendTextRaw: async () => true,
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementChecked: opts.replaceElementChecked ?? (async () => true),
    patchSummaryThrottled: () => {},
    flush: async () => {},
    cancelSummary: () => {},
    patchSettingsChecked: opts.patchSettingsChecked ?? (async () => true),
    dispose: async () => {},
    writeArtifact: (_path, value) => { artifacts.push(JSON.parse(JSON.stringify(value))) },
    writeTextArtifact: (path, value) => { textArtifacts.set(path, value) },
    loadArtifacts: opts.loadArtifacts ?? (() => []),
  }
  const service = new AgentService(deps)
  return { service, root: service.rootPrincipal(session), artifacts, textArtifacts }
}

async function waitFor(
  service: AgentService,
  principal: ReturnType<AgentService['rootPrincipal']>,
  runId: string,
  status: string,
) {
  for (let i = 0; i < 200; i++) {
    const run = service.getRun(principal, runId)
    if (run.status === status) return run
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`run ${runId} did not reach ${status}`)
}

describe('AgentService', () => {
  test('writes the terminal chat-list summary inside Card Kit config', async () => {
    const settings: object[] = []
    const { service, root } = harness({
      patchSettingsChecked: async (_cardId, value) => { settings.push(value); return true },
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'summary test' })
    await waitFor(service, root, started.runId, 'completed')
    expect(settings.at(-1)).toEqual({
      config: {
        streaming_mode: false,
        summary: { content: '✅ 委派完成 · 1/1' },
      },
    })
  })

  test('runs several full Agents concurrently and persists native sessions', async () => {
    const { service, root, artifacts, textArtifacts } = harness({ identities: [identity('a'), identity('codex')] })
    const started = await service.startRun(root, { identityIds: ['agent:a', 'agent:codex'], prompt: 'implement' })
    const terminal = await waitFor(service, root, started.runId, 'completed')
    expect(terminal.workers.map(worker => worker.sessionId)).toEqual(['sid-agent:a', 'sid-agent:codex'])
    expect(artifacts.length).toBeGreaterThan(1)
    expect(textArtifacts.size).toBe(3)
    expect((artifacts.at(-1) as any).workers.every((worker: any) => worker.output === '')).toBe(true)
  })

  test('bridges needs_input to an exact answer and resumes the same process', async () => {
    let resolve!: (value: AgentWorkerResult) => void
    let pending: any = null
    const { service, root } = harness({
      startWorker: opts => {
        const done = new Promise<AgentWorkerResult>(ok => { resolve = ok })
        queueMicrotask(() => {
          pending = { requestId: 'req-1', questions: [{ id: 'q1', question: 'Proceed?', options: [] }] }
          opts.callbacks?.onNeedsInput?.(pending)
        })
        return {
          done,
          pendingInput: () => pending,
          answer(requestId, answers) {
            expect(requestId).toBe('req-1')
            expect(answers).toEqual({ q1: 'yes' })
            pending = null
            resolve(result('sid-input'))
          },
          async cancel() {},
        }
      },
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'ask if needed' })
    await waitFor(service, root, started.runId, 'needs_input')
    await service.answer(root, started.runId, { requestId: 'req-1', answers: { q1: 'yes' } })
    const terminal = await waitFor(service, root, started.runId, 'completed')
    expect(terminal.workers[0].sessionId).toBe('sid-input')
  })

  test('follows up through the same provider-native session', async () => {
    const calls: Array<{ prompt: string; resume?: string }> = []
    const { service, root } = harness({
      startWorker: opts => {
        calls.push({ prompt: opts.prompt, resume: opts.resumeSessionId })
        return resolvedHandle(result(opts.resumeSessionId ?? 'sid-first', opts.prompt))
      },
    })
    const first = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'first' })
    await waitFor(service, root, first.runId, 'completed')
    const follow = await service.followUp(root, first.runId, { prompt: 'second' })
    await waitFor(service, root, follow.runId, 'completed')
    expect(calls).toEqual([{ prompt: 'first', resume: undefined }, { prompt: 'second', resume: 'sid-first' }])
  })

  test('delegated capabilities cannot create tasks or use follow-up to delegate again', async () => {
    const control = controlledHandle()
    let capability = ''
    let cardCount = 0
    let starts = 0
    const { service, root } = harness({
      sendCard: async () => `message-${++cardCount}`,
      startWorker: opts => {
        starts++
        capability = String(opts.hostEnv.LODESTAR_AGENT_CAPABILITY)
        return control.handle
      },
    })
    try {
      const parent = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'parent' })
      for (let i = 0; i < 50 && !capability; i++) await new Promise(resolve => setTimeout(resolve, 1))
      const worker = service.principalForCapability(capability)!
      await expect(service.startRun(worker, { identityIds: ['agent:a'], prompt: 'nested' }))
        .rejects.toThrow('cannot delegate again')
      await expect(service.followUp(worker, parent.runId, { prompt: 'nested follow-up' }))
        .rejects.toThrow('cannot delegate again')
      expect(cardCount).toBe(1)
      expect(starts).toBe(1)
      expect(service.getRun(worker, parent.runId).runId).toBe(parent.runId)
      await expect(service.cancelRun(worker, parent.runId, 'self-cancel')).rejects.toThrow('containing run')
      await service.cancelRun(root, parent.runId, 'stop')
      expect(service.principalForCapability(capability)).toBeNull()
    } finally {
      await service.shutdown('test cleanup')
    }
  })

  test('marks interrupted durable runs failed on daemon restart', () => {
    const active = {
      runId: 'agent_old', sessionName: 'project', chatId: 'chat-1', workDir: '/repo', prompt: 'old', depth: 0,
      status: 'running' as const, createdAt: new Date().toISOString(), workers: [{
        identityId: 'agent:a', identityName: 'A', tokenSourceId: 'a', provider: 'claude' as const,
        model: 'm', effort: 'max', status: 'running' as const, output: '', steps: [],
      }],
    }
    const { service, root } = harness({ loadArtifacts: () => [active] })
    expect(service.getRun(root, 'agent_old')).toMatchObject({ status: 'failed', error: expect.stringContaining('daemon restarted') })
  })

  test('the main Agent can continue a legacy nested run as a new single-level task', async () => {
    const source = {
      runId: 'agent_legacy', sessionName: 'project', chatId: 'chat-1', workDir: '/repo', prompt: 'old task', depth: 2,
      status: 'completed' as const, createdAt: '2026-09-05T00:00:00Z', workers: [{
        identityId: 'agent:a', identityName: 'A', tokenSourceId: 'a', provider: 'claude' as const,
        model: 'model-a', effort: 'max', status: 'completed' as const, output: 'old result', steps: [], sessionId: 'legacy-session',
      }],
    }
    let resumed: string | undefined
    const { service, root } = harness({
      loadArtifacts: () => [source],
      startWorker: opts => {
        resumed = opts.resumeSessionId
        return resolvedHandle(result(opts.resumeSessionId!))
      },
    })
    const follow = await service.followUp(root, source.runId, { prompt: 'continue' })
    await waitFor(service, root, follow.runId, 'completed')
    expect(resumed).toBe('legacy-session')
    expect(follow.depth).toBe(0)
    expect(follow.parentKind).toBe('follow_up')
    expect(service.getRun(root, source.runId).depth).toBe(2)
  })

  test('invalidates a root run whose card was opening when the Session was cancelled', async () => {
    let cardEntered!: () => void
    let releaseCard!: () => void
    const entered = new Promise<void>(resolve => { cardEntered = resolve })
    const released = new Promise<void>(resolve => { releaseCard = resolve })
    let starts = 0
    const { service, root } = harness({
      sendCard: async () => { cardEntered(); await released; return 'message-root-race' },
      startWorker: opts => { starts++; return resolvedHandle(result(`sid-${opts.identity.id}`)) },
    })
    const creating = service.startRun(root, { identityIds: ['agent:a'], prompt: 'racing root' })
    await entered
    await service.cancelSessionRuns('project', 'chat-1', 'session stop')
    releaseCard()
    const run = await creating
    expect(run.status).toBe('cancelled')
    expect(starts).toBe(0)
  })

  test('invalidates a main-Agent follow-up whose card was opening during Session cancellation', async () => {
    let cardEntered!: () => void
    let releaseCard!: () => void
    const entered = new Promise<void>(resolve => { cardEntered = resolve })
    const released = new Promise<void>(resolve => { releaseCard = resolve })
    let cards = 0
    let starts = 0
    const { service, root } = harness({
      sendCard: async () => {
        if (++cards === 1) return 'message-original'
        cardEntered()
        await released
        return 'message-follow-up'
      },
      startWorker: opts => { starts++; return resolvedHandle(result(`sid-${opts.identity.id}`)) },
    })
    const source = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'original' })
    await waitFor(service, root, source.runId, 'completed')
    const creating = service.followUp(root, source.runId, { prompt: 'continue' })
    await entered
    await service.cancelSessionRuns('project', 'chat-1', 'stop')
    releaseCard()
    const follow = await creating
    expect(follow.status).toBe('cancelled')
    expect(follow.depth).toBe(0)
    expect(starts).toBe(1)
  })

  test('rejects unbounded queued workers before sending another card', async () => {
    const identities = Array.from({ length: 64 }, (_, index) => identity(`q${index}`))
    let cards = 0
    const controls: ReturnType<typeof controlledHandle>[] = []
    const { service, root } = harness({
      identities,
      sendCard: async () => { cards++; return `message-${cards}` },
      startWorker: () => {
        const control = controlledHandle()
        controls.push(control)
        return control.handle
      },
    })
    const ids = identities.map(item => item.id)
    await service.startRun(root, { identityIds: ids, prompt: 'batch one' })
    await service.startRun(root, { identityIds: ids, prompt: 'batch two' })
    await expect(service.startRun(root, { identityIds: [ids[0]], prompt: 'overflow' }))
      .rejects.toThrow('global Agent worker limit')
    expect(cards).toBe(2)
    await service.shutdown('test cleanup')
  })

  test('main-Agent tasks share the concurrency limit and queued work starts when a slot is released', async () => {
    const identities = Array.from({ length: 9 }, (_, i) => identity(`worker-${i}`))
    const controls: ReturnType<typeof controlledHandle>[] = []
    const { service, root } = harness({
      identities,
      startWorker: () => {
        const control = controlledHandle()
        controls.push(control)
        return control.handle
      },
    })
    try {
      const run = await service.startRun(root, { identityIds: identities.map(item => item.id), prompt: 'parallel work' })
      for (let i = 0; i < 200 && controls.length < 8; i++) await new Promise(resolve => setTimeout(resolve, 1))
      expect(controls).toHaveLength(8)
      expect(service.getRun(root, run.runId).workers[8]!.status).toBe('queued')
      expect(service.getRun(root, run.runId).workers[8]!.queuedReason).toContain('等待执行名额')
      controls[0]!.resolve(result('first-session'))
      for (let i = 0; i < 200 && controls.length < 9; i++) await new Promise(resolve => setTimeout(resolve, 1))
      expect(controls).toHaveLength(9)
    } finally {
      await service.shutdown('test cleanup')
    }
  })

  test('failed cancellation keeps the process tracked, surfaces to Session and can be retried', async () => {
    const control = controlledHandle()
    let alive = true
    let rejectCancel = true
    const { service, root } = harness({
      startWorker: () => ({
        ...control.handle,
        isAlive: () => alive,
        cancel: async () => {
          if (rejectCancel) {
            const error = new Error('kill was not confirmed')
            control.reject(error)
            throw error
          }
          alive = false
        },
      }),
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'work' })
    await waitFor(service, root, started.runId, 'running')
    await new Promise(resolve => setTimeout(resolve, 1))
    await expect(service.cancelSessionRuns(session.sessionName, session.chatId, 'stop'))
      .rejects.toThrow('kill was not confirmed')
    expect(service.getRun(root, started.runId).status).toBe('failed')
    expect(service.getRun(root, started.runId).error).toContain('kill was not confirmed')
    expect(alive).toBe(true)
    await expect(service.followUp(root, started.runId, { prompt: 'resume too early' }))
      .rejects.toThrow('process has not stopped')
    rejectCancel = false
    expect(await service.cancelRun(root, started.runId, 'retry stop')).toBe(true)
    expect(alive).toBe(false)
    expect(await service.cancelRun(root, started.runId, 'already stopped')).toBe(false)
  })

  test('saves partial output even when the worker ultimately fails', async () => {
    const { service, root, textArtifacts } = harness({
      startWorker: () => ({
        ...resolvedHandle(result('partial-session')),
        done: Promise.reject(new AgentWorkerFailure(new Error('upstream failed'), '调查结果仍应保留', 'partial-session')),
      }),
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'investigate' })
    const failed = await waitFor(service, root, started.runId, 'failed')
    expect(failed.workers[0]!.output).toBe('调查结果仍应保留')
    expect(failed.workers[0]!.error).toBe('upstream failed')
    expect([...textArtifacts.values()]).toContain('调查结果仍应保留')
  })

  test('cancellation updates every worker panel, including tasks that never left the queue', async () => {
    const identities = Array.from({ length: 9 }, (_, i) => identity(`cancel-${i}`))
    const panels = new Map<string, any>()
    let starts = 0
    const { service, root } = harness({
      identities,
      startWorker: () => { starts++; return controlledHandle().handle },
      replaceElementChecked: async (_cardId, id, element) => {
        if (id.startsWith('aw_')) panels.set(id, element)
        return true
      },
    })
    const run = await service.startRun(root, { identityIds: identities.map(item => item.id), prompt: 'tasks' })
    for (let i = 0; i < 100 && starts < 8; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(starts).toBe(8)
    await service.cancelRun(root, run.runId, '用户取消')
    expect(panels.size).toBe(9)
    for (const panel of panels.values()) {
      expect(panel.header.title.content).toContain('取消')
      expect(JSON.stringify(panel)).toContain('停止原因')
      expect(JSON.stringify(panel)).not.toContain('等待执行名额')
    }
    expect(starts).toBe(8)
  })
})
