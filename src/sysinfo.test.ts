import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  launchdLastActiveMs, parseLaunchctlList, parseLaunchdJobDetail, parseMacMemory, parseProcessElapsed, readDiskFor,
  readMacMemory, readMacServices, readWorkDirDisk, sysinfoFs,
} from './sysinfo'
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
    const calls: [string, string[]][] = []
    const result = await readMacServices(async (file, args) => {
      calls.push([file, args])
      // 作业定义（list <label>）在这里没有日志路径：已停任务保持 MISS。
      if (file === '/bin/launchctl') return args.length === 1 ? launchList + '789\t0\tcodex-running\n' : ''
      return '123 02:03\n789 1-00:00:01\n'
    })
    expect(result.error).toBeNull()
    expect(calls.slice(0, 2)).toEqual([
      ['/bin/launchctl', ['list']],
      ['/bin/ps', ['-p', '123,789', '-o', 'pid=,etime=']],
    ])
    // 只对已停任务查作业定义：运行中的任务用 ps 的 etime，不再多起进程。
    const details = calls.slice(2)
    expect(details.every(([file, args]) => file === '/bin/launchctl' && args[0] === 'list' && args.length === 2)).toBe(true)
    expect(details.map(([, args]) => args[1]).sort()).toEqual(['cc-scheduled', 'codex-failed', 'codex-terminated'])
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
      expect(result.services[0]!.error).toBeTruthy()
      expect(result.services[1]!.error).toBeUndefined()
      const content = consoleHostContent({ cpu: null, mem: null, disks: [], services: result.services, servicesError: null })
      expect(content).toContain('运行时长 MISS')
      expect(content).toContain('cc-scheduled')
      expect(content).not.toContain('已运行 0')
    }
  })

  test('a failing ps shows MISS on each running row and its escaped reason once in the folded panel', async () => {
    const list = 'PID\tStatus\tLabel\n101\t0\tcc-alpha-dev\n102\t0\tcc-beta-dev\n103\t0\tcodex-gamma-run\n-\t0\tcc-idle\n'
    const result = await readMacServices(async (file, args) => {
      if (file === '/bin/launchctl') return args.length === 1 ? list : ''
      // Shape of a real execFile rejection: the command line plus stderr, over several lines.
      throw new Error(`Command failed: ${file} ${args.join(' ')}\nps: illegal option -- <x>\nusage: ps [-AaCcEefhjlMmrSTvwXx]`)
    })
    const snapshot = { cpu: null, mem: null, disks: [], services: result.services, servicesError: null }
    const host = consoleHostElement(snapshot) as any
    const content: string = host.elements[0].content
    expect(content.split('\n').slice(4)).toEqual([
      '　· 🟢 `cc-alpha-dev` · 运行时长 MISS',
      '　· 🟢 `cc-beta-dev` · 运行时长 MISS',
      '　· ⚪ `cc-idle` · 上次活跃 MISS · 退出码 0',
      '　· 🟢 `codex-gamma-run` · 运行时长 MISS',
    ])
    expect(content).not.toContain('Command failed')
    expect(content).not.toContain('<x>')
    expect(host.elements).toHaveLength(2)
    expect(host.elements[1].expanded).toBe(false)
    expect(host.elements[1].header.title.content).toBe('⚠️ 主机读取失败')
    // The user decided the raw reason stays visible: folded, on one line, escaped and written once.
    expect(host.elements[1].elements[0].content).toBe('运行时长：Command failed: /bin/ps -p 101,102,103 -o pid=,etime= '
      + 'ps: illegal option -- &#60;x&#62; usage: ps &#91;-AaCcEefhjlMmrSTvwXx&#93;')
    // Together with an unreadable service list, each reason is still listed once.
    const both = consoleHostElement({ ...snapshot, servicesError: 'launchctl <denied>' }) as any
    expect(both.elements[1].elements[0].content)
      .toBe(`服务列表：launchctl &#60;denied&#62;\n\n${host.elements[1].elements[0].content}`)
  })

  test('host panel does not mistake unavailable launchd timestamps for never started', async () => {
    const { services, error } = await readMacServices(async file => file === '/bin/launchctl' ? launchList : '123 02:03')
    const snapshot = {
      cpu: { cores: 8, load1: 1.5, load5: 2, load15: 2.5 },
      mem: parseMacMemory(vmStat, 16 * 1024 ** 3), disks: [], services, servicesError: error,
    }
    const content = consoleHostContent(snapshot)
    // The raw 1m/5m/15m averages stay as the system reports them, with the core count for scale.
    expect(content).toContain('**负载**　1.50 / 2.00 / 2.50 (8核)')
    expect(content).toContain('37%')
    // The dot and 已运行 / 已停 / 已挂 already carry running, stopped and failed: no repeated English state.
    expect(content).toContain('🟢 `cc-running` · 已运行 2m')
    expect(content).toContain('⚪ `cc-scheduled` · 上次活跃 MISS · 退出码 0')
    expect(content).toContain('❌ `codex-failed` · 上次活跃 MISS · 退出码 1')
    expect(content).not.toMatch(/ · (active|inactive|failed) · /)
    // The section title is just the section name; load, memory and services live in the body.
    expect((consoleHostElement(snapshot) as any).header.title.content).toBe('🖥 主机')
    expect(content).toContain('退出码 1')
    expect(content).toContain('终止信号 15')
    expect(content).not.toContain('从未启动')
    // A service list that could not be read keeps the plain title; the body keeps only MISS and
    // folds the reason into a collapsed panel, so a long error never breaks the layout.
    const unreadable = consoleHostElement({ ...snapshot, servicesError: 'launchctl MISS' }) as any
    expect(unreadable.header.title.content).toBe('🖥 主机')
    expect(unreadable.elements[0].content).toContain("<font color='red'>MISS</font>")
    expect(unreadable.elements[0].content).not.toContain('launchctl MISS')
    expect(unreadable.elements[1].expanded).toBe(false)
    expect(unreadable.elements[1].header.title.content).toBe('⚠️ 主机读取失败')
    expect(unreadable.elements[1].elements[0].content).toBe('服务列表：launchctl MISS')
    expect(consoleHostContent({ ...snapshot, services: [{ ...services[1]!, hasStarted: false }] })).toContain('从未启动')
  })

  test('launchd job definitions expose the log paths launchd writes, with escapes kept intact', () => {
    const detail = parseLaunchdJobDetail(`{
	"StandardOutPath" = "/Users/me/Library/Logs/cc-hourly.log";
	"LimitLoadToSessionType" = "Aqua";
	"StandardErrorPath" = "/tmp/cc \\"quoted\\" err.log";
	"Label" = "cc-hourly";
	"LastExitStatus" = 0;
};`)
    expect(detail.stdoutPath).toBe('/Users/me/Library/Logs/cc-hourly.log')
    expect(detail.stderrPath).toBe('/tmp/cc "quoted" err.log')
    // 没配标准输出的任务没有可观测的时间证据。
    expect(parseLaunchdJobDetail('{\n\t"Label" = "cc-plain";\n\t"LastExitStatus" = 0;\n};'))
      .toEqual({ stdoutPath: null, stderrPath: null })
    expect(parseLaunchdJobDetail('')).toEqual({ stdoutPath: null, stderrPath: null })
  })

  test('the last activity comes from the newest launchd log write, never from a guess', async () => {
    const now = Date.now()
    const detail = { stdoutPath: '/log/out.log', stderrPath: '/log/err.log' }
    expect(await launchdLastActiveMs(detail, path => path === '/log/out.log' ? now - 9_000 : now - 3_000)).toBe(now - 3_000)
    expect(await launchdLastActiveMs({ stdoutPath: '/log/out.log', stderrPath: null }, async () => now)).toBe(now)
    // 文件还没创建、不可读或时间无效都只是没有证据。
    expect(await launchdLastActiveMs(detail, () => null)).toBeNull()
    expect(await launchdLastActiveMs({ stdoutPath: '/log/out.log', stderrPath: null }, () => Number.NaN)).toBeNull()
    expect(await launchdLastActiveMs({ stdoutPath: '/log/out.log', stderrPath: null }, () => 0)).toBeNull()
    expect(await launchdLastActiveMs({ stdoutPath: null, stderrPath: null }, () => now)).toBeNull()
  })

  test('stopped launchd jobs read the last activity from the log launchd writes', async () => {
    const now = Date.now()
    const jobDetail = (label: string): string => label === 'cc-hourly'
      ? `{\n\t"StandardOutPath" = "/log/cc-hourly.log";\n\t"StandardErrorPath" = "/log/cc-hourly.err.log";\n\t"Label" = "cc-hourly";\n};`
      : `{\n\t"Label" = "cc-plain";\n};`
    const result = await readMacServices(
      async (file, args) => {
        if (file !== '/bin/launchctl') throw new Error(`Unexpected command: ${file}`)
        if (args.length === 1) return 'PID Status Label\n- 0 cc-hourly\n- 0 cc-plain\n'
        return jobDetail(args[1]!)
      },
      path => (path === '/log/cc-hourly.log' ? now - 4_000_000 : path === '/log/cc-hourly.err.log' ? now - 120_000 : null),
    )
    expect(result.error).toBeNull()
    // 程序写日志的时间就是它跑过的时间:取 stdout / stderr 里较新的那个写入时间。
    const hourly = result.services.find(s => s.name === 'cc-hourly')!
    expect(hourly.hasStarted).toBe(true)
    expect(Math.round(hourly.lastActiveAgoSec!)).toBe(120)
    // 没配日志就没有证据:保持 MISS,也不据此说从未启动。
    expect(result.services.find(s => s.name === 'cc-plain')).toMatchObject({ lastActiveAgoSec: null, hasStarted: null })
    const content = consoleHostContent({ cpu: null, mem: null, disks: [], services: result.services, servicesError: null })
    expect(content).toContain('⚪ `cc-hourly` · 上次活跃 2m前 · 退出码 0')
    expect(content).toContain('⚪ `cc-plain` · 上次活跃 MISS · 退出码 0')
    expect(content).not.toContain('从未启动')
  })

  test('an unreadable launchd job definition leaves the stopped row on MISS', async () => {
    const result = await readMacServices(async (file, args) => {
      if (file === '/bin/launchctl' && args.length === 1) return 'PID Status Label\n- 0 cc-hourly\n'
      throw new Error('launchctl list failed')
    })
    expect(result.error).toBeNull()
    expect(result.services).toHaveLength(1)
    expect(result.services[0]).toMatchObject({ name: 'cc-hourly', lastActiveAgoSec: null, hasStarted: null })
  })

  test('the disk follows the working directory and shows occupancy plus free space', async () => {
    const disk = await readDiskFor(process.cwd())
    expect(disk).not.toBeNull()
    expect(disk!.totalBytes).toBeGreaterThan(0)
    expect(disk!.availBytes).toBeGreaterThanOrEqual(0)
    expect(disk!.percent).toBeGreaterThanOrEqual(0)
    expect(disk!.percent).toBeLessThanOrEqual(100)
    expect(await readDiskFor('/definitely/not/a/real/path')).toBeNull()
    // A working directory that does not exist yet still reports its nearest existing ancestor's disk.
    const missing = join(tmpdir(), `lodestar-missing-${process.pid}`, 'nested')
    expect(await readWorkDirDisk(missing)).toEqual([(await readDiskFor(resolve(tmpdir())))!])

    const host = (disks: Array<{ totalBytes: number; availBytes: number; usedBytes: number; percent: number }>) =>
      consoleHostContent({ cpu: null, mem: null, disks, services: [], servicesError: null }).split('\n')
    expect(host([{ totalBytes: 100 * 1024 ** 3, availBytes: 15 * 1024 ** 3, usedBytes: 85 * 1024 ** 3, percent: 85 }])[2])
      .toBe('**硬盘**　占用 85% · 剩余 15G')
    expect(host([])[2]).toBe('**硬盘**　MISS')
    expect(host([{ totalBytes: 100, availBytes: -1, usedBytes: 101, percent: Number.NaN }])[2]).toBe('**硬盘**　MISS')
    expect(consoleHostContent(undefined)).toContain('**硬盘**　MISS')
    expect((consoleHostElement(undefined) as any).elements[0].text_size).toBe('notation')
  })

  test('service rows lead with the state duration and print the English state only when nothing else says it', () => {
    const row = (service: object) => consoleHostContent({ cpu: null, mem: null, disks: [], servicesError: null,
      services: [{ name: 'cc-x', sub: '', lastActiveAgoSec: null, stateAgoSec: null, ...service } as any] }).split('\n').at(-1)
    expect(row({ active: 'inactive', stateAgoSec: 120, lastActiveAgoSec: 4000, lastExitStatus: 0 }))
      .toBe('　· ⚪ `cc-x` · 已停 2m · 上次活跃 1.1h前 · 退出码 0')
    expect(row({ active: 'failed', stateAgoSec: 40, hasStarted: false, lastExitStatus: 1 }))
      .toBe('　· ❌ `cc-x` · 已挂 40s · 从未启动 · 退出码 1')
    expect(row({ active: 'activating', stateAgoSec: 3 })).toBe('　· 🚀 `cc-x` · activating · 已 3s')
    // A running job whose runtime is unreadable shows MISS, not "active"; the reason is folded below.
    expect(row({ active: 'active', error: 'ps 未返回该进程' })).toBe('　· 🟢 `cc-x` · 运行时长 MISS')
    expect(row({ active: 'active' })).toBe('　· 🟢 `cc-x` · active')
  })
})

describe('paths on an unreachable network volume', () => {
  const original = { ...sysinfoFs }
  afterEach(() => { Object.assign(sysinfoFs, original) })
  /** A file system call that never returns, as on a dead network mount. */
  const hang = <T>(calls: string[]) => (path: string): Promise<T> => { calls.push(path); return new Promise<T>(() => {}) }

  test('a working directory whose disk never answers shows MISS within the timeout, not its parent disk', async () => {
    sysinfoFs.timeoutMs = 20
    const statfsCalls: string[] = []
    sysinfoFs.statfs = hang(statfsCalls)
    // A path of its own: the stalled read stays pending for the rest of the process.
    const workDir = mkdtempSync(join(tmpdir(), 'lodestar-hung-statfs-'))
    try {
      // The loop keeps running while the read is pending: the timer below fires first.
      let ticked = false
      setTimeout(() => { ticked = true }, 1)
      const started = Date.now()
      expect(await readWorkDirDisk(workDir)).toEqual([])
      expect(ticked).toBe(true)
      expect(Date.now() - started).toBeLessThan(2_000)
      // A second read of the same stalled path reuses the pending call instead of piling up another.
      expect(await readDiskFor(workDir)).toBeNull()
      expect(statfsCalls).toEqual([workDir])
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }

    const accessCalls: string[] = []
    sysinfoFs.access = hang(accessCalls)
    sysinfoFs.statfs = original.statfs
    const missing = join(tmpdir(), `lodestar-hung-access-${process.pid}`, 'nested')
    expect(await readWorkDirDisk(missing)).toEqual([])
    expect(accessCalls).toEqual([missing])
  })

  test('a stopped job whose log never answers keeps its row on MISS', async () => {
    sysinfoFs.timeoutMs = 20
    const statCalls: string[] = []
    sysinfoFs.stat = hang(statCalls)
    const log = join(tmpdir(), `lodestar-hung-log-${process.pid}.log`)
    const started = Date.now()
    const result = await readMacServices(async (_file, args) => args.length === 1
      ? 'PID Status Label\n- 0 cc-hourly\n'
      : `{\n\t"StandardOutPath" = "${log}";\n\t"Label" = "cc-hourly";\n};`)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(statCalls).toEqual([log])
    expect(result.services[0]).toMatchObject({ name: 'cc-hourly', lastActiveAgoSec: null, hasStarted: null })
    expect(consoleHostContent({ cpu: null, mem: null, disks: [], services: result.services, servicesError: null }))
      .toContain('⚪ `cc-hourly` · 上次活跃 MISS · 退出码 0')
  })

  test('readable logs and disks still answer through the asynchronous reads', async () => {
    const result = await readMacServices(async (_file, args) => args.length === 1
      ? 'PID Status Label\n- 0 cc-hourly\n'
      : `{\n\t"StandardOutPath" = "${import.meta.path}";\n\t"Label" = "cc-hourly";\n};`)
    expect(result.services[0]!.hasStarted).toBe(true)
    expect(result.services[0]!.lastActiveAgoSec).toBeGreaterThanOrEqual(0)
    expect((await readWorkDirDisk(process.cwd()))[0]!.totalBytes).toBeGreaterThan(0)
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
    // 一次 list 拿全部状态，再一次 list <label> 取已停任务的日志路径；内存用 vm_stat。
    assert.deepEqual(calls.filter(call => call[0] === '/bin/launchctl').map(call => call[1]), [['list'], ['list', 'cc-scheduled']])
    assert.equal(calls.length, 3)
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
