import { expect, test } from 'bun:test'

function stopWithRecord(record: string, inspect: string) {
  const script = `
    import { writeFileSync } from 'node:fs'
    import { mock } from 'bun:test'
    import { PID_FILE } from './src/paths'
    const { parseDaemonPid } = await import('./src/pid-guard')
    writeFileSync(PID_FILE, ${JSON.stringify(record)})
    const signals = []
    process.kill = (pid, signal) => { signals.push([pid, signal]); return true }
    process.on('exit', () => console.log('SIGNALS=' + JSON.stringify(signals)))
    mock.module('./src/pid-guard', () => ({ parseDaemonPid, isOurDaemon: () => { ${inspect} } }))
    await import('./src/stop-cli')
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
