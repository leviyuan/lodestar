import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import {
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  CodexRpcResponseError,
  codexAppServerArgs,
  codexAppServerSpawnOptions,
  imageGenerationOutput,
  usageFromTokenUsagePayload,
} from './codex-process'
import { resetAgentSessionRegistryForTest } from './agent-session-registry'

function makeCodexLifecycleHarness(stdinOverrides: Record<string, unknown> = {}): any {
  const proc = Object.create(CodexProcess.prototype) as any
  proc.alive = true
  proc.expectedExit = false
  proc.exitEventEmitted = false
  proc.stdoutBuf = ''
  proc.stderrBuf = ''
  proc.childExitCode = null
  proc.childExitSignal = null
  proc.requestCounter = 0
  proc.pending = new Map()
  proc.serverRequests = new Map()
  proc.proc = {
    stdin: {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write: () => true,
      ...stdinOverrides,
    },
    kill: () => true,
  }
  proc.exitPromise = new Promise<void>(resolve => { proc.resolveExit = resolve })
  return proc
}

type ProtocolCall = { method: string; params: any }

function makeCodexProtocolHarness(
  opts: Record<string, unknown> = {},
  respond?: (method: string, params: any) => any | Promise<any>,
): { proc: any; calls: ProtocolCall[]; writes: any[]; events: Array<[string, any]> } {
  const proc = Object.create(CodexProcess.prototype) as any
  const calls: ProtocolCall[] = []
  const writes: any[] = []
  const events: Array<[string, any]> = []
  proc.alive = true
  proc.capacityRetryEnabled = true
  proc.opts = { workDir: '/repo', ...opts }
  proc.readyPromise = null
  proc.initializePromise = null
  proc.conversationResumable = false
  proc.conversationRolloutPath = null
  proc.currentTurnId = null
  proc.sessionId = null
  proc.lastCompletedTurnId = null
  proc.lastUsage = null
  proc.lastResult = {
    cost_usd: null,
    cost_delta_usd: null,
    duration_ms: null,
    num_turns: null,
    usage: null,
    subtype: null,
    is_error: false,
  }
  proc.write = (message: any) => {
    writes.push(message)
    return true
  }
  proc.request = async (method: string, params: any) => {
    calls.push({ method, params })
    let result: any
    if (respond) result = await respond(method, params)
    else if (method === 'initialize') result = {}
    else if (method === 'thread/start') result = { thread: { id: 'fresh-thread', cwd: '/repo' } }
    else if (method === 'thread/resume') result = { thread: { id: params.threadId, cwd: '/repo' } }
    else if (method === 'thread/fork') result = { thread: { id: 'forked-thread', cwd: '/repo' } }
    else if (method === 'model/list' || method === 'thread/list') result = { data: [], nextCursor: null }
    else throw new Error(`unexpected request ${method}`)
    if (
      method.startsWith('thread/')
      && typeof result?.thread?.id === 'string'
      && !Object.prototype.hasOwnProperty.call(result.thread, 'path')
    ) {
      result = {
        ...result,
        thread: {
          ...result.thread,
          path: `/rollouts/rollout-${result.thread.id}.jsonl`,
        },
      }
    }
    return result
  }
  proc.primeRolloutImageGenerationScan = () => {}
  proc.flushRolloutImageGenerations = () => {}
  proc.assertConversationRolloutMaterialized = () => {}
  proc.verifyConversationMaterialized = async () => {}
  proc.emit = (event: string, payload: any) => {
    events.push([event, payload])
    return true
  }
  return { proc, calls, writes, events }
}

const CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model'

async function withCapacityClock(run: (clock: {
  timers: Map<number, { callback: () => void; delay: number }>
  tick(): Promise<void>
}) => Promise<void>): Promise<void> {
  let nextId = 100_000
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const id = nextId++
    timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
  try {
    await run({
      timers,
      async tick() {
        const next = timers.entries().next().value
        if (!next) throw new Error('no scheduled capacity retry')
        timers.delete(next[0])
        next[1].callback()
        await flushCapacityMicrotasks()
      },
    })
  } finally {
    timeout.mockRestore()
    clear.mockRestore()
  }
}

async function flushCapacityMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function capacityHarness(respond?: (method: string, params: any) => any | Promise<any>) {
  let turn = 0
  const harness = makeCodexProtocolHarness({ model: 'selected-model', effort: 'high' }, respond ?? (method => {
    if (method === 'turn/start') return { turn: { id: `capacity-turn-${++turn}` } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`unexpected request ${method}`)
  }))
  harness.proc.sessionId = 'capacity-thread'
  harness.proc.readyPromise = Promise.resolve()
  harness.proc.conversationResumable = true
  return harness
}

function completeCapacityTurn(proc: any, error: any = { message: CAPACITY_MESSAGE }): void {
  proc.handleNotification('turn/completed', {
    threadId: 'capacity-thread',
    turn: { id: proc.currentTurnId, status: error ? 'failed' : 'completed', error },
  })
}

describe('native Codex quota terminal classification', () => {
  test('early error never switches; only main-thread terminal failure carries accepted recovery metadata', async () => {
    const { proc, events } = capacityHarness()
    proc.sendUserText('one task'); await flushCapacityMicrotasks()
    const error = { codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit." }
    proc.handleNotification('error', { threadId: 'capacity-thread', turnId: proc.currentTurnId, error, willRetry: false })
    expect(events.filter(([name]) => name === 'result')).toHaveLength(0)
    completeCapacityTurn(proc, error)
    expect(events.find(([name]) => name === 'result')?.[1]).toMatchObject({ is_error: true, codexQuotaFailure: { accepted: true } })
  })
  test('explicit turn/start rejection preserves unaccepted input including file hints', async () => {
    const { proc, events } = capacityHarness(async () => {
      throw new CodexRpcResponseError('turn/start', 1, -32000, 'usage denied', { codexErrorInfo: 'usageLimitExceeded' })
    })
    proc.sendUserText('one task', ['/input']); await flushCapacityMicrotasks()
    expect(events.find(([name]) => name === 'result')?.[1]).toMatchObject({
      codexQuotaFailure: { accepted: false, rejectedInput: '[file: /input]\n\none task' },
    })
  })
  test('transport timeout and rate-limited control APIs cannot authorize replay', async () => {
    const { proc, events } = capacityHarness(async () => { throw new Error('turn/start timed out HTTP 429') })
    proc.sendUserText('one task'); await flushCapacityMicrotasks()
    const result = events.find(([name]) => name === 'result')?.[1]
    expect(result.is_error).toBe(true); expect(result.codexQuotaFailure).toBeUndefined()
  })
})

describe('codex model capacity recovery', () => {
  test('waits for terminal failure, keeps one logical task open and continues its existing history', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('original task', ['/tmp/input.png'])
      await flushCapacityMicrotasks()
      for (const willRetry of [true, false]) {
        proc.handleNotification('error', {
          threadId: 'capacity-thread', turnId: proc.currentTurnId,
          error: { message: CAPACITY_MESSAGE }, willRetry,
        })
      }
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([event]) => event === 'error').map(([, error]) => error.message))
        .toEqual([CAPACITY_MESSAGE, CAPACITY_MESSAGE])

      // The completion may omit the error already supplied by the notification.
      const failedId = proc.currentTurnId
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: failedId, status: 'failed' },
      })
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: failedId, status: 'failed', error: { message: CAPACITY_MESSAGE } },
      })
      expect(events.filter(([event]) => event === 'result')).toEqual([])
      expect(proc.lastCompletedTurnId).toBeNull()
      expect([...clock.timers.values()].map(timer => timer.delay)).toEqual([5_000])
      expect(proc.turnRetry).toMatchObject({ phase: 'waiting', attempt: 1, message: CAPACITY_MESSAGE })
      await clock.tick()

      const starts = calls.filter(call => call.method === 'turn/start')
      expect(starts).toHaveLength(2)
      expect(starts[0]!.params.input[0].text).toBe('[file: /tmp/input.png]\n\noriginal task')
      expect(starts[1]!.params.input[0].text).toContain('继续完成用户尚未完成的任务')
      expect(starts[1]!.params.input[0].text).not.toContain('original task')
      expect(starts[1]!.params).toEqual({ ...starts[0]!.params, input: starts[1]!.params.input })
      expect(proc.opts).toMatchObject({ model: 'selected-model', effort: 'high' })
      expect(events.filter(([event]) => event === 'turn_started').at(-1)?.[1].retry).toBe(true)
      completeCapacityTurn(proc, null)
      expect(events.filter(([event]) => event === 'result')).toEqual([
        ['result', expect.objectContaining({ is_error: false, turn_id: 'capacity-turn-2' })],
      ])
      expect(proc.turnRetry).toBeNull()
      expect(clock.timers.size).toBe(0)
    })
  })

  test('keeps retrying with capped backoff and resets after a successful task', async () => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]) {
        completeCapacityTurn(proc)
        expect([...clock.timers.values()].map(timer => timer.delay)).toEqual([delay])
        expect(events.filter(([event]) => event === 'result')).toEqual([])
        await clock.tick()
      }
      completeCapacityTurn(proc, null)
      proc.sendUserText('next task')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      expect(proc.turnRetry).toMatchObject({ attempt: 1, delayMs: 5_000 })
    })
  })

  test('retries an explicitly rejected turn/start with its original input and files', async () => {
    await withCapacityClock(async clock => {
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
        if (++starts === 1) throw new CodexRpcResponseError(method, 1, -32000, CAPACITY_MESSAGE)
        return { turn: { id: 'accepted-retry' } }
      })
      proc.sendUserText('unaccepted task', ['/tmp/data.csv'])
      await flushCapacityMicrotasks()
      expect(events.filter(([event]) => event === 'result')).toEqual([])
      await clock.tick()
      expect(calls[1]).toEqual(calls[0])
      // No earlier accepted turn: this boundary must seed the usage baseline.
      expect(events.find(([event]) => event === 'turn_started')?.[1].retry).toBeUndefined()
      completeCapacityTurn(proc, null)
    })
  })

  test('unrelated failures and initialization errors remain terminal', async () => {
    await withCapacityClock(async clock => {
      for (const error of [
        new CodexRpcResponseError('turn/start', 1, -32000, 'Usage limit exceeded'),
        new CodexRpcResponseError('thread/start', 1, -32000, CAPACITY_MESSAGE),
        new Error('turn/start request timed out'),
      ]) {
        const { proc, events } = capacityHarness(() => { throw error })
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
        expect(proc.lastResult.is_error).toBe(true)
        expect(clock.timers.size).toBe(0)
      }
      for (const message of ['Context window capacity exceeded', 'Unauthorized', 'Usage limit exceeded']) {
        const { proc, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc, { message })
        expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
        expect(clock.timers.size).toBe(0)
      }
    })
  })

  test('interrupt during backoff cancels even an already-queued timer callback', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      const staleTimer = [...clock.timers.values()][0]!
      proc.sendInterrupt()
      expect(clock.timers.size).toBe(0)
      staleTimer.callback()
      await flushCapacityMicrotasks()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toEqual([
        ['result', expect.objectContaining({ subtype: 'interrupted', checkpoint: null })],
      ])
    })
  })

  test('interrupt also cancels a retry awaiting its turn/start acknowledgement', async () => {
    await withCapacityClock(async clock => {
      let resolveRetry!: (value: any) => void
      let starts = 0
      const { proc, calls, events } = capacityHarness(method => {
        if (method === 'turn/interrupt') return {}
        if (++starts === 1) return { turn: { id: 'first-turn' } }
        return new Promise(resolve => { resolveRetry = resolve })
      })
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      await clock.tick()
      proc.sendInterrupt()
      proc.sendInterrupt()
      resolveRetry({ turn: { id: 'cancelled-retry' } })
      await flushCapacityMicrotasks()
      expect(proc.currentTurnId).toBeNull()
      expect(calls.at(-1)).toEqual({
        method: 'turn/interrupt', params: { threadId: 'capacity-thread', turnId: 'cancelled-retry' },
      })
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread',
        turn: { id: 'cancelled-retry', status: 'failed', error: { message: CAPACITY_MESSAGE } },
      })
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
      expect(clock.timers.size).toBe(0)
    })
  })

  test('a synchronous stop at the retry progress event prevents the request from being sent', async () => {
    await withCapacityClock(async clock => {
      const { proc, calls, events } = capacityHarness()
      const emit = proc.emit
      proc.emit = (event: string, payload: any) => {
        emit(event, payload)
        if (event === 'turn_retry' && payload.phase === 'retrying') proc.sendInterrupt()
        return true
      }
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      completeCapacityTurn(proc)
      await clock.tick()
      expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })

  test('new input, native continuation, kill and OS exit all retire the waiting timer', async () => {
    await withCapacityClock(async clock => {
      for (const action of ['input', 'native', 'kill', 'exit']) {
        const { proc, calls, events } = capacityHarness()
        proc.sendUserText('do work')
        await flushCapacityMicrotasks()
        completeCapacityTurn(proc)
        const staleTimer = [...clock.timers.values()][0]!
        if (action === 'input') proc.sendUserText('new instruction')
        if (action === 'native') proc.handleNotification('turn/started', {
          threadId: 'capacity-thread', turn: { id: 'native-continuation' },
        })
        if (action === 'kill') {
          proc.sendSignal = () => {}
          proc.waitForExit = async () => true
          await proc.kill()
        }
        if (action === 'exit') proc.handleChildExit(1, null)
        expect(clock.timers.size).toBe(0)
        staleTimer.callback()
        await flushCapacityMicrotasks()
        expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(action === 'input' ? 2 : 1)
        if (action === 'native') {
          expect(proc.currentTurnId).toBe('native-continuation')
          expect(events.filter(([event]) => event === 'turn_retry').at(-1)?.[1].phase).toBe('retrying')
        }
      }
    })
  })

  test('child-thread and stale capacity errors cannot turn an unrelated failure into a retry', async () => {
    await withCapacityClock(async clock => {
      const { proc, events } = capacityHarness()
      proc.sendUserText('do work')
      await flushCapacityMicrotasks()
      for (const [threadId, turnId] of [['child-thread', proc.currentTurnId], ['capacity-thread', 'old-turn']]) {
        proc.handleNotification('error', { threadId, turnId, error: { message: CAPACITY_MESSAGE }, willRetry: false })
        proc.handleNotification('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: CAPACITY_MESSAGE } } })
      }
      proc.handleNotification('turn/completed', {
        threadId: 'capacity-thread', turn: { id: proc.currentTurnId, status: 'failed' },
      })
      expect(clock.timers.size).toBe(0)
      expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    })
  })
})

describe('codex JSON-RPC lifecycle reliability', () => {
  test('starts the complete app-server feature surface without isolation overrides', () => {
    expect(codexAppServerArgs()).toEqual(['app-server', '--listen', 'stdio://'])
  })

  for (const resume of [false, true]) {
    test(`delegated Codex workers disable native delegation at process and thread launch (resume=${resume})`, async () => {
      expect(codexAppServerArgs(false)).toEqual(['app-server', '--listen', 'stdio://', '--disable', 'multi_agent'])
      const { proc, calls } = makeCodexProtocolHarness({
        allowDelegation: false, model: 'worker-model', effort: 'xhigh',
        ...(resume ? { launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'worker-thread', cwd: '/repo' } } } : {}),
      })
      await proc.initializeAndStartThread()
      const launch = calls.find(call => call.method === (resume ? 'thread/resume' : 'thread/start'))!
      expect(launch.params.config['features.multi_agent']).toBe(false)
      expect(launch.params.config.model_reasoning_effort).toBe('xhigh')
      expect(launch.params.sandbox).toBe('danger-full-access')
      expect(launch.params.model).toBe('worker-model')
    })
  }

  test('keeps Windows-compatible Codex spawning shell-free so TOML argv stays literal', () => {
    const env = { PATH: 'C:\\bin' }
    expect(codexAppServerSpawnOptions('C:\\repo', env)).toEqual({
      cwd: 'C:\\repo',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
    })
    expect(codexAppServerArgs()).not.toContain('--disable')
  })

  test('registers pending before write and clears its timeout on response', async () => {
    let written = ''
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        written = chunk
        const id = JSON.parse(chunk).id
        proc.handleMessage({ id, result: { ok: true } })
        return true
      },
    })

    await expect(proc.request('model/list', {}, 20)).resolves.toEqual({ ok: true })
    expect(JSON.parse(written)).toMatchObject({ id: 1, method: 'model/list' })
    expect(proc.pending.size).toBe(0)
  })

  test('JSON-RPC response errors retain the pending method in diagnostics', async () => {
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        const id = JSON.parse(chunk).id
        queueMicrotask(() => proc.handleMessage({
          id,
          error: { code: -32000, message: 'no rollout found for thread id ghost-thread' },
        }))
        return true
      },
    })

    const request = proc.request('thread/resume', {}, 20)
    await expect(request).rejects.toThrow('codex app-server thread/resume failed')
    await expect(request).rejects.toMatchObject({
      method: 'thread/resume',
      requestId: 1,
      serverCode: -32000,
      serverMessage: 'no rollout found for thread id ghost-thread',
    })
    expect(proc.pending.size).toBe(0)
  })

  test('rejects dead stdin writes without leaving a pending request', async () => {
    const proc = makeCodexLifecycleHarness({ writable: false })

    await expect(proc.request('initialize', {}, 20)).rejects.toThrow('request write failed')
    expect(proc.pending.size).toBe(0)
  })

  test('rejects asynchronous stdin write failures without leaking pending', async () => {
    const proc = makeCodexLifecycleHarness({
      write: (_chunk: string, callback: (error?: Error) => void) => {
        queueMicrotask(() => callback(new Error('EPIPE')))
        return true
      },
    })

    await expect(proc.request('initialize', {}, 20)).rejects.toThrow('EPIPE')
    expect(proc.pending.size).toBe(0)
  })

  test('a spawn error without a pid terminalizes lifecycle instead of leaving a ghost alive process', async () => {
    const proc = makeCodexLifecycleHarness()
    const exits: any[] = []
    proc.on('error', () => {})
    proc.on('exit', (event: any) => exits.push(event))
    const pending = proc.request('initialize', {}, 100)

    proc.handleChildProcessError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    await expect(pending).rejects.toThrow('process failed before initialize response')
    expect(proc.isAlive()).toBe(false)
    await expect(proc.kill(1)).resolves.toBeUndefined()
    expect(exits).toEqual([{ code: null, signal: null, expected: false }])
  })

  test('OS exit keeps pending RPCs alive until a final stdout response is drained on close', async () => {
    let requestId = 0
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        requestId = JSON.parse(chunk).id
        return true
      },
    })
    const pending = proc.request('thread/read', {}, 100)
    proc.stdoutBuf = JSON.stringify({ id: requestId, result: { thread: { id: 'thread-1' } } })

    proc.handleChildExit(0, null)
    expect(proc.pending.size).toBe(1)
    proc.handleChildClose(0, null)

    await expect(pending).resolves.toEqual({ thread: { id: 'thread-1' } })
    expect(proc.pending.size).toBe(0)
    expect(proc.isAlive()).toBe(false)
  })

  test('stdin EPIPE does not reject an already-sent RPC whose response is in the stdout tail', async () => {
    let requestId = 0
    const proc = makeCodexLifecycleHarness({
      write: (chunk: string) => {
        requestId = JSON.parse(chunk).id
        return true
      },
    })
    proc.expectedExit = true
    const pending = proc.request('thread/read', {}, 100)

    proc.handleStdinError(new Error('EPIPE'))
    expect(proc.pending.size).toBe(1)
    proc.stdoutBuf = JSON.stringify({ id: requestId, result: { thread: { id: 'thread-1' } } })
    proc.handleChildClose(0, null)

    await expect(pending).resolves.toEqual({ thread: { id: 'thread-1' } })
  })

  test('public exit waits for tail materialization continuations before Session cleanup', async () => {
    const proc = makeCodexLifecycleHarness()
    const exits: any[] = []
    proc.on('exit', (event: any) => exits.push(event))
    let releaseMaterialization: () => void = () => {}
    const materialization = new Promise<void>(resolve => {
      releaseMaterialization = resolve
    })
    proc.conversationMaterializationVerification = materialization
    void materialization.then(() => {
      proc.conversationMaterializationVerification = null
    })

    proc.handleChildExit(0, null)
    proc.handleChildClose(0, null)
    expect(exits).toEqual([])
    expect(proc.isAlive()).toBe(true)

    releaseMaterialization()
    await proc.exitPromise
    expect(exits).toEqual([{ code: 0, signal: null, expected: false }])
    expect(proc.isAlive()).toBe(false)
  })

  test('times out unanswered requests and removes them from pending', async () => {
    const proc = makeCodexLifecycleHarness()

    await expect(proc.request('thread/start', {}, 5)).rejects.toThrow('timed out after 5ms')
    expect(proc.pending.size).toBe(0)
  })

  test('waits for real exit after SIGKILL instead of returning after delivery', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          proc.alive = false
          proc.exitEventEmitted = true
          proc.resolveExit()
        })
      }
      return true
    }

    await expect(proc.kill(5)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(proc.alive).toBe(false)
  })

  test('rejects kill when neither TERM nor KILL produces an exit', async () => {
    const proc = makeCodexLifecycleHarness()
    const signals: string[] = []
    proc.proc.kill = (signal: string) => {
      signals.push(signal)
      return true
    }

    await expect(proc.kill(2)).rejects.toThrow('did not exit after SIGTERM and SIGKILL')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('codex app-server conversation protocol', () => {
  test('catalog and main launch share one initialize handshake and send initialized once', async () => {
    let releaseInitialize!: () => void
    const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve })
    const { proc, calls, writes } = makeCodexProtocolHarness({}, async (method, _params) => {
      if (method === 'initialize') {
        await initializeGate
        return {}
      }
      if (method === 'thread/start') return { thread: { id: 'main-thread', cwd: '/repo' } }
      if (method === 'model/list') return { data: [], nextCursor: null }
      throw new Error(`unexpected request ${method}`)
    })

    const main = proc.initializeAndStartThread()
    const catalog = proc.listModels()
    await Promise.resolve()
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)

    releaseInitialize()
    await expect(Promise.all([main, catalog])).resolves.toEqual([undefined, []])
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)
    expect(writes).toEqual([{ method: 'initialized' }])
    expect(calls.findIndex(c => c.method === 'initialize')).toBeLessThan(calls.findIndex(c => c.method === 'thread/start'))
    expect(calls.findIndex(c => c.method === 'initialize')).toBeLessThan(calls.findIndex(c => c.method === 'model/list'))
  })

  test('does not issue catalog requests when the initialized notification cannot be written', async () => {
    const { proc, calls } = makeCodexProtocolHarness()
    proc.write = () => false

    await expect(proc.listModels()).rejects.toThrow('initialized notification write failed')
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(1)
    expect(calls.some(c => c.method === 'model/list')).toBe(false)
  })

  test('maps an explicit fresh launch to thread/start', async () => {
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fresh' },
    })

    await proc.initializeAndStartThread()
    const launches = calls.filter(c => c.method.startsWith('thread/'))
    expect(launches).toHaveLength(1)
    expect(launches[0].method).toBe('thread/start')
    expect(launches[0].params).not.toHaveProperty('threadId')
    expect(proc.sessionId).toBe('fresh-thread')
    expect(proc.isConversationResumable()).toBe(false)
  })

  test('maps explicit resume to thread/resume', async () => {
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'resume', source: { provider: 'codex', sessionId: 'explicit-thread', cwd: '/repo' } },
    })
    await proc.initializeAndStartThread()
    expect(calls.find(c => c.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'explicit-thread', cwd: '/repo', excludeTurns: true,
    })
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('maps a Codex turn checkpoint to thread/fork lastTurnId', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: {
        kind: 'fork',
        source,
        through: { provider: 'codex', kind: 'turn', id: 'turn-7', source },
      },
    })

    await proc.initializeAndStartThread()
    expect(calls.find(c => c.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'source-thread',
      lastTurnId: 'turn-7',
      cwd: '/repo',
      excludeTurns: true,
    })
    expect(proc.sessionId).toBe('forked-thread')
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('sendInitialize returns the same exact readiness transaction to every caller', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        await startGate
        return { thread: { id: 'fresh-thread', cwd: '/repo' } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    proc.sendInitialize()
    const first = proc.initializationPromise()
    proc.sendInitialize()
    const second = proc.initializationPromise()
    expect(second).toBe(first)
    releaseStart()
    await expect(first).resolves.toBeUndefined()
  })

  test('rejects a non-turn fork checkpoint before sending thread/fork', async () => {
    const source = { provider: 'codex', sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: {
        kind: 'fork',
        source,
        through: { provider: 'codex', kind: 'assistant-message', id: 'message-1', source },
      },
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('must be a codex turn checkpoint')
    expect(calls.some(c => c.method === 'thread/fork')).toBe(false)
  })

  test('rejects a fork response that reuses the source id without falling back', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fork', source },
    }, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/fork') return { thread: { id: params.threadId, cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned source thread id')
    expect(calls.filter(c => c.method === 'thread/fork')).toHaveLength(1)
    expect(calls.some(c => c.method === 'thread/resume' || c.method === 'thread/start')).toBe(false)
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a fork response without a new thread id', async () => {
    const source = { provider: 'codex' as const, sessionId: 'source-thread', cwd: '/repo' }
    const { proc, calls } = makeCodexProtocolHarness({
      launch: { kind: 'fork', source },
    }, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/fork') return { thread: { cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('thread/fork returned no thread.id')
    expect(calls.some(c => c.method === 'thread/resume' || c.method === 'thread/start')).toBe(false)
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a launch response for a different cwd before exposing the thread id', async () => {
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'wrong-cwd-thread', cwd: '/other' } }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned cwd=/other, expected /repo')
    expect(proc.sessionId).toBeNull()
  })

  test('rejects a launch response without an authoritative rollout path', async () => {
    const { proc } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        return { thread: { id: 'pathless-thread', cwd: '/repo', path: null } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow('returned invalid thread.path=MISS')
    expect(proc.sessionId).toBeNull()
  })

  test('runs every Codex turn with the complete danger-full-access policy', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return { turn: { id: 'agent-turn' } }
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'agent-thread'
    await proc.startTurn('work')
    expect(calls[0]).toMatchObject({
      method: 'turn/start',
      params: {
        sandboxPolicy: { type: 'dangerFullAccess' },
        runtimeWorkspaceRoots: ['/repo'],
      },
    })
  })

  test('rejects a resume response that routes to a different thread id', async () => {
    const source = { provider: 'codex' as const, sessionId: 'expected-thread', cwd: '/repo' }
    const { proc } = makeCodexProtocolHarness({
      launch: { kind: 'resume', source },
    }, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        return { thread: { id: 'wrong-thread', cwd: '/repo' } }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.initializeAndStartThread()).rejects.toThrow(
      'thread/resume returned thread id wrong-thread, expected expected-thread',
    )
    expect(proc.sessionId).toBeNull()
  })

  test('turn/start response and notification share one canonical transition', async () => {
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-response' } }
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'
    proc.conversationResumable = false

    await proc.startTurn('hello')
    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-response' },
    })
    await Promise.resolve()

    expect(proc.currentTurnId).toBe('turn-response')
    expect(events.filter(([event]) => event === 'turn_started')).toEqual([
      ['turn_started', { turn_id: 'turn-response', thread_id: 'main-thread' }],
    ])
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([
      ['conversation_materialized', {
        session_id: 'main-thread',
        source: 'turn/started notification',
      }],
    ])
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('malformed turn/started cannot mark a fresh conversation resumable', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationResumable = false

    expect(() => proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: {},
    })).toThrow('returned no turn.id')

    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
  })

  test('turn lifecycle notifications without the exact main thread id fail closed', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-current'

    proc.handleNotification('turn/started', { turn: { id: 'turn-missing-thread' } })
    proc.handleNotification('turn/completed', {
      turn: { id: 'turn-current', status: 'completed' },
    })

    expect(proc.currentTurnId).toBe('turn-current')
    expect(events.filter(([event]) => event === 'turn_started' || event === 'result')).toEqual([])
  })

  test('turn/started without authoritative thread/read acknowledgement emits failure and stays unbound', async () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'
    proc.conversationResumable = false
    proc.verifyConversationMaterialized = async () => {
      throw new Error('rollout stat EACCES')
    }

    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'turn-1' },
    })
    await Promise.resolve()

    expect(proc.isConversationResumable()).toBe(false)
    expect(events.filter(([event]) => event === 'conversation_materialized')).toEqual([])
    expect(events.filter(([event]) => event === 'conversation_materialization_failed')).toEqual([
      ['conversation_materialization_failed', {
        session_id: 'main-thread',
        path: '/rollouts/rollout-main-thread.jsonl',
        source: 'turn/started notification',
        error: expect.any(Error),
      }],
    ])
  })

  test('materialization verification requires thread/read includeTurns and exact id cwd path', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: params.threadId,
            cwd: '/repo',
            path: '/rollouts/rollout-main-thread.jsonl',
            turns: [{ id: 'turn-1' }],
          },
        }
      }
      throw new Error(`unexpected request ${method}`)
    })
    delete proc.verifyConversationMaterialized
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'

    await expect(proc.verifyConversationMaterialized('turn/started notification')).resolves.toBeUndefined()
    expect(calls).toContainEqual({
      method: 'thread/read',
      params: { threadId: 'main-thread', includeTurns: true },
    })
  })

  test('materialization barrier drains a completion-triggered retry before settling', async () => {
    const { proc } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.conversationRolloutPath = '/rollouts/rollout-main-thread.jsonl'
    proc.conversationResumable = false
    let attempts = 0
    let releaseRetry: () => void = () => {}
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
    proc.verifyConversationMaterialized = async () => {
      attempts++
      if (attempts === 1) throw new Error('first verification raced persistence')
      await retryGate
    }

    proc.markConversationMaterialized('turn/started notification')
    proc.markConversationMaterialized('turn/completed notification')
    const barrier = proc.conversationMaterializationBarrier()
    expect(barrier).not.toBeNull()
    let settled = false
    void barrier!.then(() => { settled = true })
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(attempts).toBe(2)
    expect(settled).toBe(false)
    releaseRetry()
    await expect(barrier!).resolves.toBeUndefined()
    expect(proc.isConversationResumable()).toBe(true)
  })

  test('does not revive a completed turn when its turn/start response arrives late', async () => {
    let resolveStart!: (value: any) => void
    const startResponse = new Promise<any>(resolve => { resolveStart = resolve })
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') return startResponse
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'
    proc.lastCompletedTurnId = 'previous-turn'

    const pending = proc.startTurn('fast turn')
    await Promise.resolve()
    expect(proc.lastCompletedTurnId).toBeNull()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'fast-turn' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'fast-turn', status: 'completed', durationMs: 1 },
    })
    resolveStart({ turn: { id: 'fast-turn' } })
    await pending

    expect(proc.currentTurnId).toBeNull()
    expect(proc.lastCompletedTurnId).toBe('fast-turn')
    expect(events.filter(([event]) => event === 'turn_started')).toHaveLength(1)
  })

  test('late turn/started for a finished id cannot capture the next turn owner', () => {
    const { proc } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.finishedTurnIds = new Set(['turn-old'])
    const nextAttempt = proc.beginTurnStart()

    proc.recordTurnStarted(
      { id: 'turn-old' },
      'main-thread',
      'late turn/started notification',
    )

    expect(nextAttempt.turnId).toBeNull()
    expect(() => proc.recordTurnStarted(
      { id: 'turn-new' },
      'main-thread',
      'turn/start response',
      nextAttempt,
    )).not.toThrow()
    expect(nextAttempt.turnId).toBe('turn-new')
  })

  test('late or duplicate turn/completed cannot clear a newer active turn or emit a second result', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-new'
    proc.lastCompletedTurnId = 'checkpoint-newer'
    proc.finishedTurnIds = new Set(['turn-finished'])

    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-finished', status: 'completed' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-old-first-terminal', status: 'completed' },
    })

    expect(proc.currentTurnId).toBe('turn-new')
    expect(proc.lastCompletedTurnId).toBe('checkpoint-newer')
    expect(events.filter(([event]) => event === 'result')).toEqual([])
    expect(proc.finishedTurnIds.has('turn-old-first-terminal')).toBe(true)
  })

  test('a duplicate completion for the current turn emits exactly one terminal result', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-1'
    proc.conversationResumable = true
    proc.finishedTurnIds = new Set()
    const notification = {
      threadId: 'main-thread',
      turn: { id: 'turn-1', status: 'completed' },
    }

    proc.handleNotification('turn/completed', notification)
    proc.handleNotification('turn/completed', notification)

    expect(events.filter(([event]) => event === 'result')).toHaveLength(1)
    expect(proc.currentTurnId).toBeNull()
  })

  test('ignores an old request timeout after its turn completed and the next turn started', async () => {
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (value: any) => void
    const firstResponse = new Promise<any>((_resolve, reject) => { rejectFirst = reject })
    const secondResponse = new Promise<any>(resolve => { resolveSecond = resolve })
    let requestIndex = 0
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method !== 'turn/start') throw new Error(`unexpected request ${method}`)
      requestIndex += 1
      return requestIndex === 1 ? firstResponse : secondResponse
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'

    proc.sendUserText('first')
    await Promise.resolve()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'first-turn' },
    })
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'first-turn', status: 'completed', durationMs: 1 },
    })

    proc.sendUserText('second')
    await Promise.resolve()
    proc.handleNotification('turn/started', {
      threadId: 'main-thread',
      turn: { id: 'second-turn' },
    })

    rejectFirst(new Error('turn/start request timed out'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(proc.currentTurnId).toBe('second-turn')
    expect(proc.lastResult.is_error).toBe(false)
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({ turn_id: 'first-turn', is_error: false })],
    ])

    resolveSecond({ turn: { id: 'second-turn' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(proc.currentTurnId).toBe('second-turn')
    expect(events.filter(([event]) => event === 'turn_started')).toHaveLength(2)
  })

  test('still reports a turn/start rejection owned by the current generation', async () => {
    const { proc, events } = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'turn/start') throw new Error('current request failed')
      throw new Error(`unexpected request ${method}`)
    })
    proc.readyPromise = Promise.resolve()
    proc.sessionId = 'main-thread'

    proc.sendUserText('will fail')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(proc.currentTurnId).toBeNull()
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({
        subtype: 'codex_turn_start_failed',
        is_error: true,
        error: 'current request failed',
      })],
    ])
  })

  test('records the canonical main-thread turn/completed id publicly', () => {
    const { proc, events } = makeCodexProtocolHarness()
    proc.sessionId = 'main-thread'
    proc.currentTurnId = 'turn-9'

    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-9', status: 'completed', durationMs: 25 },
    })

    expect(proc.lastCompletedTurnId).toBe('turn-9')
    expect(proc.currentTurnId).toBeNull()
    expect(events.filter(([event]) => event === 'result')).toEqual([
      ['result', expect.objectContaining({
        turn_id: 'turn-9',
        checkpoint: {
          provider: 'codex',
          kind: 'turn',
          id: 'turn-9',
          source: { provider: 'codex', sessionId: 'main-thread', cwd: '/repo' },
        },
      })],
    ])
  })

  test('failed or malformed terminal turns cannot reuse an earlier checkpoint', () => {
    for (const turn of [
      { id: 'failed-turn', status: 'failed', error: { type: 'model_error' } },
      { status: 'completed' },
    ]) {
      const { proc, events } = makeCodexProtocolHarness()
      proc.sessionId = 'main-thread'
      proc.lastCompletedTurnId = 'previous-turn'
      proc.handleNotification('turn/completed', { threadId: 'main-thread', turn })

      expect(proc.lastCompletedTurnId).toBeNull()
      expect(events.find(([event]) => event === 'result')?.[1].checkpoint).toBeNull()
    }
  })

  test('lists exact-cwd interactive conversations across every page without over-filtering their source', async () => {
    const { proc, calls, writes } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list' && params.cursor === null) {
        return {
          data: [{ id: 'newer', cwd: '/repo', preview: 'new task', updatedAt: 1_777_000_000, status: { type: 'idle' } }],
          nextCursor: 'page-2',
        }
      }
      if (method === 'thread/list' && params.cursor === 'page-2') {
        return {
          data: [{ id: 'older', cwd: '/repo', preview: 'old task', updatedAt: 1_776_000_000, status: { type: 'systemError' } }],
          nextCursor: null,
        }
      }
      throw new Error(`unexpected request ${method}`)
    })

    await expect(proc.listConversations()).resolves.toEqual([
      { provider: 'codex', sessionId: 'newer', cwd: '/repo', preview: 'new task', ts: 1_777_000_000_000, status: 'idle' },
      { provider: 'codex', sessionId: 'older', cwd: '/repo', preview: 'old task', ts: 1_776_000_000_000, status: 'systemError' },
    ])
    expect(calls.filter(c => c.method === 'thread/list').map(c => c.params)).toEqual([
      {
        cursor: null,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: '/repo',
      },
      {
        cursor: 'page-2',
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: '/repo',
      },
    ])
    expect(writes).toEqual([{ method: 'initialized' }])
    expect(calls.some(c => c.method === 'thread/start')).toBe(false)
  })

  test('excludes delegated Agent threads from the main rs history', async () => {
    resetAgentSessionRegistryForTest(['codex:delegated'])
    try {
      const { proc } = makeCodexProtocolHarness({}, async (method) => {
        if (method === 'initialize') return {}
        if (method === 'thread/list') return {
          data: [
            { id: 'delegated', cwd: '/repo', preview: 'child work', updatedAt: 2 },
            { id: 'main', cwd: '/repo', preview: 'main work', updatedAt: 1 },
          ],
          nextCursor: null,
        }
        throw new Error(`unexpected request ${method}`)
      })
      await expect(proc.listConversations()).resolves.toEqual([
        { provider: 'codex', sessionId: 'main', cwd: '/repo', preview: 'main work', ts: 1000 },
      ])
    } finally {
      resetAgentSessionRegistryForTest()
    }
  })

  test('surfaces thread/list transport and malformed-response failures', async () => {
    const failed = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') throw new Error('list unavailable')
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(failed.listConversations()).rejects.toThrow('list unavailable')

    const malformed = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') return { nextCursor: null }
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(malformed.listConversations()).rejects.toThrow('no data array')

    const wrongCwd = makeCodexProtocolHarness({}, async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/list') {
        return { data: [{ id: 'wrong', cwd: '/other', preview: 'x', updatedAt: 1 }], nextCursor: null }
      }
      throw new Error(`unexpected request ${method}`)
    }).proc
    await expect(wrongCwd.listConversations()).rejects.toThrow('invalid thread summary')
  })

  test('resolves a legacy resume id through stable thread/read cwd metadata', async () => {
    const { proc, calls } = makeCodexProtocolHarness({}, async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/repo' } }
      throw new Error(`unexpected request ${method}`)
    })
    await expect(proc.readConversationRef('legacy-thread')).resolves.toEqual({
      provider: 'codex', sessionId: 'legacy-thread', cwd: '/repo',
    })
    expect(calls.find(call => call.method === 'thread/read')?.params).toEqual({
      threadId: 'legacy-thread', includeTurns: false,
    })
  })
})

describe('codex rollout incremental reader', () => {
  test('authoritative rollout checks require the exact app-server path to be a readable file', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-rollout-authority-'))
    const file = join(root, 'rollout-thread-1.jsonl')
    const { proc } = makeCodexProtocolHarness()
    delete proc.assertConversationRolloutMaterialized
    proc.conversationRolloutPath = file

    try {
      expect(() => proc.assertConversationRolloutMaterialized('test notification')).toThrow(
        'rollout is not readable',
      )
      writeFileSync(file, '{}\n')
      expect(() => proc.assertConversationRolloutMaterialized('test notification')).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reads only appended bytes and retains an incomplete JSON line', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-rollout-'))
    const file = join(root, 'rollout.jsonl')
    try {
      const proc = Object.create(CodexProcess.prototype) as any
      const seen: any[] = []
      proc.sessionId = 'thread-1'
      proc.rolloutFilePath = file
      proc.rolloutReadOffset = 0
      proc.rolloutLineRemainder = ''
      proc.rolloutDecoder = new StringDecoder('utf8')
      proc.emitRolloutImageGeneration = (payload: any) => { seen.push(payload) }

      const line = JSON.stringify({ payload: { type: 'image_generation_end', call_id: 'img-1' } })
      const split = Math.floor(line.length / 2)
      writeFileSync(file, line.slice(0, split))
      proc.flushRolloutImageGenerations()
      expect(seen).toHaveLength(0)
      expect(proc.rolloutReadOffset).toBe(split)

      appendFileSync(file, line.slice(split) + '\n')
      proc.flushRolloutImageGenerations()
      expect(seen).toEqual([{ type: 'image_generation_end', call_id: 'img-1' }])
      expect(proc.rolloutReadOffset).toBe(Buffer.byteLength(line + '\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('codex process compaction notifications', () => {
  test('detects explicit thread compaction notifications', () => {
    const notice = contextCompactionNoticeFromNotification('thread/compacted', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(notice?.sourceMethod).toBe('thread/compacted')
    expect(notice?.threadId).toBe('thread-1')
    expect(notice?.turnId).toBe('turn-1')
  })

  test('detects Codex event messages persisted as context_compacted', () => {
    const notice = contextCompactionNoticeFromNotification('event_msg', {
      type: 'context_compacted',
    })

    expect(notice?.sourceMethod).toBe('event_msg')
    expect(notice?.sourceType).toBe('context_compacted')
    expect(notice?.phase).toBe('end')
  })

  test('detects raw compacted records with replacement history', () => {
    const notice = contextCompactionNoticeFromMessage({
      timestamp: '2026-06-03T16:03:16.331Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
    })

    expect(notice?.sourceMethod).toBe('compacted')
    expect(notice?.sourceType).toBe('compacted')
    expect(notice?.phase).toBe('start')
    expect(notice?.timestamp).toBe('2026-06-03T16:03:16.331Z')
    expect(notice?.replacement_history).toHaveLength(1)
  })

  test('detects raw response compaction items', () => {
    const notice = contextCompactionNoticeFromNotification('rawResponseItem/completed', {
      item: {
        type: 'contextCompaction',
        id: 'item-1',
      },
      threadId: 'thread-2',
    })

    expect(notice?.sourceMethod).toBe('rawResponseItem/completed')
    expect(notice?.sourceType).toBe('contextCompaction')
    expect(notice?.phase).toBe('end')
    expect(notice?.itemId).toBe('item-1')
    expect(notice?.threadId).toBe('thread-2')
  })

  test('marks live app-server context compaction item start and completion', () => {
    const started = contextCompactionNoticeFromNotification('item/started', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })
    const completed = contextCompactionNoticeFromNotification('item/completed', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
        replacementHistory: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })

    expect(started?.phase).toBe('start')
    expect(started?.itemId).toBe('compact-1')
    expect(started?.threadId).toBe('thread-3')
    expect(completed?.phase).toBe('end')
    expect(completed?.itemId).toBe('compact-1')
    expect(completed?.replacementHistory).toHaveLength(1)
  })

  test('ignores unrelated notifications', () => {
    expect(contextCompactionNoticeFromNotification('thread/settings/updated', {
      threadSettings: { model: 'gpt-5' },
    })).toBeNull()
  })

  test('unmapped app-server notifications are logged without breaking message handling', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const raw: unknown[] = []
    const compacted: unknown[] = []
    proc.opts = { workDir: '/tmp' }
    proc.emit = (event: string, payload: unknown) => {
      if (event === 'raw') raw.push(payload)
      if (event === 'context_compacted') compacted.push(payload)
      return true
    }

    expect(() => proc.handleNotification('item/started', {
      item: { type: 'contextCompaction', id: 'compact-2' },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    expect(() => proc.handleNotification('thread/status/changed', {
      threadId: 'thread-4',
      status: { type: 'idle' },
    })).not.toThrow()
    expect(() => proc.handleNotification('item/started', {
      item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    // reasoning item 走 UNMAPPED log(不 emit raw);thread/status/changed 已被
    // 子 agent 状态机消费(exec-cell 编排的终态信号),不再落 raw。
    expect(raw).toHaveLength(0)
    expect(compacted).toHaveLength(1)
  })

  test('retains the completed image prompt when the start event has no prompt', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.emittedImageGenerationIds = new Set()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    proc.handleNotification('item/started', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'inProgress',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'completed',
        revised_prompt: 'A cute cat curled up in a sunbeam.',
        saved_path: '/tmp/cat.png',
        result: 'ignored when saved_path exists',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })

    expect(events).toEqual([
      ['tool_use', {
        id: 'img-1',
        name: 'ImageGeneration',
        input: {
          status: 'inProgress',
          revisedPrompt: undefined,
        },
      }],
      ['tool_result', {
        tool_use_id: 'img-1',
        content: '/tmp/cat.png',
        is_error: false,
        input: { status: 'completed', revisedPrompt: 'A cute cat curled up in a sunbeam.' },
      }],
    ])
  })

  test('materializes inline base64 image generation results to a sendable file path', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imggen-'))
    try {
      const output = imageGenerationOutput({
        call_id: 'ig-inline',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      }, 'thread-inline', root)

      expect(output).toBe(join(root, 'thread-inline', 'ig-inline.png'))
      expect(readFileSync(output).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('codex token usage helpers', () => {
  test('parses app-server token usage payloads for last and total snapshots', () => {
    expect(usageFromTokenUsagePayload({
      totalTokens: 1200,
      inputTokens: 900,
      outputTokens: 300,
      reasoningOutputTokens: 220,
      cachedInputTokens: 400,
    })).toEqual({
      total_tokens: 1200,
      input_tokens: 900,
      output_tokens: 300,
      reasoning_output_tokens: 220,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 400,
    })
  })

  test('computes turn aggregate from absolute thread totals', () => {
    const usage = diffUsageTotals(
      {
        total_tokens: 10_000,
        input_tokens: 7_000,
        output_tokens: 3_000,
        reasoning_output_tokens: 1_200,
        cache_read_input_tokens: 2_800,
      },
      {
        total_tokens: 4_000,
        input_tokens: 3_100,
        output_tokens: 900,
        reasoning_output_tokens: 500,
        cache_read_input_tokens: 1_200,
      },
    )

    expect(usage).toEqual({
      total_tokens: 6000,
      input_tokens: 3900,
      output_tokens: 2100,
      reasoning_output_tokens: 700,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 1600,
    })
    expect(effectiveTurnTokens(usage)).toBe(6000)
    expect(effectiveTurnTokens({ total_tokens: 1234 })).toBe(1234)
    expect(effectiveTurnTokens(null)).toBeNull()
  })

  test('clamps negative deltas and treats missing totals as unknown', () => {
    expect(diffUsageTotals(
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 120, output_tokens: 10 },
    )).toEqual({
      total_tokens: undefined,
      input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    })
    expect(diffUsageTotals(null, null)).toBeNull()
  })
})

describe('codex collab agent translation (ultra multi-agent)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subAgentActivity started → bg_task_started + promoted; completed terminal via collabAgentToolCall → bg_task_settled', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_1',
        kind: 'started',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/order_schema/official_history_orders',
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const bgEvents = events.filter(([e]) => e.startsWith('bg_task'))
    expect(bgEvents).toEqual([
      ['bg_task_started', {
        task_id: 'agent-thread-1',
        task_type: 'local_agent',
        description: 'official_history_orders',
        prompt: undefined,
      }],
      ['bg_task_updated', {
        task_id: 'agent-thread-1',
        patch: { is_backgrounded: true },
      }],
    ])

    // wait 调用携带 agentsStates:running → updated;completed(message)→ settled。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_2',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-1',
      status: 'completed',
      summary: '调查结论:可以改',
    }]])

    // 同 agent 的后续 wait item 重复携带终态 → 不重复结算、不翻活。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_3',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
  })

  test('spawnAgent emits one Agent tool panel (started) and closes it once (completed)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        prompt: '调查 history_orders 接口',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // spawn started:一个 Agent tool_use + bg_task_started/promoted(先于 subAgentActivity)
    const toolUses = events.filter(([e]) => e === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0][1].name).toBe('Agent')
    expect(toolUses[0][1].input.description).toBe('派生 1 个子 agent')

    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // completed 不再补 tool_use,只补 tool_result 关面板。
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
    const results = events.filter(([e]) => e === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0][1].tool_use_id).toBe('spawn-1')
    expect(results[0][1].content).toContain('agent-thread-2: running')
  })

  test('pure orchestration calls (wait/sendInput/closeAgent) emit no tool panels', () => {
    const { proc, events } = makeProc()
    for (const tool of ['wait', 'sendInput', 'resumeAgent', 'closeAgent']) {
      proc.handleNotification('item/started', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'inProgress', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
      proc.handleNotification('item/completed', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'completed', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
    }
    expect(events.filter(([e]) => e === 'tool_use' || e === 'tool_result')).toHaveLength(0)
  })

  test('errored agent settles as failed; unknown orchestration items stay out of UNHANDLED noise', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_9',
        kind: 'started',
        agentThreadId: 'agent-thread-3',
        agentPath: '/root/fix_bug',
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_10',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-thread-3': { status: 'errored', message: 'context window exceeded' } },
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-3',
      status: 'failed',
      summary: 'context window exceeded',
    }]])
    expect(events.filter(([e]) => e === 'raw')).toHaveLength(0)
  })
})

describe('codex collab followup reactivation', () => {
  test('settled agent re-runs via followup: revive then settle again', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    const startedItem = {
      type: 'subAgentActivity',
      id: 'call_a',
      kind: 'started',
      agentThreadId: 'agent-r',
      agentPath: '/root/final_review',
    }
    proc.handleNotification('item/started', { item: startedItem, threadId: 'm', turnId: 't' })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w1',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '初审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)

    // followup_task:agent 重新 running → 补 started+promote 让沉降后已清空的
    // entry 重新入池,running patch 翻活墓碑。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w2',
        tool: 'sendInput',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const tail = events.filter(([e]) => e.startsWith('bg_task')).slice(-3)
    expect(tail.map(([e]) => e)).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_updated'])
    expect(tail[0][1].description).toBe('final_review')
    expect(tail[2][1].patch).toEqual({ status: 'running' })

    // 第二次完成 → 重新结算,summary 换新。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w3',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '复审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toHaveLength(2)
    expect(settled[1][1].summary).toBe('复审完成')
  })
})

describe('codex collab closeAgent and terminal-first edge cases', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('closeAgent settles receivers as stopped even when snapshot says running', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa1', kind: 'started',
        agentThreadId: 'ag-1', agentPath: '/root/worker',
      },
      threadId: 'm', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'c1', tool: 'closeAgent', status: 'completed',
        receiverThreadIds: ['ag-1'],
        agentsStates: { 'ag-1': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-1', status: 'stopped' }]])
  })

  test('terminal-first agent: started+promoted+settled in one item, no running patch after settle', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w9', tool: 'wait', status: 'completed',
        receiverThreadIds: ['ag-fast'],
        agentsStates: { 'ag-fast': { status: 'completed', message: '秒完' } },
      },
      threadId: 'm', turnId: 't',
    })
    const kinds = events.filter(([e]) => e.startsWith('bg_task')).map(([e]) => e)
    expect(kinds).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_settled'])
  })

  test('spawn-first uses placeholder name; subAgentActivity later patches real name', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp1', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-2'], prompt: 'gAAAAABciphertext',
        agentsStates: { 'ag-2': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const firstStarted = events.find(([e]) => e === 'bg_task_started')!
    expect(firstStarted[1].description).toBe('子 agent')
    expect(firstStarted[1].prompt).toBe('(继承主线程历史的密文任务书)')

    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa2', kind: 'started',
        agentThreadId: 'ag-2', agentPath: '/root/etl/orders',
      },
      threadId: 'm', turnId: 't',
    })
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds).toHaveLength(2)
    expect(starteds[1][1].description).toBe('orders')
  })
})

describe('codex subagent item filtering (main-card cleanliness)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subagent-thread commandExecution becomes subagent_step, not tool_use', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', cwd: '/tmp' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', aggregatedOutput: '3 passed', exitCode: 0 },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(0)
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(2)
    expect(steps[0][1]).toMatchObject({ thread_id: 'sub-thread-1', tool: 'Bash', phase: 'started' })
    expect(steps[1][1]).toMatchObject({
      thread_id: 'sub-thread-1', tool: 'Bash', phase: 'completed', brief: '→ 3 passed',
    })
  })

  test('subagent Bash step brief unwraps PowerShell-wrapped desc command', () => {
    // Windows 上 Codex 把命令包进 powershell.exe 调用,子 agent 后台卡 steps
    // 的 brief 也要显示中文说明,不显示 powershell.exe 路径。
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'commandExecution', id: 'exec-ps', cwd: 'C:\\repo',
        command: `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command '# desc: 查看模板目录状态\nGet-ChildItem "C:\\repo\\templates" -Recurse'`,
      },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(1)
    expect((steps[0][1] as any).brief).toBe('查看模板目录状态')
  })

  test('subagent agentMessage does not leak into main assistant stream', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-sub', text: '子 agent 阶段性输出' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(0)
    // 主线程的 agentMessage 不受影响
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-main', text: '主线程正文' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(1)
  })

  test('main-thread commandExecution still emits tool_use (unchanged behavior)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-2', command: 'ls', cwd: '/tmp' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
  })
})

describe('codex subagent step filtering', () => {
  test('reasoning items produce no subagent_step (step budget reserved for tools)', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    for (const phase of ['item/started', 'item/completed'] as const) {
      proc.handleNotification(phase, {
        item: { type: 'reasoning', id: 'rs-1', summary: [], content: ['思考中…'] },
        threadId: 'sub-thread-1',
        turnId: 't',
      })
    }
    // reasoning 完成也不出 step
    expect(events.filter(([e]) => e === 'subagent_step')).toHaveLength(0)
  })
})

describe('codex exec-cell orchestration via thread/status/changed', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('idle(create)→active→idle(complete) settles as completed; create-idle does not', () => {
    const { proc, events } = makeProc()
    // spawn 信号(subAgentActivity)先到
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-x', agentPath: '/root/etl' },
      threadId: 'main-thread', turnId: 't',
    })
    // 创建态 idle:不结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(0)
    // active:running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'active', activeFlags: [] } })
    // 完成态 idle:结算 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-x', status: 'completed' }]])
  })

  test('revive after idle: second active re-enters pool and settles again', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-y', agentPath: '/root/rev' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    // 复活:followup 再拉起 → settled 清除,重新入池 running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    const revived = events.filter(([e]) => e === 'bg_task_settled')
    expect(revived).toHaveLength(1) // 尚未第二次 idle
    const lastStarted = events.filter(([e]) => e === 'bg_task_started').at(-1)!
    expect(lastStarted[1].description).toBe('rev')
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(2)
  })

  test('main-thread and unknown-thread status changes are ignored', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('thread/status/changed', { threadId: 'main-thread', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'unknown-ag', status: { type: 'active' } })
    expect(events.filter(([e]) => e.startsWith('bg_task'))).toHaveLength(0)
  })
})

describe('codex review-round-3 fixes', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('child turn/completed does not emit main result (entry-level threadId filter)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('turn/completed', {
      threadId: 'sub-thread',
      turn: { id: 'turn-sub', status: 'completed', durationMs: 1000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(0)
    // 主线程 turn 照常
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-main', status: 'completed', durationMs: 2000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(1)
  })

  test('child agentMessage/delta does not emit assistant_text', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'sub-thread', turnId: 't', itemId: 'msg-sub', delta: '子agent输出',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(0)
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'main-thread', turnId: 't', itemId: 'msg-main', delta: '主线程正文',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(1)
  })

  test('child tokenUsage does not overwrite main-thread usage', () => {
    const { proc, events } = makeProc()
    proc.lastUsage = { total_tokens: 999 }
    proc.handleNotification('thread/tokenUsage/updated', {
      threadId: 'sub-thread', turnId: 't',
      tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: 2 } },
    })
    expect(events.filter(([e]) => e === 'token_usage')).toHaveLength(0)
    expect(proc.lastUsage.total_tokens).toBe(999)
  })

  test('systemError settles as failed; agentMessage text becomes settle summary', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-e', agentPath: '/root/review' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'm1', text: '审查结论:发现 2 处问题' },
      threadId: 'ag-e', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'systemError' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'ag-e', status: 'failed', summary: '审查结论:发现 2 处问题',
    }]])
  })

  test('authoritative agentsStates terminal corrects fallback completed into failed', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-c', agentPath: '/root/x' },
      threadId: 'main-thread', turnId: 't',
    })
    // idle 兜底先结算成 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'idle' } })
    // 权威 agentsStates 随后带 errored → 墓碑纠正为 failed,不翻活
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w', tool: 'wait', status: 'completed',
        agentsStates: { 'ag-c': { status: 'errored', message: 'boom' } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
    const corrections = events.filter(([e, p]) => e === 'bg_task_updated' && (p as any).patch?.status === 'failed')
    expect(corrections).toHaveLength(1)
    expect((corrections[0][1] as any).patch.error).toBe('boom')
  })

  test('late subAgentActivity name patch does not revive a settled task', () => {
    const { proc, events } = makeProc()
    // spawn-first 占位
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-l'], agentsStates: { 'ag-l': { status: 'running', message: null } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    // 结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'idle' } })
    const settledBefore = events.filter(([e]) => e === 'bg_task_settled').length
    // 晚到的 subAgentActivity(started)带真名 —— 只改 map,不发 started(不复活)
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa-late', kind: 'started', agentThreadId: 'ag-l', agentPath: '/root/real_name' },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled').length).toBe(settledBefore)
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds.length).toBe(1) // 只有 spawn-first 那次
  })
})
