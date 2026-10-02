import { describe, expect, test } from 'bun:test'
import { parseLaunchctlList, parseMacMemory, parseProcessElapsed, readMacMemory, readMacServices } from './sysinfo'
import { consoleHostContent, consoleHostElement } from './cards/console'

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                10000.
Pages active:                             200000.
Pages inactive:                           150000.
Pages speculative:                         10000.
Pages wired down:                         100000.
Pages purgeable:                           10000.
File-backed pages:                       160000.
Anonymous pages:                         200000.
Pages stored in compressor:              400000.
Pages occupied by compressor:            100000.
`

const launchList = `PID\tStatus\tLabel
123\t-9\tcc-running
-\t0\tcc-scheduled
-\t1\tcodex-failed
-\t-15\tcodex-terminated
456\t0\tcom.apple.Finder
-\t0\tcom.example.other
`

describe('macOS host snapshot', () => {
  test('uses real page size, excludes reclaimable cache and counts compressed physical pages once', () => {
    const mem = parseMacMemory(vmStat, 16 * 1024 ** 3)
    expect(mem.usedBytes).toBe(6_389_760_000)
    expect(mem.availBytes).toBe(10_790_109_184)
    expect(mem.percent).toBe(37)
    const intel = parseMacMemory(vmStat.replace('16384 bytes', '4096 bytes'), 16 * 1024 ** 3)
    expect(intel.usedBytes).toBe(1_597_440_000)
    expect(intel.percent).toBe(9)
  })

  test('missing or invalid macOS memory counters cannot become zero or a healthy snapshot', () => {
    for (const key of ['Anonymous pages', 'Pages purgeable', 'Pages wired down', 'Pages occupied by compressor']) {
      expect(() => parseMacMemory(vmStat.replace(new RegExp(`^${key}:.*\\n`, 'm'), ''), 16 * 1024 ** 3)).toThrow(key)
    }
    expect(() => parseMacMemory('', 16 * 1024 ** 3)).toThrow('page size')
    expect(() => parseMacMemory(vmStat, 0)).toThrow('总量')
    expect(() => parseMacMemory(vmStat, NaN)).toThrow('总量')
    expect(() => parseMacMemory(vmStat, 1024)).toThrow('范围')
    expect(() => parseMacMemory(vmStat.replace('200000.\nPages stored', '1000.\nPages stored'), 16 * 1024 ** 3)).toThrow('范围')
  })

  test('memory command failure returns a missing value', async () => {
    expect(await readMacMemory(async () => { throw new Error('vm_stat denied') })).toBeNull()
    expect(await readMacMemory(async () => 'invalid output')).toBeNull()
  })

  test('launchd state follows current PID and preserves exit codes, signals and unknown start history', () => {
    const services = parseLaunchctlList(launchList)
    expect(services.map(s => s.name)).toEqual(['cc-running', 'cc-scheduled', 'codex-failed', 'codex-terminated'])
    expect(services[0]).toMatchObject({ pid: 123, active: 'active', sub: 'running', hasStarted: true, lastExitStatus: -9 })
    expect(services[1]).toMatchObject({ pid: null, active: 'inactive', hasStarted: null, lastActiveAgoSec: null })
    expect(services[2]).toMatchObject({ active: 'failed', lastExitStatus: 1 })
    expect(services[3]).toMatchObject({ active: 'failed', sub: 'signal', lastExitStatus: -15 })
    expect(parseLaunchctlList('PID Status Label\n')).toEqual([])
    for (const output of ['', 'permission denied', 'PID Status Label\n0 0 cc-invalid', 'PID Status Label\n- unknown cc-bad']) {
      expect(() => parseLaunchctlList(output)).toThrow()
    }
  })

  test('BSD process elapsed supports minutes, hours, days and zero without parsing calendar dates', () => {
    expect([...parseProcessElapsed('10 00:00\n11 02:03\n12 04:05:06\n13 7-08:09:10\n')]).toEqual([
      [10, 0], [11, 123], [12, 14_706], [13, 634_150],
    ])
    for (const bad of ['1 nonsense', '1 01:60', '1 60:00', '1 1-02:03', '1 1-24:00:00', '0 00:00']) {
      expect(() => parseProcessElapsed(bad)).toThrow()
    }
  })

  test('launchd sampling batches active PIDs and keeps inactive scheduled jobs visible', async () => {
    const calls: unknown[] = []
    const result = await readMacServices(async (file, args) => {
      calls.push([file, args])
      if (file === '/bin/launchctl') return launchList + '789\t0\tcodex-running\n'
      return '123 02:03\n789 1-00:00:01\n'
    })
    expect(result.error).toBeNull()
    expect(calls).toEqual([
      ['/bin/launchctl', ['list']],
      ['/bin/ps', ['-p', '123,789', '-o', 'pid=,etime=']],
    ])
    expect(result.services.find(s => s.name === 'cc-running')).toMatchObject({ stateAgoSec: 123, lastActiveAgoSec: 123 })
    expect(result.services.find(s => s.name === 'codex-running')).toMatchObject({ stateAgoSec: 86_401 })
    expect(result.services.find(s => s.name === 'cc-scheduled')).toMatchObject({ stateAgoSec: null, hasStarted: null })
    expect(result.services[0]).not.toHaveProperty('pid')
  })

  test('unavailable launchctl is an error; a successful empty listing does not run ps', async () => {
    const failure = await readMacServices(async () => { throw new Error('launchctl denied') })
    expect(failure.services).toEqual([])
    expect(failure.error).toContain('launchctl denied')
    expect((await readMacServices(async () => '')).error).toContain('表头无效')
    const result = await readMacServices(async file => {
      expect(file).toBe('/bin/launchctl')
      return 'PID Status Label\n- 0 cc-scheduled\n'
    })
    expect(result.error).toBeNull()
    expect(result.services).toHaveLength(1)
  })

  test('ps failures or exits during sampling preserve service state and display the missing timing', async () => {
    for (const processOutput of [null, '', 'bad output']) {
      const result = await readMacServices(async file => {
        if (file === '/bin/launchctl') return launchList
        if (processOutput === null) throw new Error('ps denied')
        return processOutput
      })
      expect(result.error).toBeNull()
      expect(result.services[0]).toMatchObject({ active: 'active', stateAgoSec: null })
      expect(result.services[0]!.error).toContain('MISS')
      expect(result.services[1]!.error).toBeUndefined()
      const content = consoleHostContent({ cpu: null, mem: null, disks: [], services: result.services, servicesError: null })
      expect(content).toContain('运行时长 MISS')
      expect(content).toContain('cc-scheduled')
      expect(content).not.toContain('已运行 0')
    }
  })

  test('host panel does not mistake unavailable launchd timestamps for never started', async () => {
    const { services, error } = await readMacServices(async file => file === '/bin/launchctl' ? launchList : '123 02:03')
    const snapshot = {
      cpu: { cores: 8, load1: 1.5, load5: 2, load15: 2.5 },
      mem: parseMacMemory(vmStat, 16 * 1024 ** 3), disks: [], services, servicesError: error,
    }
    const content = consoleHostContent(snapshot)
    expect(content).toContain('1.50 / 2.00 / 2.50 (8核)')
    expect(content).toContain('37%')
    expect(content).toContain('cc-running` · active · 已运行 2m')
    expect(content).toContain('cc-scheduled` · inactive · 上次活跃 MISS · 退出码 0')
    expect(content).toContain('退出码 1')
    expect(content).toContain('终止信号 15')
    expect(content).not.toContain('从未启动')
    expect(JSON.stringify(consoleHostElement(snapshot))).toContain('L1.50 · M37% · S4')
    expect(consoleHostContent({ ...snapshot, services: [{ ...services[1]!, hasStarted: false }] })).toContain('从未启动')
  })
})

test('macOS dispatch uses native OS metrics and launchctl, without Linux commands or files', () => {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import * as fs from 'node:fs'
    import * as cp from 'node:child_process'
    import * as os from 'node:os'
    const originalRead = fs.readFileSync
    const files = []
    const calls = []
    mock.module('node:fs', () => ({ ...fs, readFileSync(path, ...args) {
      files.push(String(path))
      if (String(path).startsWith('/proc/')) throw new Error('Linux file read on macOS')
      return originalRead(path, ...args)
    } }))
    mock.module('node:os', () => ({ ...os, loadavg: () => [1.5, 2, 2.5], totalmem: () => 16 * 1024 ** 3 }))
    const execFile = () => { throw new Error('Expected promisified execFile') }
    execFile[Symbol.for('nodejs.util.promisify.custom')] = async (file, args, options) => {
      calls.push([file, args])
      assert.equal(options.timeout, 2000)
      assert.equal(options.env.LC_ALL, 'C')
      if (file === '/usr/bin/vm_stat') return { stdout: ${JSON.stringify(vmStat)}, stderr: '' }
      if (file === '/bin/launchctl') return { stdout: 'PID Status Label\\n- 0 cc-scheduled\\n', stderr: '' }
      throw new Error('Unexpected command: ' + file)
    }
    mock.module('node:child_process', () => ({ ...cp, execFile }))
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { readSysInfo } = await import('./src/sysinfo')
    const info = await readSysInfo()
    assert.equal(info.cpu.load1, 1.5)
    assert.equal(info.mem.usedBytes, 6389760000)
    assert.equal(info.services[0].name, 'cc-scheduled')
    assert.equal(info.servicesError, null)
    assert.ok(!files.some(file => file.startsWith('/proc/')))
    assert.equal(calls.length, 2)
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
