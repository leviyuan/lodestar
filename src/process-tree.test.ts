import { expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { terminateProcessTree } from './process-tree'

function fakeChild(pid: number | undefined, signals: string[]): Pick<ChildProcess, 'pid' | 'kill'> {
  return { pid, kill: ((signal?: NodeJS.Signals | number) => { signals.push(String(signal)); return true }) as ChildProcess['kill'] }
}

test('Windows terminates the whole tree so a .cmd shim cannot orphan the CLI', () => {
  const signals: string[] = []
  const killed: number[] = []
  const started = terminateProcessTree(fakeChild(4242, signals), 'SIGTERM', undefined, {
    platform: 'win32',
    taskkill: (pid, done) => { killed.push(pid); setImmediate(() => done(null)) },
  })
  expect(started).toBe(true)
  // The caller still awaits close; the direct child is not signalled twice.
  expect(killed).toEqual([4242])
  expect(signals).toEqual([])
})

test('a failing Windows tree kill falls back to the direct signal and reports why', async () => {
  const signals: string[] = []
  const errors: Error[] = []
  terminateProcessTree(fakeChild(7, signals), 'SIGTERM', error => errors.push(error), {
    platform: 'win32',
    taskkill: (_pid, done) => { setImmediate(() => done(new Error('taskkill failed'))) },
  })
  await Bun.sleep(5)
  expect(errors.map(error => error.message)).toEqual(['taskkill failed'])
  expect(signals).toEqual(['SIGTERM'])
})

test('POSIX callers keep signalling the child themselves', () => {
  const signals: string[] = []
  const started = terminateProcessTree(fakeChild(9, signals), 'SIGTERM', undefined, {
    platform: 'darwin',
    taskkill: () => { throw new Error('taskkill must not run on POSIX') },
  })
  expect(started).toBe(false)
  expect(signals).toEqual([])
})

test('a child without a pid is signalled directly', () => {
  const signals: string[] = []
  const started = terminateProcessTree(fakeChild(undefined, signals), 'SIGKILL', undefined, {
    platform: 'win32',
    taskkill: () => { throw new Error('taskkill needs a pid') },
  })
  expect(started).toBe(false)
  expect(signals).toEqual([])
})
