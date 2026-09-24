import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { AgentWorkerFailure, collectAgentTurn } from './agent-runner'

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

describe('full delegated Agent runner', () => {
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

  test('capacity backoff reports progress without imposing a turn deadline or changing output', async () => {
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
      const retry = { phase: 'waiting', attempt: 1, delayMs: 60_000, message: 'Selected model is at capacity' }
      proc.emit('turn_retry', retry)
      expect(timers.size).toBe(0)
      expect(proc.alive).toBe(true)
      expect(progress.at(-1).detail).toContain(retry.message)
      proc.emit('turn_retry', { ...retry, phase: 'retrying', delayMs: 0 })
      expect(timers.size).toBe(0)
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
