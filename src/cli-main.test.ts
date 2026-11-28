import { describe, expect, test } from 'bun:test'
import { runCli, type CliCommands } from './cli-main'
import { commandHelp, topLevelHelp } from './cli-help'
import { UsageError } from './cli-errors'
import { C, forceColor } from './cli-output'
import { lodestarVersion } from './version'

function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (text: string) => { out.push(text) },
      err: (text: string) => { err.push(text) },
    },
  }
}

/** 全部命令替换为记录器，测试永远不会碰真实配置、进程或网络。 */
function fakeCommands(overrides: Partial<CliCommands> = {}) {
  const calls: string[] = []
  const commands: CliCommands = {
    start: async argv => { calls.push(`start ${argv.join(' ')}`.trim()) },
    setup: async argv => { calls.push(`setup ${argv.join(' ')}`.trim()) },
    stop: async argv => { calls.push(`stop ${argv.join(' ')}`.trim()) },
    update: async argv => { calls.push(`update ${argv.join(' ')}`.trim()) },
    version: async argv => { calls.push(`version ${argv.join(' ')}`.trim()) },
    agent: async argv => { calls.push(`agent ${argv.join(' ')}`.trim()) },
    claude: async argv => { calls.push(`claude ${argv.join(' ')}`.trim()) },
    ...overrides,
  }
  return { commands, calls }
}

describe('lodestar 统一入口', () => {
  test('--help 只打印总览，不执行任何命令', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli(['--help'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toBe(topLevelHelp())
    expect(r.out.join('')).toContain('lodestar update [--agents-only]')
    expect(r.out.join('')).toContain('restart')
    expect(calls).toEqual([])
  })

  test('--version 只输出版本号', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli(['-V'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toBe(`${lodestarVersion()}\n`)
    expect(calls).toEqual([])
  })

  test('子命令的 --help 不触发原命令，尤其是 stop', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli(['stop', '--help'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toBe(commandHelp('stop')!)
    expect(r.out.join('')).toContain('lodestar stop')
    expect(calls).toEqual([])
  })

  test('agent/claude 的帮助来自各自模块，同样不执行任务', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli(['agent', '--help'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toContain('lodestar agent')
    expect(await runCli(['claude', '--help'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toContain('lodestar claude')
    expect(calls).toEqual([])
  })

  test('未知命令与多余参数返回 2', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli(['bogus'], { io: r.io, commands })).toBe(2)
    expect(r.err.join('')).toContain('未知命令')
    expect(await runCli(['stop', 'now'], { io: r.io, commands })).toBe(2)
    expect(calls).toEqual([])
  })

  test('help <命令> 输出单条帮助', async () => {
    const r = recorder()
    const { commands } = fakeCommands()
    expect(await runCli(['help', 'stop'], { io: r.io, commands })).toBe(0)
    expect(r.out.join('')).toBe(commandHelp('stop')!)
    expect(await runCli(['help', 'bogus'], { io: r.io, commands })).toBe(2)
    expect(r.err.join('')).toContain('未知命令')
  })

  test('无参数启动 daemon，--agents-only 转交 update', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    expect(await runCli([], { io: r.io, commands })).toBe(0)
    expect(await runCli(['--no-color', 'start'], { io: r.io, commands })).toBe(0)
    // 跨版本协议：已发布的 update 会以 `<新装入口> --agents-only` 调用新版本，不能删除或改名。
    expect(await runCli(['--agents-only'], { io: r.io, commands })).toBe(0)
    expect(calls).toEqual(['start', 'start', 'update --agents-only'])
  })

  test('用法错误退出 2，运行失败退出 1', async () => {
    const usage = recorder()
    const usageCommands = fakeCommands({ stop: async () => { throw new UsageError('bad flag') } })
    expect(await runCli(['stop'], { io: usage.io, commands: usageCommands.commands })).toBe(2)
    expect(usage.err.join('')).toContain('lodestar stop: bad flag')

    const runtime = recorder()
    const runtimeCommands = fakeCommands({ version: async () => { throw new Error('boom') } })
    expect(await runCli(['version'], { io: runtime.io, commands: runtimeCommands.commands })).toBe(1)
    expect(runtime.err.join('')).toContain('lodestar version: boom')
  })

  test('--no-color 关闭颜色输出', async () => {
    forceColor(true)
    expect(C.red).not.toBe('')
    const r = recorder()
    const { commands } = fakeCommands()
    expect(await runCli(['--no-color', '--version'], { io: r.io, commands })).toBe(0)
    expect(C.red).toBe('')
    forceColor(undefined)
  })

  test('--no-color 也可写在 lodestar 自有子命令之后；agent、claude 之后的参数原样交给子命令', async () => {
    const r = recorder()
    const { commands, calls } = fakeCommands()
    try {
      for (const argv of [['stop', '--no-color'], ['setup', '--no-color'], ['start', '--no-color'],
        ['update', '--no-color', '--agents-only'], ['version', '--verbose', '--no-color'], ['--agents-only', '--no-color']]) {
        forceColor(true)
        expect(await runCli(argv, { io: r.io, commands })).toBe(0)
        expect(C.red).toBe('')
      }
      expect(r.err).toEqual([])
      expect(await runCli(['claude', '工作号', '--no-color'], { io: r.io, commands })).toBe(0)
      expect(await runCli(['agent', 'run', '--prompt', '--no-color'], { io: r.io, commands })).toBe(0)
      expect(calls).toEqual(['stop', 'setup', 'start', 'update --agents-only', 'version --verbose', 'update --agents-only',
        'claude 工作号 --no-color', 'agent run --prompt --no-color'])
    } finally {
      forceColor(true)
      forceColor(undefined)
    }
  })

  test('已在运行时提示服务托管的由服务管理器重启', () => {
    const script = `
      import { mock } from 'bun:test'
      mock.module('./src/pid-guard', () => ({ checkPidGuard: () => ({ state: 'exit', pid: 12345 }) }))
      const { startDaemon } = await import('./src/daemon-entry')
      process.exitCode = await startDaemon()
    `
    const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
      cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    expect(result.exitCode).toBe(1)
    const stderr = result.stderr.toString()
    expect(stderr).toContain('已经有一个 daemon 在运行')
    expect(stderr).toContain('lodestar stop')
    expect(stderr).toContain('由服务管理器重启或停止')
    expect(commandHelp('start')).toContain('服务托管的由服务管理器重启或停止')
  })
})
