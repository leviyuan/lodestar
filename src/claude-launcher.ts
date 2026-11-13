/** Starts Claude Code through a wrapper executable (for example reclaude) instead of directly. */
import { spawn as crossSpawn } from 'cross-spawn'
import { basename, posix, win32 } from 'node:path'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

export interface ClaudeLauncher {
  /** Wrapper executable. It resolves `claude` through PATH and execs it with the arguments after its own. */
  command: string
  /** Wrapper arguments placed before the Claude Code arguments. */
  args: readonly string[]
  /** How the wrapper prefixes its own stderr lines; nothing else on stderr is kept. */
  diagnosticPrefix: string
}

const DIAGNOSTIC_LINES = 4
const DIAGNOSTIC_LINE_CHARS = 400
const PENDING_CHARS = 4096

function pathKey(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** The process the SDK would have started, rewritten to go through the launcher. */
export function launcherCommand(
  launcher: ClaudeLauncher, options: Pick<SpawnOptions, 'command' | 'args' | 'env'>, platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; env: Record<string, string | undefined> } {
  const paths = platform === 'win32' ? win32 : posix
  // A script entry arrives as `node cli.js …`; the launcher can only start an executable named claude.
  if (!/^claude(?:\.exe|\.cmd|\.bat)?$/i.test(paths.basename(options.command))) {
    throw new Error(`${paths.basename(launcher.command)} 只能启动原生 Claude Code 可执行文件；请移除指向脚本入口的 [claude].bin 配置`)
  }
  const key = pathKey(options.env, platform)
  // The launcher picks the first `claude` on PATH. Put the SDK's own binary first so the
  // process it starts is the exact build this SDK expects, not another local install.
  const path = [paths.dirname(options.command), options.env[key]].filter(Boolean).join(paths.delimiter)
  return { command: launcher.command, args: [...launcher.args, ...options.args], env: { ...options.env, [key]: path } }
}

/** The launcher's own error lines, newest last. The SDK only reports an exit code when the
 * launcher fails before handing over, so the caller adds these to the error it shows. */
export class LauncherDiagnostics {
  readonly lines: string[] = []
  private closed: Promise<void> = Promise.resolve()

  watch(closed: Promise<void>): void { this.closed = closed }

  /** The exit can be reported before stderr is drained; wait for it, but never for long. */
  async describe(error: unknown, timeoutMs = 300): Promise<Error> {
    const failure = error instanceof Error ? error : new Error(String(error))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    clearTimeout(timer)
    return this.lines.length ? new Error(`${failure.message}：${this.lines.join('；')}`, { cause: failure }) : failure
  }
}

export function spawnThroughLauncher(launcher: ClaudeLauncher, diagnostics: LauncherDiagnostics): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    const { command, args, env } = launcherCommand(launcher, options)
    const child = crossSpawn(command, args, {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      shell: false,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill()
      throw new Error(`failed to open stdio for ${basename(launcher.command)}`)
    }
    // Once the launcher has handed over, this stream is the native stderr, which can hold
    // prompts, paths and account details. Only the launcher's prefixed lines are kept.
    let pending = ''
    const keep = (line: string) => {
      const text = line.trim()
      if (!text.startsWith(launcher.diagnosticPrefix)) return
      diagnostics.lines.push(text.slice(0, DIAGNOSTIC_LINE_CHARS))
      if (diagnostics.lines.length > DIAGNOSTIC_LINES) diagnostics.lines.splice(0, diagnostics.lines.length - DIAGNOSTIC_LINES)
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/)
      pending = lines.pop()!.slice(-PENDING_CHARS)
      for (const line of lines) keep(line)
    })
    diagnostics.watch(new Promise(resolve => {
      child.stderr!.on('end', () => { keep(pending); pending = ''; resolve() })
      child.stderr!.on('error', () => resolve())
      child.on('error', () => resolve())
    }))
    return child as unknown as SpawnedProcess
  }
}
