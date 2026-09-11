import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshProcess } from './dsh-process'
import type { DshSpawnOptions } from './dsh-process'
import type { ConversationLaunch } from './conversation'
import { queryDshRuntime } from './dsh-runtime'
import { emptyBgStore, applyBgTaskStarted, applyBgTaskSettled, applyBgToolUse, applyBgToolResult, promotePendingOnAdvance } from './cards/background'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'DSH test cleanup failed')
})

function completion(delta: object, finish = 'stop', model = 'deepseek-v4-flash') {
  return new Response([
    `data: ${JSON.stringify({ id: 'test-completion', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: {
      prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
    } })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function fixture(reply: (body: any, count: number) => Response | Promise<Response>) {
  const dir = await mkdtemp(join(tmpdir(), 'lodestar-dsh-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const requests: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('unexpected endpoint', { status: 404 })
    const body = await req.json()
    requests.push(body)
    return reply(body, requests.length)
  } })
  cleanups.push(async () => { await server.stop(true) })
  const opts: DshSpawnOptions = {
    workDir: dir, tokenSourceId: 'deepseek-harness', model: 'deepseek-v4-flash', effort: 'high',
    allowDelegation: false, profile: { loadProjectMcp: false },
    runtimeOptions: { home: join(dir, 'home') },
    transformEnv: env => ({ ...env, DEEPSEEK_API_KEY: 'local-test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.port}` }),
  }
  function processFor(launch?: ConversationLaunch, overrides: Partial<DshSpawnOptions> = {}) {
    const proc = new DshProcess({ ...opts, ...overrides, launch })
    proc.on('error', () => {})
    cleanups.push(() => proc.kill())
    return proc
  }
  return { dir, opts, requests, processFor, baseUrl: `http://127.0.0.1:${server.port}` }
}

function nextResult(proc: DshProcess): Promise<any> {
  const promise = new Promise((resolve, reject) => {
    const onExit = () => { cleanup(); reject(new Error('DSH exited before result')) }
    const onResult = (result: any) => { cleanup(); resolve(result) }
    const cleanup = () => { proc.off('exit', onExit); proc.off('result', onResult) }
    proc.on('exit', onExit); proc.on('result', onResult)
  })
  void promise.catch(() => {})
  return promise
}

describe('DSH native runtime through Lodestar bridge', () => {
  test('a manually entered DeepSeek model outside the native list resolves effort and runs', async () => {
    const model = 'deepseek-manual-catalog-probe'
    const f = await fixture(() => completion({ content: 'custom model replied' }, 'stop', model))
    const proc = f.processFor(undefined, { model, effort: 'max' })
    await proc.initializationPromise()
    const entry = (await proc.listModels()).find(entry => entry.model === model)
    expect(entry?.supportedReasoningEfforts.map(entry => entry.reasoningEffort)).toContain('max')
    const done = nextResult(proc)
    proc.sendUserText('use the manually entered model')
    expect(await done).toMatchObject({ is_error: false })
    expect(f.requests[0]).toMatchObject({ model, reasoning_effort: 'max' })
    expect(f.requests[0].dsh_plugin_packages?.packages.some((entry: any) => entry.name === '@leviyuan/lodestar' && entry.version)).toBe(true)
  }, 30_000)

  test('GLM Coding Plan models outside the installed pi-ai catalog accept the chosen effort', async () => {
    const model = 'glm-manual-catalog-probe'
    const f = await fixture(() => completion({ content: 'custom GLM replied' }, 'stop', model))
    const proc = f.processFor(undefined, { tokenSourceId: 'dsh-glm', model, effort: 'high',
      transformEnv: env => ({ ...env, LODESTAR_DSH_PROVIDER: 'zai-coding-cn', LODESTAR_DSH_GLM_API_KEY: 'local-test-key',
        LODESTAR_DSH_BASE_URL: f.baseUrl, LODESTAR_DSH_MODELS: JSON.stringify([model]), LODESTAR_DSH_DEFAULT_MODEL: model }) })
    await proc.initializationPromise()
    const done = nextResult(proc)
    proc.sendUserText('use the model missing from the installed catalog')
    expect(await done).toMatchObject({ is_error: false })
    expect(f.requests[0]).toMatchObject({ model, reasoning_effort: 'high', thinking: { type: 'enabled' } })
  }, 30_000)

  test('GLM Coding Plan runs tools, changes effort and resumes through the native pi-ai adapter', async () => {
    const f = await fixture((_body, count) => count === 1 ? completion({ tool_calls: [{ index: 0, id: 'glm-tool', type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({ command: '# desc: 验证 GLM 原生工具调用\nprintf glm-tool-proof', description: 'Return proof' }),
    } }] }, 'tool_calls', 'glm-5.3') : completion({ content: `glm reply ${count}` }, 'stop', 'glm-5.3'))
    const overrides: Partial<DshSpawnOptions> = { tokenSourceId: 'dsh-glm', model: 'glm-5.3', effort: 'low',
      transformEnv: env => ({ ...env, LODESTAR_DSH_PROVIDER: 'zai-coding-cn', LODESTAR_DSH_GLM_API_KEY: 'glm-local-test-key',
        LODESTAR_DSH_BASE_URL: f.baseUrl, LODESTAR_DSH_MODELS: '["glm-5.3"]', LODESTAR_DSH_DEFAULT_MODEL: 'glm-5.3' }) }
    const proc = f.processFor(undefined, overrides)
    await proc.initializationPromise()
    expect((await proc.listModels()).map(m => m.model)).toEqual(['glm-5.3'])
    let done = nextResult(proc)
    proc.sendUserText('remember the GLM lighthouse and run the tool')
    expect(await done).toMatchObject({ is_error: false })
    expect(JSON.stringify(f.requests[1].messages)).toContain('glm-tool-proof')
    expect(f.requests[0]).toMatchObject({ model: 'glm-5.3', reasoning_effort: 'low', thinking: { type: 'enabled' } })
    await proc.setModelSettings('glm-5.3', 'max')
    done = nextResult(proc); proc.sendUserText('continue at max')
    expect(await done).toMatchObject({ is_error: false })
    expect(f.requests[2].reasoning_effort).toBe('max')
    const sessionId = proc.sessionId!
    await proc.kill()
    const resumed = f.processFor({ kind: 'resume', source: { provider: 'dsh', sessionId, cwd: f.dir } }, overrides)
    await resumed.initializationPromise()
    done = nextResult(resumed); resumed.sendUserText('recall the lighthouse')
    expect(await done).toMatchObject({ is_error: false })
    expect(JSON.stringify(f.requests[3].messages)).toContain('remember the GLM lighthouse')
    expect(f.requests.every(body => body.model === 'glm-5.3')).toBe(true)
  }, 30_000)

  test('background child tool content reaches the shared card store after the parent finishes', async () => {
    let parentRequests = 0
    let childRequests = 0
    const f = await fixture(async body => {
      const child = body.messages.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('background-child-probe'))
      if (child) {
        childRequests++
        if (childRequests === 1) {
          await Bun.sleep(100)
          return completion({ tool_calls: [{ index: 0, id: 'bg-bash', type: 'function', function: {
            name: 'bash', arguments: JSON.stringify({ command: '# desc: 验证后台结构化工具结果\nprintf background-proof', description: 'Return background tool proof' }),
          } }] }, 'tool_calls')
        }
        return completion({ content: 'background-child-finished' })
      }
      parentRequests++
      if (parentRequests === 1) return completion({ tool_calls: [{ index: 0, id: 'bg-spawn', type: 'function', function: {
        name: 'subagent', arguments: JSON.stringify({ description: 'Background child probe', prompt: 'background-child-probe', run_in_background: true }),
      } }] }, 'tool_calls')
      return completion({ content: 'parent-released' })
    })
    const proc = f.processFor(undefined, { allowDelegation: true })
    let store = emptyBgStore()
    proc.on('bg_task_started', e => { store = applyBgTaskStarted(store, e) })
    proc.on('assistant_block_stop', e => { if (!e.parentToolUseId) store = promotePendingOnAdvance(store) })
    proc.on('tool_use', e => { if (e.parentToolUseId) store = applyBgToolUse(store, e.parentToolUseId, e.id, e.name, e.input) })
    proc.on('tool_result', e => { if (e.parentToolUseId) store = applyBgToolResult(store, e.parentToolUseId, e.tool_use_id, e.content, e.is_error) })
    const childDone = new Promise<any>((resolve, reject) => {
      proc.once('bg_task_settled', e => { store = applyBgTaskSettled(store, e); resolve(e) })
      proc.once('exit', () => reject(new Error('runtime exited before background child completed')))
    })
    void childDone.catch(() => {})
    await proc.initializationPromise()
    const parentDone = nextResult(proc)
    proc.sendUserText('start the background child')
    expect(await parentDone).toMatchObject({ is_error: false })
    expect(await childDone).toMatchObject({ status: 'completed', summary: 'background-child-finished' })
    expect(proc.isAlive()).toBe(true)
    expect(store.active[0].status).toBe('completed')
    expect(store.active[0].steps.some(step => step.brief.includes('background-proof'))).toBe(true)
  }, 30_000)

  test('a fatal bridge error reports an unexpected exit even when shutdown succeeds', async () => {
    const f = await fixture(() => completion({ content: 'unused' }))
    const proc = f.processFor()
    await proc.initializationPromise()
    const exit = new Promise<any>(resolve => proc.once('exit', resolve))
    ;(proc as any).runtime.emit('notification', { method: 'failure', params: { message: 'native protocol failed' } })
    expect(await exit).toMatchObject({ expected: false })
    expect(proc.isAlive()).toBe(false)
  }, 15_000)

  test('streams multiple turns, persists and resumes exact history, and forks a checkpoint', async () => {
    const f = await fixture((_body, count) => completion({ content: `native reply ${count}` }))
    const proc = f.processFor()
    const chunks: string[] = []
    proc.on('assistant_text', ({ text }) => chunks.push(text))
    await proc.initializationPromise()
    expect(proc.sessionId).toBeTruthy()
    let result = nextResult(proc)
    proc.sendUserText('remember the blue lighthouse')
    const first = await result
    expect(first).toMatchObject({ is_error: false })
    expect(chunks.join('')).toBe('native reply 1')
    expect(proc.lastUsage).toMatchObject({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 10 })
    result = nextResult(proc)
    proc.sendUserText('continue the same conversation')
    expect(await result).toMatchObject({ is_error: false })
    expect(JSON.stringify(f.requests[1].messages)).toContain('remember the blue lighthouse')
    const sessionId = proc.sessionId!
    await proc.kill()
    expect(proc.isAlive()).toBe(false)
    const resumed = f.processFor({ kind: 'resume', source: { provider: 'dsh', sessionId, cwd: f.dir } })
    await resumed.initializationPromise()
    result = nextResult(resumed)
    resumed.sendUserText('after process restart')
    expect(await result).toMatchObject({ is_error: false })
    expect(JSON.stringify(f.requests[2].messages)).toContain('continue the same conversation')
    await resumed.kill()
    const fork = f.processFor({ kind: 'fork', source: { provider: 'dsh', sessionId, cwd: f.dir }, through: first.checkpoint })
    await fork.initializationPromise()
    expect(fork.sessionId).not.toBe(sessionId)
    result = nextResult(fork)
    fork.sendUserText('forked branch')
    expect(await result).toMatchObject({ is_error: false })
    expect(JSON.stringify(f.requests[3].messages)).toContain('remember the blue lighthouse')
    expect(JSON.stringify(f.requests[3].messages)).not.toContain('continue the same conversation')
    const history = await queryDshRuntime({ cwd: f.dir, home: f.opts.runtimeOptions!.home,
      env: f.opts.transformEnv!(process.env), profile: { loadProjectMcp: false } }, 'session/list', { cwd: f.dir })
    expect(history).toHaveLength(2)
    expect(history.every((row: any) => row.provider === 'dsh' && row.cwd === f.dir)).toBe(true)
    expect(history.find((row: any) => row.sessionId === sessionId).preview).toContain('blue lighthouse')
  }, 30_000)

  test('runs a real local shell tool and publishes its result', async () => {
    const f = await fixture((_body, count) => count === 1
      ? completion({ tool_calls: [{ index: 0, id: 'call-shell', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: "# desc: 写入隔离测试文件\nprintf native-tool > proof.txt", description: 'Write isolated proof file' }),
      } }] }, 'tool_calls')
      : completion({ content: 'tool finished' }))
    const proc = f.processFor()
    const results: any[] = []
    proc.on('tool_result', result => results.push(result))
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('write the proof file')
    expect(await result).toMatchObject({ is_error: false })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ tool_use_id: 'call-shell', is_error: false })
    expect(await readFile(join(f.dir, 'proof.txt'), 'utf8')).toBe('native-tool')
  }, 30_000)

  test('answers a native user question and preserves the selected label', async () => {
    const f = await fixture((_body, count) => count === 1
      ? completion({ tool_calls: [{ index: 0, id: 'call-question', type: 'function', function: {
        name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }] }),
      } }] }, 'tool_calls') : completion({ content: 'answer received' }))
    const proc = f.processFor()
    let asked = 0
    proc.on('can_use_tool', request => {
      asked++
      proc.sendPermissionResponse(request.request_id, 'allow', { updatedInput: { answers: { 'Which colour?': 'Blue' } } })
    })
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('ask for a colour')
    expect(await result).toMatchObject({ is_error: false })
    expect(asked).toBe(1)
    expect(JSON.stringify(f.requests[1].messages)).toContain('Blue')
  }, 30_000)

  test('cancels a live model request without losing the process or conversation', async () => {
    let seen!: () => void
    const received = new Promise<void>(resolve => { seen = resolve })
    const f = await fixture((_body, count) => {
      if (count !== 1) return completion({ content: 'continued after cancel' })
      seen()
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) } }),
        { headers: { 'content-type': 'text/event-stream' } })
    })
    const proc = f.processFor()
    await proc.initializationPromise()
    let result = nextResult(proc)
    proc.sendUserText('wait for cancellation')
    await received
    proc.sendInterrupt()
    expect(await result).toMatchObject({ is_error: true, subtype: 'aborted' })
    expect(proc.isAlive()).toBe(true)
    result = nextResult(proc)
    proc.sendUserText('continue now')
    expect(await result).toMatchObject({ is_error: false })
  }, 30_000)

  test('surfaces authentication failure and output limits instead of reporting success', async () => {
    const f = await fixture((_body, count) => count === 1
      ? Response.json({ error: { message: 'test credential rejected', type: 'authentication_error' } }, { status: 401 })
      : completion({ content: 'truncated output' }, 'length'))
    const proc = f.processFor()
    await proc.initializationPromise()
    let result = nextResult(proc)
    proc.sendUserText('fail authentication')
    expect(await result).toMatchObject({ is_error: true, subtype: 'error' })
    result = nextResult(proc)
    proc.sendUserText('hit output cap')
    expect(await result).toMatchObject({ is_error: true, subtype: 'max-tokens' })
  }, 30_000)

  test('stages model changes for the next turn and hides delegation tools in workers', async () => {
    let proc!: DshProcess
    const f = await fixture(async (body, count) => {
      const names = body.tools.map((tool: any) => tool.function.name)
      expect(names).not.toContain('subagent')
      expect(names).not.toContain('subagent_fork')
      expect(names).not.toContain('workflow')
      if (count === 1) {
        await proc.setModelSettings('deepseek-v4-pro', 'off')
        return completion({ tool_calls: [{ index: 0, id: 'route-call', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command: '# desc: 验证当前模型轮次\ntrue', description: 'Check current turn' }),
        } }] }, 'tool_calls')
      }
      return completion({ content: 'route checked' })
    })
    proc = f.processFor()
    await proc.initializationPromise()
    let result = nextResult(proc)
    proc.sendUserText('change the next turn model')
    expect(await result).toMatchObject({ is_error: false })
    expect(f.requests[1].model).toBe('deepseek-v4-flash')
    expect(f.requests[1].reasoning_effort).toBe('high')
    result = nextResult(proc)
    proc.sendUserText('now use the new selection')
    expect(await result).toMatchObject({ is_error: false })
    expect(f.requests[2].model).toBe('deepseek-v4-pro')
    expect(f.requests[2].thinking).toEqual({ type: 'disabled' })
  }, 30_000)

  test('routes Lodestar capability through root-only shell environment', async () => {
    const f = await fixture((_body, count) => count === 1
      ? completion({ tool_calls: [{ index: 0, id: 'call-env', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({
          command: '# desc: 验证主会话凭据环境隔离\ntest -n "$DSH_LODESTAR_AGENT_CONTEXT" && test -z "$LODESTAR_AGENT_CAPABILITY" && printf scoped-context-ok',
          description: 'Verify scoped root environment',
        }),
      } }] }, 'tool_calls') : completion({ content: 'environment checked' }))
    const proc = f.processFor(undefined, { hostEnv: { LODESTAR_AGENT_URL: 'http://127.0.0.1:9876', LODESTAR_AGENT_CAPABILITY: 'test-root-only' } })
    const results: any[] = []
    proc.on('tool_result', value => results.push(value))
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('inspect the scoped environment')
    expect(await result).toMatchObject({ is_error: false })
    expect(results[0]).toMatchObject({ is_error: false })
    expect(JSON.stringify(results[0])).toContain('scoped-context-ok')
  }, 30_000)

  test('fails visibly when an attached image cannot be admitted', async () => {
    const f = await fixture(() => completion({ content: 'must not reach model' }))
    const badImage = join(f.dir, 'invalid.png')
    await writeFile(badImage, 'not an image')
    const proc = f.processFor()
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('read the image', [badImage])
    expect(await result).toMatchObject({ is_error: true })
    expect(f.requests).toHaveLength(0)
  }, 30_000)

  test('admits a JPEG downloaded by Feishu under a .png filename', async () => {
    const f = await fixture(() => completion({ content: 'image accepted' }))
    const image = join(f.dir, 'feishu-download.png')
    await writeFile(image, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCaAK+Kv//Z', 'base64'))
    const proc = f.processFor(undefined, { model: 'deepseek-v4-flash-vision-exp' })
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('inspect the supplied image', [image])
    expect(await result).toMatchObject({ is_error: false })
    expect(f.requests).toHaveLength(1)
  }, 30_000)

  test('uses native manual compaction and keeps the compacted session resumable', async () => {
    const f = await fixture(() => completion({ content: 'A concise summary of the earlier conversation.' }))
    const proc = f.processFor()
    const notices: any[] = []
    proc.on('context_compacted', value => notices.push(value))
    await proc.initializationPromise()
    await expect(proc.compactThread()).rejects.toThrow('无需压缩')
    for (let i = 0; i < 3; i++) {
      const result = nextResult(proc)
      proc.sendUserText(`history ${i}: ${'detailed information '.repeat(1000)}`)
      expect(await result).toMatchObject({ is_error: false })
    }
    await proc.compactThread()
    expect(notices.some(notice => notice.phase === 'end')).toBe(true)
    const sessionId = proc.sessionId!
    await proc.kill()
    const resumed = f.processFor({ kind: 'resume', source: { provider: 'dsh', sessionId, cwd: f.dir } })
    await resumed.initializationPromise()
    const result = nextResult(resumed)
    resumed.sendUserText('continue after compaction')
    expect(await result).toMatchObject({ is_error: false })
  }, 30_000)

  test('native children cannot delegate again or inherit the root capability', async () => {
    let rootRequests = 0
    let childRequests = 0
    const f = await fixture(body => {
      const child = body.messages.some((message: any) => message.role === 'user'
        && typeof message.content === 'string' && message.content.startsWith('child-scope-check'))
      if (child) {
        childRequests++
        const names = body.tools.map((tool: any) => tool.function.name)
        expect(names).not.toContain('subagent')
        expect(names).not.toContain('send_message')
        if (childRequests === 1) return completion({ tool_calls: [{ index: 0, id: 'child-shell', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({
            command: '# desc: 验证子 Agent 没有主会话凭据\ntest -z "$DSH_LODESTAR_AGENT_CONTEXT" && test -z "$LODESTAR_AGENT_CAPABILITY" && printf child-isolated',
            description: 'Verify child capability isolation',
          }),
        } }] }, 'tool_calls')
        return completion({ content: 'child-finished' })
      }
      rootRequests++
      if (rootRequests === 1) return completion({ tool_calls: [{ index: 0, id: 'spawn-child', type: 'function', function: {
        name: 'subagent', arguments: JSON.stringify({ description: 'Check scoped child', prompt: 'child-scope-check', run_in_background: false }),
      } }] }, 'tool_calls')
      return completion({ content: 'root-finished' })
    })
    const proc = f.processFor(undefined, { allowDelegation: true,
      hostEnv: { LODESTAR_AGENT_URL: 'http://127.0.0.1:9876', LODESTAR_AGENT_CAPABILITY: 'root-only-test' } })
    const background: any[] = []
    const toolResults: any[] = []
    const rootText: string[] = []
    proc.on('bg_task_started', value => background.push(value))
    proc.on('tool_result', value => toolResults.push(value))
    proc.on('assistant_text', value => { if (!value.parentToolUseId) rootText.push(value.text) })
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('delegate a scoped task')
    expect(await result).toMatchObject({ is_error: false })
    expect(childRequests).toBe(2)
    expect(background).toHaveLength(1)
    expect(rootText.join('')).toBe('root-finished')
    expect(toolResults.find(result => result.tool_use_id === 'child-shell')).toMatchObject({ is_error: false })
    expect(JSON.stringify(toolResults)).toContain('child-isolated')
  }, 30_000)

  test('loads project MCP over stdio and executes its discovered tool', async () => {
    const f = await fixture((_body, count) => count === 1
      ? completion({ tool_calls: [{ index: 0, id: 'mcp-call', type: 'function', function: {
        name: 'mcp__probe__echo', arguments: JSON.stringify({ text: 'native-mcp' }),
      } }] }, 'tool_calls') : completion({ content: 'MCP worked' }))
    const serverPath = join(f.dir, 'mcp-server.mjs')
    await writeFile(serverPath, `import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
        else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo the test value', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
        else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'mcp echo: ' + request.params.arguments.text }] };
        else throw new Error('unexpected MCP request ' + request.method);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });`)
    await writeFile(join(f.dir, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { command: 'node', args: [serverPath] } } }))
    const proc = f.processFor(undefined, { profile: { loadProjectMcp: true } })
    const results: any[] = []
    proc.on('tool_result', value => results.push(value))
    await proc.initializationPromise()
    const result = nextResult(proc)
    proc.sendUserText('call the local MCP tool')
    expect(await result).toMatchObject({ is_error: false })
    expect(results[0]).toMatchObject({ tool_use_id: 'mcp-call', is_error: false })
    expect(JSON.stringify(results[0])).toContain('mcp echo: native-mcp')
  }, 30_000)
})
