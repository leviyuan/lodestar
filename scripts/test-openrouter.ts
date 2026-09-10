/** 真实 OpenRouter / Claude SDK smoke；读取私有 Key 文件，在临时目录执行 Read。
 * 用法：bun scripts/test-openrouter.ts --credential /abs/key.json --output-dir /abs/private-dir [--model vendor/model] [--capture-requests]
 * --sequence vendor/model,vendor/model 在同一原生会话中按顺序切换，验证 resume 和上下文。
 * 会产生模型调用费用；不连接飞书、不启动 daemon、不改生产会话状态。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
function option(name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const credential = option('--credential')
const output = option('--output-dir')
if (!credential || !output || !isAbsolute(credential) || !isAbsolute(output)) throw new Error('必须提供 --credential 和 --output-dir 的绝对路径')
const root = resolve(output)
mkdirSync(root, { recursive: true, mode: 0o700 })
process.env.LODESTAR_DATA_DIR = join(root, 'state')
const key: unknown = JSON.parse(readFileSync(resolve(credential), 'utf8')).api_key
if (typeof key !== 'string' || !key.trim()) throw new Error('私有凭据文件缺少 api_key')
const { createAgentProcess } = await import('../src/agent-launch')
const { collectAgentTurn } = await import('../src/agent-runner')
const { registerTokenSource, tokenSourceFactories } = await import('../src/token-source')
const { OPENROUTER_DEFAULT_MODELS } = await import('../src/openrouter-defaults')
await import('../src/token-source-openrouter')
// 可选的临时转发探针只记录实际发出的模型/effort/预算；正文与凭据不写入报告。
const wire: Array<Record<string, unknown>> = []
const gateway = args.includes('--capture-requests') ? Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(incoming) {
    const url = new URL(incoming.url)
    const body = incoming.method === 'POST' ? await incoming.text() : undefined
    let captured: Record<string, unknown> | undefined
    if (body && url.pathname === '/v1/messages') {
      const json = JSON.parse(body)
      captured = { model: json.model, output_config: json.output_config ?? null,
        thinking: json.thinking ?? null, max_tokens: json.max_tokens }
      wire.push(captured)
      writeFileSync(join(root, 'wire.json'), JSON.stringify(wire, null, 2), { mode: 0o600 })
    }
    const headers = new Headers(incoming.headers)
    headers.delete('host'); headers.delete('content-length')
    headers.set('accept-encoding', 'identity')
    try {
      const response = await fetch(`https://openrouter.ai/api${url.pathname}${url.search}`, {
        method: incoming.method, headers, body, signal: incoming.signal,
      })
      if (captured) captured.status = response.status
      const returned = new Headers(response.headers)
      returned.delete('content-encoding'); returned.delete('content-length')
      return new Response(response.body, { status: response.status, headers: returned })
    } catch (error) {
      const message = String(error).replaceAll(key, '[redacted]')
      console.error(`probe upstream transport failure: ${message}`)
      if (captured) { captured.status = 502; captured.transportError = message }
      return Response.json({ type: 'error', error: { type: 'api_error', message } }, { status: 502 })
    } finally {
      writeFileSync(join(root, 'wire.json'), JSON.stringify(wire, null, 2), { mode: 0o600 })
    }
  },
}) : null
try {
  const source = tokenSourceFactories().find(entry => entry.kind === 'openrouter')!.build({ api_key: key,
    ...(gateway ? { base_url: `http://127.0.0.1:${gateway.port}` } : {}) })
  await source.refreshModels()
  if (source.modelCatalogState?.status !== 'ready') throw new Error(source.modelCatalogState?.error ?? 'catalog MISS')
  registerTokenSource(source)
  const filter = option('--model')
  const sequence = option('--sequence')
  if (filter && sequence) throw new Error('--model 和 --sequence 不能同时使用')
  const entries = sequence ? sequence.split(',').map(id => {
    const entry = OPENROUTER_DEFAULT_MODELS.find(entry => entry.model === id)
    if (!entry) throw new Error(`顺序测试模型不在默认九项中: ${id}`)
    return entry
  }) : filter ? OPENROUTER_DEFAULT_MODELS.filter(entry => entry.model === filter) : OPENROUTER_DEFAULT_MODELS
  if (!entries.length) throw new Error('指定模型不在默认九项中')
  const results: Array<Record<string, unknown>> = []
  let previousSessionId: string | undefined
  let previousMarker: string | undefined
  for (const entry of entries) {
    const dir = join(root, sequence ? 'conversation' : entry.model.replaceAll('/', '--'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const nonce = `LODESTAR-${randomUUID()}`
    writeFileSync(join(dir, 'probe.txt'), nonce + '\n', { mode: 0o600 })
    const tools: string[] = []
    let toolErrors = 0
    const wireStart = wire.length
    const result: Record<string, unknown> = { model: entry.model, effort: entry.effort }
    console.log(`TEST ${entry.model} / ${entry.effort}`)
    try {
      const { process: proc } = createAgentProcess({
        provider: 'claude', tokenSourceId: source.id, workDir: dir, model: entry.model, effort: entry.effort,
        ...(previousSessionId ? { launch: { kind: 'resume', source: { provider: 'claude', sessionId: previousSessionId, cwd: dir } } as const } : {}),
        profile: { tools: 'Read', loadProjectMcp: false }, allowDelegation: false,
        hostEnv: { CLAUDE_CONFIG_DIR: join(dir, 'claude-state'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' },
      })
      proc.on('tool_use', event => { tools.push(String(event.name)) })
      proc.on('tool_result', event => { if (event.is_error) toolErrors++ })
      const handle = collectAgentTurn(proc,
        'Integration test. Read the file probe.txt in the current directory using the Read tool. '
          + (previousMarker ? 'Reply with the previous turn\'s file marker from our conversation, then the current file marker, copied verbatim.' : 'Return its exact contents.')
          + ' Do not infer the contents, do not read any other files, and do not perform any other work.',
        {}, () => {})
      const timer = setTimeout(() => { void handle.cancel('OpenRouter smoke exceeded 90 seconds') }, 90_000)
      try {
        const completed = await handle.done
        if (!tools.includes('Read') || !completed.output.includes(nonce)) throw new Error('Read 工具与文件随机值校验失败')
        if (previousMarker && (!completed.output.includes(previousMarker) || completed.sessionId !== previousSessionId)) {
          throw new Error('原生 resume 未保留 session id 或上一轮上下文')
        }
        if (gateway) {
          const expected = entry.effort === 'default' ? undefined : entry.effort
          const calls = wire.slice(wireStart)
          if (!calls.length || calls.some(call => call.model !== entry.model
            || (call.output_config as { effort?: string } | null)?.effort !== expected)) {
            throw new Error('实际请求的 model/effort 与所选项不一致：' + JSON.stringify(calls))
          }
          result.wireRequests = calls.length
          result.httpErrorsRecovered = calls.filter(call => typeof call.status === 'number' && call.status >= 400).length
        }
        Object.assign(result, { ok: true, tools, toolErrors, seconds: completed.durationMs / 1000,
          usage: completed.usage, modelUsage: proc.lastModel, contextWindow: proc.lastContextWindow,
          ...(previousSessionId ? { resumed: true, historyPreserved: true } : {}) })
        if (sequence) { previousSessionId = completed.sessionId; previousMarker = nonce }
      } finally { clearTimeout(timer) }
    } catch (error) {
      Object.assign(result, { ok: false, tools, error: String(error).replaceAll(key, '[redacted]') })
    }
    results.push(result)
    writeFileSync(join(root, 'sdk-results.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(result))
  }
  console.log(`RESULT ${results.filter(result => result.ok).length}/${results.length}`)
  if (results.some(result => !result.ok)) process.exitCode = 1
} finally { if (gateway) await gateway.stop(false) }
