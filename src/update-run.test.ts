import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { runInstalledAgentUpdate, runLodestarUpdate } from './update-run'

function deps(overrides: Parameters<typeof runLodestarUpdate>[1] = {}) {
  const calls: string[] = []
  const lines: string[] = []
  return { calls, lines, deps: {
    npmInstall: async () => { calls.push('npm'); return 0 },
    updateAgents: async () => { calls.push('in-process agents') },
    installedAgentUpdate: async () => { calls.push('installed agents'); return 0 },
    daemonRunning: () => false,
    print: (line = '') => { lines.push(line) },
    ...overrides,
  } }
}

test('after upgrading the package, Agents are updated by the newly installed updater, not the old in-memory code', async () => {
  const run = deps()
  expect(await runLodestarUpdate([], run.deps)).toBe(0)
  expect(run.calls).toEqual(['npm', 'installed agents'])
})

test('--agents-only updates in process without upgrading the package', async () => {
  const run = deps()
  expect(await runLodestarUpdate(['--agents-only'], run.deps)).toBe(0)
  expect(run.calls).toEqual(['in-process agents'])
  expect(run.lines.some(line => line.includes('Agent 更新完成'))).toBe(true)
})

test('the installed updater exit code is propagated and a failed npm upgrade never updates Agents', async () => {
  const failedAgents = deps({ installedAgentUpdate: async () => 3, daemonRunning: () => true })
  expect(await runLodestarUpdate([], failedAgents.deps)).toBe(3)
  expect(failedAgents.lines.some(line => line.includes('需要重启'))).toBe(false)
  const failedNpm = deps({ npmInstall: async () => 7 })
  await expect(runLodestarUpdate([], failedNpm.deps)).rejects.toThrow('npm exit 7')
  expect(failedNpm.calls).toEqual([])
  await expect(runLodestarUpdate(['--force'], deps().deps)).rejects.toThrow('用法')
})

test('the installed updater is re-executed with the current runtime, script and --agents-only, inheriting stdio', async () => {
  let command: unknown[] = []
  let child!: EventEmitter
  const fake = ((...args: unknown[]) => { command = args; return child = new EventEmitter() }) as unknown as typeof spawn
  const exit = runInstalledAgentUpdate(fake, '/runtime/node', '/global/lodestar-update.js')
  expect(command.slice(0, 2)).toEqual(['/runtime/node', ['/global/lodestar-update.js', '--agents-only']])
  expect(command[2]).toMatchObject({ stdio: 'inherit' })
  child.emit('exit', 5, null)
  expect(await exit).toBe(5)
  const killed = runInstalledAgentUpdate(fake, '/runtime/node', '/global/lodestar-update.js')
  child.emit('exit', null, 'SIGTERM')
  expect(await killed).toBe(1)
  const failed = runInstalledAgentUpdate(fake, '/runtime/node', '/global/lodestar-update.js')
  child.emit('error', new Error('ENOENT'))
  await expect(failed).rejects.toThrow('启动新版 Agent 更新失败')
  await expect(runInstalledAgentUpdate(fake, '/runtime/node', '')).rejects.toThrow('入口路径')
})
