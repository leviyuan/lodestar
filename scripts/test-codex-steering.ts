/** Native Codex input-consumption boundary against a localhost Responses stub.
 * No real model, credentials, Feishu messages, or live daemon.
 * bun scripts/test-codex-steering.ts --agent-runtimes /abs/runtimes --output-dir /abs/new-dir
 */
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const output = option('--output-dir')
const runtimes = option('--agent-runtimes')
const inputCount = Number(option('--input-count') ?? '1')
assert(Number.isSafeInteger(inputCount) && inputCount >= 1 && inputCount <= 100, 'input-count must be 1–100')
assert(output && runtimes && isAbsolute(output) && isAbsolute(runtimes), 'provide absolute --output-dir and --agent-runtimes')
const root = resolve(output)
mkdirSync(root, { mode: 0o700 })
for (const name of ['workspace', 'state', 'native']) mkdirSync(join(root, name), { mode: 0o700 })
const workDir = join(root, 'workspace')
const nativeHome = join(root, 'native')
symlinkSync(resolve(runtimes), join(root, 'state', 'agent-runtimes'), 'dir')
const configFile = join(root, 'config.toml')
writeFileSync(configFile, '[feishu]\napp_id="isolated-probe"\napp_secret="synthetic-no-feishu-access"\n', { mode: 0o600 })
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
process.env.CODEX_HOME = nativeHome
process.env.LODESTAR_DISABLE_SKILL_SYNC = '1'
writeFileSync(join(nativeHome, 'config.toml'), [
  'cli_auth_credentials_store = "file"', 'web_search = "disabled"', 'sandbox_mode = "danger-full-access"',
  'model = "gpt-5.5"', '[features]', 'code_mode = false',
  `[projects.${JSON.stringify(workDir)}]`, 'trust_level = "trusted"', '',
].join('\n'), { mode: 0o600 })
const { CodexProcess } = await import('../src/codex-process')
const text = `NATIVE_GUIDANCE_${randomUUID()}`
const inputs = Array.from({ length: inputCount }, (_, index) => ({ inputId: randomUUID(), text: `${text}_${index + 1}` }))
const timeline: Array<{ event: string; value?: unknown }> = []
const requests: any[] = []
let proc: InstanceType<typeof CodexProcess>
let fail: (error: unknown) => void = () => {}

function response(items: any[], index: number): Response {
  const result = { id: `response_${index}`, object: 'response', status: 'completed', output: items,
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } }
  const events: object[] = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }]
  for (const [output_index, item] of items.entries()) {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } })
    if (item.type === 'message') {
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } })
      events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text })
    }
    events.push({ type: 'response.output_item.done', output_index, item })
  }
  events.push({ type: 'response.completed', response: result })
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const message = (text: string, index: number) => ({ type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  error(error) { fail(error); return new Response('probe failure', { status: 400 }) },
  async fetch(req) {
    assert(new URL(req.url).pathname.endsWith('/responses'), 'unexpected endpoint')
    const body = await req.json() as any
    requests.push(body)
    if (requests.length === 1) {
      for (const input of inputs) assert(await proc.steerUserText(input.text, [], input.inputId))
      timeline.push({ event: 'submitted' })
      await new Promise(resolve => setTimeout(resolve, 80))
      assert(!timeline.some(entry => entry.event === 'consumed'), 'request ACK is not a native input boundary')
      return response([message('BEFORE_CONSUMPTION', 1), {
        type: 'function_call', id: 'tool_probe', call_id: 'call_probe', name: 'exec_command',
        arguments: JSON.stringify({ cmd: '# desc: 输出本地消费边界验收标记\nprintf native-tool-result', workdir: workDir, yield_time_ms: 1000 }),
      }], 1)
    }
    assert.equal(requests.length, 2, 'unexpected extra inference')
    for (const input of inputs) assert(JSON.stringify(body.input).includes(input.text), 'guidance missing from the next request')
    assert.equal(timeline.filter(entry => entry.event === 'consumed').length, inputCount, 'not all native input boundaries preceded model continuation')
    return response([message('AFTER_CONSUMPTION', 2)], 2)
  },
})
proc = new CodexProcess({ workDir, model: 'gpt-5.5', effort: 'high', launch: { kind: 'fresh' },
  apiProvider: { id: 'steering_probe', name: 'Local steering probe', baseUrl: `http://127.0.0.1:${server.port}/v1`, envKey: 'LODESTAR_STEERING_PROBE_KEY' },
  transformEnv: env => ({ ...env, CODEX_SQLITE_HOME: nativeHome, LODESTAR_STEERING_PROBE_KEY: 'synthetic-model-token',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }),
})
proc.on('user_input_consumed', event => { assert(inputs.some(input => input.inputId === event.inputId)); timeline.push({ event: 'consumed', value: event }) })
proc.on('input_batch_end', event => timeline.push({ event: 'batch-end', value: event }))
proc.on('assistant_text', event => timeline.push({ event: 'text', value: event.text }))
let timeout: ReturnType<typeof setTimeout> | undefined
let passed = false
try {
  const done = new Promise<any>((resolve, reject) => {
    fail = reject
    proc.on('result', resolve)
    proc.on('error', reject)
    timeout = setTimeout(() => reject(new Error('Codex input consumption probe timed out')), 30_000)
  })
  proc.sendUserText('Print the local probe marker, then finish.')
  const result = await done
  assert.equal(result.is_error, false, JSON.stringify(result))
  const consumedAt = timeline.findIndex(entry => entry.event === 'consumed')
  const beforeAt = timeline.findIndex(entry => entry.value === 'BEFORE_CONSUMPTION')
  const afterAt = timeline.findIndex(entry => entry.value === 'AFTER_CONSUMPTION')
  assert(consumedAt > beforeAt && beforeAt >= 0, 'pre-consumption assistant output crossed the native input boundary')
  assert(afterAt > consumedAt, 'post-consumption output precedes the boundary')
  assert.deepEqual(timeline.filter(entry => entry.event === 'consumed').map(entry => (entry.value as any).inputId), inputs.map(input => input.inputId))
  const batchEnd = timeline.findIndex(entry => entry.event === 'batch-end')
  const consumedIndices = timeline.flatMap((entry, index) => entry.event === 'consumed' ? [index] : [])
  assert(consumedIndices.every(index => index < batchEnd), 'batch ended before the consecutive inputs were consumed')
  assert(batchEnd < afterAt, 'batch end arrived after the new output')
  assert.equal(timeline.filter(entry => entry.event === 'batch-end').length, 1)
  passed = true
  console.log(JSON.stringify({ status: 'PASS', inputCount, timeline, requests: requests.length }))
} finally {
  clearTimeout(timeout)
  await proc.kill()
  server.stop(true)
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: passed ? 'PASS' : 'FAIL', timeline, requests }, null, 2), { mode: 0o600 })
}
