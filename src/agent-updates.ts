import { networkFetch } from './network'
/** Explicit/opt-in Agent updates follow latest independently of Lodestar releases. */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_RUNTIMES_DIR } from './paths'
import { AGENT_INSTALLER_RECORD, AgentInstallTerminationError, installAgentPackages } from './agent-install'
import { writeStateFileAtomic } from './state-store'
export { installAgentPackages } from './agent-install'

export const AGENTS = ['codex', 'claude', 'dsh'] as const
export type UpdatedAgent = typeof AGENTS[number]
export const AGENT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const REGISTRY = 'https://registry.npmjs.org'
const PACKAGES: Record<UpdatedAgent, string[]> = {
  codex: ['@openai/codex'],
  claude: ['@anthropic-ai/claude-code', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'],
  dsh: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-tool-ask-user'],
}
interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
export interface AgentRuntimeState {
  directory?: string
  versions?: Record<string, string>
  checkedAt: number
  /** Legacy diagnostic only; ignored when selecting an installed runtime. */
  error?: string
}
export interface AgentUpdateOptions {
  root?: string
  signal?: AbortSignal
  report?: (message: string) => void
  /** Injectable registry and installer for isolated, offline lifecycle tests. */
  metadata?: (name: string, version: string) => Promise<Manifest>
  install?: (directory: string, signal?: AbortSignal) => Promise<void>
  /** Process table used to keep installations a live Agent still runs from. */
  runningCommands?: () => Promise<string[] | null>
}

/** Older installs are disposable; the selected one and running ones are not. */
const RUNTIME_KEEP = 3
const RUNTIME_FINGERPRINT = /^[0-9a-f]{20}$/
const execFileAsync = promisify(execFile)
const STALE_LOCK_PREFIX = '.stale-lock-'
/** Far longer than mkdir -> atomic PID write, including Windows sharing retries. */
const LOCK_PID_GRACE_MS = 30_000
/** A recently moved-aside lock may still be verified and renamed back by its reclaimer. */
const STALE_LOCK_SWEEP_AGE_MS = 5 * 60_000
/** Staging without a readable installer record (crash before spawn, older Lodestar):
 * its installer cannot be checked, so only age proves it is abandoned. */
const UNRECORDED_STAGING_AGE_MS = 24 * 60 * 60_000

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function readState(agent: UpdatedAgent, root = AGENT_RUNTIMES_DIR): AgentRuntimeState | null {
  const file = join(root, agent, 'current.json')
  if (!existsSync(file)) return null
  const state = JSON.parse(readFileSync(file, 'utf8')) as AgentRuntimeState
  if (!Number.isFinite(state.checkedAt) || (state.directory !== undefined && !isAbsolute(state.directory))) {
    throw new Error(`Invalid ${agent} runtime state: ${file}`)
  }
  return state
}

export function agentRuntimeState(agent: UpdatedAgent): AgentRuntimeState | null { return readState(agent) }

/** Constructors only read the selected local install; they never query the registry. */
export function agentRuntimeRoot(agent: UpdatedAgent): string {
  // Tests explicitly use their own dependency tree; production never substitutes it.
  if (process.env.NODE_ENV === 'test' && process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT) {
    return process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT
  }
  const state = readState(agent)
  if (!state?.directory) throw new Error(`${agent} runtime 未安装，请运行 lodestar-update --agents-only`)
  if (!existsSync(state.directory)) throw new Error(`${agent} runtime 安装目录不存在: ${state.directory}；请运行 lodestar-update --agents-only`)
  return state.directory
}

export function agentPackagePath(agent: UpdatedAgent, name: string): string {
  return createRequire(join(agentRuntimeRoot(agent), 'package.json')).resolve(name)
}

export function agentBin(agent: UpdatedAgent, command: string): string {
  const bin = join(agentRuntimeRoot(agent), 'node_modules', '.bin', `${command}${process.platform === 'win32' ? '.cmd' : ''}`)
  if (!existsSync(bin)) throw new Error(`${agent} executable missing: ${bin}`)
  return bin
}

export async function loadClaudeSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  return import(pathToFileURL(agentPackagePath('claude', '@anthropic-ai/claude-agent-sdk')).href)
}

async function metadata(name: string, version: string, signal?: AbortSignal): Promise<Manifest> {
  const abort = new AbortController()
  const cancel = () => abort.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => abort.abort(new Error('npm registry request timed out')), 30_000)
  try {
    const response = await networkFetch(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: abort.signal })
    if (!response.ok) throw new Error(`${name}@${version}: npm HTTP ${response.status}`)
    const value = await response.json() as Manifest
    if (value.name !== name || typeof value.version !== 'string' || !value.version) throw new Error(`Invalid npm manifest: ${name}@${version}`)
    return value
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** The DSH release is selected dynamically; its plugin family is installed together. */
export async function resolveAgentPackages(agent: UpdatedAgent, read: (name: string, version: string) => Promise<Manifest>): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {}
  if (agent !== 'dsh') {
    const rows = await Promise.all(PACKAGES[agent].map(name => read(name, 'latest')))
    for (const row of rows) dependencies[row.name] = row.version
    return dependencies
  }
  const main = await read('@deepseek-ai/dsh', 'latest')
  const pending = new Set(PACKAGES.dsh)
  const seen = new Set<string>()
  while (pending.size) {
    const batch = [...pending].slice(0, 12)
    for (const name of batch) { pending.delete(name); seen.add(name) }
    const rows = await Promise.all(batch.map(name => name === main.name ? main : read(name, main.version)))
    for (const row of rows) {
      if (row.version !== main.version) throw new Error(`DSH release package mismatch: ${row.name}@${row.version}, expected ${main.version}`)
      dependencies[row.name] = row.version
      for (const name of Object.keys({ ...row.dependencies, ...row.peerDependencies, ...row.optionalDependencies })) {
        if (name.startsWith('@deepseek-ai/dsh') && !seen.has(name)) pending.add(name)
      }
    }
  }
  return dependencies
}

/** Windows scanners/file readers may briefly hold a rename target. Retry the
 * same operation only; never delete the selected file to make a rename work. */
export async function retryAgentFileOperation<T>(operation: () => Promise<T>, platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || attempt >= 5) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

async function writeState(agentDirectory: string, state: AgentRuntimeState): Promise<void> {
  const temp = join(agentDirectory, `current-${randomUUID()}.json`)
  let failure: unknown
  try {
    await writeFile(temp, JSON.stringify(state) + '\n', { mode: 0o600 })
    await retryAgentFileOperation(() => rename(temp, join(agentDirectory, 'current.json')))
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { await retryAgentFileOperation(() => rm(temp, { force: true })) }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], `${errorMessage(failure)}; state temporary file cleanup failed: ${errorMessage(error)}`)
      throw error
    }
  }
}

/** npm exits 0 when an optional platform package cannot be extracted (for
 * example ENOSPC). The SDK only reports the missing CLI when a session starts,
 * so a runtime without it must never be selected. */
async function validateClaudeNativeBinary(directory: string): Promise<void> {
  const sdk = join(directory, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  const installed = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8')) as Manifest
  const suffix = `-${process.platform}-${process.arch}`
  const candidates = Object.keys(installed.optionalDependencies ?? {})
    .filter(name => name.endsWith(suffix) || (process.platform === 'linux' && name.endsWith(`${suffix}-musl`)))
  // Packaging without a declared platform package needs no extra check.
  if (candidates.length === 0) return
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  if (candidates.some(name => existsSync(join(directory, 'node_modules', name, binary)))) return
  throw new Error(`Invalid Agent runtime at ${directory}: @anthropic-ai/claude-agent-sdk@${installed.version} is missing its ${process.platform}-${process.arch} native CLI binary; reinstall with optional dependencies`)
}

async function validateInstalledPackages(agent: UpdatedAgent, directory: string, versions: Record<string, string>): Promise<void> {
  for (const [name, version] of Object.entries(versions)) {
    const installed = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'))
    if (installed.name !== name || installed.version !== version) {
      throw new Error(`Invalid Agent runtime at ${directory}: expected ${name}@${version}, found ${installed.name}@${installed.version}`)
    }
  }
  if (agent === 'claude') await validateClaudeNativeBinary(directory)
}

/** Windows has no portable process table here; guessing could delete a directory
 * a running Agent still uses, so pruning is skipped instead. */
async function runningCommandLines(): Promise<string[] | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-a', '-x', '-o', 'command='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout.split('\n')
  } catch {
    return null
  }
}

/** A path argument ends at `/`, whitespace or the end of the command line; the
 * npm installer names its staging directory as `--prefix <dir> --include...`. */
function processUsesDirectory(commands: string[], directory: string): boolean {
  const paths = new Set([directory])
  try { paths.add(realpathSync(directory)) } catch {}
  return commands.some(command => [...paths].some(path => {
    for (let index = command.indexOf(path); index >= 0; index = command.indexOf(path, index + 1)) {
      const next = command[index + path.length]
      if (next === undefined || next === '/' || /\s/.test(next)) return true
    }
    return false
  }))
}

/** Removes directories no live process uses. `null` means the process table
 * is unavailable and nothing was attempted. */
async function removeUnusedDirectories(paths: string[], options: AgentUpdateOptions): Promise<{ removed: number; failed: boolean } | null> {
  let commands: string[] | null
  try { commands = await (options.runningCommands ?? runningCommandLines)() } catch { commands = null }
  if (!commands) return null
  let removed = 0
  let failed = false
  for (const path of paths) {
    if (options.signal?.aborted) break
    if (processUsesDirectory(commands, path)) continue
    try {
      await retryAgentFileOperation(() => rm(path, { recursive: true, force: true }))
      removed++
    } catch { failed = true }
  }
  return { removed, failed }
}

/** Keep the selected install and the newest releases. A directory any live
 * process still runs from is preserved: an update never breaks a running Agent.
 * Cleanup is best-effort and must not turn a successful update into a failure. */
async function pruneAgentRuntimes(agent: UpdatedAgent, directory: string, selected: string, options: AgentUpdateOptions): Promise<void> {
  const report = (message: string) => { try { options.report?.(message) } catch {} }
  try {
    const versions: Array<{ path: string; mtimeMs: number }> = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUNTIME_FINGERPRINT.test(entry.name)) continue
      const path = join(directory, entry.name)
      try { versions.push({ path, mtimeMs: (await stat(path)).mtimeMs }) } catch {}
    }
    const keep = new Set([selected, ...versions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RUNTIME_KEEP).map(version => version.path)])
    const expired = versions.filter(version => !keep.has(version.path))
    if (expired.length === 0) return
    const result = await removeUnusedDirectories(expired.map(version => version.path), options)
    if (!result) {
      report(`${agent}: 旧运行时清理跳过（无法确认占用）`)
      return
    }
    if (result.removed > 0) report(`${agent}: 已清理 ${result.removed} 个旧运行时`)
    if (result.failed) report(`${agent}: 旧运行时清理未完成，保留原目录`)
  } catch {
    // Cleanup runs after the update is committed; report it without failing the update.
    report(`${agent}: 旧运行时清理未完成，保留原目录`)
  }
}

/** Rename keeps a directory's mtime; ctime records the move aside. */
async function ageMs(path: string): Promise<number> {
  const info = await stat(path)
  return Date.now() - Math.max(info.mtimeMs, info.ctimeMs)
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** npm lifecycle children run with their cwd in the staging directory and no path
 * in argv, so the recorded installer PID must be gone too, not just command lines. */
async function stagingAbandoned(path: string): Promise<boolean> {
  let pid: unknown
  // A missing or torn record falls back to the age rule below.
  try { pid = JSON.parse(await readFile(join(path, AGENT_INSTALLER_RECORD), 'utf8'))?.pid }
  catch {}
  if (Number.isSafeInteger(pid) && (pid as number) > 0) return !processAlive(pid as number)
  return await ageMs(path) >= UNRECORDED_STAGING_AGE_MS
}

async function staleLockAbandoned(name: string, path: string): Promise<boolean> {
  const movedAt = Number(/^\.stale-lock-(\d+)-/.exec(name)?.[1])
  const age = Number.isSafeInteger(movedAt) ? Date.now() - movedAt : await ageMs(path)
  return age >= STALE_LOCK_SWEEP_AGE_MS
}

/** Staging directories of interrupted or cancelled installs (and reclaimed
 * locks) belong to no updater once this one holds the lock. One an orphaned
 * installer may still own stays; without a process table nothing is removed. */
async function pruneStaleStaging(agent: UpdatedAgent, directory: string, options: AgentUpdateOptions): Promise<void> {
  const report = (message: string) => { try { options.report?.(message) } catch {} }
  try {
    const stale: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      try {
        if (entry.name.startsWith('.install-') ? await stagingAbandoned(path)
          : entry.name.startsWith(STALE_LOCK_PREFIX) && await staleLockAbandoned(entry.name, path)) stale.push(path)
      } catch (error) {
        // Already removed by its own reclaimer; anything else keeps the directory.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (stale.length === 0) return
    const result = await removeUnusedDirectories(stale, options)
    if (!result) {
      report(`${agent}: 中断安装的临时目录清理跳过（无法确认占用）`)
      return
    }
    if (result.removed > 0) report(`${agent}: 已清理 ${result.removed} 个中断安装的临时目录`)
    if (result.failed) report(`${agent}: 中断安装的临时目录清理未完成，保留原目录`)
  } catch {
    report(`${agent}: 中断安装的临时目录清理未完成，保留原目录`)
  }
}

/** Moves a dead updater's lock aside, then checks it is the same lock that was
 * judged stale: another waiter may have reclaimed it and taken a fresh one in
 * between, and that live lock is handed back instead of deleted. */
async function reclaimLock(directory: string, path: string, observed: { ino: number; mtimeMs: number }): Promise<void> {
  const aside = join(directory, `${STALE_LOCK_PREFIX}${Date.now()}-${randomUUID()}`)
  try { await retryAgentFileOperation(() => rename(path, aside)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const moved = await stat(aside)
  if (moved.ino !== observed.ino || moved.mtimeMs !== observed.mtimeMs) {
    try { await retryAgentFileOperation(() => rename(aside, path)) }
    catch (error) { throw new Error(`Runtime update lock was replaced while reclaiming a stale lock and could not be restored: ${path}: ${errorMessage(error)}`) }
    return
  }
  // A failed removal leaves only an inert directory; the next successful update sweeps and reports it.
  try { await retryAgentFileOperation(() => rm(aside, { recursive: true })) } catch {}
}

/** Directory lock also serializes a manual CLI update with the daemon timer. */
async function lock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const path = join(directory, 'update.lock')
  const deadline = Date.now() + 360_000
  for (;;) {
    signal?.throwIfAborted()
    try {
      await mkdir(path)
      // Identifies this updater's lock at release. An inode cannot: Linux hands the same
      // number to a directory created right after one was removed.
      const owner = randomUUID()
      try {
        // Other updaters may inspect the directory immediately. Publish a complete PID atomically.
        await retryAgentFileOperation(async () => writeStateFileAtomic(join(path, 'pid'), String(process.pid)))
        await retryAgentFileOperation(async () => writeStateFileAtomic(join(path, 'owner'), owner))
      } catch (error) {
        try { await retryAgentFileOperation(() => rm(path, { recursive: true })) }
        catch (cleanup) { throw new AggregateError([error, cleanup], `${errorMessage(error)}; runtime update lock cleanup failed: ${errorMessage(cleanup)}`) }
        throw error
      }
      // A lock already gone, or replaced by another updater's, is not this updater's to remove.
      return async () => {
        try {
          if (await readFile(join(path, 'owner'), 'utf8') !== owner) return
          await retryAgentFileOperation(() => rm(path, { recursive: true }))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const observed = await stat(path)
        let text: string | undefined
        try { text = await readFile(join(path, 'pid'), 'utf8') }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
        if (text === undefined) {
          // The PID is published right after mkdir; a lock still without one
          // long after belongs to an updater that died in between.
          if (Date.now() - observed.mtimeMs >= LOCK_PID_GRACE_MS) { await reclaimLock(directory, path, observed); continue }
        } else {
          const pid = Number(text)
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid runtime update lock: ${path}`)
          try { process.kill(pid, 0) }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
            await reclaimLock(directory, path, observed)
            continue
          }
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for runtime update lock: ${path}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}

export async function updateAgentRuntime(agent: UpdatedAgent, options: AgentUpdateOptions = {}): Promise<AgentRuntimeState> {
  const root = options.root ?? AGENT_RUNTIMES_DIR
  const directory = join(root, agent)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const unlock = await lock(directory, options.signal)
  let staging: string | undefined
  let failure: unknown
  let preserveStaging = false
  try {
    const previous = readState(agent, root)
    options.report?.(`${agent}: 检查 upstream latest`)
    const versions = await resolveAgentPackages(agent, options.metadata ?? ((name, version) => metadata(name, version, options.signal)))
    options.signal?.throwIfAborted()
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    // Fixes for one Agent's runtime stay in that Agent's own dependency tree; they are
    // not added to the daemon's dependencies.
    const security = { ...manifest.overrides, ...manifest.agentRuntimeOverrides?.[agent] }
    // Format 4 installs through a canonical npm root so security overrides also
    // apply when the state directory is reached through a filesystem alias.
    const fingerprint = createHash('sha256').update(JSON.stringify({ installFormat: 4, versions: Object.entries(versions).sort(), security,
      platform: process.platform, arch: process.arch })).digest('hex').slice(0, 20)
    const destination = join(directory, fingerprint)
    if (!existsSync(destination)) {
      staging = await mkdtemp(join(directory, '.install-'))
      // Resolved versions are an installation snapshot, never a compatibility whitelist.
      // Keep internal DSH plugins transitive so npm can place their peers according
      // to upstream dependencies; the overrides still keep its family on one release.
      await writeFile(join(staging, 'package.json'), JSON.stringify({ name: `lodestar-runtime-${agent}`, version: versions[PACKAGES[agent][0]], private: true, type: 'module',
        dependencies: Object.fromEntries(PACKAGES[agent].map(name => [name, versions[name]])),
        overrides: { ...security, ...(agent === 'dsh' ? versions : {}) } }) + '\n', { mode: 0o600 })
      await (options.install ?? installAgentPackages)(staging, options.signal)
      await validateInstalledPackages(agent, staging, versions)
      options.signal?.throwIfAborted()
      const completedInstall = staging
      await retryAgentFileOperation(() => rename(completedInstall, destination))
      staging = undefined
    } else {
      // An existing fingerprint is not proof that its installation is intact.
      // Never activate a damaged directory or overwrite files a process may use.
      await validateInstalledPackages(agent, destination, versions)
    }
    const state = { directory: destination, versions, checkedAt: Date.now() }
    const unchanged = previous?.directory === destination
    await writeState(directory, state)
    options.report?.(`${agent}: ${PACKAGES[agent][0]}@${versions[PACKAGES[agent][0]]}${unchanged ? ' 已是 latest' : ' 已更新，新进程使用新版'}`)
    await pruneAgentRuntimes(agent, directory, destination, options)
    // This update's own staging was renamed into place; any left is foreign.
    await pruneStaleStaging(agent, directory, options)
    return state
  } catch (error) {
    // Failed updates leave the selected installation untouched. The updater
    // reports the failure; an enabled timer tries again at its next interval.
    failure = error
    preserveStaging = error instanceof AgentInstallTerminationError
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    if (staging && !preserveStaging) {
      const partialInstall = staging
      try { await retryAgentFileOperation(() => rm(partialInstall, { recursive: true })) }
      catch (error) { cleanupErrors.push(error) }
    }
    try { await unlock() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      const errors = failure ? [failure, ...cleanupErrors] : cleanupErrors
      throw new AggregateError(errors, errors.map(errorMessage).join('; '))
    }
  }
}

export async function updateAgentRuntimes(options: AgentUpdateOptions = {}): Promise<void> {
  const results = await Promise.allSettled(AGENTS.map(agent => updateAgentRuntime(agent, options)))
  const failures: Error[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      const error = new Error(`${AGENTS[i]}: ${errorMessage(result.reason)}`)
      options.report?.(`Agent 更新失败: ${error.message}`)
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
}

export function startAgentAutoUpdates(report: (message: string) => void, options: {
  enabled?: Partial<Record<UpdatedAgent, boolean>>
  update?: typeof updateAgentRuntime
} = {}): () => Promise<void> {
  const stops = AGENTS.filter(agent => options.enabled?.[agent] === true).map(agent => {
    const controller = new AbortController()
    let pending: Promise<void> | undefined
    const timer = setInterval(() => {
      if (pending) return
      pending = (options.update ?? updateAgentRuntime)(agent, { report, signal: controller.signal })
        .then(() => {}, error => report(`${agent} 自动更新未完成: ${errorMessage(error)}`))
        .finally(() => { pending = undefined })
    }, AGENT_UPDATE_INTERVAL_MS)
    timer.unref()
    return (): Promise<void> => { clearInterval(timer); controller.abort(); return pending ?? Promise.resolve() }
  })
  /** Stops synchronously; the result settles once cancelled updates released their lock and staging. */
  return async () => { await Promise.all(stops.map(stop => stop())) }
}
