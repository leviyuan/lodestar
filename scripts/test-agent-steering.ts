/** Native Claude streaming-input probe against a localhost model.
 * No Feishu, live daemon, production credentials, or paid inference.
 * bun scripts/test-agent-steering.ts --agent-runtimes /abs/runtimes --output-dir /abs/new-dir
 */
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const output = option('--output-dir')
const runtimes = option('--agent-runtimes')
assert(output && runtimes && isAbsolute(output) && isAbsolute(runtimes), 'provide absolute --output-dir and --agent-runtimes')
const root = resolve(output)
mkdirSync(root, { mode: 0o700 })
for (const name of ['state', 'claude', 'workspace']) mkdirSync(join(root, name), { mode: 0o700 })
symlinkSync(resolve(runtimes), join(root, 'state', 'agent-runtimes'), 'dir')
const configFile = join(root, 'config.toml')
writeFileSync(configFile, '[feishu]\napp_id="isolated-probe"\napp_secret="synthetic-no-feishu-access"\n', { mode: 0o600 })
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = join(root, 'state')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.LODESTAR_DISABLE_SKILL_SYNC = '1'
const { ClaudeAgentProcess } = await import('../src/claude-agent-process')
const { scrubAnthropicEnv } = await import('../src/token-source')
const proof = join(root, 'workspace', 'proof.txt')
writeFileSync(proof, 'LOCAL_READ_PROOF', { mode: 0o600 })

function response(body: any, content: any, reason: string): Response {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return new Response([
    event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } }),
    event('content_block_delta', { index: 0, delta: content.type === 'text'
      ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } }),
    event('message_stop', {}),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

const report: object[] = []
for (const mode of ['tool-boundary', 'turn-boundary', 'stop'] as const) {
  const nonce = `GUIDANCE-${randomUUID()}`
  let proc: InstanceType<typeof ClaudeAgentProcess>
  let requests = 0
  let failProbe: (error: unknown) => void = () => {}
  let stopReceipt: Promise<any> | undefined
  let stoppedInputId: string | undefined
  const nativeResults: any[] = []
  const lifecycle: any[] = []
  const consumed: Array<{ inputId: string }> = []
  const wire: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    error(error) { failProbe(error); return new Response('probe failure', { status: 400 }) },
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
      if (!path.endsWith('/messages')) return new Response('unexpected endpoint', { status: 404 })
      const body = await req.json() as any
      if (!body.tools?.length) return response(body, { type: 'text', text: 'local helper' }, 'end_turn')
      wire.push(body)
      requests++
      if (requests === 1) {
        assert(await proc.steerUserText(nonce), 'guidance must submit while the original model request is running')
        stoppedInputId = [...(proc as any).steeringInputs][0] as string | undefined
        await new Promise(resolve => setTimeout(resolve, 80))
        assert.equal(consumed.length, 0, 'queued input was mistaken for native consumption')
        if (mode === 'stop') {
          const query = (proc as any).query
          const interrupt = query.interrupt.bind(query)
          query.interrupt = (options: any) => { stopReceipt = interrupt(options); return stopReceipt }
          proc.sendInterrupt()
        }
        return mode === 'tool-boundary'
          ? response(body, { type: 'tool_use', id: 'read_proof', name: 'Read', input: { file_path: proof } }, 'tool_use')
          : response(body, { type: 'text', text: 'FIRST_NATIVE_TURN_COMPLETE' }, 'end_turn')
      }
      if (mode === 'stop') {
        assert(JSON.stringify(body.messages).includes('AFTER_STOP'), 'queued input started after stop')
        assert(!JSON.stringify(body.messages).includes(nonce), 'cancelled guidance reached the model')
      } else {
        assert.equal(consumed.length, 1, 'native input boundary must precede the request using the guidance')
        assert(JSON.stringify(body.messages).includes(nonce), 'next native request must contain the guidance')
        if (mode === 'tool-boundary') {
          assert.equal(nativeResults.length, 0, 'guidance waited for a full turn')
          assert(JSON.stringify(body.messages).includes('LOCAL_READ_PROOF'), 'steering interrupted the original tool')
        }
      }
      return response(body, { type: 'text', text: 'STEERING_COMPLETE' }, 'end_turn')
    },
  })
  proc = new ClaudeAgentProcess({ workDir: join(root, 'workspace'), effort: 'high', model: 'GLM-5.3-Flash', settingSources: [],
    profile: { tools: 'Read', loadProjectMcp: false },
    transformEnv: env => ({ ...scrubAnthropicEnv(env), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_AUTH_TOKEN: 'synthetic-model-token', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-5.3-Flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5.3-Flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM-5.3-Flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' }),
  })
  const original = (proc as any).handleMessage.bind(proc)
  proc.on('user_input_consumed', event => consumed.push(event))
  ;(proc as any).handleMessage = (raw: any) => {
    if (raw.type === 'command_lifecycle') lifecycle.push(raw)
    if (raw.type === 'result') nativeResults.push({ subtype: raw.subtype, user_message_uuid: raw.user_message_uuid,
      user_message_uuids: raw.user_message_uuids, queued_turn_count: raw.queued_turn_count })
    original(raw)
  }
  const run = (text: string): Promise<any> => new Promise((resolve, reject) => {
    const finish = (error: unknown, value?: any) => {
      clearTimeout(timeout)
      proc.off('result', onResult)
      proc.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onResult = (value: any) => finish(null, value)
    const onError = (error: unknown) => finish(error)
    const timeout = setTimeout(() => finish(new Error(`native probe timed out: ${JSON.stringify({ mode, requests, nativeResults, lifecycle })}`)), 30_000)
    failProbe = onError
    proc.on('result', onResult)
    proc.on('error', onError)
    proc.sendUserText(text)
  })
  try {
    let result = await run('Read proof.txt, then finish the local protocol test.')
    if (mode === 'stop') {
      assert(stopReceipt, 'stop did not reach the SDK')
      const receipt = await stopReceipt
      assert.deepEqual(receipt?.still_queued, [])
      assert(receipt.cancelled.includes(stoppedInputId), 'native stop did not confirm cancellation')
      result = await run('AFTER_STOP: finish a fresh request.')
    }
    assert.equal(result.is_error, false, JSON.stringify(result))
    assert.equal(requests, 2)
    assert.equal((proc as any).steeringInputs.size, 0)
    assert.equal(consumed.length, mode === 'stop' ? 0 : 1)
    assert.equal(nativeResults.length, mode === 'tool-boundary' ? 1 : 2)
    report.push({ mode, status: 'PASS', requests, nativeResults: nativeResults.length, consumptionBoundaries: consumed.length })
    console.log(JSON.stringify(report.at(-1)))
  } finally {
    await proc.kill()
    server.stop(true)
    writeFileSync(join(root, `${mode}.json`), JSON.stringify({ nativeResults, lifecycle, consumed, wire }, null, 2), { mode: 0o600 })
  }
}
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(`原生追加输入验证通过：${root}`)
