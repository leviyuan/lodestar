import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentWorkerFailure, collectAgentTurn } from './agent-runner'
import { ClaudeAgentProcess } from './claude-agent-process'
import { ClaudeTranslationContext } from './claude-translation-context'

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
  test('only visible worker prose and progress enter translation and conversation history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-presentation-context-'))
    const context = new ClaudeTranslationContext({ workDir: tmpdir(), storeDir: directory })
    await context.initialize(new AbortController().signal)
    context.bindSession('worker-presentation-session')
    const translated: string[] = [], progress: any[] = [], nativeResults: string[] = []
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', tokenSourceId: 'claude-sub', translationContext: context,
      translation: {
        toEnglish: async text => text,
        toChinese: async text => { translated.push(text); return `ZH:${text}` },
        toChineseFields: async fields => { translated.push(...fields); return fields.map(text => `ZH:${text}`) },
      },
    }) as any
    proc.translationContextInitialized = true
    proc.sessionId = 'worker-presentation-session'
    proc.sendInitialize = () => {}
    proc.sendUserText = () => {}
    proc.kill = async () => { proc.alive = false }
    proc.on('tool_result', (event: { content: string }) => nativeResults.push(event.content))
    const handle = collectAgentTurn(proc, 'Task', { onProgress: step => progress.push(step) }, () => {})
    try {
      await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'hidden-child', parent_tool_use_id: 'native-parent',
        message: { content: [{ type: 'text', text: 'HIDDEN_CHILD_PROSE' }] } })
      await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'worker-tool', message: { content: [
        { type: 'tool_use', id: 'native-tool', name: 'Agent', input: { description: 'Visible progress', prompt: 'HIDDEN_TOOL_PROMPT' } },
      ] } })
      await proc.handleTranslatedMessage({ type: 'user', uuid: 'hidden-result', message: { content: [
        { type: 'tool_result', tool_use_id: 'native-tool', content: 'HIDDEN_TOOL_RECEIPT' },
      ] } })
      await proc.handleTranslatedMessage({ type: 'user', uuid: 'hidden-unseen-result', message: { content: [
        { type: 'tool_result', tool_use_id: 'unseen-native-tool', content: 'HIDDEN_UNSEEN_TOOL_RECEIPT' },
      ] } })
      await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_started', task_id: 'child-task',
        description: 'HIDDEN_BACKGROUND_DESCRIPTION', prompt: 'HIDDEN_BACKGROUND_PROMPT' })
      await proc.handleTranslatedMessage({ type: 'user', isMeta: true, promptSource: 'sdk', uuid: 'hidden-schedule',
        message: { content: 'HIDDEN_SCHEDULED_PROMPT' } })
      await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'visible-answer',
        message: { content: [{ type: 'text', text: 'Visible answer' }] } })
      proc.emit('result', { is_error: false })
      expect(await handle.done).toMatchObject({ output: 'Visible answer', displayOutput: 'ZH:Visible answer' })
      expect(progress).toContainEqual(expect.objectContaining({ phase: 'started', detail: 'Visible progress', displayDetail: 'ZH:Visible progress' }))
      expect(progress).toContainEqual(expect.objectContaining({ phase: 'completed', detail: '' }))
      expect(nativeResults).toEqual(['HIDDEN_TOOL_RECEIPT', 'HIDDEN_UNSEEN_TOOL_RECEIPT'])
      expect(translated).toEqual(['Visible progress', 'Visible answer'])
      const history = JSON.stringify(context.snapshot())
      expect(history).toContain('Visible progress')
      expect(history).toContain('Visible answer')
      expect(history).not.toContain('HIDDEN_')
    } finally {
      await handle.cancel()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each(['glm', 'claude-sub'])('nontranslated %s workers do not install a presentation policy', async source => {
    const proc = new FakeProcess() as any
    proc.tokenSourceId = source
    proc.translationEnabled = false
    let installed = false
    proc.setTranslationPresentationPolicy = () => { installed = true }
    const handle = collectAgentTurn(proc, 'Task', {}, () => {})
    expect(installed).toBe(false)
    proc.emit('assistant_text', { text: 'Native output', parentToolUseId: null })
    proc.emit('result', { is_error: false })
    expect(await handle.done).toMatchObject({ output: 'Native output' })
  })

  test('delegation returns native prose and question keys while the UI has translations', async () => {
    const proc = new FakeProcess() as any
    proc.tokenSourceId = 'claude-sub'
    proc.translationEnabled = true
    const displayed: unknown[] = []
    const handle = collectAgentTurn(proc, 'work', { onNeedsInput: (_request, display) => displayed.push(display) }, () => {})
    const originalInput = { questions: [{ question: 'Which test?', options: [{ label: 'Unit test' }] }] }
    proc.emit('assistant_text', { text: 'Ready.', displayText: '已准备好。', parentToolUseId: null })
    proc.emit('can_use_tool', { request_id: 'q-translated', tool_name: 'AskUserQuestion', originalInput,
      input: { questions: [{ question: '选择哪种测试？', options: [{ label: '单元测试' }] }] } })
    expect(handle.pendingInput()?.questions[0]?.question).toBe('Which test?')
    expect(handle.displayPendingInput?.()?.questions[0]).toMatchObject({ id: 'Which test?', question: '选择哪种测试？' })
    expect(displayed).toEqual([handle.displayPendingInput?.()])
    handle.answer('q-translated', { 'Which test?': 'Unit test' })
    expect(proc.permissionResponses[0][2].updatedInput).toEqual({ ...originalInput, answers: { 'Which test?': 'Unit test' } })
    proc.emit('result', { is_error: false })
    expect(await handle.done).toMatchObject({ output: 'Ready.', displayOutput: '已准备好。' })
    expect(handle.displayPendingInput?.()).toBeNull()
  })

  test.each(['claude-sub', 'glm'])('%s translation display context precedes native submission', async source => {
    const proc = new FakeProcess() as any
    proc.tokenSourceId = source
    proc.translationEnabled = true
    let complete!: (texts: string[]) => void
    const fields: unknown[] = []
    const contexts: unknown[] = []
    proc.translateDisplayFields = (texts: string[], _signal: AbortSignal, acceptDisplay: (fields: string[]) => boolean) => {
      fields.push(texts)
      return new Promise<string[]>(resolve => { complete = translated => { acceptDisplay(translated); resolve(translated) } })
    }
    const handle = collectAgentTurn(proc, 'Inspect API', { onDisplayContext: value => { contexts.push(value) } }, () => {}, undefined,
      true, { description: 'Inspect API', prompt: 'Inspect API' })
    expect(proc.initialized).toBe(true)
    expect(proc.prompts).toEqual([])
    expect(fields).toEqual([['Inspect API', 'Inspect API']])
    complete(['检查接口', '检查接口'])
    await Promise.resolve()
    expect(contexts).toEqual([{ description: '检查接口', prompt: '检查接口' }])
    expect(proc.prompts).toEqual(['Inspect API'])
    expect(proc.tokenSourceId).toBe(source)
    proc.emit('result', { is_error: false })
    await handle.done
  })

  test('cancelling display-context translation prevents a late native task submission', async () => {
    const proc = new FakeProcess() as any
    proc.tokenSourceId = 'claude-sub'
    proc.translationEnabled = true
    let complete!: (texts: string[]) => void
    let signal!: AbortSignal
    proc.translateDisplayFields = (_texts: string[], supplied: AbortSignal) => {
      signal = supplied
      return new Promise<string[]>(resolve => { complete = resolve })
    }
    const contexts: unknown[] = []
    const handle = collectAgentTurn(proc, 'Inspect API', { onDisplayContext: value => { contexts.push(value) } }, () => {}, undefined,
      true, { description: 'Inspect API', prompt: 'Inspect API' })
    const failure = handle.done.catch(error => error)
    await handle.cancel()
    complete(['检查接口', '检查接口'])
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(proc.prompts).toEqual([])
    expect(contexts).toEqual([])
    expect(await failure).toBeInstanceOf(AgentWorkerFailure)
  })

  test.each(['accepted', 'rejected', 'thrown', 'cancelled', 'unobserved'] as const)(
    'delegated display context joins history only after acceptance: %s', async outcome => {
      const directory = mkdtempSync(join(tmpdir(), 'worker-display-history-'))
      const context = new ClaudeTranslationContext({ workDir: tmpdir(), storeDir: directory })
      await context.initialize(new AbortController().signal)
      context.bindSession(`worker-display-${outcome}`)
      let complete!: (texts: string[]) => void
      let translationStarted!: () => void
      const started = new Promise<void>(resolve => { translationStarted = resolve })
      const nativePrompts: string[] = [], displayed: unknown[] = []
      const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', tokenSourceId: 'claude-sub',
        translationContext: context, translation: {
          toEnglish: async text => text,
          toChinese: async text => text,
          toChineseFields: async () => {
            translationStarted()
            return new Promise<string[]>(resolve => { complete = resolve })
          },
        },
      }) as any
      proc.translationContextInitialized = true
      proc.sessionId = `worker-display-${outcome}`
      proc.sendInitialize = () => {}
      proc.sendUserText = (text: string) => { nativePrompts.push(text) }
      proc.kill = async () => { proc.alive = false }
      let finishTranslation!: () => void
      const translated = new Promise<void>(resolve => { finishTranslation = resolve })
      const translateDisplayFields = proc.translateDisplayFields.bind(proc)
      proc.translateDisplayFields = async (...args: any[]) => {
        try { return await translateDisplayFields(...args) }
        finally { finishTranslation() }
      }
      const handle = collectAgentTurn(proc, 'Inspect electric charge', outcome === 'unobserved' ? {} : {
        onDisplayContext: value => {
          expect(context.snapshot().entries).toEqual([])
          displayed.push(value)
          if (outcome === 'thrown') throw new Error('Display state rejected the task')
          return outcome !== 'rejected'
        },
      }, () => {}, undefined, true, { description: 'Inspect charge', prompt: 'Inspect electric charge' })
      const done = handle.done.catch(error => error)
      try {
        await started
        if (outcome === 'cancelled') await handle.cancel()
        complete(['检查电荷', '检查电荷计算'])
        await translated
        // The runner submits native input in the continuation after this boundary.
        await Promise.resolve()
        if (outcome === 'accepted' || outcome === 'unobserved') {
          expect(nativePrompts).toEqual(['Inspect electric charge'])
          proc.emit('result', { is_error: false })
          await done
        } else {
          expect(await done).toBeInstanceOf(AgentWorkerFailure)
          expect(nativePrompts).toEqual([])
        }
        const entries = context.snapshot().entries
        if (outcome === 'accepted') {
          expect(entries).toHaveLength(1)
          expect(entries[0]).toMatchObject({
            original: 'Inspect charge\n\nInspect electric charge', translated: '检查电荷\n\n检查电荷计算',
            origin: 'Caller → delegated Claude Code agent, also shown to the Feishu user: delegated task request.',
          })
        } else expect(entries).toEqual([])
        expect(displayed).toHaveLength(outcome === 'cancelled' || outcome === 'unobserved' ? 0 : 1)
      } finally {
        await handle.cancel()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  test('translation-enabled output without verified presentation fails without exposing raw text on the card', async () => {
    const proc = new FakeProcess() as any
    proc.tokenSourceId = 'claude-sub'
    proc.translationEnabled = true
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    proc.emit('assistant_text', { text: 'Unverified prose' })
    const error = await handle.done.catch(error => error)
    expect(error).toBeInstanceOf(AgentWorkerFailure)
    expect(error.message).toContain('missing verified translation')
    expect(error.output).toBe('Unverified prose')
    expect(error.displayOutput).toBe('')
  })

  test('translated descriptions reach progress without changing or exposing executed commands', async () => {
    const proc = new FakeProcess() as any
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'work', { onProgress: step => progress.push(step) }, () => {})
    proc.emit('tool_use', { name: 'Bash', input: { command: '# desc: Inspect files\ncat .env' },
      displayInput: { command: '# desc: Inspect files\ncat .env', __displayDescription: '检查文件' } })
    proc.emit('tool_use', { name: 'Agent', input: { description: 'Inspect API', prompt: 'secret' },
      displayInput: { description: '检查接口', prompt: 'secret' } })
    expect(progress.map(step => step.detail)).toEqual(['Inspect files', 'Inspect API'])
    expect(progress.map(step => step.displayDetail)).toEqual(['检查文件', '检查接口'])
    expect(JSON.stringify(progress)).not.toContain('secret')
    expect(JSON.stringify(progress)).not.toContain('cat .env')
    proc.emit('result', { is_error: false })
    await handle.done
  })

  test('failure preserves verified partial output and error separately from native diagnostics', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'work', {}, () => {})
    proc.emit('assistant_text', { text: 'Partial result', displayText: '部分结果' })
    proc.emit('result', { is_error: true, error: 'Request failed', displayError: '请求失败' })
    const failure = await handle.done.catch(error => error)
    expect(failure).toMatchObject({ output: 'Partial result', displayOutput: '部分结果', message: 'Request failed', displayError: '请求失败' })
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
