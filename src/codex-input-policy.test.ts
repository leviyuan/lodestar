import { expect, test } from 'bun:test'
import { codexInputFeaturesToDisable, restrictCodexInputTools } from './codex-input-policy'

test('restricts interaction declarations without changing native model, Code Mode, prompts or other tools', () => {
  const catalog = { schema_revision: 'keep', models: [{ slug: 'model-A', tool_mode: 'code_mode_only',
    base_instructions: 'native prompt', default_reasoning_level: 'xhigh', context_window: 258400,
    experimental_supported_tools: ['shell', 'request_user_input_async', 'send_user_message_async', 'send_message_to_user_async', 'web'],
    new_native_field: { keep: true },
  }, { slug: 'model-B', experimental_supported_tools: [] }] }
  const before = structuredClone(catalog)
  const result = restrictCodexInputTools(catalog)
  expect(result).toEqual({ ...catalog, models: [{ ...catalog.models[0], experimental_supported_tools: ['shell', 'web'] }, catalog.models[1]] })
  expect(catalog).toEqual(before)
})

test('rejects missing or malformed native metadata instead of supplying a default tool catalog', () => {
  for (const value of [null, [], {}, { models: [] }, { models: [{}] },
    { models: [{ slug: 'a' }] }, { models: [{ slug: 'a', experimental_supported_tools: ['shell', 12] }] }]) {
    expect(() => restrictCodexInputTools(value)).toThrow()
  }
})

test('disables only interaction feature switches actually offered by the native binary', () => {
  expect(codexInputFeaturesToDisable('code_mode stable true\nsend_async_message removed false\nsend_message_to_user_async under development true\n'))
    .toEqual(['send_message_to_user_async'])
  expect(codexInputFeaturesToDisable('send_async_message experimental false\n')).toEqual(['send_async_message'])
  expect(() => codexInputFeaturesToDisable('')).toThrow()
  expect(() => codexInputFeaturesToDisable('send_message_to_user_async unrecognized')).toThrow()
})

for (const failure of ['cancel', 'upstream']) test(`input-policy preparation ${failure} prevents native Agent startup`, async () => {
  const script = `
    import { mock } from 'bun:test'
    let calls = 0
    mock.module('cross-spawn', () => ({ spawn() { calls++; throw new Error('must not launch') } }))
    mock.module('./src/codex-input-policy', () => ({ prepareCodexInputPolicyCatalog: ({ signal }) =>
      ${failure === 'cancel' ? 'new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))' : 'Promise.reject(new Error("catalog upstream failed"))'}
    }))
    const { CodexProcess } = await import('./src/codex-process')
    const p = new CodexProcess({ workDir: process.cwd(), model: 'test', effort: 'high', allowUserInput: false,
      apiProvider: { id: 'probe', name: 'Probe', baseUrl: 'http://127.0.0.1:1', envKey: 'LODESTAR_TEST_KEY' } })
    const errors = []; p.on('error', error => errors.push(error.message))
    ${failure === 'cancel' ? 'await p.kill()' : 'await p.initializationPromise().catch(() => {}); await p.kill()'}
    console.log(JSON.stringify({ calls, alive: p.isAlive(), errors }))
  `
  const child = Bun.spawn([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.calls).toBe(0)
  expect(result.alive).toBe(false)
  expect(result.errors.join(' ')).toContain(failure === 'cancel' ? 'cancelled' : 'catalog upstream failed')
})

test('unconfirmed catalog-query shutdown remains visible and keeps the process owned', async () => {
  const script = `
    import { mock } from 'bun:test'
    let rejectPreparation, calls = 0
    mock.module('cross-spawn', () => ({ spawn() { calls++; throw new Error('must not launch') } }))
    mock.module('./src/codex-input-policy', () => ({ prepareCodexInputPolicyCatalog: () => new Promise((_resolve, reject) => { rejectPreparation = reject }) }))
    const { CodexProcess } = await import('./src/codex-process')
    const p = new CodexProcess({ workDir: process.cwd(), model: 'test', effort: 'high', allowUserInput: false,
      apiProvider: { id: 'probe', name: 'Probe', baseUrl: 'http://127.0.0.1:1', envKey: 'LODESTAR_TEST_KEY' } })
    const error = await p.kill(5).catch(error => error.message)
    const owned = p.isAlive()
    rejectPreparation(new Error('late cancellation'))
    await p.kill()
    console.log(JSON.stringify({ error, owned, alive: p.isAlive(), calls }))
  `
  const child = Bun.spawn([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.error).toContain('model catalog preparation did not exit')
  expect(result.owned).toBe(true)
  expect(result.alive).toBe(false)
  expect(result.calls).toBe(0)
})
