import { expect, test } from 'bun:test'

test('setup reports asynchronous daemon spawn failure and only returns a PID after the spawn event', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    import * as cp from 'node:child_process'
    import * as fs from 'node:fs'
    import { mock } from 'bun:test'
    const originalExists = fs.existsSync
    mock.module('node:fs', () => ({ ...fs, existsSync(path) {
      if (String(path).endsWith('lodestar.js')) return true
      return originalExists(path)
    } }))
    mock.module('node:readline/promises', () => ({ createInterface: () => ({ close() {} }) }))
    let mode = 'error'
    let child
    let unrefs = 0
    mock.module('node:child_process', () => ({ ...cp, spawn() {
      child = new EventEmitter()
      child.pid = 12345
      child.unref = () => { unrefs++ }
      if (mode === 'error') queueMicrotask(() => child.emit('error', new Error('spawn EACCES')))
      return child
    } }))
    const { spawnDaemonDetached } = await import('./src/setup')
    assert.deepEqual(await spawnDaemonDetached(), { error: 'spawn EACCES' })
    assert.equal(unrefs, 0)
    mode = 'success'
    let settled = false
    const pending = spawnDaemonDetached().then(result => { settled = true; return result })
    await Promise.resolve()
    assert.equal(settled, false)
    child.emit('spawn')
    assert.deepEqual(await pending, { pid: 12345 })
    assert.equal(unrefs, 1)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
