import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReclaudeRecoveryWatch, reclaudeWatchStatePath } from './reclaude-watch'

const recovered = { output: 'RECLAUDE_OK', costUsd: 0.002, inputTokens: 100, outputTokens: 3 }

test('failed probes stay visible; recovery is saved before notifying and notification retries never call the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reclaude-watch-test-'))
  const file = join(dir, 'state.json')
  let probes = 0
  let notifications = 0
  const messages: string[] = []
  const options = { project: 'test-group', model: 'opus', file, log: (message: string) => messages.push(message) }
  try {
    const watch = new ReclaudeRecoveryWatch({ ...options,
      probe: async () => { if (++probes === 1) throw new Error('HTTP 503 gateway_unavailable'); return recovered },
      notify: async () => {
        notifications++
        expect(JSON.parse(readFileSync(file, 'utf8')).recovered.output).toBe('RECLAUDE_OK')
        throw new Error('notify HTTP 502')
      },
    })
    expect(await watch.step()).toBe('waiting')
    expect(notifications).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).lastError).toContain('gateway_unavailable')
    expect(await watch.step()).toBe('notify_pending')
    expect(probes).toBe(2)
    expect(await watch.step()).toBe('notify_pending')
    expect(probes).toBe(2)

    const resumed = new ReclaudeRecoveryWatch({ ...options,
      probe: async () => { throw new Error('must not spend quota after recovery') },
      notify: async () => { notifications++; return 'om_confirmed' },
    })
    expect(await resumed.step()).toBe('done')
    expect(JSON.parse(readFileSync(file, 'utf8')).notified.messageId).toBe('om_confirmed')
    expect(await resumed.step()).toBe('done')
    expect(notifications).toBe(3)
    const finished = new ReclaudeRecoveryWatch({ ...options,
      probe: async () => { throw new Error('unexpected probe after restart') },
      notify: async () => { throw new Error('unexpected duplicate notification') },
    })
    expect(await finished.step()).toBe('done')
    expect(messages.some(message => message.includes('HTTP 503'))).toBe(true)
    expect(messages.some(message => message.includes('notify HTTP 502'))).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('invalid state, mismatched targets and cancellation never start another probe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reclaude-watch-invalid-'))
  const file = join(dir, 'state.json')
  const controller = new AbortController()
  let probes = 0
  const options = { project: 'test-group', model: 'opus', file, log: () => {},
    probe: async () => { probes++; return recovered }, notify: async () => 'om_test', signal: controller.signal }
  try {
    writeFileSync(file, '{broken')
    expect(() => new ReclaudeRecoveryWatch(options)).toThrow()
    writeFileSync(file, JSON.stringify({ version: 1, project: 'wrong-group', model: 'opus', attempts: 0 }))
    expect(() => new ReclaudeRecoveryWatch(options)).toThrow('目标不匹配')
    rmSync(file)
    const watch = new ReclaudeRecoveryWatch(options)
    controller.abort(new Error('stopped'))
    await expect(watch.step()).rejects.toThrow('stopped')
    expect(probes).toBe(0)
    expect(reclaudeWatchStatePath('../one', 'opus')).not.toBe(reclaudeWatchStatePath('one', 'opus'))
    expect(reclaudeWatchStatePath('one', 'opus')).not.toBe(reclaudeWatchStatePath('one', 'haiku'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('native SDK probes disable tools, extra retries and persistence; notification requires a real receipt', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { join } from 'node:path'
    const config = await import('./src/config')
    const fixture = { ...config.config, token_sources: { reclaude: { auth: 'reclaude-login' } } }
    mock.module('./src/config', () => ({ ...config, loadConfig: () => fixture }))
    const source = await import('./src/token-source-reclaude')
    mock.module('./src/token-source-reclaude', () => ({ ...source, createReclaudeSource: () => ({
      refreshModels: async () => {}, modelCatalogState: { status: 'ready' },
      models: [{ model: 'opus', defaultEffort: 'max' }], spawnEnv: env => env,
      claudeSettings: { env: { HTTPS_PROXY: 'http://127.0.0.1:12345' } },
    }) }))
    let options, closed = 0, failed = false
    const updates = await import('./src/agent-updates')
    mock.module('./src/agent-updates', () => ({ ...updates, loadClaudeSdk: async () => ({ query: args => {
      options = args.options
      const q = (async function* () {
        yield failed ? { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['gateway unavailable'] }
          : { type: 'result', is_error: false, subtype: 'success', result: 'RECLAUDE_OK', total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 3 } }
      })()
      q.close = () => { closed++ }
      return q
    } }) }))
    let status = 200, receipt = { ok: true, message_id: 'om_real' }, sent
    const network = await import('./src/network')
    mock.module('./src/network', () => ({ ...network, localFetch: async (url, options) => {
      assert.equal(String(url), 'http://127.0.0.1:9876/notify')
      sent = JSON.parse(options.body)
      return Response.json(receipt, { status })
    } }))
    const { probeReclaudeModel, notifyReclaudeRecovery } = await import('./src/reclaude-watch')
    const signal = new AbortController().signal
    const result = await probeReclaudeModel('opus', join(process.env.LODESTAR_DATA_DIR, 'probe'), signal)
    assert.equal(result.output, 'RECLAUDE_OK')
    assert.equal(closed, 1)
    assert.equal(options.persistSession, false)
    assert.equal(options.maxTurns, 1)
    assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES, '0')
    assert.deepEqual(options.tools, [])
    assert.deepEqual(options.settingSources, [])
    assert.deepEqual(options.mcpServers, {})
    assert.equal(options.strictMcpConfig, true)
    assert.ok(options.title)
    failed = true
    await assert.rejects(probeReclaudeModel('opus', join(process.env.LODESTAR_DATA_DIR, 'probe'), signal), /gateway unavailable/)
    assert.equal(closed, 2)
    const data = { ...result, at: new Date().toISOString() }
    assert.equal(await notifyReclaudeRecovery('test-group', 'opus', data, signal), 'om_real')
    assert.equal(sent.project, 'test-group')
    assert.equal(sent.title, 'ReClaude 已恢复')
    status = 502
    await assert.rejects(notifyReclaudeRecovery('test-group', 'opus', data, signal), /HTTP 502/)
    status = 200; receipt = { ok: true }
    await assert.rejects(notifyReclaudeRecovery('test-group', 'opus', data, signal), /有效投递回执/)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
