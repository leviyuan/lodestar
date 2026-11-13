import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LauncherDiagnostics, launcherCommand, spawnThroughLauncher, type ClaudeLauncher } from './claude-launcher'

const root = mkdtempSync(join(tmpdir(), 'lodestar-launcher-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const launcher: ClaudeLauncher = { command: '/opt/tools/reclaude', args: ['--org', '7', 'cli'], diagnosticPrefix: 'reclaude:' }

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('launcherCommand', () => {
  test('starts the launcher with its own arguments first and the SDK binary first on PATH', () => {
    const result = launcherCommand(launcher, {
      command: '/runtime/sdk-darwin-arm64/claude', args: ['--output-format', 'stream-json'], env: { PATH: '/usr/bin:/bin', KEEP: '1' },
    }, 'darwin')
    expect(result.command).toBe('/opt/tools/reclaude')
    expect(result.args).toEqual(['--org', '7', 'cli', '--output-format', 'stream-json'])
    expect(result.env).toEqual({ PATH: '/runtime/sdk-darwin-arm64:/usr/bin:/bin', KEEP: '1' })
  })

  test('keeps the existing Windows Path key and separator', () => {
    const result = launcherCommand(launcher, { command: 'C:\\runtime\\claude.exe', args: [], env: { Path: 'C:\\Windows' } }, 'win32')
    expect(result.env).toEqual({ Path: 'C:\\runtime;C:\\Windows' })
  })

  test('sets PATH when the environment has none', () => {
    expect(launcherCommand(launcher, { command: '/runtime/claude', args: [], env: {} }, 'linux').env).toEqual({ PATH: '/runtime' })
  })

  test('refuses a script entry the launcher cannot start', () => {
    expect(() => launcherCommand(launcher, { command: '/usr/local/bin/node', args: ['/runtime/cli.js'], env: {} }, 'linux'))
      .toThrow('reclaude 只能启动原生 Claude Code 可执行文件')
  })
})

describe.skipIf(process.platform === 'win32')('spawnThroughLauncher', () => {
  const sdk = join(root, 'sdk')
  mkdirSync(sdk)
  // Stands in for the SDK's native binary: echoes its arguments on the protocol stream.
  const claude = script(join(sdk, 'claude'), 'echo "native:$*"')

  async function run(body: string, args: string[]): Promise<{ stdout: string; code: number | null; diagnostics: LauncherDiagnostics }> {
    const wrapper = script(join(root, `wrapper-${Math.random().toString(36).slice(2)}`), body)
    const diagnostics = new LauncherDiagnostics()
    const child = spawnThroughLauncher({ command: wrapper, args: ['cli'], diagnosticPrefix: 'reclaude:' }, diagnostics)({
      command: claude, args, cwd: root, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal,
    }) as unknown as import('node:child_process').ChildProcess
    let stdout = ''
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    return { stdout, code, diagnostics }
  }

  test('the launcher resolves `claude` to the SDK binary and passes the arguments through', async () => {
    // Like reclaude: drop the subcommand, then exec whichever `claude` is first on PATH.
    const { stdout, code, diagnostics } = await run('shift; echo "同步配置…" >&2; exec claude "$@"', ['--model', 'opus'])
    expect(code).toBe(0)
    expect(stdout).toBe('native:--model opus\n')
    expect(diagnostics.lines).toEqual([])
    expect((await diagnostics.describe(new Error('unchanged'))).message).toBe('unchanged')
  })

  test('a launcher failure keeps only its own prefixed lines and adds them to the reported error', async () => {
    const { code, diagnostics } = await run([
      'echo "同步配置…" >&2',
      'echo "prompt text and /private/path that must not be kept" >&2',
      'printf "reclaude: 本机还没有绑定组织 7，请先运行 reclaude org bind 7" >&2',
      'exit 1',
    ].join('\n'), [])
    expect(code).toBe(1)
    expect(diagnostics.lines).toEqual(['reclaude: 本机还没有绑定组织 7，请先运行 reclaude org bind 7'])
    const failure = await diagnostics.describe(new Error('Claude Code process exited with code 1'))
    expect(failure.message).toBe('Claude Code process exited with code 1：reclaude: 本机还没有绑定组织 7，请先运行 reclaude org bind 7')
    expect((failure.cause as Error).message).toBe('Claude Code process exited with code 1')
  })

  test('diagnostics stay bounded', async () => {
    const { diagnostics } = await run(`i=0; while [ $i -lt 20 ]; do echo "reclaude: line $i $(printf '%0600d' 0)" >&2; i=$((i+1)); done; exit 1`, [])
    expect(diagnostics.lines.length).toBe(4)
    expect(diagnostics.lines.at(-1)!.startsWith('reclaude: line 19 ')).toBe(true)
    expect(diagnostics.lines.every(line => line.length <= 400)).toBe(true)
  })
})

test('describe does not wait long for a stderr stream that never closes', async () => {
  const diagnostics = new LauncherDiagnostics()
  diagnostics.watch(new Promise(() => {}))
  const started = Date.now()
  expect((await diagnostics.describe('boom', 20)).message).toBe('boom')
  expect(Date.now() - started).toBeLessThan(1000)
})
