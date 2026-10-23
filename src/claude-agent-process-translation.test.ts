import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ClaudeAgentProcess } from './claude-agent-process'
import { NothingToCompactError } from './agent-process'
import type { ClaudeTranslation } from './claude-translation'
import { CLAUDE_TRANSLATION_ORIGINS, ClaudeTranslationContext } from './claude-translation-context'
import * as agentUpdates from './agent-updates'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const contextDirectories: string[] = []

afterEach(() => {
  for (const directory of contextDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function attachContext(proc: any): Promise<ClaudeTranslationContext> {
  const storeDir = mkdtempSync(join(tmpdir(), 'claude-process-translation-history-'))
  contextDirectories.push(storeDir)
  const context = new ClaudeTranslationContext({ workDir: proc.opts.workDir, storeDir })
  await context.initialize(new AbortController().signal)
  context.bindSession('boundary-session')
  proc.opts.translationContext = context
  proc.translationContextInitialized = true
  return context
}
const defaultTranslation: ClaudeTranslation = {
  toEnglish: async text => `EN:${text}`,
  toChinese: async text => `ZH:${text}`,
  toChineseFields: async fields => fields.map(text => `ZH:${text}`),
}

function running(translation: ClaudeTranslation = defaultTranslation) {
  const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', translation }) as any
  proc.started = true
  proc.query = { interrupt: async () => ({ still_queued: [] }) }
  const results: any[] = [], errors: any[] = [], texts: any[] = [], exits: any[] = []
  proc.on('result', (event: any) => results.push(event))
  proc.on('error', (event: any) => errors.push(event))
  proc.on('assistant_text', (event: any) => texts.push(event))
  proc.on('exit', (event: any) => exits.push(event))
  return { proc, results, errors, texts, exits }
}

const assistant = (text: string) => ({ type: 'assistant', uuid: 'assistant-1',
  message: { content: [{ type: 'text', text }] } })
const result = (extra = {}) => ({ type: 'result', subtype: 'success', duration_ms: 1, num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 }, ...extra })

describe('Claude host conversation translation', () => {
  test('card metadata does not enter conversation history and the actual prompt is recorded only as user input', async () => {
    const { proc } = running()
    const context = await attachContext(proc)
    expect(await proc.translateDisplayFields(['Caller description', 'Actual task prompt'])).toEqual([
      'ZH:Caller description', 'ZH:Actual task prompt',
    ])
    expect(context.snapshot().entries).toEqual([])
    proc.sendUserText('Actual task prompt')
    await tick()
    const submitted = proc.input.items[0]
    await proc.handleTranslatedMessage({ type: 'user', uuid: submitted.uuid,
      message: { content: [{ type: 'text', text: submitted.message.content[0].text }] } })
    const entries = context.snapshot().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ role: 'user', status: 'consumed' })
    expect(entries[0]).toMatchObject({ original: 'Actual task prompt', translated: 'EN:Actual task prompt' })
    expect(JSON.stringify(context.snapshot())).not.toContain('Caller description')
  })

  test('keeps translation history bound to its main native session', async () => {
    const { proc } = running()
    const context = await attachContext(proc)
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'init', session_id: 'boundary-session' })
    await proc.handleTranslatedMessage({ ...assistant('Child progress'), session_id: 'child-session', parent_tool_use_id: 'child-tool' })
    expect(context.snapshot().sessionId).toBe('boundary-session')
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'init', session_id: 'wrong-main-session' })
    expect(proc.translationContextFailure?.message).toContain('session mismatch')
  })

  test('conversation history records submitted user text and verified presentation without host or native context', async () => {
    const inputTranslations: string[] = []
    const { proc } = running({ ...defaultTranslation, toEnglish: async text => {
      inputTranslations.push(text)
      return `EN:${text}`
    } })
    const context = await attachContext(proc)
    const hostPolicy = 'HOST_POLICY_PRIVATE_MARKER 宿主交付约定：保留原文\n\n'
    proc.sendUserText('Keep the capacitor charge.', ['/tmp/source-code.ts'], { contextPrefix: hostPolicy })
    await tick()
    const submitted = proc.input.items[0]
    expect(submitted.message.content[0].text).toStartWith(hostPolicy)
    expect(inputTranslations).toEqual(['Keep the capacitor charge.'])
    expect(context.snapshot().entries[0]?.status).toBe('pending')
    await proc.handleTranslatedMessage({ type: 'user', uuid: submitted.uuid,
      message: { content: [{ type: 'text', text: 'NATIVE_ECHO_MUST_NOT_REPLACE_USER_INPUT' }] } })
    expect(context.snapshot().entries[0]?.status).toBe('consumed')
    await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'boundary-output', message: { content: [
      { type: 'thinking', thinking: 'PRIVATE_REASONING_MARKER' },
      { type: 'text', text: 'The charge is stable.\n```ts\nconst PRIVATE_SOURCE_MARKER = 1\n```' },
      { type: 'tool_use', id: 'boundary-command', name: 'Bash', input: { command: '# desc: Inspect the capacitor\nprintf PRIVATE_COMMAND_MARKER' } },
      { type: 'tool_use', id: 'boundary-read', name: 'Read', input: { file_path: '/tmp/PRIVATE_PATH_MARKER.ts' } },
    ] } })
    await proc.handleTranslatedMessage({ type: 'user', isMeta: true,
      message: { content: [{ type: 'text', text: 'INTERNAL_USER_MARKER' },
        { type: 'tool_result', tool_use_id: 'boundary-command', content: 'PRIVATE_STDOUT_MARKER' },
        { type: 'tool_result', tool_use_id: 'boundary-read', content: 'PRIVATE_FILE_CONTENT_MARKER' }] } })
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'unrecognized_internal_event', description: 'PRIVATE_SYSTEM_MARKER' })
    const history = JSON.stringify(context.snapshot())
    expect(history).toContain('Keep the capacitor charge.')
    expect(history).toContain('EN:Keep the capacitor charge.')
    expect(history).toContain('The charge is stable.')
    expect(history).toContain('ZH:The charge is stable.')
    expect(history).toContain('Inspect the capacitor')
    expect(history).toContain('ZH:Inspect the capacitor')
    for (const hidden of ['HOST_POLICY_PRIVATE_MARKER', 'NATIVE_ECHO_MUST_NOT_REPLACE_USER_INPUT',
      'PRIVATE_REASONING_MARKER', 'PRIVATE_SOURCE_MARKER', 'PRIVATE_COMMAND_MARKER', 'PRIVATE_PATH_MARKER',
      'INTERNAL_USER_MARKER', 'PRIVATE_STDOUT_MARKER', 'PRIVATE_FILE_CONTENT_MARKER', 'PRIVATE_SYSTEM_MARKER']) {
      expect(history).not.toContain(hidden)
    }
  })

  test('a cancelled pending output never enters displayed conversation history', async () => {
    const translation = deferred<string>()
    const { proc, texts } = running({ ...defaultTranslation, toChinese: () => translation.promise })
    const context = await attachContext(proc)
    const rendering = proc.handleTranslatedMessage(assistant('Cancelled reply'))
    await tick()
    expect(context.snapshot().entries).toEqual([])
    proc.sendInterrupt()
    translation.resolve('已取消的迟到回复')
    await rendering
    expect(texts).toEqual([])
    expect(context.snapshot().entries).toEqual([])
  })

  test('only a translated native submission commits input and creates a pending native turn', async () => {
    const translation = deferred<string>()
    const { proc } = running({ ...defaultTranslation, toEnglish: () => translation.promise })
    const submitted: any[] = []
    proc.on('user_input_submitted', (event: any) => {
      submitted.push(event)
      expect(proc.input.items).toHaveLength(1)
      expect(proc.hasPendingNativeTurn()).toBe(true)
    })
    expect(proc.hasPendingNativeTurn()).toBe(false)
    proc.sendUserText('pending translation')
    await tick()
    expect(proc.hasPendingNativeTurn()).toBe(false)
    expect(submitted).toEqual([])
    translation.resolve('Translated input')
    await tick()
    expect(submitted).toEqual([{}])
    expect(proc.hasPendingNativeTurn()).toBe(true)
    proc.sendInterrupt()
    expect(proc.hasPendingNativeTurn()).toBe(true)
    proc.handleMessage(result())
    expect(proc.hasPendingNativeTurn()).toBe(false)
  })

  test('stop before translation submission neither commits input nor invents a native pending turn', async () => {
    const translation = deferred<string>()
    const { proc, results } = running({ ...defaultTranslation, toEnglish: () => translation.promise })
    const submitted: any[] = []
    proc.on('user_input_submitted', (event: any) => submitted.push(event))
    proc.sendUserText('pending translation')
    await tick()
    proc.sendInterrupt()
    expect(proc.hasPendingNativeTurn()).toBe(false)
    translation.resolve('Cancelled input')
    await tick()
    expect(proc.hasPendingNativeTurn()).toBe(false)
    expect(submitted).toEqual([])
    expect(results).toEqual([])
  })

  test('native results clear pending state even when a translated steering input defers settlement', async () => {
    const translation = deferred<string>()
    const { proc, results } = running({ ...defaultTranslation, toEnglish: () => translation.promise })
    proc.handleMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    expect(proc.hasPendingNativeTurn()).toBe(true)
    const steering = proc.steerUserText('additional input', [], 'steer-id')
    await tick()
    proc.handleMessage(result())
    expect(proc.hasPendingNativeTurn()).toBe(false)
    expect(results).toEqual([])
    translation.resolve('Additional input')
    await expect(steering).resolves.toBe(true)
    expect(proc.hasPendingNativeTurn()).toBe(true)
    proc.handleMessage(result({ user_message_uuids: ['steer-id'] }))
    expect(proc.hasPendingNativeTurn()).toBe(false)
  })

  test('translates initial and steering inputs in order while preserving file paths and UUIDs', async () => {
    const first = deferred<string>()
    const calls: string[] = []
    const { proc, texts } = running({ ...defaultTranslation, toEnglish: async text => {
      calls.push(text)
      return text === 'first' ? first.promise : `EN:${text}`
    } })
    const context = await attachContext(proc)
    const scheduledInputs: unknown[] = []
    proc.on('scheduled_turn_input', (event: unknown) => scheduledInputs.push(event))
    proc.sendUserText('first', ['/tmp/中文.txt'], { contextPrefix: 'HOST_CONTEXT_PREFIX\n\n' })
    const steering = proc.steerUserText('second', ['/tmp/第二.txt'], 'client-uuid')
    await tick()
    expect(calls).toEqual(['first'])
    expect(proc.input.items).toEqual([])
    const translatedBody = 'First input\n```sh\nprintf "中文"\n```'
    first.resolve(translatedBody)
    await expect(steering).resolves.toBe(true)
    const initial = (await proc.input.next()).value
    const additional = (await proc.input.next()).value
    expect(initial.message.content[0].text).toBe(`HOST_CONTEXT_PREFIX\n\n[file: /tmp/中文.txt]\n\n${translatedBody}`)
    expect(initial.priority).toBe('now')
    expect(additional.message.content[0].text).toBe('[file: /tmp/第二.txt]\n\nEN:second')
    expect(additional.uuid).toBe('client-uuid')
    expect(additional.priority).toBe('next')
    expect(initial.message.content).toHaveLength(1)
    expect(additional.message.content).toHaveLength(1)
    for (const input of [initial, additional]) {
      await proc.handleTranslatedMessage({ type: 'user', uuid: input.uuid, message: input.message })
    }
    expect(texts).toEqual([])
    expect(scheduledInputs).toEqual([])
    expect(context.snapshot().entries.map(entry => entry.status)).toEqual(['consumed', 'consumed'])
    const history = JSON.stringify(context.snapshot())
    expect(context.snapshot().entries.map(({ original, translated }) => ({ original, translated }))).toEqual([
      { original: 'first', translated: 'First input' }, { original: 'second', translated: 'EN:second' },
    ])
    expect(history).toContain('First input')
    expect(history).toContain('EN:second')
    expect(history).not.toContain('HOST_CONTEXT_PREFIX')
    expect(history).not.toContain('[file:')
  })

  test('stop invalidates in-flight and queued translation without replaying stale input', async () => {
    const first = deferred<string>()
    const signals: AbortSignal[] = []
    const { proc, results } = running({ ...defaultTranslation, toEnglish: async (text, signal) => {
      signals.push(signal)
      return text === 'first' ? first.promise : `EN:${text}`
    } })
    proc.sendUserText('first')
    const steering = proc.steerUserText('second')
    await tick()
    proc.sendInterrupt()
    expect(signals[0]!.aborted).toBe(true)
    first.resolve('Late translation')
    await expect(steering).resolves.toBe(false)
    await tick()
    expect(proc.input.items).toEqual([])
    expect(results).toEqual([])
    proc.sendUserText('new turn')
    await tick()
    expect(proc.input.items[0].message.content[0].text).toBe('EN:new turn')
  })

  test('stop preserves already-consumed steering input when its native receipt was buffered behind output translation', async () => {
    const translation = deferred<string>(), queuedReceipts = deferred<any[]>(), end = deferred<void>()
    const { proc, texts } = running({ ...defaultTranslation, toChinese: () => translation.promise })
    const context = await attachContext(proc)
    proc.turnActive = true
    const reading = proc.readLoop((async function* () {
      yield assistant('Earlier output waiting for translation')
      for (const message of await queuedReceipts.promise) yield message
      await end.promise
    })())
    try {
      await tick()
      await proc.steerUserText('Already consumed requirement', [], 'consumed-input')
      await proc.steerUserText('Never consumed requirement', [], 'cancelled-input')
      expect(context.snapshot().entries).toHaveLength(2)
      // Native processing has advanced; only the host's translated event reader
      // is waiting. Stop must not equate a buffered receipt with no consumption.
      queuedReceipts.resolve([
        { type: 'command_lifecycle', state: 'started', command_uuid: 'consumed-input' },
        { type: 'command_lifecycle', state: 'cancelled', command_uuid: 'cancelled-input' },
        result({ user_message_uuids: ['consumed-input'] }),
      ])
      proc.sendInterrupt()
      expect(context.snapshot().entries).toEqual([])
      translation.resolve('取消后迟到的译文')
      await tick(); await tick()
      expect(texts).toEqual([])
      expect(proc.input.items).toEqual([])
      expect(context.snapshot().entries).toHaveLength(1)
      expect(context.snapshot().entries[0]).toMatchObject({ uuid: 'consumed-input', status: 'consumed' })
      expect(context.snapshot().entries[0]?.original).toBe('Already consumed requirement')
      expect(JSON.stringify(context.snapshot())).not.toContain('Never consumed requirement')
    } finally { end.resolve(); await reading }
  })

  test('input translation failure fails the turn while the native process stays alive', async () => {
    const { proc, results, exits } = running({ ...defaultTranslation, toEnglish: async () => { throw new Error('validation denied') } })
    const submitted: any[] = []
    proc.on('user_input_submitted', (event: any) => submitted.push(event))
    proc.sendUserText('request')
    await tick()
    expect(proc.input.items).toEqual([])
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].error).toContain('validation denied')
    expect(proc.isAlive()).toBe(true)
    expect(exits).toEqual([])
    expect(submitted).toEqual([])
    expect(proc.hasPendingNativeTurn()).toBe(false)
  })

  test('failed additional-input translation releases a deferred native result with a visible error', async () => {
    const translation = deferred<string>()
    const { proc, results } = running({ ...defaultTranslation, toEnglish: () => translation.promise })
    proc.inputTurnPending = true
    const steering = proc.steerUserText('additional')
    void steering.catch(() => {})
    await tick()
    proc.handleMessage(result())
    expect(results).toEqual([])
    translation.reject(new Error('upstream unavailable'))
    await expect(steering).rejects.toThrow('追加输入翻译失败')
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].error).toContain('upstream unavailable')
  })

  test('SDK stream preserves text, block stop, and native result ordering while translating display text', async () => {
    const translation = deferred<string>(), end = deferred<void>()
    const { proc, texts } = running({ ...defaultTranslation, toChinese: () => translation.promise })
    const order: string[] = []
    proc.on('assistant_text', () => order.push('text'))
    proc.on('assistant_block_stop', () => order.push('stop'))
    proc.on('result', () => order.push('result'))
    const stream = (async function* () {
      yield assistant('English response')
      yield result()
      await end.promise
    })()
    const reading = proc.readLoop(stream)
    await tick()
    expect(order).toEqual([])
    translation.resolve('中文回复')
    await tick()
    expect(order).toEqual(['text', 'stop', 'result'])
    expect(texts[0]).toEqual({ uuid: 'assistant-1', text: 'English response', displayText: '中文回复', parentToolUseId: null })
    end.resolve()
    await reading
  })

  test('output failure interrupts native work and only its real result settles the failure', async () => {
    const { proc, results, texts, errors, exits } = running({ ...defaultTranslation, toChinese: async () => { throw new Error('translator timeout') } })
    let interrupted = 0
    proc.query.interrupt = async () => { interrupted++; return { still_queued: [] } }
    await proc.handleTranslatedMessage(assistant('Never show this as translated'))
    expect(interrupted).toBe(1)
    expect(texts).toEqual([])
    expect(errors[0].message).toContain('translator timeout')
    expect(results).toEqual([])
    expect(exits).toEqual([])
    expect(proc.isAlive()).toBe(true)
    proc.handleMessage(result())
    expect(results[0].is_error).toBe(true)
    expect(results[0].subtype).toBe('claude_translation_failed')
    expect(results[0].error).toContain('translator timeout')
    expect(proc.isAlive()).toBe(true)
  })

  test('output failure preserves prior continuation usage and does not poison the next turn', async () => {
    let fail = true
    const { proc, results, texts } = running({ ...defaultTranslation, toChinese: async text => {
      if (fail) throw new Error('temporary translator error')
      return `ZH:${text}`
    } })
    proc.inputTurnPending = true
    await proc.steerUserText('continuation', [], 'input-id')
    proc.handleMessage(result({ usage: { input_tokens: 3, output_tokens: 2 } }))
    await proc.handleTranslatedMessage(assistant('translation fails'))
    proc.handleMessage(result({ usage: { input_tokens: 7, output_tokens: 4 } }))
    expect(results[0].is_error).toBe(true)
    expect(results[0].usage.input_tokens).toBe(10)
    expect(results[0].usage.output_tokens).toBe(6)
    fail = false
    proc.sendUserText('fresh task')
    await tick()
    await proc.handleTranslatedMessage(assistant('new result'))
    proc.handleMessage(result())
    expect(texts[0].displayText).toBe('ZH:new result')
    expect(results[1].is_error).toBe(false)
  })

  test('stop suppresses delayed and subsequent output without reporting a translation failure', async () => {
    const translation = deferred<string>()
    const { proc, texts, errors } = running({ ...defaultTranslation, toChinese: () => translation.promise })
    const output = proc.handleTranslatedMessage(assistant('pending'))
    await tick()
    proc.sendInterrupt()
    translation.resolve('迟到译文')
    await output
    await proc.handleTranslatedMessage(assistant('late native message'))
    expect(texts).toEqual([])
    expect(errors).toEqual([])
  })

  test('tool display descriptions are translated while executable arguments and stdout remain exact', async () => {
    const { proc } = running()
    const tools: any[] = [], outputs: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.on('tool_result', (event: any) => outputs.push(event))
    const input = { command: '# desc: Read the requested file\ncat /tmp/中文.txt', description: 'Read file' }
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-id', name: 'Bash', input }] } })
    await proc.handleTranslatedMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-id', content: '原始内容' }] } })
    expect(tools[0].input).toEqual(input)
    expect(tools[0].displayInput).toEqual({ command: input.command, description: 'Read file', __displayDescription: 'ZH:Read the requested file' })
    expect(outputs[0].content).toBe('原始内容')
    expect(outputs[0].displayContent).toBe('原始内容')
    expect(outputs[0].displayInput).toEqual(tools[0].displayInput)
    expect(proc.translatedToolInputs.has('tool-id')).toBe(false)
  })

  test('resolves server-tool scaffolds once across messages for translation, history and native events', async () => {
    for (const separateMessages of [true, false]) {
      const calls: string[][] = []
      const { proc } = running({ ...defaultTranslation, toChineseFields: async fields => {
        calls.push(fields)
        return fields.map(text => `ZH:${text}`)
      } })
      const context = await attachContext(proc)
      const events: any[] = []
      proc.on('tool_use', (event: any) => events.push(event))
      const input = { imageSource: 'https://example.org/image', prompt: 'Read the screenshot' }
      const scaffold = { type: 'text', text: `**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n\`\`\`json\n${JSON.stringify(input)}\n\`\`\`` }
      const tool = { type: 'server_tool_use', id: 'image-tool', name: 'analyze_image', input: {} }
      if (separateMessages) await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'scaffold', message: { content: [scaffold] } })
      await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'tool', message: { content: separateMessages ? [tool] : [scaffold, tool] } })
      expect(calls).toEqual([['Read the screenshot']])
      expect(events[0].input).toEqual({ tool: 'analyze_image', input })
      expect(events[0].displayInput).toEqual({ tool: 'analyze_image', input: { ...input, prompt: 'ZH:Read the screenshot' } })
      expect(context.snapshot().entries.map(entry => [entry.original, entry.translated])).toEqual([
        ['Read the screenshot', 'ZH:Read the screenshot'],
      ])
      expect(proc.pendingServerToolInputs).toEqual([])
      expect(tool.input).toEqual({})
    }
  })

  test('matches multiple same-name server-tool scaffolds in native block order', async () => {
    const { proc } = running()
    const events: any[] = []
    proc.on('tool_use', (event: any) => events.push(event))
    const scaffold = (prompt: string) => ({ type: 'text', text: `**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n\`\`\`json\n${JSON.stringify({ prompt })}\n\`\`\`` })
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [
      scaffold('First image'), { type: 'server_tool_use', id: 'image-1', name: 'analyze_image', input: {} },
      scaffold('Second image'), { type: 'server_tool_use', id: 'image-2', name: 'analyze_image', input: {} },
    ] } })
    expect(events.map(event => [event.input.input.prompt, event.displayInput.input.prompt])).toEqual([
      ['First image', 'ZH:First image'], ['Second image', 'ZH:Second image'],
    ])
    expect(proc.pendingServerToolInputs).toEqual([])
  })

  test('retains unfinished tool display inputs until result or process exit', async () => {
    const { proc } = running()
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'completed-tool', name: 'Bash', input: { command: '# desc: First command\nprintf first' } },
      { type: 'tool_use', id: 'pending-tool', name: 'Bash', input: { command: '# desc: Background command\nprintf pending' } },
    ] } })
    await proc.handleTranslatedMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'completed-tool', content: 'first' }] } })
    expect([...proc.translatedToolInputs.keys()]).toEqual(['pending-tool'])
    proc.sendInterrupt()
    expect([...proc.translatedToolInputs.keys()]).toEqual(['pending-tool'])
    proc.finishExit(0, null)
    expect(proc.translatedToolInputs.size).toBe(0)
  })

  test('native receipts share display and history visibility across assistant/user streams, including structured receipts and failures', async () => {
    const translatedFields: string[][] = []
    const { proc, errors } = running({ ...defaultTranslation, toChineseFields: async fields => {
      translatedFields.push([...fields])
      return fields.map(field => `ZH:${field}`)
    } })
    const context = await attachContext(proc)
    const outputs: any[] = []
    proc.on('tool_result', (event: any) => outputs.push(event))
    let sequence = 0
    for (const name of ['AskUserQuestion', 'TaskCreate', 'TaskUpdate']) {
      for (const type of ['assistant', 'user']) {
        for (const structured of [false, true]) {
          for (const [receiptVisible, isError] of [[false, false], [true, false], [false, true], [true, true]]) {
            const id = `receipt-${++sequence}`
            const prose = `Receipt details ${sequence}`
            const content = structured ? JSON.stringify({ message: prose, id, status: isError ? 'failed' : 'completed' }) : prose
            const parent = receiptVisible ? 'native-parent-task' : null
            proc.translatedToolNames.set(id, name)
            const callCount = translatedFields.length
            const historyCount = context.snapshot().entries.length
            await proc.handleTranslatedMessage({ type, uuid: `message-${sequence}`, parent_tool_use_id: parent,
              message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
            const output = outputs.at(-1)!
            expect(output).toMatchObject({ tool_use_id: id, content, is_error: isError, parentToolUseId: parent })
            if (receiptVisible || (name === 'AskUserQuestion' && isError)) {
              expect(translatedFields.slice(callCount)).toEqual([[prose]])
              expect(output.displayContent).toBe(structured
                ? JSON.stringify({ message: `ZH:${prose}`, id, status: isError ? 'failed' : 'completed' }, null, 2)
                : `ZH:${prose}`)
              const entries = context.snapshot().entries
              expect(entries.length).toBe(historyCount + 1)
              expect(entries.at(-1)?.original).toContain(prose)
              expect(entries.at(-1)?.translated).toContain(`ZH:${prose}`)
              if (receiptVisible) expect(entries.at(-1)?.role).toBe('assistant/subagent:native-parent-task')
            } else {
              expect(translatedFields.length).toBe(callCount)
              expect(output.displayContent).toBe(content)
              expect(context.snapshot().entries.length).toBe(historyCount)
            }
          }
        }
      }
    }
    expect(errors).toEqual([])
    expect(outputs).toHaveLength(sequence)
  })

  test('native subagent prose is translated with its parent identity without changing the main checkpoint', async () => {
    const calls: string[] = []
    const { proc, results, errors, texts } = running({ ...defaultTranslation, toChinese: async () => {
      calls.push('subagent result')
      return '子任务结果'
    } })
    const context = await attachContext(proc)
    proc.lastAssistantUuid = 'main-checkpoint'
    proc.sessionId = 'main-session'
    await proc.handleTranslatedMessage({ ...assistant('subagent result'), uuid: 'child-checkpoint', session_id: 'child-session', parent_tool_use_id: 'native-task' })
    expect(calls).toEqual(['subagent result'])
    expect(texts[0]).toEqual({ uuid: 'child-checkpoint', text: 'subagent result', displayText: '子任务结果', parentToolUseId: 'native-task' })
    expect(proc.lastAssistantUuid).toBe('main-checkpoint')
    expect(proc.sessionId).toBe('main-session')
    expect(errors).toEqual([])
    const history = context.snapshot()
    expect(history.sessionId).toBe('boundary-session')
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]?.original).toContain('subagent result')
    expect(history.entries[0]?.translated).toContain('子任务结果')
    proc.handleMessage(result())
    expect(results[0].is_error).toBe(false)
    expect(results[0].checkpoint.id).toBe('main-checkpoint')
  })

  test('a failed child translation reports failure without leaking the untranslated child response', async () => {
    const { proc, results, errors, texts } = running({ ...defaultTranslation, toChinese: async () => { throw new Error('child translation failed') } })
    proc.nativeTurnPending = true
    await proc.handleTranslatedMessage({ ...assistant('Child response'), parent_tool_use_id: 'native-task' })
    expect(texts).toEqual([])
    expect(errors[0].message).toContain('child translation failed')
    await proc.handleTranslatedMessage(result())
    expect(results[0].is_error).toBe(true)
  })

  test('an idle background translation failure is visible without interrupting or poisoning the next task', async () => {
    const { proc, results, errors, texts } = running({ ...defaultTranslation, toChineseFields: async fields => {
      if (fields.includes('Idle background progress')) throw new Error('Idle translation unavailable')
      return fields.map(field => `ZH:${field}`)
    } })
    let interrupts = 0
    proc.query.interrupt = async () => { interrupts++; return { still_queued: [] } }
    proc.nativeTurnPending = true
    await proc.handleTranslatedMessage(assistant('The first task is complete.'))
    await proc.handleTranslatedMessage(result())
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(false)
    expect(proc.hasPendingNativeTurn()).toBe(false)

    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_progress', task_id: 'background-1', summary: 'Idle background progress' })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Idle translation unavailable')
    expect(interrupts).toBe(0)
    expect(proc.translationFailure).toBeNull()
    expect(results).toHaveLength(1)

    proc.sendUserText('Start the next task.')
    await tick()
    expect(proc.input.items[0].message.content[0].text).toBe('EN:Start the next task.')
    await proc.handleTranslatedMessage({ ...assistant('The next task is complete.'), uuid: 'next-task-reply' })
    await proc.handleTranslatedMessage(result())
    expect(texts.at(-1)).toMatchObject({ uuid: 'next-task-reply', displayText: 'ZH:The next task is complete.' })
    expect(results).toHaveLength(2)
    expect(results[1].is_error).toBe(false)
    expect(interrupts).toBe(0)
  })

  test('translates background task lifecycle descriptions, progress and errors without altering protocol values', async () => {
    const { proc } = running()
    const started: any[] = [], progress: any[] = [], updated: any[] = [], settled: any[] = []
    proc.on('bg_task_started', (event: any) => started.push(event))
    proc.on('bg_task_progress', (event: any) => progress.push(event))
    proc.on('bg_task_updated', (event: any) => updated.push(event))
    proc.on('bg_task_settled', (event: any) => settled.push(event))
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_started', task_id: 'bg-1', tool_use_id: 'agent-tool-1', task_type: 'local_agent',
      description: 'Review recent changes', prompt: 'Inspect the implementation.', workflow_name: 'Code review', subagent_type: 'Explore' })
    const usage = { total_tokens: 120, tool_uses: 3, duration_ms: 2000 }
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_progress', task_id: 'bg-1', description: 'Reviewing files', summary: 'Two files checked', last_tool_name: 'Read', usage })
    const patch = { status: 'failed', description: 'Review interrupted', error: 'File was removed', end_time: 1000 }
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch })
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', tool_use_id: 'agent-tool-1', status: 'failed', summary: 'Review could not finish', usage })
    expect(started[0]).toMatchObject({ task_id: 'bg-1', tool_use_id: 'agent-tool-1', task_type: 'local_agent', subagent_type: 'Explore',
      description: 'Review recent changes', prompt: 'Inspect the implementation.', workflow_name: 'Code review',
      display: { description: 'ZH:Review recent changes', prompt: 'ZH:Inspect the implementation.', workflow_name: 'ZH:Code review' } })
    expect(progress[0]).toMatchObject({ task_id: 'bg-1', description: 'Reviewing files', summary: 'Two files checked', last_tool_name: 'Read', usage,
      display: { description: 'ZH:Reviewing files', summary: 'ZH:Two files checked' } })
    expect(updated[0]).toEqual({ task_id: 'bg-1', patch, display: { description: 'ZH:Review interrupted', error: 'ZH:File was removed' } })
    expect(settled[0]).toEqual({ task_id: 'bg-1', tool_use_id: 'agent-tool-1', status: 'failed', summary: 'Review could not finish', usage,
      display: { summary: 'ZH:Review could not finish' } })
  })

  test('task tool presentation preserves raw confirmations and JSON identities for downstream task parsing', async () => {
    const { proc } = running()
    const tools: any[] = [], outputs: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.on('tool_result', (event: any) => outputs.push(event))
    const input = { subject: 'Inspect API', description: 'Inspect supported arguments', activeForm: 'Inspecting API', metadata: { description: 'literal metadata' } }
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'create-7', name: 'TaskCreate', input }] } })
    const confirmation = 'Task #7 created successfully: Inspect API'
    await proc.handleTranslatedMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'create-7', content: confirmation }] } })
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'list-7', name: 'TaskList', input: {} }] } })
    const tasks = { tasks: [{ id: '7', subject: 'Inspect API', description: 'Inspect supported arguments', status: 'in_progress', blockedBy: ['2'], owner: 'review-agent' }] }
    const rawJson = JSON.stringify(tasks)
    await proc.handleTranslatedMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'list-7', content: rawJson }] } })
    expect(tools[0].input).toEqual(input)
    expect(tools[0].displayInput).toEqual({ ...input, subject: 'ZH:Inspect API', activeForm: 'ZH:Inspecting API' })
    expect(outputs[0].content).toBe(confirmation)
    expect(outputs[0].displayContent).toBe(confirmation)
    expect(outputs[1].content).toBe(rawJson)
    expect(JSON.parse(outputs[1].displayContent)).toEqual({ tasks: [{ ...tasks.tasks[0], subject: 'ZH:Inspect API' }] })
  })

  test('main task read receipts record only consumed JSON labels and preserve raw prose and errors on both native streams', async () => {
    const translatedFields: string[][] = []
    const { proc, errors } = running({ ...defaultTranslation, toChineseFields: async fields => {
      translatedFields.push([...fields])
      return fields.map(field => `ZH:${field}`)
    } })
    const context = await attachContext(proc)
    const outputs: any[] = []
    proc.on('tool_result', (event: any) => outputs.push(event))
    let sequence = 0
    for (const name of ['TaskList', 'TaskGet']) {
      for (const type of ['assistant', 'user']) {
        for (const parent of [null, 'native-parent-task']) {
          const task = { id: '1', subject: 'Visible subject', activeForm: 'Visible activity', description: 'Private task details', status: 'in_progress' }
          const snapshot = JSON.stringify(name === 'TaskList' ? { tasks: [task] } : { task })
          for (const content of ['Task #1: Visible subject\nStatus: in_progress\nDescription: Private task details', snapshot]) {
            for (const isError of [false, true]) {
              const id = `task-read-${++sequence}`
              proc.translatedToolNames.set(id, name)
              const callCount = translatedFields.length
              const historyCount = context.snapshot().entries.length
              await proc.handleTranslatedMessage({ type, uuid: `task-message-${sequence}`, parent_tool_use_id: parent,
                message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
              const output = outputs.at(-1)!
              expect(output).toMatchObject({ tool_use_id: id, content, is_error: isError, parentToolUseId: parent })
              const visible = parent !== null || (!isError && content === snapshot)
              if (!visible) {
                expect(translatedFields.length).toBe(callCount)
                expect(context.snapshot().entries.length).toBe(historyCount)
                expect(output.displayContent).toBe(content)
              } else {
                const fields = content === snapshot
                  ? ['Visible subject', 'Visible activity', ...(parent ? ['Private task details'] : [])] : [content]
                expect(translatedFields.slice(callCount)).toEqual([fields])
                expect(context.snapshot().entries.length).toBe(historyCount + 1)
                const entry = context.snapshot().entries.at(-1)!
                expect(entry.original).toBe(fields.join('\n'))
                expect(entry.translated).toBe(fields.map(field => `ZH:${field}`).join('\n'))
                if (!parent) expect(entry.original).not.toContain('Private task details')
              }
            }
          }
        }
      }
    }
    expect(errors).toEqual([])
  })

  test('native result errors keep diagnostic and settlement semantics while exposing translated error display', async () => {
    const { proc, results } = running()
    const original = { ...result(), subtype: 'error_during_execution', is_error: true, errors: ['The request was rejected.', 'Retry after the reset.'], session_id: 'native-session' }
    await proc.handleTranslatedMessage(original)
    expect(original.errors).toEqual(['The request was rejected.', 'Retry after the reset.'])
    expect(results[0]).toMatchObject({ subtype: 'error_during_execution', is_error: true,
      error: 'The request was rejected.\nRetry after the reset.', displayError: 'ZH:The request was rejected.\nRetry after the reset.' })
    expect(proc.hasPendingNativeTurn()).toBe(false)
    expect(proc.sessionId).toBe('native-session')
  })

  test('Cron wakeups carry an original prompt and translated display even after a prior stop', async () => {
    const { proc } = running()
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (event: any) => scheduled.push(event))
    proc.sendInterrupt()
    await proc.handleTranslatedMessage({ type: 'user', isMeta: true, promptSource: 'sdk', promptId: 'cron-7', message: { content: 'Inspect the service and report.' } })
    await proc.handleTranslatedMessage({ type: 'user', isMeta: true, promptId: 'image-7', message: { content: '[Image: original 1440x2400]' } })
    expect(scheduled).toEqual([{ text: 'Inspect the service and report.', displayText: 'ZH:Inspect the service and report.', promptId: 'cron-7' }])
  })

  test('child tool translations retain parent routing and never change command stdout', async () => {
    const { proc } = running()
    const tools: any[] = [], outputs: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.on('tool_result', (event: any) => outputs.push(event))
    const input = { command: '# desc: Inspect the repository\ngit status --short' }
    await proc.handleTranslatedMessage({ type: 'assistant', parent_tool_use_id: 'parent-agent', message: { content: [{ type: 'tool_use', id: 'child-bash', name: 'Bash', input }] } })
    await proc.handleTranslatedMessage({ type: 'user', parent_tool_use_id: 'parent-agent', tool_use_result: { stdout: 'Raw program output', stderr: 'Raw diagnostics' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'child-bash', content: '' }] } })
    expect(tools[0]).toMatchObject({ parentToolUseId: 'parent-agent', input, displayInput: { command: input.command, __displayDescription: 'ZH:Inspect the repository' } })
    expect(outputs[0]).toMatchObject({ parentToolUseId: 'parent-agent', content: 'Raw program output\nRaw diagnostics', displayContent: 'Raw program output\nRaw diagnostics' })
  })

  test('native SendMessage includes translated content and summary without changing recipient routing', async () => {
    const { proc } = running()
    const tools: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    const input = { type: 'message', recipient: 'review-agent', content: 'Please review the API changes.', summary: 'Request API review' }
    await proc.handleTranslatedMessage({ type: 'assistant', parent_tool_use_id: 'parent-agent',
      message: { content: [{ type: 'tool_use', id: 'send-message-1', name: 'SendMessage', input }] } })
    expect(tools[0]).toMatchObject({ name: 'SendMessage', parentToolUseId: 'parent-agent', input,
      displayInput: { ...input, content: 'ZH:Please review the API changes.', summary: 'ZH:Request API review' } })
    expect(input.content).toBe('Please review the API changes.')
  })

  test('resumed stdout results remain exact even when their earlier tool call was not replayed', async () => {
    const batches: string[][] = []
    const { proc } = running({ ...defaultTranslation, toChineseFields: async fields => {
      batches.push(fields)
      return fields.map(field => `ZH:${field}`)
    } })
    const outputs: any[] = []
    proc.on('tool_result', (event: any) => outputs.push(event))
    await proc.handleTranslatedMessage({ type: 'user', tool_use_result: { stdout: 'const message = "Keep source code"', stderr: 'Raw program diagnostic' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'previous-process-command', content: '' }] } })
    expect(outputs[0].content).toBe('const message = "Keep source code"\nRaw program diagnostic')
    expect(outputs[0].displayContent).toBe(outputs[0].content)
    expect(batches).toEqual([])
  })

  test('MCP content translates prose and known JSON fields while preserving resource bytes and IDs', async () => {
    const { proc } = running()
    const tools: any[] = [], outputs: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.on('tool_result', (event: any) => outputs.push(event))
    const input = { prompt: 'Inspect the service state.', resource: { text: 'Literal file bytes' }, id: 'service-1' }
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__service__inspect', input }] } })
    const output = { content: [
      { type: 'text', text: 'The service is running.' },
      { type: 'text', text: JSON.stringify({ message: 'The check succeeded.', id: 'check-1', status: 'completed' }) },
      { type: 'resource', resource: { text: 'const label = "Preserve these bytes"' } },
    ], structuredContent: { message: 'Opaque structured payload', status: 'running' } }
    await proc.handleTranslatedMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: JSON.stringify(output) }] } })
    expect(tools[0].input).toEqual(input)
    expect(tools[0].displayInput).toEqual({ ...input, prompt: 'ZH:Inspect the service state.' })
    expect(outputs[0].content).toBe(JSON.stringify(output))
    const display = JSON.parse(outputs[0].displayContent)
    expect(display.content[0].text).toBe('ZH:The service is running.')
    expect(JSON.parse(display.content[1].text)).toEqual({ message: 'ZH:The check succeeded.', id: 'check-1', status: 'completed' })
    expect(display.content[2]).toEqual(output.content[2])
    expect(display.structuredContent).toEqual(output.structuredContent)
  })

  test('background translation failure retains lifecycle status and surfaces an explicit display failure', async () => {
    const { proc, errors } = running({ ...defaultTranslation, toChineseFields: async () => { throw new Error('background translator unavailable') } })
    const settled: any[] = []
    proc.on('bg_task_settled', (event: any) => settled.push(event))
    await proc.handleTranslatedMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg-failure', status: 'failed', summary: 'The operation failed.' })
    expect(errors[0].message).toContain('background translator unavailable')
    expect(settled[0]).toMatchObject({ task_id: 'bg-failure', status: 'failed', summary: 'The operation failed.' })
    expect(settled[0].display.summary).toContain('翻译失败')
    expect(settled[0].display.summary).not.toBe(settled[0].summary)
  })

  test('translation history binding failures interrupt the turn without inventing a native process exit', async () => {
    const { proc, errors, exits, texts, results } = running()
    proc.translationContextInitialized = true
    proc.opts.translationContext = {
      bindSession() { throw new Error('Translation context session mismatch') },
      cancelPendingInputs() {},
    }
    await expect(proc.handleTranslatedMessage({ ...assistant('Do not display mismatched history'), session_id: 'wrong-session' })).resolves.toBeUndefined()
    expect(errors[0].message).toContain('Translation context session mismatch')
    expect(texts).toEqual([])
    expect(exits).toEqual([])
    expect(proc.isAlive()).toBe(true)
    await proc.handleTranslatedMessage(result())
    expect(results[0].is_error).toBe(true)
    expect(proc.isAlive()).toBe(true)
  })

  test('checkpoint persistence failure cannot leave an undisplayed output or tool identity on disk', async () => {
    const { proc, texts, errors } = running()
    const context = await attachContext(proc)
    const path = (context as any).filePath('boundary-session') as string
    const before = readFileSync(path, 'utf8')
    const originalPersist = (context as any).persist.bind(context)
    const persistence = spyOn(context as any, 'persist').mockImplementation(() => {
      if ((context as any).checkpoints.some((item: any) => item.uuid === 'failed-checkpoint')) {
        throw new Error('checkpoint fsync failure')
      }
      originalPersist()
    })
    try {
      await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'failed-checkpoint', message: { content: [
        { type: 'text', text: 'This response cannot be committed.' },
        { type: 'tool_use', id: 'unpublished-tool', name: 'Bash', input: { command: '# desc: Check state\ntrue' } },
      ] } })
      expect(errors[0].message).toContain('checkpoint fsync failure')
      expect(texts).toEqual([])
      expect(context.snapshot().entries).toEqual([])
      expect(context.toolName('unpublished-tool')).toBeUndefined()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(persistence).toHaveBeenCalledTimes(1)
    } finally { persistence.mockRestore() }
  })

  test('a later field failure does not emit a partially translated assistant message', async () => {
    const { proc, texts, errors } = running({ ...defaultTranslation,
      toChineseFields: async () => { throw new Error('tool translation failed') },
    })
    const context = await attachContext(proc)
    const tools: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    await proc.handleTranslatedMessage({ type: 'assistant', message: { content: [
      { type: 'text', text: 'I will inspect the files.' },
      { type: 'tool_use', id: 'failed-tool', name: 'Bash', input: { command: '# desc: Inspect files\nls' } },
    ] } })
    expect(errors[0].message).toContain('tool translation failed')
    expect(texts).toEqual([])
    expect(tools).toEqual([])
    expect(context.snapshot().entries).toEqual([])
  })

  test('preserves custom Chinese system instructions exactly without calling the translator', async () => {
    const calls: unknown[] = [], options: any[] = []
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk').mockResolvedValue({ query: (request: any) => {
      options.push(request.options)
      return (async function* () {})()
    } } as any)
    try {
      const instructions = '宿主规则：保留中文与换行。\n路径：`/tmp/中文目录`\n不要改写这份自定义指令。'
      const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', appendSystemPrompt: instructions,
        profile: { loadProjectMcp: false }, translation: { ...defaultTranslation, toEnglish: async text => {
          calls.push(text)
          throw new Error('host instructions must not enter translation')
        } } }) as any
      const context = await attachContext(proc)
      proc.sendInitialize()
      await proc.queryStart
      expect(calls).toEqual([])
      expect(options[0].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: instructions, snapshot: false })
      expect(context.snapshot().entries).toEqual([])
    } finally { sdk.mockRestore() }
  })

  test('kill during translation-context initialization prevents late SDK startup', async () => {
    const initialization = deferred<void>()
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk')
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', appendSystemPrompt: 'host instructions',
      profile: { loadProjectMcp: false }, translation: defaultTranslation }) as any
    proc.opts.translationContext = { initialize: () => initialization.promise }
    try {
      proc.sendInitialize()
      await tick()
      await proc.kill()
      initialization.resolve()
      await proc.queryStart
      expect(sdk).not.toHaveBeenCalled()
      expect(proc.isAlive()).toBe(false)
    } finally { sdk.mockRestore() }
  })

  test('compact still recognizes the original native message when its display is translated', async () => {
    const { proc } = running()
    const compaction = proc.compactThread()
    void compaction.catch(() => {})
    await proc.handleTranslatedMessage(assistant('Not enough messages to compact'))
    await expect(compaction).rejects.toBeInstanceOf(NothingToCompactError)
  })

  test('stop followed by compact resolves its control response before translation finishes', async () => {
    const translation = deferred<string>()
    const { proc } = running({ ...defaultTranslation, toChinese: () => translation.promise })
    proc.sendInterrupt()
    const compaction = proc.compactThread()
    void compaction.catch(() => {})
    const rendering = proc.handleTranslatedMessage(assistant('Not enough messages to compact'))
    await expect(compaction).rejects.toBeInstanceOf(NothingToCompactError)
    translation.resolve('没有足够的消息可以压缩')
    await rendering
  })
})

describe('Claude behavior with translation disabled', () => {
  test('keeps native input, child session IDs and the original compaction text event', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', tokenSourceId: 'glm' }) as any
    proc.started = true
    const controlTexts: unknown[] = []
    const texts: unknown[] = []
    proc.on('assistant_control_text', (event: unknown) => controlTexts.push(event))
    proc.on('assistant_text', (event: unknown) => texts.push(event))
    proc.sendUserText('原始输入', ['/tmp/原始.ts'])
    expect(proc.input.items[0].message.content).toEqual([{ type: 'text', text: '[file: /tmp/原始.ts]\n\n原始输入' }])
    await expect(proc.steerUserText('原始追加', ['/tmp/追加.ts'], 'plain-steer')).resolves.toBe(true)
    expect(proc.input.items[1].message.content).toEqual([{ type: 'text', text: '[file: /tmp/追加.ts]\n\n原始追加' }])
    proc.handleMessage({ ...assistant('Original child output'), parent_tool_use_id: 'child-tool', session_id: 'child-session' })
    expect(proc.sessionId).toBe('child-session')
    expect(texts).toEqual([{ uuid: 'assistant-1', text: 'Original child output', parentToolUseId: 'child-tool' }])
    expect(controlTexts).toEqual([])
    const compaction = proc.compactThread()
    void compaction.catch(() => {})
    proc.emit('assistant_text', { text: 'Not enough messages to compact', parentToolUseId: null })
    await expect(compaction).rejects.toBeInstanceOf(NothingToCompactError)
  })

  test('keeps the existing nontranslated question option normalization', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', tokenSourceId: 'claude-sub' }) as any
    const requests: any[] = []
    proc.on('can_use_tool', (request: any) => {
      requests.push(request)
      proc.sendPermissionResponse(request.request_id, 'allow', {
        updatedInput: { ...request.input, answers: { 'Choose?': 'Compact' } },
      })
    })
    const answer = await proc.canUseTool('AskUserQuestion', { questions: [{ question: 'Choose?', options: [
      { label: 'Compact', description: 'A dense layout', preview: '## Compact preview' },
    ] }] }, { signal: new AbortController().signal, toolUseID: 'plain-question' })
    expect(requests[0].input.questions[0].options).toEqual([{ label: 'Compact', description: 'A dense layout' }])
    expect(requests[0].originalInput).toBeUndefined()
    expect(answer.updatedInput.answers).toEqual({ 'Choose?': 'Compact' })
  })

  test('stopping before native initialization does not introduce a nontranslation abort', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high', tokenSourceId: 'glm' }) as any
    await proc.kill()
    expect(proc.isAlive()).toBe(false)
    expect(proc.abortController.signal.aborted).toBe(false)
  })
})

describe('Claude translated questions', () => {
  const input = { questions: [{ id: 'stable-id', question: 'Choose one?', header: 'Choice', options: [
    { label: 'A', description: 'First option' }, { label: 'B', description: 'Second option' },
  ] }] }

  test('shows translated questions once and translates selected answers while preserving native question keys', async () => {
    const englishCalls: string[] = []
    const batches: string[][] = []
    const { proc } = running({ ...defaultTranslation,
      toChineseFields: async fields => { batches.push(fields); return fields.map(text => `ZH:${text}`) },
      toEnglish: async text => { englishCalls.push(text); return `EN:${text}` },
    })
    const context = await attachContext(proc)
    const tools: any[] = []
    const requests: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.handleMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'question-id', name: 'AskUserQuestion', input }] } })
    proc.on('can_use_tool', (event: any) => {
      requests.push(event)
      proc.sendPermissionResponse(event.request_id, 'allow', {
        updatedInput: { ...event.input, answers: { 'ZH:Choose one?': 'ZH:B' } },
      })
    })
    const answer = await proc.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(tools).toHaveLength(1)
    expect(tools[0].input).toEqual(input)
    expect(tools[0].displayInput.questions[0]).toEqual({ id: 'stable-id', question: 'ZH:Choose one?', header: 'Choice', options: [
      { label: 'ZH:A', description: 'ZH:First option' }, { label: 'ZH:B', description: 'ZH:Second option' },
    ] })
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Choose one?': 'EN:ZH:B' } } })
    expect(englishCalls).toEqual(['ZH:B'])
    expect(requests[0].originalInput).toEqual(input)
    expect(batches).toEqual([['Choose one?', 'A', 'First option', 'B', 'Second option']])
    const history = context.snapshot().entries
    expect(history.map(entry => entry.role)).toEqual(['assistant/question', 'user/answer'])
    expect(history[0]?.original).toContain('Choose one?')
    expect(history[0]?.translated).toContain('ZH:Choose one?')
    expect(history[1]?.original).toContain('ZH:B')
    expect(history[1]?.translated).toContain('EN:ZH:B')
    const receipt = 'The user answered: "Choose one?"="EN:ZH:B". Read the answers carefully and follow what they actually say.'
    const toolResults: any[] = []
    proc.on('tool_result', (event: any) => toolResults.push(event))
    await proc.handleTranslatedMessage({ type: 'user', uuid: 'internal-question-receipt', message: { content: [
      { type: 'tool_result', tool_use_id: 'question-id', content: receipt },
    ] } })
    expect(toolResults[0].content).toBe(receipt)
    expect(toolResults[0].displayContent).toBe(receipt)
    expect(batches).toEqual([['Choose one?', 'A', 'First option', 'B', 'Second option']])
    expect(context.snapshot().entries).toEqual(history)
  })

  test('Chinese native questions and options submit English answer values without rewriting protocol keys', async () => {
    const englishCalls: string[] = []
    const { proc } = running({ ...defaultTranslation,
      toChineseFields: async fields => [...fields],
      toEnglish: async text => { englishCalls.push(text); return 'Continue execution' },
    })
    const context = await attachContext(proc)
    const nativeInput = { questions: [{ id: 'native-question-id', question: '下一步怎么做？', header: '下一步', options: [
      { label: '继续执行', description: '继续当前任务' }, { label: '取消任务', description: '停止当前任务' },
    ] }] }
    const original = structuredClone(nativeInput)
    const tools: any[] = [], requests: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    proc.on('can_use_tool', (event: any) => {
      requests.push(event)
      expect(event.input.questions[0].question).toBe('下一步怎么做？')
      expect(event.input.questions[0].options[0].label).toBe('继续执行')
      proc.sendPermissionResponse(event.request_id, 'allow', {
        updatedInput: { ...event.input, answers: { '下一步怎么做？': '继续执行' } },
      })
    })
    const answer = await proc.canUseTool('AskUserQuestion', nativeInput,
      { signal: new AbortController().signal, toolUseID: 'native-tool-id' })
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { ...original, answers: { '下一步怎么做？': 'Continue execution' } } })
    expect(nativeInput).toEqual(original)
    expect(requests[0].originalInput).toEqual(original)
    expect(requests[0].tool_use_id).toBe('native-tool-id')
    expect(tools[0].id).toBe('native-tool-id')
    expect(tools[0].input).toEqual(original)
    expect(englishCalls).toEqual(['继续执行'])
    expect(context.snapshot().entries.at(-1)?.original).toBe('下一步怎么做？: 继续执行')
    expect(context.snapshot().entries.at(-1)?.translated).toBe('下一步怎么做？: Continue execution')
  })

  test('translates the visible selected answer itself and submits that result with the native question unchanged', async () => {
    const englishCalls: string[] = []
    const labels: Record<string, string> = { 'Finish this task?': '是否完成任务？', Complete: '完成', Wait: '等待' }
    const { proc } = running({ ...defaultTranslation,
      toChineseFields: async fields => fields.map(field => labels[field]!),
      toEnglish: async text => { englishCalls.push(text); return 'Finish' },
    })
    const context = await attachContext(proc)
    const nativeInput = { questions: [{ id: 'finish-task', question: 'Finish this task?', options: [
      { label: 'Complete' }, { label: 'Wait' },
    ] }] }
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { '是否完成任务？': '完成' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', nativeInput,
      { signal: new AbortController().signal, toolUseID: 'finish-task-tool' })
    expect(englishCalls).toEqual(['完成'])
    expect(answer).toEqual({ behavior: 'allow', updatedInput: {
      ...nativeInput, answers: { 'Finish this task?': 'Finish' },
    } })
    expect(context.snapshot().entries.at(-1)).toMatchObject({
      role: 'user/answer', original: '是否完成任务？: 完成', translated: 'Finish this task?: Finish',
      origin: CLAUDE_TRANSLATION_ORIGINS.userAnswer,
    })
  })

  test('keeps hidden question headers and option previews out of translation and history', async () => {
    const batches: string[][] = []
    const { proc } = running({ ...defaultTranslation,
      toChineseFields: async fields => { batches.push(fields); return fields.map(field => `ZH:${field}`) },
    })
    const context = await attachContext(proc)
    const tools: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    const previewInput = { questions: [{ question: 'Choose a layout?', header: 'Layout', options: [
      { label: 'Compact', description: 'A dense layout', preview: '## Compact layout\nFewer blank lines.' },
    ] }] }
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Choose a layout?': 'ZH:Compact' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', previewInput, { signal: new AbortController().signal, toolUseID: 'preview-question' })
    expect(tools[0].input.questions[0].options[0].preview).toBe('## Compact layout\nFewer blank lines.')
    expect(tools[0].displayInput.questions[0].options[0].preview).toBe('## Compact layout\nFewer blank lines.')
    expect(tools[0].displayInput.questions[0].header).toBe('Layout')
    expect(answer.updatedInput.answers).toEqual({ 'Choose a layout?': 'EN:ZH:Compact' })
    expect(answer.updatedInput.questions[0].options[0].preview).toBe('## Compact layout\nFewer blank lines.')
    expect(batches).toEqual([['Choose a layout?', 'Compact', 'A dense layout']])
    expect(JSON.stringify(context.snapshot())).not.toContain('Fewer blank lines.')
    expect(JSON.stringify(context.snapshot())).not.toContain('Layout')
    expect(JSON.stringify(context.snapshot())).toContain('A dense layout')
  })

  test('translates freeform answers and maps delegated stable IDs back to native questions', async () => {
    const { proc } = running()
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'stable-id': '使用自定义方案' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.updatedInput.answers).toEqual({ 'Choose one?': 'EN:使用自定义方案' })
  })

  test('translates delegated original-English option values while preserving the native question key', async () => {
    const { proc } = running()
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.originalInput, answers: { 'Choose one?': 'B' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.updatedInput.answers).toEqual({ 'Choose one?': 'EN:B' })
  })

  test('maps comma-separated multiple selections including commas inside option labels', async () => {
    const { proc } = running()
    const multi = { questions: [{ question: 'Select features?', multiSelect: true, options: [
      { label: 'Read, then write' }, { label: 'Validate' }, { label: 'Skip' },
    ] }] }
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Select features?': 'ZH:Read, then write, ZH:Validate' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', multi, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.updatedInput.answers).toEqual({ 'Select features?': 'EN:ZH:Read, then write, ZH:Validate' })
  })

  test('rejects ambiguous native multi-select representations instead of guessing an option', async () => {
    const { proc, errors } = running()
    const multi = { questions: [{ question: 'Select features?', multiSelect: true, options: [
      { label: 'A' }, { label: 'B' }, { label: 'A, B' },
    ] }] }
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Select features?': 'ZH:A, ZH:B' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', multi, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.behavior).toBe('deny')
    expect(errors[0].message).toContain('ambiguous')
  })

  test('cancels a question before any untranslated content reaches the card', async () => {
    const translation = deferred<string>()
    const { proc, errors } = running({ ...defaultTranslation, toChineseFields: async fields => {
      const text = await translation.promise
      return fields.map(() => text)
    } })
    const context = await attachContext(proc)
    const tools: any[] = []
    proc.on('tool_use', (event: any) => tools.push(event))
    const controller = new AbortController()
    const question = proc.canUseTool('AskUserQuestion', input, { signal: controller.signal, toolUseID: 'question-id' })
    await tick()
    expect(context.snapshot().entries).toEqual([])
    controller.abort()
    translation.resolve('迟到译文')
    await expect(question).resolves.toEqual({ behavior: 'deny', message: 'aborted' })
    expect(tools).toEqual([])
    expect(errors).toEqual([])
    expect(context.snapshot().entries).toEqual([])
  })

  test('answer translation failure denies the tool and remains a visible turn failure', async () => {
    const { proc, errors, results } = running({ ...defaultTranslation, toEnglish: async () => { throw new Error('answer validation rejected：内容未通过') } })
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Choose one?': 'custom answer' } },
    }))
    const answer = await proc.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.behavior).toBe('deny')
    expect(answer.message).toContain('could not translate or validate the answer')
    expect(answer.message).not.toMatch(/\p{Script=Han}/u)
    expect(errors[0].message).toContain('answer validation rejected')
    expect(proc.pendingPermissions.size).toBe(0)
    proc.handleMessage(result())
    expect(results[0].is_error).toBe(true)
  })

  test('cancels answer translation without returning a late answer to the SDK', async () => {
    const translation = deferred<string>()
    const { proc, errors } = running({ ...defaultTranslation, toEnglish: () => translation.promise })
    const context = await attachContext(proc)
    const controller = new AbortController()
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Choose one?': 'custom answer' } },
    }))
    const question = proc.canUseTool('AskUserQuestion', input, { signal: controller.signal, toolUseID: 'question-id' })
    await tick()
    const beforeCancellation = context.snapshot()
    expect(beforeCancellation.entries).toHaveLength(1)
    controller.abort()
    await expect(question).resolves.toEqual({ behavior: 'deny', message: 'aborted' })
    translation.resolve('Late answer')
    await tick()
    expect(proc.pendingPermissions.size).toBe(0)
    expect(errors).toEqual([])
    expect(context.snapshot()).toEqual(beforeCancellation)
  })

  test('ambiguous translated options fail rather than answering the wrong original option', async () => {
    const { proc, errors } = running({ ...defaultTranslation, toChineseFields: async fields => fields.map(() => '相同译文') })
    const answer = await proc.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-id' })
    expect(answer.behavior).toBe('deny')
    expect(errors[0].message).toContain('ambiguous')
  })
})

describe('plain translator provenance at process boundaries', () => {
  test('identifies user, reply, command, tool result and child text in requests and history', async () => {
    const calls: Array<{ text: string; origin: unknown }> = []
    const { proc } = running({
      toEnglish: async (text, _signal, origin) => { calls.push({ text, origin }); return `EN:${text}` },
      toChinese: async (text, _signal, origin) => { calls.push({ text, origin }); return `ZH:${text}` },
      toChineseFields: async (texts, _signal, origin) => { calls.push({ text: texts.join('\n'), origin }); return texts.map(text => `ZH:${text}`) },
    })
    const context = await attachContext(proc)
    proc.sendUserText('用户任务')
    await tick()
    const input = proc.input.items[0]
    await proc.handleTranslatedMessage({ type: 'user', uuid: input.uuid, message: input.message })
    await proc.handleTranslatedMessage(assistant('I will inspect the project.'))
    await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'origin-command', message: { content: [
      { type: 'tool_use', id: 'origin-command-id', name: 'Bash', input: { command: '# desc: Inspect project\npwd' } },
    ] } })
    await proc.handleTranslatedMessage({ type: 'assistant', uuid: 'origin-search', message: { content: [
      { type: 'tool_use', id: 'origin-search-id', name: 'mcp__example__search', input: { description: 'Find the record' } },
    ] } })
    await proc.handleTranslatedMessage({ type: 'user', uuid: 'origin-result', message: { content: [
      { type: 'tool_result', tool_use_id: 'origin-search-id', content: 'Found the requested record.' },
    ] } })
    await proc.handleTranslatedMessage({ ...assistant('The child task is ready.'), uuid: 'origin-child', parent_tool_use_id: 'opaque-parent-id' })
    expect(calls.find(call => call.text === '用户任务')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.userMessage)
    expect(calls.find(call => call.text === 'I will inspect the project.')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.reply)
    expect(calls.find(call => call.text === 'Inspect project')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.commandExplanation)
    expect(calls.find(call => call.text === 'Found the requested record.')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.toolResult)
    expect(calls.find(call => call.text === 'The child task is ready.')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.subagentOutput)
    for (const [original, origin] of [
      ['用户任务', CLAUDE_TRANSLATION_ORIGINS.userMessage],
      ['I will inspect the project.', CLAUDE_TRANSLATION_ORIGINS.reply],
      ['Inspect project', CLAUDE_TRANSLATION_ORIGINS.commandExplanation],
      ['Found the requested record.', CLAUDE_TRANSLATION_ORIGINS.toolResult],
      ['The child task is ready.', CLAUDE_TRANSLATION_ORIGINS.subagentOutput],
    ]) expect(context.snapshot().entries.find(entry => entry.original === original)?.origin).toBe(origin)
    expect(calls.some(call => String(call.origin).includes('opaque-parent-id'))).toBe(false)
  })

  test('delegated requests, questions and answers do not claim to be Feishu-user speech', async () => {
    const origins: unknown[] = []
    const { proc } = running({ ...defaultTranslation,
      toEnglish: async (text, _signal, origin) => { origins.push(origin); return `EN:${text}` },
      toChineseFields: async (fields, _signal, origin) => { origins.push(origin); return fields.map(text => `ZH:${text}`) },
    })
    proc.opts.hostEnv = { LODESTAR_AGENT_ROLE: 'worker' }
    const context = await attachContext(proc)
    proc.sendUserText('Delegated task')
    await tick()
    expect(context.snapshot().entries[0]?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
    proc.on('can_use_tool', (event: any) => proc.sendPermissionResponse(event.request_id, 'allow', {
      updatedInput: { ...event.input, answers: { 'ZH:Proceed?': 'ZH:Yes' } },
    }))
    await proc.canUseTool('AskUserQuestion', { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: 'Proceed now' }] }] },
      { signal: new AbortController().signal, toolUseID: 'delegated-question-origin' })
    expect(origins).toEqual([CLAUDE_TRANSLATION_ORIGINS.delegatedRequest,
      CLAUDE_TRANSLATION_ORIGINS.delegatedQuestion, CLAUDE_TRANSLATION_ORIGINS.delegatedAnswer])
    expect(context.snapshot().entries.find(entry => entry.role === 'assistant/question')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.delegatedQuestion)
    expect(context.snapshot().entries.find(entry => entry.role === 'user/answer')?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.delegatedAnswer)
  })
})
