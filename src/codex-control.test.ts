import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { AppServerOnce } from './usage'

test('short-lived account probes exclude deletion until confirmed close, including failed shutdown and spawn', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    import { PassThrough } from 'node:stream'
    const children = []
    const launches = []
    mock.module('cross-spawn', () => ({ spawn: (bin, args, options) => {
      launches.push({ bin, args, options })
      const child = new EventEmitter()
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, signalCode: null, kill: () => false })
      children.push(child)
      return child
    } }))
    const { AppServerOnce } = await import('./src/usage')
    const { codexAccounts, codexAccountInUse } = await import('./src/codex-accounts')
    const account = codexAccounts.ensure('probe')
    const opts = { accountId: account.id, bin: 'mock-codex', env: {} }
    const first = new AppServerOnce(opts)
    const customArgs = ['-c', 'features.plugins=true', '-c', 'features.apps=true']
    const second = new AppServerOnce({ ...opts, args: customArgs, login: true })
    // Both normal probes and login/custom-argument callers disable startup
    // catalogs last, while retaining account routing and caller settings.
    for (const [index, originalArgs] of [codexAccounts.cliArgs(account.id), customArgs].entries()) {
      assert.equal(launches[index].bin, opts.bin)
      assert.deepEqual(launches[index].args, ['app-server', '--listen', 'stdio://', ...originalArgs,
        '-c', 'features.plugins=false', '-c', 'features.apps=false'])
      assert.equal(launches[index].options.env, opts.env)
      assert.equal(launches[index].options.shell, false)
    }
    assert.equal(codexAccountInUse(account.id), true)
    assert.throws(() => codexAccounts.remove(account.id), /正在使用中/)
    await assert.rejects(first.close(1), /rejected SIGTERM/)
    assert.equal(codexAccountInUse(account.id), true)
    children[0].emit('exit', 0, null)
    assert.equal(first.isAlive(), true)
    children[0].emit('close', 0, null)
    assert.equal(first.isAlive(), false)
    assert.equal(codexAccountInUse(account.id), true)
    children[1].emit('error', new Error('spawn failed'))
    assert.equal(second.isAlive(), false)
    assert.equal(codexAccountInUse(account.id), false)
    codexAccounts.remove(account.id)
    assert.throws(() => codexAccounts.get(account.id), /不存在/)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('server requests cannot masquerade as a matching account/read response', () => {
  const app: any = Object.create(AppServerOnce.prototype)
  EventEmitter.call(app)
  const writes: any[] = []
  const results: any[] = []
  const notifications: string[] = []
  app.buf = ''; app.decoder = new StringDecoder('utf8')
  app.proc = { stdin: { write: (value: string) => writes.push(JSON.parse(value)) } }
  const timer = setTimeout(() => {}, 1000)
  app.pending = new Map([[7, { resolve: (value: any) => results.push(value), reject: () => {}, method: 'account/read', timer }]])
  app.on('notification', (method: string) => notifications.push(method))
  try {
    app.onStdout(Buffer.from(JSON.stringify({ id: 7, method: 'attestation/generate', params: {} }) + '\n'))
    expect(results).toEqual([])
    expect(app.pending.has(7)).toBe(true)
    expect(writes[0]).toMatchObject({ id: 7, error: { code: -32601 } })
    app.onStdout(Buffer.from(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\n'))
    app.onStdout(Buffer.from(JSON.stringify({ id: 7, result: { account: { type: 'chatgpt', planType: 'plus' } } }) + '\n'))
    expect(results).toEqual([{ account: { type: 'chatgpt', planType: 'plus' } }])
    expect(notifications).toEqual(['account/updated'])
    expect(app.pending.has(7)).toBe(false)
  } finally { clearTimeout(timer) }
})

test('incomplete RPC frames produce a protocol error instead of an undefined successful result', () => {
  const app: any = Object.create(AppServerOnce.prototype)
  EventEmitter.call(app)
  app.buf = ''; app.decoder = new StringDecoder('utf8'); app.pending = new Map()
  const errors: Error[] = []
  app.on('protocolError', (error: Error) => errors.push(error))
  app.onStdout(Buffer.from('null\n{"id":1}\nnot json\n'))
  expect(errors).toHaveLength(3)
})
