import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { log, logError } from './log'
import { writeExecutableFileAtomic } from './state-store'

export interface LodestarLaunch {
  runtime: string
  entry: string
}

interface ResolveLaunchOptions {
  daemonEntry?: string
  runtime?: string
  exists?: (path: string) => boolean
}

/** Resolve the unified `lodestar` entry under Bun or the sibling release
 * bundle under Node. A missing command is a boot error: the Skill must never be
 * installed with a command that can only fail later. */
export function resolveLodestarLaunch(opts: ResolveLaunchOptions = {}): LodestarLaunch {
  // npm bin commands are symlinks. argv[1] retains the bin path, so locate the
  // actual bundle beside the real daemon entry, not beside the command link.
  const daemonEntry = realpathSync(resolve(opts.daemonEntry ?? process.argv[1] ?? ''))
  const runtime = opts.runtime ?? process.execPath
  const exists = opts.exists ?? existsSync
  const root = dirname(daemonEntry)
  const source = join(root, 'cli.ts')
  const siblingBundle = join(root, 'lodestar.js')
  const rootBundle = join(root, 'dist', 'lodestar.js')
  const runtimeIsBun = /^bun(?:\.exe)?$/i.test(basename(runtime))
  const candidates = runtimeIsBun
    ? [source, siblingBundle, rootBundle]
    : [siblingBundle, rootBundle]
  const entry = candidates.find(exists)
  if (!entry) {
    throw new Error(`lodestar entry not found beside daemon: ${candidates.join(', ')}`)
  }
  return { runtime, entry }
}

interface SyncCommandOptions {
  platform?: NodeJS.Platform
  targetDir?: string
  launch?: LodestarLaunch
  env?: NodeJS.ProcessEnv
  homeDir?: string
  localAppData?: string
}

/** Install/update the bare `lodestar` command before managed Skills and
 * sessions are revived, so Agents can run `lodestar agent ...` even when the
 * npm bin directory is not on their PATH. The wrapper contains paths only,
 * never capability or provider credentials.
 *
 * 只写入不存在的目标或 Lodestar 自己生成的 wrapper；npm 的命令链接和用户自己的同名
 * 脚本原样保留。返回 wrapper 路径，未写入（链接或他人文件）时返回 null。 */
export function ensureLodestarCommand(opts: SyncCommandOptions = {}): string | null {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const targetDir = opts.targetDir ?? managedBinDir(
    platform,
    opts.homeDir ?? homedir(),
    opts.localAppData ?? process.env.LOCALAPPDATA,
  )
  const launch = opts.launch ?? resolveLodestarLaunch()
  const target = join(targetDir, platform === 'win32' ? 'lodestar.cmd' : 'lodestar')
  const body = platform === 'win32'
    ? `@"${windowsQuote(launch.runtime)}" "${windowsQuote(launch.entry)}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(launch.runtime)} ${shellQuote(launch.entry)} "$@"\n`
  const existing = existingCommand(target, launch.entry, platform)
  if (existing.kind === 'foreign') {
    // 不覆盖，也不把该目录提到 PATH 前面：Agent 照常按继承的 PATH 找 lodestar。
    log('command: existing lodestar command is not a Lodestar wrapper and was left unchanged; move it away to let Lodestar manage it')
    return null
  }
  if (existing.kind !== 'link') {
    if (existing.body !== body) {
      writeExecutableFileAtomic(target, body)
      log('command: managed command updated')
    } else {
      chmodSync(target, 0o700)
    }
  }
  prependPath(env, targetDir, platform)
  removeObsoleteCommand(targetDir, platform, 'lodestar-consult', ['lodestar-consult', 'consult-cli'])
  removeObsoleteCommand(targetDir, platform, 'lodestar-agent', ['agent-cli.ts', 'lodestar-agent.js'])
  return existing.kind === 'link' ? null : target
}

// 0.25 起生成的 wrapper 形如 `exec '<运行时>' '<…/cli.ts|lodestar.js>' "$@"`（Windows 为 `@"…" "…" %*`）；
// 运行时或安装位置变化后内容不同，但仍是 Lodestar 的。
const MANAGED_POSIX_WRAPPER = /^#!\/bin\/sh\nexec '(?:[^']|'"'"')*' '(?:[^']|'"'"')*\/(?:cli\.ts|lodestar\.js)' "\$@"\n$/
const MANAGED_WINDOWS_WRAPPER = /^@"(?:[^"]|"")*" "(?:[^"]|"")*[\\/](?:cli\.ts|lodestar\.js)" %\*\r\n$/

type ExistingCommand =
  | { kind: 'missing'; body: null }
  | { kind: 'managed'; body: string }
  | { kind: 'link' }
  | { kind: 'foreign' }

function existingCommand(target: string, entry: string, platform: NodeJS.Platform): ExistingCommand {
  let info: ReturnType<typeof lstatSync>
  try { info = lstatSync(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing', body: null }
    throw error
  }
  if (info.isSymbolicLink()) {
    // npm 全局安装的 bin 链接指向本次运行的入口时，命令已经可用，不替换成 wrapper。
    try { return realpathSync(target) === realpathSync(entry) ? { kind: 'link' } : { kind: 'foreign' } }
    catch { return { kind: 'foreign' } }
  }
  if (!info.isFile()) return { kind: 'foreign' }
  const body = readFileSync(target, 'utf8')
  const managed = platform === 'win32' ? MANAGED_WINDOWS_WRAPPER : MANAGED_POSIX_WRAPPER
  return managed.test(body) ? { kind: 'managed', body } : { kind: 'foreign' }
}

/** Delete an obsolete wrapper only when its body proves Lodestar wrote it. */
function removeObsoleteCommand(targetDir: string, platform: NodeJS.Platform, name: string, markers: string[]): void {
  const legacy = join(targetDir, platform === 'win32' ? `${name}.cmd` : name)
  if (!existsSync(legacy)) return
  try {
    const body = readFileSync(legacy, 'utf8')
    if (!markers.some(marker => body.includes(marker))) {
      log('command: obsolete command preserved because ownership is unclear')
      return
    }
    unlinkSync(legacy)
    log('command: removed obsolete managed command')
  } catch (error) {
    logError('command: obsolete command removal failed', error)
  }
}

function managedBinDir(
  platform: NodeJS.Platform,
  homeDir: string,
  localAppData: string | undefined,
): string {
  if (platform === 'win32') {
    return join(localAppData ?? join(homeDir, 'AppData', 'Local'), 'Lodestar', 'bin')
  }
  return join(homeDir, '.local', 'bin')
}

function prependPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): void {
  const key = platform === 'win32'
    ? Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'Path'
    : 'PATH'
  const delimiter = platform === 'win32' ? ';' : ':'
  const current = env[key] ?? ''
  const normalized = (value: string) => platform === 'win32' ? value.toLowerCase() : value
  if (current.split(delimiter).some(entry => normalized(entry) === normalized(dir))) return
  env[key] = current ? `${dir}${delimiter}${current}` : dir
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function windowsQuote(value: string): string {
  return value.replaceAll('"', '""')
}
