import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test } from 'bun:test'
import { AgentInstallTerminationError, installAgentPackages, terminateWindowsInstaller } from './agent-install'

function installer() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (_signal?: string) => { throw new Error('Windows cancellation must not kill only the npm wrapper') },
  })
  let spawns = 0
  const spawn = ((command: string, args: string[], options: any) => {
    spawns++
    expect(command).toBe('npm')
    expect(args).toContain('--prefix')
    expect(options.shell).toBe(false)
    return child
  }) as unknown as NonNullable<Parameters<typeof installAgentPackages>[2]>['spawn']
  return { child, spawn, spawns: () => spawns }
}

test('an already-aborted update never starts npm', async () => {
  const h = installer()
  const controller = new AbortController()
  controller.abort(new Error('already stopped'))
  await expect(installAgentPackages('/private/staging', controller.signal, { spawn: h.spawn })).rejects.toThrow('already stopped')
  expect(h.spawns()).toBe(0)
})

test('Windows abort waits for both its exact installer tree and stdio to finish', async () => {
  const h = installer()
  const controller = new AbortController()
  let releaseTree!: () => void
  const tree = new Promise<void>(resolve => { releaseTree = resolve })
  const pids: number[] = []
  let settled = false
  const installing = installAgentPackages('/private/staging', controller.signal, {
    platform: 'win32', spawn: h.spawn,
    terminateWindows: async pid => { pids.push(pid); await tree },
  })
  const failed = installing.catch(error => { settled = true; return error })
  controller.abort()
  await Promise.resolve()
  expect(pids).toEqual([12345])
  h.child.emit('close', 1, null)
  await Promise.resolve()
  expect(settled).toBe(false)
  releaseTree()
  const error = await failed
  expect(error.message).toContain('install aborted')
  expect(error).not.toBeInstanceOf(AgentInstallTerminationError)
})

test('Windows installation timeout also terminates the installer tree', async () => {
  const h = installer()
  const pids: number[] = []
  await expect(installAgentPackages('/private/staging', undefined, {
    platform: 'win32', spawn: h.spawn, timeoutMs: 1,
    terminateWindows: async pid => { pids.push(pid); h.child.emit('close', 1, null) },
  })).rejects.toThrow('timed out after 1ms')
  expect(pids).toEqual([12345])
})

test('a failed Windows tree termination explicitly forbids cleanup of occupied EXEs', async () => {
  const h = installer()
  const controller = new AbortController()
  const installing = installAgentPackages('/private/staging', controller.signal, {
    platform: 'win32', spawn: h.spawn,
    terminateWindows: async () => { throw new Error('Access is denied') },
  })
  const failed = installing.catch(error => error)
  controller.abort()
  const error = await failed
  expect(error).toBeInstanceOf(AgentInstallTerminationError)
  expect(error.message).toContain('PID 12345 termination unconfirmed')
  expect(error.message).toContain('Access is denied')
  expect(error.message).toContain('partial directory retained: /private/staging')
})

test('successful taskkill without stdio closure cannot report cleanup-safe termination', async () => {
  const h = installer()
  const controller = new AbortController()
  const installing = installAgentPackages('/private/staging', controller.signal, {
    platform: 'win32', spawn: h.spawn, terminationTimeoutMs: 1,
    terminateWindows: async () => {},
  })
  const failed = installing.catch(error => error)
  controller.abort()
  const error = await failed
  expect(error).toBeInstanceOf(AgentInstallTerminationError)
  expect(error.message).toContain('stdio did not close')
})

test('late abort after npm closes cannot target an exited or reused PID', async () => {
  const h = installer()
  const controller = new AbortController()
  let kills = 0
  const installing = installAgentPackages('/private/staging', controller.signal, {
    platform: 'win32', spawn: h.spawn,
    terminateWindows: async () => { kills++ },
  })
  h.child.emit('close', 0, null)
  controller.abort()
  await installing
  expect(kills).toBe(0)
})

test('npm failures retain installation diagnostics', async () => {
  const h = installer()
  const installing = installAgentPackages('/private/staging', undefined, { spawn: h.spawn })
  h.child.stderr.write('native.exe: EPERM')
  h.child.emit('close', 1, null)
  await expect(installing).rejects.toThrow('native.exe: EPERM')
})

test('Windows termination rejects non-specific process targets before invoking taskkill', async () => {
  for (const pid of [0, -1, NaN, Infinity, 1.5]) {
    await expect(terminateWindowsInstaller(pid)).rejects.toThrow('Invalid npm installer PID')
  }
})
