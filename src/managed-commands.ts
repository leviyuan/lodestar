import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { log } from './log'
import { writeExecutableFileAtomic } from './state-store'

export interface AgentCliLaunch {
  runtime: string
  entry: string
}

interface ResolveLaunchOptions {
  daemonEntry?: string
  runtime?: string
  exists?: (path: string) => boolean
}

/** Resolve the source entry under Bun or the sibling release bundle under
 * Node. A missing command is a boot error: the Skill must never be installed
 * with a command that can only fail later. */
export function resolveAgentCliLaunch(opts: ResolveLaunchOptions = {}): AgentCliLaunch {
  // npm bin commands are symlinks. argv[1] retains the bin path, so locate
  // bundled companions beside the actual entry, not beside the command link.
  const daemonEntry = realpathSync(resolve(opts.daemonEntry ?? process.argv[1] ?? ''))
  const runtime = opts.runtime ?? process.execPath
  const exists = opts.exists ?? existsSync
  const root = dirname(daemonEntry)
  const source = join(root, 'src', 'agent-cli.ts')
  const siblingBundle = join(root, 'lodestar-agent.js')
  const rootBundle = join(root, 'dist', 'lodestar-agent.js')
  const runtimeIsBun = /^bun(?:\.exe)?$/i.test(basename(runtime))
  const candidates = runtimeIsBun
    ? [source, siblingBundle, rootBundle]
    : [siblingBundle, rootBundle]
  const entry = candidates.find(exists)
  if (!entry) {
    throw new Error(`lodestar-agent entry not found beside daemon: ${candidates.join(', ')}`)
  }
  return { runtime, entry }
}

interface SyncCommandOptions {
  platform?: NodeJS.Platform
  targetDir?: string
  launch?: AgentCliLaunch
  env?: NodeJS.ProcessEnv
  homeDir?: string
  localAppData?: string
}

/** Install/update the bare `lodestar-agent` command before managed Skills
 * and sessions are revived. The wrapper contains paths only, never capability
 * or provider credentials. */
export function ensureLodestarAgentCommand(opts: SyncCommandOptions = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const targetDir = opts.targetDir ?? managedBinDir(
    platform,
    opts.homeDir ?? homedir(),
    opts.localAppData ?? process.env.LOCALAPPDATA,
  )
  const launch = opts.launch ?? resolveAgentCliLaunch()
  const target = join(targetDir, platform === 'win32' ? 'lodestar-agent.cmd' : 'lodestar-agent')
  const body = platform === 'win32'
    ? `@"${windowsQuote(launch.runtime)}" "${windowsQuote(launch.entry)}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(launch.runtime)} ${shellQuote(launch.entry)} "$@"\n`
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (current !== body) {
    writeExecutableFileAtomic(target, body)
    log(`command: ${current === null ? 'installed' : 'updated'} ${target}`)
  } else {
    chmodSync(target, 0o700)
  }
  prependPath(env, targetDir, platform)
  removeLegacyConsultCommand(targetDir, platform)
  return target
}

function removeLegacyConsultCommand(targetDir: string, platform: NodeJS.Platform): void {
  const legacy = join(targetDir, platform === 'win32' ? 'lodestar-consult.cmd' : 'lodestar-consult')
  if (!existsSync(legacy)) return
  try {
    const body = readFileSync(legacy, 'utf8')
    if (!body.includes('lodestar-consult') && !body.includes('consult-cli')) {
      log(`command: obsolete path preserved because ownership is unclear ${legacy}`)
      return
    }
    unlinkSync(legacy)
    log(`command: removed obsolete ${legacy}`)
  } catch (error) {
    log(`command: obsolete removal failed (${legacy}): ${error}`)
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
