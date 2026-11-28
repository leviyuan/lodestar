import { expect, test } from 'bun:test'

function stopWithRecord(record: string, inspect: string, setup = '') {
  const script = `
    import { writeFileSync } from 'node:fs'
    import { mock } from 'bun:test'
    import { PID_FILE } from './src/paths'
    const { parseDaemonPid } = await import('./src/pid-guard')
    writeFileSync(PID_FILE, ${JSON.stringify(record)})
    const signals = []
    process.kill = (pid, signal) => { signals.push([pid, signal]); return true }
    process.on('exit', () => console.log('SIGNALS=' + JSON.stringify(signals)))
    ${setup}
    mock.module('./src/pid-guard', () => ({ parseDaemonPid, isOurDaemon: () => { ${inspect} } }))
    const { stopDaemon } = await import('./src/stop-command')
    try {
      process.exitCode = await stopDaemon({
        out: text => process.stdout.write(text),
        err: text => process.stderr.write(text),
      })
    } catch (error) {
      process.stderr.write('lodestar stop: ' + (error instanceof Error ? error.message : String(error)) + '\\n')
      process.exitCode = 1
    }
  `
  return Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  })
}

test('stop refuses an old PID record without verified process identity', () => {
  const result = stopWithRecord('12345', 'throw new Error("must not inspect")')
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('拒绝发送停止信号')
  expect(result.stdout.toString()).toContain('SIGNALS=[]')
})

test('stop refuses malformed PID and propagates process inspection failures without signalling', () => {
  const malformed = stopWithRecord('12345other\n/project/daemon.ts', 'return true')
  expect(malformed.exitCode).toBe(1)
  expect(malformed.stderr.toString()).toContain('PID 文件格式坏')
  expect(malformed.stdout.toString()).toContain('SIGNALS=[]')
  const failed = stopWithRecord('12345\n/project/daemon.ts', 'throw new Error("CIM permission denied")')
  expect(failed.exitCode).toBe(1)
  expect(failed.stderr.toString()).toContain('CIM permission denied')
  expect(failed.stdout.toString()).toContain('SIGNALS=[]')
})

test('stop never signals a recycled PID that no longer matches the daemon', () => {
  const result = stopWithRecord('12345\n/project/daemon.ts', 'return false')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('stale 文件')
  expect(result.stdout.toString()).toContain('SIGNALS=[]')
})

/** A synthetic clock: every sleep advances time instantly, so nothing really waits. */
const FAKE_CLOCK = `
  let now = 1_000_000
  Date.now = () => now
  globalThis.setTimeout = (fn, ms = 0) => { now += ms; queueMicrotask(fn); return 0 }
  globalThis.elapsedMs = () => now - 1_000_000
`

// The signal step would run taskkill on Windows; the timing logic is platform independent.
test.skipIf(process.platform === 'win32')('stop waits through the daemon 15-second shutdown deadline before reporting failure', () => {
  // The daemon exits after 14.5 s of its 15 s graceful shutdown.
  const slow = stopWithRecord('12345\n/project/daemon.ts', 'return globalThis.elapsedMs() < 14_500', FAKE_CLOCK)
  expect(slow.stderr.toString()).toBe('')
  expect(slow.exitCode).toBe(0)
  expect(slow.stdout.toString()).toContain('daemon 已停')
  expect(slow.stdout.toString()).toContain('SIGNALS=[[12345,"SIGTERM"]]')
})

test.skipIf(process.platform === 'win32')('stop reports a daemon that outlives the shutdown deadline', () => {
  const stuck = stopWithRecord('12345\n/project/daemon.ts', 'return true', FAKE_CLOCK)
  expect(stuck.exitCode).toBe(1)
  expect(stuck.stderr.toString()).toContain('20s 内 PID 12345 的 daemon 仍未退出')
})
