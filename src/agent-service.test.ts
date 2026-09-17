import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, type AgentServiceDeps } from './agent-service'
import type { AgentIdentity, AgentIdentityCatalog } from './agent-identities'
import { AgentWorkerFailure, type AgentWorkerHandle, type AgentWorkerResult } from './agent-runner'
import type { AgentRunSnapshot } from './agent-run-types'
import { AGENT_RUNS_DIR } from './paths'
import { projectProfiles } from './feishu-test-mock'

function identity(id: string, name = id): AgentIdentity {
  return {
    id: `agent:${id}`, displayName: name, tokenSourceId: id, tokenSourceDisplay: id,
    provider: id === 'codex' ? 'codex' : 'claude', model: `model-${id}`, modelDisplay: name,
    defaultEffort: 'max', supportedEfforts: ['low', 'max'], sourceDefault: true, status: 'ready',
  }
}

function openRouterIdentity(id: string): AgentIdentity {
  return { ...identity(id), tokenSourceId: 'openrouter', tokenSourceDisplay: 'OpenRouter' }
}

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-agent-service-')))
mkdirSync(join(testDir, 'repo', 'packages', 'app'), { recursive: true })
mkdirSync(join(testDir, 'other'))
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

const session = {
  sessionName: 'project', chatId: 'chat-1', workDir: join(testDir, 'repo'),
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

function completedHistory(count: number, chain = false): AgentRunSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    runId: `agent_history_${index}`, sessionName: session.sessionName, chatId: session.chatId,
    workDir: session.workDir, prompt: `original prompt ${index}`, description: `历史任务 ${index}`, depth: 0,
    ...(chain && index > 0 ? { parentRunId: `agent_history_${index - 1}`, parentKind: 'follow_up' as const } : {}),
    status: 'completed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    workers: [{
      identityId: 'agent:a', identityName: 'Agent A', tokenSourceId: 'a', provider: 'claude',
      model: 'model-a', effort: index === count - 1 ? 'low' : 'max', status: 'completed',
      output: `original output ${index}`, steps: [], sessionId: chain ? 'sid-history' : `sid-history-${index}`,
    }],
  }))
}

function harness(opts: {
  identities?: AgentIdentity[]
  startWorker?: AgentServiceDeps['startWorker']
  loadArtifacts?: AgentServiceDeps['loadArtifacts']
  sendCard?: AgentServiceDeps['sendCard']
  patchSettingsChecked?: AgentServiceDeps['patchSettingsChecked']
  replaceElementChecked?: (cardId: string, elementId: string, element: object) => Promise<boolean>
  getChatTailMessageId?: AgentServiceDeps['getChatTailMessageId']
  sendTextRaw?: AgentServiceDeps['sendTextRaw']
} = {}) {
  const identities = opts.identities ?? [identity('a', 'Agent A')]
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', identities, sourceFailures: [] }
  const artifacts: unknown[] = []
  const textArtifacts = new Map<string, string>()
  const artifactReads: string[] = []
  const deps: AgentServiceDeps = {
    getCatalog: () => catalog,
    startWorker: opts.startWorker ?? (worker => resolvedHandle(result(`sid-${worker.identity.id}`, `output-${worker.identity.id}`))),
    sendCard: opts.sendCard ?? (async () => 'message-1'),
    sendTextRaw: opts.sendTextRaw ?? (async () => true),
    getChatTailMessageId: opts.getChatTailMessageId ?? (async () => null),
    getElementCount: () => 1,
    addElementResult: async () => ({ landed: true }),
    deleteElementChecked: async () => true,
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementResult: async (cardId, id, element) => ({ landed: await (opts.replaceElementChecked?.(cardId, id, element) ?? true) }),
    cancelSummary: () => {},
    patchSettingsChecked: opts.patchSettingsChecked ?? (async () => true),
    dispose: async () => {},
    writeArtifact: (_path, value) => { artifacts.push(JSON.parse(JSON.stringify(value))) },
    writeTextArtifact: (path, value) => { textArtifacts.set(path, value) },
    readTextArtifact: (name, label) => {
      artifactReads.push(name)
      const text = textArtifacts.get(join(AGENT_RUNS_DIR, name))
      if (text === undefined) throw new Error(`${label} is unreadable (${name})`)
      return text
    },
    loadArtifacts: opts.loadArtifacts ?? (() => []),
  }
  const service = new AgentService(deps)
  return { service, root: service.rootPrincipal(session), artifacts, textArtifacts, artifactReads }
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

async function waitForCondition(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Agent worker condition was not reached')
}

describe('AgentService', () => {
  test('delegated launch profile follows the selected execution directory', async () => {
    const profiles: unknown[] = []
    projectProfiles.set('parent-profile', { cwd: session.workDir, settingSources: 'project' })
    projectProfiles.set('child-profile', { cwd: join(session.workDir, 'packages', 'app'), settingSources: 'local' })
    const { service, root } = harness({ startWorker: opts => {
      profiles.push(opts.profile)
      return resolvedHandle(result(`profile-${profiles.length}`))
    } })
    try {
      for (const workDir of [undefined, 'packages/app']) {
        const started = await service.startRun(root, { description: '目录配置', identityIds: ['agent:a'], prompt: 'inspect', workDir })
        await waitFor(service, root, started.runId, 'completed')
      }
      expect(profiles).toMatchObject([{ settingSources: 'project' }, { settingSources: 'local' }])
    } finally {
      projectProfiles.delete('parent-profile'); projectProfiles.delete('child-profile')
    }
  })

  test('defaults to the main directory and resolves relative, absolute and symlinked subdirectories', async () => {
    const calls: string[] = []
    const { service, root, artifacts } = harness({
      startWorker: opts => { calls.push(opts.workDir); return resolvedHandle(result(`sid-${calls.length}`)) },
    })
    const subdir = join(session.workDir, 'packages', 'app')
    symlinkSync(subdir, join(session.workDir, 'app-alias'), 'dir')
    const alias = join(testDir, 'repo-alias')
    symlinkSync(session.workDir, alias, 'dir')
    const aliasRoot = service.rootPrincipal({ ...session, workDir: alias })
    for (const principal of [root, aliasRoot]) {
      for (const workDir of [undefined, '.', principal.session.workDir, 'packages/app', subdir, 'app-alias']) {
        const expected = workDir === undefined || workDir === '.' || workDir === principal.session.workDir ? principal.session.workDir : subdir
        const started = await service.startRun(principal, { description: '选择目录', identityIds: ['agent:a'], prompt: 'inspect', workDir })
        const terminal = await waitFor(service, principal, started.runId, 'completed')
        expect(terminal).toMatchObject({ workDir: expected, sessionWorkDir: principal.session.workDir })
        expect(calls.at(-1)).toBe(expected)
        expect(artifacts.at(-1)).toMatchObject({ workDir: expected, sessionWorkDir: principal.session.workDir })
      }
    }
  })

  test('preserves a legacy native session directory when the main project path is a symlink', async () => {
    const workDir = join(testDir, 'legacy-root-alias')
    symlinkSync(session.workDir, workDir, 'dir')
    const calls: string[] = []
    const { service } = harness({
      loadArtifacts: () => completedHistory(1).map(run => ({ ...run, workDir })),
      startWorker: opts => { calls.push(opts.workDir); return resolvedHandle(result(opts.resumeSessionId!)) },
    })
    const root = service.rootPrincipal({ ...session, workDir })
    const next = await service.startRun(root, { description: '继续旧目录会话', identityIds: [], sessionId: 'sid-history-0', prompt: 'next' })
    await waitFor(service, root, next.runId, 'completed')
    expect(calls).toEqual([workDir])
    expect(next).toMatchObject({ sessionWorkDir: workDir, workDir })
  })

  test('rejects outside, missing and non-directory paths before creating a card or starting a worker', async () => {
    let starts = 0
    let cards = 0
    const { service, root, artifacts } = harness({
      sendCard: async () => `card-${++cards}`,
      startWorker: () => { starts++; return resolvedHandle(result('unexpected')) },
    })
    const sibling = join(testDir, 'repo-other')
    mkdirSync(sibling)
    writeFileSync(join(session.workDir, 'ordinary-file'), 'data')
    symlinkSync(sibling, join(session.workDir, 'escape'), 'dir')
    symlinkSync(join(testDir, 'missing'), join(session.workDir, 'broken-link'), 'dir')
    for (const workDir of ['..', '../repo-other', sibling, 'escape', join(session.workDir, 'escape')]) {
      await expect(service.startRun(root, { description: '拒绝越界', identityIds: ['agent:a'], prompt: 'inspect', workDir }))
        .rejects.toThrow('main Agent working directory')
    }
    for (const workDir of ['missing', 'broken-link', 'ordinary-file', '', ' ', 'path\0invalid']) {
      await expect(service.startRun(root, { description: '拒绝无效目录', identityIds: ['agent:a'], prompt: 'inspect', workDir })).rejects.toThrow()
    }
    expect(starts).toBe(0)
    expect(cards).toBe(0)
    expect(artifacts).toHaveLength(0)
  })

  test('keeps subdirectory history within its owning Session and rejects changes to the continuation directory', async () => {
    const { service, root } = harness()
    const first = await service.startRun(root, {
      description: '子目录任务', identityIds: ['agent:a'], prompt: 'first', workDir: 'packages/app',
    })
    const terminal = await waitFor(service, root, first.runId, 'completed')
    for (const workDir of [terminal.workDir, testDir, join(testDir, 'other')]) {
      const other = service.rootPrincipal({ ...session, workDir })
      expect(() => service.getRun(other, first.runId)).toThrow('different Session')
      await expect(service.startRun(other, { description: '越界续接', identityIds: [], sessionId: terminal.workers[0]!.sessionId, prompt: 'next' }))
        .rejects.toThrow('agent session not found')
      await expect(service.cancelRun(other, first.runId)).rejects.toThrow('different Session')
    }
    for (const workDir of ['.', 'packages']) {
      await expect(service.followUp(root, first.runId, { description: '更换目录', prompt: 'next', workDir }))
        .rejects.toThrow('original work_dir')
      await expect(service.startRun(root, { description: '更换目录', identityIds: [], sessionId: terminal.workers[0]!.sessionId, prompt: 'next', workDir }))
        .rejects.toThrow('original work_dir')
    }
    const next = await service.followUp(root, first.runId, { description: '原目录续跑', prompt: 'next' })
    await waitFor(service, root, next.runId, 'completed')
    expect(next.workDir).toBe(terminal.workDir)
  })

  test('retains status and cancellation access after a worker directory disappears', async () => {
    const workDir = join(session.workDir, 'removed-worker-dir')
    mkdirSync(workDir)
    const control = controlledHandle()
    let workerStarted = false
    const { service, root } = harness({ startWorker: opts => {
      workerStarted = true
      opts.callbacks?.onSession?.('sid-removed-directory')
      return control.handle
    } })
    try {
      const started = await service.startRun(root, { description: '目录被删除', identityIds: ['agent:a'], prompt: 'work', workDir })
      await waitForCondition(() => workerStarted)
      rmSync(workDir, { recursive: true })
      expect(service.getRun(root, started.runId).workDir).toBe(workDir)
      await expect(service.cancelRun(root, started.runId)).resolves.toBe(true)
      await expect(service.followUp(root, started.runId, { description: '缺失目录续跑', prompt: 'next' })).rejects.toThrow('ENOENT')
    } finally { await service.shutdown('test cleanup') }
  })

  test('does not resume a completed task in a replacement directory', async () => {
    const workDir = join(session.workDir, 'replaced-worker-dir')
    mkdirSync(workDir)
    let starts = 0
    const { service, root } = harness({ startWorker: () => { starts++; return resolvedHandle(result('sid-replaced-directory')) } })
    const started = await service.startRun(root, { description: '原目录任务', identityIds: ['agent:a'], prompt: 'work', workDir })
    await waitFor(service, root, started.runId, 'completed')
    rmSync(workDir, { recursive: true })
    symlinkSync(join(session.workDir, 'packages', 'app'), workDir, 'dir')
    await expect(service.startRun(root, { description: '目录已替换', identityIds: [], sessionId: 'sid-replaced-directory', prompt: 'next' }))
      .rejects.toThrow('work_dir changed')
    expect(starts).toBe(1)
  })

  test('rejects a directory replaced with an outside symlink while waiting for a worker slot', async () => {
    const workDir = join(session.workDir, 'queued-worker-dir')
    mkdirSync(workDir)
    const controls = [controlledHandle(), controlledHandle()]
    let starts = 0
    const { service, root } = harness({
      identities: [openRouterIdentity('a')],
      startWorker: () => controls[starts++]!.handle,
    })
    try {
      for (let i = 0; i < 2; i++) await service.startRun(root, { description: '占用并发槽', identityIds: ['agent:a'], prompt: 'wait' })
      await waitForCondition(() => starts === 2)
      const queued = await service.startRun(root, { description: '检查排队目录', identityIds: ['agent:a'], prompt: 'work', workDir })
      await waitForCondition(() => !!service.getRun(root, queued.runId).workers[0]!.queuedReason)
      rmSync(workDir, { recursive: true })
      symlinkSync(join(testDir, 'other'), workDir, 'dir')
      controls[0]!.resolve(result('sid-release-slot'))
      const failed = await waitFor(service, root, queued.runId, 'failed')
      expect(failed.workers[0]!.error).toContain('main Agent working directory')
      expect(starts).toBe(2)
    } finally { await service.shutdown('test cleanup') }
  })

  test('persists shared card ownership and a new description for each native follow-up', async () => {
    const sent: object[] = []
    const { service, root, artifacts } = harness({
      sendCard: async (_chat, card) => { sent.push(card); return 'message-1' },
      getChatTailMessageId: async () => 'message-1',
    })
    const first = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'first', description: '实现功能' })
    await waitFor(service, root, first.runId, 'completed')
    const next = await service.followUp(root, first.runId, { prompt: 'verify', description: '验证功能' })
    await waitForCondition(() => artifacts.some((value: any) => value.runId === next.runId && value.status === 'completed'))
    expect(sent).toHaveLength(1)
    expect(next.cardMessageId).toBe(first.cardMessageId)
    expect(service.getRun(root, next.runId)).toMatchObject({ description: '验证功能', cardMessageId: 'message-1' })
    expect(service.getRun(root, first.runId).description).toBe('实现功能')
  })

  test('a card finalization failure keeps the worker result and sends the concrete error to the chat', async () => {
    const notices: string[] = []
    const { service, root, artifacts } = harness({
      patchSettingsChecked: async (cardId, settings, onFailure) => {
        if ((settings as any).config.streaming_mode !== false) return true
        onFailure?.({ cardId, operation: 'patchSettings', code: 300317, logId: 'terminal-request-id', message: 'sequence number compare failed' })
        return false
      },
      sendTextRaw: async (_chatId, text) => { notices.push(text); return true },
    })
    const started = await service.startRun(root, { description: '保存检查结果', identityIds: ['agent:a'], prompt: 'inspect' })
    await waitForCondition(() => notices.length === 1)
    const saved = service.getRun(root, started.runId)
    expect(saved.status).toBe('completed')
    expect(saved.workers[0]!.output).toBe('output-agent:a')
    expect(saved.presentationErrors).toHaveLength(1)
    expect(notices[0]).toContain('保存检查结果')
    expect(notices[0]).toContain('sequence number compare failed')
    expect(notices[0]).toContain('code=300317')
    expect(notices[0]).toContain('log_id=terminal-request-id')
    expect(notices[0]).toContain(started.runId)
    expect((artifacts.at(-1) as AgentRunSnapshot).presentationErrors).toEqual(saved.presentationErrors)
  })

  test('writes the terminal chat-list summary inside Card Kit config', async () => {
    const settings: object[] = []
    const { service, root } = harness({
      patchSettingsChecked: async (_cardId, value) => { settings.push(value); return true },
    })
    const started = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'summary test' })
    await waitFor(service, root, started.runId, 'completed')
    expect(settings.at(-1)).toEqual({
      config: {
        streaming_mode: false,
        summary: { content: '✅ 委派完成 · 任务说明' },
      },
    })
  })

  test('runs several full Agents concurrently and persists native sessions', async () => {
    const { service, root, artifacts, textArtifacts } = harness({ identities: [identity('a'), identity('codex')] })
    const started = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a', 'agent:codex'], prompt: 'implement' })
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
    const started = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'ask if needed', workDir: 'packages/app' })
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
    const first = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'first' })
    await waitFor(service, root, first.runId, 'completed')
    const follow = await service.followUp(root, first.runId, { description: '任务说明', prompt: 'second' })
    await waitFor(service, root, follow.runId, 'completed')
    expect(calls).toEqual([{ prompt: 'first', resume: undefined }, { prompt: 'second', resume: 'sid-first' }])
  })

  for (const provider of ['codex', 'claude', 'dsh'] as const) {
    test(`${provider}: long historical chains do not evict a new task's session index`, async () => {
      const selected = { ...identity(provider), provider }
      const history = completedHistory(520, true)
      const calls: Array<string | undefined> = []
      const { service, root } = harness({
        identities: [selected], loadArtifacts: () => history,
        startWorker: opts => {
          calls.push(opts.resumeSessionId)
          return resolvedHandle(result(opts.resumeSessionId ?? `sid-new-${calls.length}`))
        },
      })
      const first = await service.startRun(root, { description: '新任务', identityIds: [selected.id], prompt: 'first' })
      const terminal = await waitFor(service, root, first.runId, 'completed')
      const other = await service.startRun(root, { description: '触发历史清理', identityIds: [selected.id], prompt: 'other' })
      await waitFor(service, root, other.runId, 'completed')
      const continued = await service.startRun(root, {
        description: '继续新任务', identityIds: [], sessionId: terminal.workers[0]!.sessionId, prompt: 'continue',
      })
      await waitFor(service, root, continued.runId, 'completed')
      expect(continued.parentRunId).toBe(first.runId)
      expect(calls).toEqual([undefined, undefined, 'sid-new-1'])
      expect(service.getRun(root, first.runId).prompt).toBe('first')
    })

    test(`${provider}: continues by session id for three turns including reloaded history`, async () => {
      const selected = { ...identity(provider), provider }
      const workDir = join(session.workDir, `continued-${provider}`)
      mkdirSync(workDir)
      const calls: Array<{ prompt: string; resume?: string; identity: string; effort: string; workDir: string }> = []
      const startWorker: AgentServiceDeps['startWorker'] = opts => {
        calls.push({ prompt: opts.prompt, resume: opts.resumeSessionId, identity: opts.identity.id, effort: opts.effort, workDir: opts.workDir })
        return resolvedHandle(result(opts.resumeSessionId ?? `sid-${provider}`, `reply: ${opts.prompt}`))
      }
      const { service, root } = harness({ identities: [selected], startWorker })
      const first = await service.startRun(root, { description: '任务说明', identityIds: [selected.id], prompt: 'first', workDir: `continued-${provider}` })
      const firstResult = await waitFor(service, root, first.runId, 'completed')
      const sessionId = firstResult.workers[0]!.sessionId!
      const second = await service.startRun(root, { description: '任务说明', identityIds: [], sessionId, prompt: '  second\n', effort: 'low', workDir })
      const secondResult = await waitFor(service, root, second.runId, 'completed')
      expect(secondResult).toMatchObject({ parentRunId: first.runId, parentKind: 'follow_up' })
      expect(secondResult.workers[0]).toMatchObject({ sessionId, output: 'reply:   second\n', effort: 'low' })
      expect(service.getRun(root, first.runId).workers[0]!.output).toBe('reply: first')

      // Disk enumeration is not chronological. Lineage must win even with equal timestamps.
      const history = [secondResult, firstResult].map(run => ({ ...run, createdAt: '2026-09-01T00:00:00Z' }))
      const reloaded = harness({ identities: [selected], startWorker, loadArtifacts: () => history })
      const third = await reloaded.service.startRun(reloaded.root, { description: '任务说明', identityIds: [], sessionId, prompt: 'third' })
      const terminal = await waitFor(reloaded.service, reloaded.root, third.runId, 'completed')
      expect(terminal).toMatchObject({ parentRunId: second.runId, parentKind: 'follow_up', workDir, sessionWorkDir: session.workDir })
      expect(terminal.workers[0]).toMatchObject({ sessionId, effort: 'low', output: 'reply: third' })
      expect(new Set([first.runId, second.runId, third.runId]).size).toBe(3)
      expect(calls).toEqual([
        { prompt: 'first', resume: undefined, identity: selected.id, effort: 'max', workDir },
        { prompt: '  second\n', resume: sessionId, identity: selected.id, effort: 'low', workDir },
        { prompt: 'third', resume: sessionId, identity: selected.id, effort: 'low', workDir },
      ])
    })
  }

  test('retains the latest turn and effort when a reloaded chain exceeds the artifact cache limit', async () => {
    const history = completedHistory(520, true)
    const { service, root } = harness({ loadArtifacts: () => history })
    const continued = await service.startRun(root, {
      description: '继续长会话', identityIds: [], sessionId: 'sid-history', prompt: 'next',
    })
    await waitFor(service, root, continued.runId, 'completed')
    expect(continued.parentRunId).toBe(history.at(-1)!.runId)
    expect(continued.workers[0]!.effort).toBe('low')
  })

  test('retains old run lookup, complete results and follow-up beyond the artifact cache limit', async () => {
    const history = completedHistory(520)
    const calls: Array<string | undefined> = []
    const { service, root, artifactReads } = harness({
      loadArtifacts: () => history,
      startWorker: opts => {
        calls.push(opts.resumeSessionId)
        return resolvedHandle(result(opts.resumeSessionId!))
      },
    })
    const original = service.getRun(root, 'agent_history_0')
    expect(original.prompt).toBe('original prompt 0')
    expect(original.workers[0]!.output).toBe('original output 0')
    expect(artifactReads).toHaveLength(2)
    expect(service.getRun(root, 'agent_history_519').workers[0]!.output).toBe('original output 519')
    expect(artifactReads).toHaveLength(2)
    original.workers[0]!.output = 'caller mutation'
    expect(service.getRun(root, original.runId).workers[0]!.output).toBe('original output 0')
    expect(artifactReads).toHaveLength(4)
    const continued = await service.followUp(root, original.runId, { description: '继续旧任务', prompt: 'next' })
    await waitFor(service, root, continued.runId, 'completed')
    expect(calls).toEqual(['sid-history-0'])
    expect(continued.parentRunId).toBe(original.runId)
  })

  test('checks access before reading evicted artifacts and surfaces missing text instead of an empty result', async () => {
    const history = completedHistory(520)
    const { service, root, textArtifacts, artifactReads } = harness({ loadArtifacts: () => history })
    for (const other of [{ chatId: 'other-chat' }, { sessionName: 'other-session' }, { workDir: '/other-repo' }]) {
      const outsider = service.rootPrincipal({ ...session, ...other })
      expect(() => service.getRun(outsider, 'agent_history_0')).toThrow()
      await expect(service.startRun(outsider, {
        description: '越界续接', identityIds: [], sessionId: 'sid-history-0', prompt: 'next',
      })).rejects.toThrow('agent session not found')
    }
    expect(artifactReads).toHaveLength(0)
    const outputArtifact = history[0]!.workers[0]!.outputArtifact!
    expect(textArtifacts.delete(join(AGENT_RUNS_DIR, outputArtifact))).toBe(true)
    expect(() => service.getRun(root, 'agent_history_0')).toThrow('output for agent_history_0 is unreadable')
    expect(() => service.getRun(root, 'agent_history_0')).toThrow('output for agent_history_0 is unreadable')
    expect(artifactReads).toHaveLength(4)
    expect(() => service.getRun(root, 'agent_missing')).toThrow('agent run not found')
  })

  for (const stop of ['parent', 'session', 'shutdown'] as const) {
    test(`${stop}: evicting ancestor artifacts preserves cancellation of an active follow-up`, async () => {
      const history = completedHistory(520, true)
      const control = controlledHandle()
      const { service, root } = harness({ loadArtifacts: () => history, startWorker: () => control.handle })
      const continued = await service.startRun(root, {
        description: '继续长会话', identityIds: [], sessionId: 'sid-history', prompt: 'next',
      })
      await waitFor(service, root, continued.runId, 'running')
      if (stop === 'parent') await service.cancelRun(root, history[0]!.runId, 'test stop')
      else if (stop === 'session') await service.cancelSessionRuns(session.sessionName, session.chatId, 'test stop')
      else await service.shutdown('test stop')
      expect(service.getRun(root, continued.runId).status).toBe('cancelled')
      expect(service.getRun(root, history[0]!.runId).workers[0]!.output).toBe('original output 0')
    })
  }

  test('resolves the right worker in a parallel run and rejects inaccessible or mismatched sessions', async () => {
    let starts = 0
    let cards = 0
    const { service, root } = harness({
      identities: [identity('a'), identity('b')],
      sendCard: async () => `card-${++cards}`,
      startWorker: opts => { starts++; return resolvedHandle(result(opts.resumeSessionId ?? `sid-${opts.identity.id}`)) },
    })
    const first = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a', 'agent:b'], prompt: 'first' })
    await waitFor(service, root, first.runId, 'completed')
    for (const request of [
      { description: '任务说明', identityIds: [], sessionId: 'missing', prompt: 'next' },
      { description: '任务说明', identityIds: ['agent:b'], sessionId: 'sid-agent:a', prompt: 'next' },
    ]) await expect(service.startRun(root, request)).rejects.toThrow('agent session not found')
    for (const other of [{ chatId: 'other-chat' }, { sessionName: 'other-session' }, { workDir: '/other-repo' }]) {
      const outsider = service.rootPrincipal({ ...session, ...other })
      await expect(service.startRun(outsider, { description: '任务说明', identityIds: [], sessionId: 'sid-agent:a', prompt: 'next' }))
        .rejects.toThrow('agent session not found')
    }
    expect(starts).toBe(2)
    expect(cards).toBe(1)
    const next = await service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid-agent:b', prompt: 'second' })
    const terminal = await waitFor(service, root, next.runId, 'completed')
    expect(terminal.workers).toHaveLength(1)
    expect(terminal.workers[0]).toMatchObject({ identityId: 'agent:b', sessionId: 'sid-agent:b' })
  })

  test('rejects concurrent continuation during card creation and while the native session is running', async () => {
    let enterCard!: () => void
    let releaseCard!: () => void
    const entered = new Promise<void>(resolve => { enterCard = resolve })
    const released = new Promise<void>(resolve => { releaseCard = resolve })
    const control = controlledHandle()
    let cards = 0
    let starts = 0
    const { service, root } = harness({
      sendCard: async () => {
        if (++cards === 2) { enterCard(); await released }
        return `message-${cards}`
      },
      startWorker: opts => ++starts === 2 ? control.handle : resolvedHandle(result(opts.resumeSessionId ?? 'sid')),
    })
    try {
      const first = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'first' })
      await waitFor(service, root, first.runId, 'completed')
      const creating = service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'second' })
      await entered
      await expect(service.followUp(root, first.runId, { description: '任务说明', prompt: 'duplicate' })).rejects.toThrow('already running or starting')
      expect(cards).toBe(2)
      releaseCard()
      const second = await creating
      await waitFor(service, root, second.runId, 'running')
      await expect(service.followUp(root, first.runId, { description: '任务说明', prompt: 'still duplicate' })).rejects.toThrow('already running or starting')
      await expect(service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'too early' })).rejects.toThrow('terminal source run')
      control.resolve(result('sid'))
      await waitFor(service, root, second.runId, 'completed')
      const third = await service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'third' })
      await waitFor(service, root, third.runId, 'completed')
      expect(starts).toBe(3)
    } finally { releaseCard(); await service.shutdown('test cleanup') }
  })

  test('releases a continuation reservation after card failure and rejects identity drift', async () => {
    let cards = 0
    let starts = 0
    const selected = identity('a')
    const { service, root } = harness({
      identities: [selected], sendCard: async () => ++cards === 2 ? null : `message-${cards}`,
      startWorker: opts => { starts++; return resolvedHandle(result(opts.resumeSessionId ?? 'sid')) },
    })
    const first = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'first' })
    await waitFor(service, root, first.runId, 'completed')
    await expect(service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'second' })).rejects.toThrow('card creation failed')
    for (const field of ['model', 'tokenSourceId', 'provider'] as const) {
      const original = selected[field]
      Object.assign(selected, { [field]: field === 'provider' ? 'codex' : 'changed' })
      await expect(service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'wrong identity' }))
        .rejects.toThrow('identity changed')
      Object.assign(selected, { [field]: original })
    }
    selected.status = 'catalog_failed'
    await expect(service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'unavailable' })).rejects.toThrow('catalog_failed')
    selected.status = 'ready'
    expect(starts).toBe(1)
    expect(cards).toBe(2)
    const second = await service.startRun(root, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'second' })
    await waitFor(service, root, second.runId, 'completed')
    expect(starts).toBe(2)
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
      const parent = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'parent' })
      for (let i = 0; i < 50 && !capability; i++) await new Promise(resolve => setTimeout(resolve, 1))
      const worker = service.principalForCapability(capability)!
      await expect(service.startRun(worker, { description: '任务说明', identityIds: ['agent:a'], prompt: 'nested' }))
        .rejects.toThrow('cannot delegate again')
      await expect(service.startRun(worker, { description: '任务说明', identityIds: [], sessionId: 'sid', prompt: 'nested resume' }))
        .rejects.toThrow('cannot delegate again')
      await expect(service.followUp(worker, parent.runId, { description: '任务说明', prompt: 'nested follow-up' }))
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
      runId: 'agent_old', sessionName: 'project', chatId: 'chat-1', workDir: session.workDir, prompt: 'old', depth: 0,
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
      runId: 'agent_legacy', sessionName: 'project', chatId: 'chat-1', workDir: session.workDir, prompt: 'old task', depth: 2,
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
    const follow = await service.followUp(root, source.runId, { description: '任务说明', prompt: 'continue' })
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
    const creating = service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'racing root' })
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
    const source = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'original' })
    await waitFor(service, root, source.runId, 'completed')
    const creating = service.followUp(root, source.runId, { description: '任务说明', prompt: 'continue' })
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
    await service.startRun(root, { description: '任务说明', identityIds: ids, prompt: 'batch one' })
    await service.startRun(root, { description: '任务说明', identityIds: ids, prompt: 'batch two' })
    await expect(service.startRun(root, { description: '任务说明', identityIds: [ids[0]], prompt: 'overflow' }))
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
      const run = await service.startRun(root, { description: '任务说明', identityIds: identities.map(item => item.id), prompt: 'parallel work' })
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

  test('shares OpenRouter slots across projects and models without blocking other queued sources', async () => {
    const router = ['router-a', 'router-b', 'router-c'].map(openRouterIdentity)
    const others = Array.from({ length: 7 }, (_, i) => identity(`other-${i}`))
    const controls = new Map<string, ReturnType<typeof controlledHandle>>()
    const { service, root } = harness({
      identities: [...router, ...others],
      startWorker: opts => {
        const control = controlledHandle()
        controls.set(opts.identity.id, control)
        return control.handle
      },
    })
    const otherRoot = service.rootPrincipal({ ...session, sessionName: 'other-project', chatId: 'chat-2', workDir: join(testDir, 'other') })
    try {
      await service.startRun(root, { description: '任务说明', identityIds: router.slice(0, 2).map(item => item.id), prompt: 'first project' })
      const queued = await service.startRun(otherRoot, { description: '任务说明',
        identityIds: [router[2]!.id, ...others.map(item => item.id)], prompt: 'second project',
      })
      await waitForCondition(() => controls.size === 8)
      const workers = service.getRun(otherRoot, queued.runId).workers
      expect(workers[0]!.status).toBe('queued')
      expect(workers[0]!.queuedReason).toContain('等待 OpenRouter 执行名额')
      expect(workers.at(-1)!.status).toBe('queued')
      expect(controls.has(router[2]!.id)).toBe(false)

      controls.get(others[0]!.id)!.resolve(result('other-finished'))
      await waitForCondition(() => controls.has(others[6]!.id))
      expect(controls.has(router[2]!.id)).toBe(false)

      controls.get(router[0]!.id)!.resolve(result('router-finished'))
      await waitForCondition(() => controls.has(router[2]!.id))
      expect(service.getRun(otherRoot, queued.runId).workers[0]!.queuedReason).toBeUndefined()
    } finally {
      await service.shutdown('test cleanup')
    }
  })

  test.each(['completed', 'failed', 'cancelled'] as const)('releases OpenRouter slots after %s and skips cancelled queued tasks', async status => {
    const identities = Array.from({ length: 4 }, (_, i) => openRouterIdentity(`router-${i}`))
    const controls = new Map<string, ReturnType<typeof controlledHandle>>()
    const { service, root } = harness({
      identities,
      startWorker: opts => {
        const control = controlledHandle()
        controls.set(opts.identity.id, control)
        return control.handle
      },
    })
    try {
      const runs = []
      for (const item of identities) runs.push(await service.startRun(root, { description: '任务说明', identityIds: [item.id], prompt: 'work' }))
      await waitForCondition(() => controls.size === 2)
      expect(service.getRun(root, runs[2]!.runId).status).toBe('queued')
      expect(service.getRun(root, runs[3]!.runId).status).toBe('queued')
      await service.cancelRun(root, runs[2]!.runId, 'cancel queued task')
      const first = controls.get(identities[0]!.id)!
      if (status === 'completed') first.resolve(result('first-finished'))
      else if (status === 'failed') first.reject(new Error('upstream 429'))
      else await service.cancelRun(root, runs[0]!.runId, 'cancel running task')
      const terminal = await waitFor(service, root, runs[0]!.runId, status)
      if (status === 'failed') expect(terminal.workers[0]!.error).toBe('upstream 429')
      await waitForCondition(() => controls.has(identities[3]!.id))
      expect(controls.has(identities[2]!.id)).toBe(false)
      expect(controls.size).toBe(3)
    } finally {
      await service.shutdown('test cleanup')
    }
  })

  test('keeps OpenRouter slots while waiting for input and queues native follow-ups', async () => {
    const identities = ['router-a', 'router-b', 'router-c'].map(openRouterIdentity)
    const controls = new Map<string, ReturnType<typeof controlledHandle>>()
    let pending: any = null
    let resumedSession: string | undefined
    const { service, root } = harness({
      identities,
      startWorker: opts => {
        if (opts.resumeSessionId) {
          resumedSession = opts.resumeSessionId
          return resolvedHandle(result(opts.resumeSessionId))
        }
        const control = controlledHandle()
        controls.set(opts.identity.id, control)
        if (opts.identity.id === identities[0]!.id) {
          queueMicrotask(() => {
            pending = { requestId: 'req-router', questions: [{ id: 'q1', question: 'Proceed?', options: [] }] }
            opts.callbacks?.onNeedsInput?.(pending)
          })
          return {
            ...control.handle,
            pendingInput: () => pending,
            answer: () => { pending = null; control.resolve(result('sid-router')) },
          }
        }
        return control.handle
      },
    })
    try {
      const first = await service.startRun(root, { description: '任务说明', identityIds: [identities[0]!.id], prompt: 'ask if needed' })
      await waitFor(service, root, first.runId, 'needs_input')
      const second = await service.startRun(root, { description: '任务说明', identityIds: [identities[1]!.id], prompt: 'work' })
      const third = await service.startRun(root, { description: '任务说明', identityIds: [identities[2]!.id], prompt: 'wait' })
      await waitForCondition(() => controls.size === 2)
      expect(service.getRun(root, third.runId).status).toBe('queued')
      await service.answer(root, first.runId, { requestId: 'req-router', answers: { q1: 'yes' } })
      await waitFor(service, root, first.runId, 'completed')
      await waitForCondition(() => controls.size === 3)

      const follow = await service.followUp(root, first.runId, { description: '任务说明', prompt: 'continue' })
      expect(service.getRun(root, follow.runId).status).toBe('queued')
      expect(resumedSession).toBeUndefined()
      await service.cancelRun(root, second.runId, 'make room')
      await waitFor(service, root, follow.runId, 'completed')
      expect(resumedSession).toBe('sid-router')
    } finally {
      await service.shutdown('test cleanup')
    }
  })

  test('retains an OpenRouter slot until cancellation confirms the process has stopped', async () => {
    const identities = ['router-a', 'router-b', 'router-c'].map(openRouterIdentity)
    const controls = new Map<string, ReturnType<typeof controlledHandle>>()
    let alive = true
    let rejectCancel = true
    const { service, root } = harness({
      identities,
      startWorker: opts => {
        const control = controlledHandle()
        controls.set(opts.identity.id, control)
        if (opts.identity.id !== identities[0]!.id) return control.handle
        return {
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
        }
      },
    })
    try {
      const first = await service.startRun(root, { description: '任务说明', identityIds: [identities[0]!.id], prompt: 'work' })
      await service.startRun(root, { description: '任务说明', identityIds: [identities[1]!.id], prompt: 'work' })
      const third = await service.startRun(root, { description: '任务说明', identityIds: [identities[2]!.id], prompt: 'wait' })
      await waitForCondition(() => controls.size === 2)
      await expect(service.cancelRun(root, first.runId, 'stop')).rejects.toThrow('kill was not confirmed')
      expect(service.getRun(root, third.runId).status).toBe('queued')
      expect(controls.size).toBe(2)
      rejectCancel = false
      await service.cancelRun(root, first.runId, 'retry stop')
      await waitForCondition(() => controls.size === 3)
      expect(alive).toBe(false)
    } finally {
      rejectCancel = false
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
    const started = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'work' })
    await waitFor(service, root, started.runId, 'running')
    await new Promise(resolve => setTimeout(resolve, 1))
    await expect(service.cancelSessionRuns(session.sessionName, session.chatId, 'stop'))
      .rejects.toThrow('kill was not confirmed')
    expect(service.getRun(root, started.runId).status).toBe('failed')
    expect(service.getRun(root, started.runId).error).toContain('kill was not confirmed')
    expect(alive).toBe(true)
    await expect(service.followUp(root, started.runId, { description: '任务说明', prompt: 'resume too early' }))
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
    const started = await service.startRun(root, { description: '任务说明', identityIds: ['agent:a'], prompt: 'investigate' })
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
        if (id.startsWith('ar_')) panels.set(id, element)
        return true
      },
    })
    const run = await service.startRun(root, { description: '任务说明', identityIds: identities.map(item => item.id), prompt: 'tasks' })
    for (let i = 0; i < 100 && starts < 8; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(starts).toBe(8)
    await service.cancelRun(root, run.runId, '用户取消')
    expect(panels.size).toBe(1)
    for (const panel of panels.values()) {
      expect(panel.header.title.content).toContain('取消')
      expect(panel.expanded).toBe(false)
      for (const item of identities) expect(JSON.stringify(panel)).toContain(item.displayName)
      expect(JSON.stringify(panel)).toContain('停止原因')
      expect(JSON.stringify(panel)).not.toContain('等待执行名额')
    }
    expect(starts).toBe(8)
  })
})
