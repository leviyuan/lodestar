import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { AgentWorkerFailure, collectAgentTurn } from './agent-runner'
import { bindProcessCodexAccount } from './codex-accounts'
import * as liveCodexUsage from './codex-live-usage'

class FakeProcess extends EventEmitter {
  provider = 'claude' as const
  tokenSourceId = 'glm'
  sessionId: string | null = 'sid-1'
  lastAssistantUuid: string | null = 'checkpoint-1'
  lastCompletedTurnId = null
  lastModel = 'GLM-5.3'
  lastEffort = 'max' as const
  lastUsage = null
  lastTotalUsage = null
  lastResult = { subtype: 'success', is_error: false } as any
  lastContextWindow = null
  lastContextTokens = null
  alive = true
  initialized = false
  prompts: string[] = []
  permissionResponses: any[] = []

  sendInitialize() { this.initialized = true }
  sendUserText(text: string) { this.prompts.push(text) }
  sendPermissionResponse(...args: any[]) { this.permissionResponses.push(args) }
  sendHookResponse() {}
  async kill() { this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
  isAlive() { return this.alive }
}

test('worker startup rejects Claude subscriptions before creating a process while third-party Claude remains available', () => {
  const run = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    let currentSource
    const launches = [], rejected = [], accepted = []
    mock.module('./src/token-source', () => ({ listTokenSources: () => [], getTokenSourceForAccount: () => currentSource }))
    mock.module('./src/agent-session-registry', () => ({ rememberAgentSession() {} }))
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      launches.push(options)
      const proc = new EventEmitter()
      Object.assign(proc, { provider: options.provider, sessionId: 'native-session', alive: true,
        isAlive() { return this.alive }, sendInitialize() {},
        sendUserText() { queueMicrotask(() => this.emit('result', { is_error: false })) },
        async kill() { this.alive = false; this.emit('exit', { code: 0 }) },
      })
      return { process: proc }
    } }))
    const { startAgentWorker } = await import('./src/agent-runner')
    const { agentIdentityId } = await import('./src/agent-identities')
    const denied = [
      { source: 'claude-sub', model: 'opus' },
      { source: 'disguised-subscription', kind: 'claude-subscription', model: 'unmarked-model' },
      { source: 'claude-subscription', model: 'unmarked-model' },
      { source: 'packy', model: 'unmarked-model', id: agentIdentityId('claude-sub', 'opus') },
    ]
    for (const projectBound of [false, true]) {
      for (const resumeSessionId of [undefined, 'native-session']) {
        for (const entry of denied) {
          currentSource = { id: entry.source, kind: entry.kind ?? 'api', resolveSpawnModel: () => { throw new Error('admission must not resolve models') } }
          const count = launches.length
          try {
            const handle = startAgentWorker({
              identity: { id: entry.id ?? agentIdentityId(entry.source, entry.model), tokenSourceId: entry.source,
                provider: 'claude', model: entry.model, modelDisplay: entry.display ?? entry.model, supportedEfforts: ['high'] },
              projectBound, resumeSessionId, effort: 'high', workDir: process.cwd(), prompt: 'task', hostEnv: {},
            })
            await handle.done
            rejected.push({ error: 'unexpected success', started: launches.length !== count })
          } catch (error) { rejected.push({ error: error.message, started: launches.length !== count }) }
        }
        for (const entry of [
          { source: 'glm', model: 'GLM-5.3-Flash', provider: 'claude' },
          { source: 'deepseek', model: 'deepseek-chat', provider: 'claude' },
          { source: 'codex-sub', model: 'gpt-5', provider: 'codex' },
          { source: 'dsh-glm', model: 'GLM-5.3-Flash', provider: 'dsh' },
          { source: 'packy', model: 'claude-opus-4-6', provider: 'claude' },
          { source: 'openrouter', model: 'anthropic/claude-sonnet-4.6', provider: 'claude' },
          { source: 'packy-secondary', model: 'custom-model', provider: 'claude', display: 'Claude Fable 5' },
        ]) {
          currentSource = { id: entry.source, kind: 'api', resolveSpawnModel: () => { throw new Error('admission must not resolve models') } }
          await startAgentWorker({
            identity: { id: agentIdentityId(entry.source, entry.model), tokenSourceId: entry.source,
              provider: entry.provider, model: entry.model, modelDisplay: entry.display ?? entry.model, supportedEfforts: ['high'] },
            projectBound, resumeSessionId, effort: 'high', workDir: process.cwd(), prompt: 'task', hostEnv: {},
          }).done
          accepted.push(entry.source)
        }
      }
    }
    console.log(JSON.stringify({ rejected, accepted, launches: launches.length }))
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  const result = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
  expect(result.rejected).toHaveLength(16)
  expect(result.rejected.every((entry: { error: string; started: boolean }) => entry.error
    === "Lodestar Agent does not support Claude subscription calls; comply with Claude's user agreement." && !entry.started)).toBe(true)
  expect(result.launches).toBe(28)
  expect(result.accepted).toEqual(Array.from({ length: 4 }, () => ['glm', 'deepseek', 'codex-sub', 'dsh-glm', 'packy', 'openrouter', 'packy-secondary']).flat())
})

describe('delegated Codex final quota refresh', () => {
  test.each([false, true])('waits on the current bound account before killing a result process (is_error=%s)', async isError => {
    const proc = new FakeProcess() as any
    proc.provider = 'codex'; proc.tokenSourceId = 'codex-sub'
    bindProcessCodexAccount(proc, 'worker-before', false)
    const order: string[] = []
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const quota = spyOn(liveCodexUsage, 'waitForLiveCodexUsage').mockImplementation(accountId => {
      order.push(`quota:${accountId}`)
      markStarted()
      return new Promise<void>(resolve => { release = resolve })
    })
    const kill = proc.kill.bind(proc)
    proc.kill = async () => { order.push('kill'); await kill() }
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    const completed = handle.done.then(value => ({ value, error: null }), error => ({ value: null, error }))
    try {
      bindProcessCodexAccount(proc, 'worker-current', false)
      proc.emit('assistant_text', { text: 'retained result' })
      proc.emit('result', { is_error: isError, error: isError ? 'task failed' : undefined })
      await started
      expect(order).toEqual(['quota:worker-current'])
      expect(proc.isAlive()).toBe(true)
      release()
      const result = await completed
      expect(order).toEqual(['quota:worker-current', 'kill'])
      if (isError) {
        expect(result.error).toBeInstanceOf(AgentWorkerFailure)
        expect(result.error).toMatchObject({ message: 'task failed', output: 'retained result' })
      } else expect(result.value).toMatchObject({ output: 'retained result', sessionId: 'sid-1' })
    } finally { release?.(); await handle.cancel(); quota.mockRestore() }
  })

  test.each(['api', 'unbound', 'claude'])('skips quota waiting for %s workers', async kind => {
    const proc = new FakeProcess() as any
    proc.provider = kind === 'claude' ? 'claude' : 'codex'
    proc.tokenSourceId = kind === 'api' ? 'packy-codex' : kind === 'claude' ? 'glm' : 'codex-sub'
    const quota = spyOn(liveCodexUsage, 'waitForLiveCodexUsage').mockImplementation(async () => {
      throw new Error('unexpected quota read')
    })
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    try {
      proc.emit('result', { is_error: false })
      await handle.done
      expect(quota).not.toHaveBeenCalled()
      expect(proc.isAlive()).toBe(false)
    } finally { await handle.cancel(); quota.mockRestore() }
  })

  test.each(['before-result', 'during-quota', 'submission-error'])('stops without quota delay on %s', async scenario => {
    const proc = new FakeProcess() as any
    proc.provider = 'codex'; proc.tokenSourceId = 'codex-sub'
    bindProcessCodexAccount(proc, 'cancelled-worker', false)
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const quota = spyOn(liveCodexUsage, 'waitForLiveCodexUsage').mockImplementation(() => {
      markStarted()
      return new Promise<void>(resolve => { release = resolve })
    })
    if (scenario === 'submission-error') proc.sendUserText = () => { throw new Error('submission failed') }
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    const completed = handle.done.then(value => ({ value, error: null }), error => ({ value: null, error }))
    try {
      if (scenario === 'during-quota') {
        proc.emit('result', { is_error: false })
        await started
        expect(quota).toHaveBeenCalledTimes(1)
        expect(proc.isAlive()).toBe(true)
      }
      if (scenario !== 'submission-error') await handle.cancel('stop now')
      const result = await completed
      expect(proc.isAlive()).toBe(false)
      if (scenario !== 'during-quota') {
        expect(quota).not.toHaveBeenCalled()
        expect(result.error).toBeInstanceOf(AgentWorkerFailure)
        expect(result.error.message).toBe(scenario === 'submission-error' ? 'submission failed' : 'stop now')
      }
    } finally { release?.(); await handle.cancel(); quota.mockRestore() }
  })

  test('a final quota failure does not prevent process cleanup or overwrite the completed task', async () => {
    const proc = new FakeProcess() as any
    proc.provider = 'codex'; proc.tokenSourceId = 'codex-sub'
    bindProcessCodexAccount(proc, 'quota-failure-worker', false)
    const quota = spyOn(liveCodexUsage, 'waitForLiveCodexUsage').mockRejectedValue(new Error('quota unavailable'))
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    try {
      proc.emit('result', { is_error: false })
      await expect(handle.done).resolves.toMatchObject({ sessionId: 'sid-1' })
      expect(quota).toHaveBeenCalledTimes(1)
      expect(proc.isAlive()).toBe(false)
    } finally { await handle.cancel(); quota.mockRestore() }
  })
})

describe('full delegated Agent runner', () => {
  test('failure preserves partial output and the native error', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    proc.emit('assistant_text', { text: 'Partial result' })
    proc.emit('result', { is_error: true, error: 'Request failed' })
    const failure = await handle.done.catch(error => error)
    expect(failure).toMatchObject({ output: 'Partial result', message: 'Request failed' })
  })

  test('successful account selection keeps other-account diagnostics out of delegated progress', async () => {
    const proc = new FakeProcess() as any
    proc.provider = 'codex'
    const progress: unknown[] = []
    const accounts: string[] = []
    const handle = collectAgentTurn(proc, 'do work', {
      onProgress: step => progress.push(step), onCodexAccount: accountId => accounts.push(accountId),
    }, () => {})
    proc.emit('codex_account_changed', { accountId: 'available', diagnostics: ['other: catalog unavailable'] })
    expect(accounts).toEqual(['available'])
    expect(progress).toEqual([])
    proc.emit('result', { is_error: false })
    await handle.done
  })

  test.each([
    [undefined, 'Selected model is at capacity', 'Codex 容量重试'],
    ['capacity', 'Selected model is at capacity', 'Codex 容量重试'],
    ['stream_disconnected', 'stream disconnected before completion: An error occurred while processing your request.', 'Codex 连接中断重试'],
    ['compact_connection_failed', 'Error running remote compact task: Connection failed: error sending request', 'Codex 压缩连接中断重试'],
    ['transient_error', 'Server overloaded, please try again later.', 'Codex 临时故障重试'],
    ['quota', '正在等待 Codex 额度恢复', 'Codex 额度换号'],
  ] as const)('%s backoff reports progress without imposing a turn deadline or changing output', async (reason, message, tool) => {
    const timers = new Map<number, number>()
    let nextId = 100_000
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((_callback: () => void, delay: number) => {
      const id = nextId++
      timers.set(id, delay)
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
    const proc = new FakeProcess() as any
    proc.provider = 'codex'
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', { onProgress: step => progress.push(step) }, () => {})
    try {
      expect(timers.size).toBe(0)
      const retry = { phase: 'waiting', attempt: 1, delayMs: 60_000, message, reason }
      proc.emit('turn_retry', retry)
      expect(timers.size).toBe(0)
      expect(proc.alive).toBe(true)
      expect(progress.at(-1)).toMatchObject({ tool, detail: `${message} · 60s 后重试 #1` })
      proc.emit('turn_retry', { ...retry, phase: 'retrying', delayMs: 0 })
      expect(timers.size).toBe(0)
      expect(progress.at(-1)).toMatchObject({ tool, detail: '正在重试 #1' })
      proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
      proc.emit('result', { is_error: false })
      await expect(handle.done).resolves.toMatchObject({ output: 'finished' })
      expect(timers.size).toBe(0)
      expect(proc.listenerCount('turn_retry')).toBe(0)
    } finally {
      await handle.cancel()
      timeout.mockRestore()
      clear.mockRestore()
    }
  })

  test('long-running work completes with its entire output beyond the old truncation threshold', async () => {
    const proc = new FakeProcess() as any
    const now = Date.now()
    const time = spyOn(Date, 'now').mockReturnValue(now)
    const handle = collectAgentTurn(proc, 'long work', {}, () => {})
    try {
      const body = '完整输出'.repeat(510_000)
      proc.emit('assistant_text', { text: body })
      time.mockReturnValue(now + 2 * 60 * 60 * 1000)
      proc.emit('tool_use', { name: 'Bash' })
      expect(proc.alive).toBe(true)
      proc.emit('assistant_text', { text: '\n最终结论' })
      proc.emit('result', { is_error: false })
      await expect(handle.done).resolves.toMatchObject({
        output: body + '\n最终结论', outputTruncated: false, durationMs: 2 * 60 * 60 * 1000,
      })
    } finally {
      await handle.cancel()
      time.mockRestore()
    }
  })

  test('auto-allows ordinary permissions but pauses and resumes exact input requests', async () => {
    const proc = new FakeProcess() as any
    const waiting: any[] = []
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', {
      onNeedsInput: request => waiting.push(request),
      onProgress: step => progress.push(step),
    }, () => {})
    expect(proc.initialized).toBe(true)
    expect(proc.prompts).toEqual(['do work'])

    proc.emit('can_use_tool', { request_id: 'perm', tool_name: 'Bash', input: { command: 'touch x' } })
    expect(proc.permissionResponses[0]).toEqual(['perm', 'allow', { updatedInput: { command: 'touch x' } }])
    proc.emit('tool_use', { name: 'Bash', input: { command: 'cat .env', token: 'secret' } })
    proc.emit('tool_result', { content: 'API_KEY=secret', is_error: false })
    expect(progress.map(step => step.detail)).toEqual(['', ''])

    proc.emit('can_use_tool', {
      request_id: 'ask', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1',
      input: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
    })
    expect(waiting[0]).toMatchObject({ requestId: 'ask', questions: [{ id: 'q1', question: 'Proceed?' }] })
    handle.answer('ask', { q1: 'Yes' })
    expect(proc.permissionResponses[1]).toEqual([
      'ask', 'allow',
      { updatedInput: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }], answers: { q1: 'Yes' } } },
    ])

    proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: 'finished', sessionId: 'sid-1', checkpointId: 'checkpoint-1' })
  })

  test('treats a successful file-only turn with no assistant text as completed', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'edit files', {}, () => {})
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: '', sessionId: 'sid-1' })
  })

  for (const provider of ['codex', 'claude', 'dsh']) {
    for (const resume of [false, true]) {
      test(`non-interactive ${provider} calls fail on input without waiting or inventing answers (resume=${resume})`, async () => {
        const proc = new FakeProcess() as any
        proc.provider = provider
        const waiting: unknown[] = []
        const handle = collectAgentTurn(proc, 'execute task', {
          onNeedsInput: request => waiting.push(request),
        }, () => {}, resume ? 'sid-1' : undefined, false)
        proc.emit('assistant_text', { text: 'work already performed' })
        proc.emit('can_use_tool', { request_id: 'work', tool_name: 'Bash', input: { command: 'pwd' } })
        proc.emit('can_use_tool', {
          request_id: 'ask', tool_name: 'AskUserQuestion',
          input: { questions: [{ id: 'q', question: 'Missing execution target?' }] },
        })
        const failure = await handle.done.catch(error => error)
        expect(failure).toBeInstanceOf(AgentWorkerFailure)
        expect(failure.message).toContain('non-interactive')
        expect(failure.message).toContain('Missing execution target?')
        expect(failure.output).toBe('work already performed')
        expect(failure.sessionId).toBe('sid-1')
        expect(waiting).toEqual([])
        expect(handle.pendingInput()).toBeNull()
        expect(proc.permissionResponses).toEqual([['work', 'allow', { updatedInput: { command: 'pwd' } }]])
        expect(proc.isAlive()).toBe(false)
      })
    }
  }

  test('queues simultaneous questions without killing the task or losing answers', async () => {
    const proc = new FakeProcess() as any
    const questions: string[] = []
    const handle = collectAgentTurn(proc, 'ask questions', {
      onNeedsInput: request => questions.push(request.requestId),
    }, () => {})
    for (const id of ['first', 'second']) {
      proc.emit('can_use_tool', {
        request_id: id, tool_name: 'AskUserQuestion',
        input: { questions: [{ id, question: `Question ${id}?` }] },
      })
    }
    expect(questions).toEqual(['first'])
    expect(proc.alive).toBe(true)
    handle.answer('first', { first: 'one' })
    expect(questions).toEqual(['first', 'second'])
    expect(handle.pendingInput()?.requestId).toBe('second')
    handle.answer('second', { second: 'two' })
    expect(handle.pendingInput()).toBeNull()
    expect(proc.permissionResponses.map((response: any[]) => response[0])).toEqual(['first', 'second'])
    proc.emit('result', { is_error: false })
    await handle.done
  })

  test('cancellation exposes failed process termination and permits a later cleanup attempt', async () => {
    const proc = new FakeProcess() as any
    const kill = spyOn(proc, 'kill').mockRejectedValue(new Error('process termination not confirmed'))
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    const failure = handle.done.catch(error => error)
    try {
      await expect(handle.cancel('stop')).rejects.toThrow('process termination not confirmed')
      expect((await failure).message).toContain('process termination not confirmed')
      expect(handle.isAlive?.()).toBe(true)
      expect(() => proc.emit('error', new Error('process remains alive'))).not.toThrow()
    } finally {
      kill.mockRestore()
      await handle.cancel('retry stop')
    }
    expect(handle.isAlive?.()).toBe(false)
    expect(proc.listenerCount('error')).toBe(0)
  })

  test('a failed task preserves the output produced before the error', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    proc.emit('assistant_text', { text: '已完成的调查结果' })
    proc.emit('result', { is_error: true, error: 'upstream request failed' })
    const error = await handle.done.catch(error => error)
    expect(error).toBeInstanceOf(AgentWorkerFailure)
    expect(error.message).toBe('upstream request failed')
    expect(error.output).toBe('已完成的调查结果')
    expect(error.sessionId).toBe('sid-1')
  })
})

test('native resume rejects a backend that silently creates a different conversation', async () => {
  const proc = new FakeProcess() as any
  proc.sessionId = 'unexpected-new-session'
  const remembered: string[] = []
  const handle = collectAgentTurn(proc, 'continue', {}, (_provider, id) => { remembered.push(id) }, 'original-session')
  proc.emit('init', { session_id: proc.sessionId })
  await expect(handle.done).rejects.toThrow('native resume returned session unexpected-new-session, expected original-session')
  expect(proc.isAlive()).toBe(false)
  expect(remembered).toContain('unexpected-new-session')
})

test('native resume preserves the original history classification of an external conversation', async () => {
  const proc = new FakeProcess() as any
  proc.sessionId = 'external-session'
  const classified: string[] = []
  const handle = collectAgentTurn(proc, 'continue', {}, (_provider, id) => { classified.push(id) }, 'external-session')
  proc.emit('init', { session_id: proc.sessionId })
  proc.emit('assistant_text', { text: 'restored' })
  proc.emit('result', { is_error: false })
  await expect(handle.done).resolves.toMatchObject({ sessionId: 'external-session', output: 'restored' })
  expect(classified).toEqual([])
})
