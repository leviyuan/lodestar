import { networkFetch } from './network'
/** Explicit/opt-in Agent updates follow latest independently of Lodestar releases. */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_RUNTIMES_DIR } from './paths'
import { AGENT_INSTALLER_RECORD, AgentInstallTerminationError, installAgentPackages } from './agent-install'
import { writeStateFileAtomic } from './state-store'
import { processStartId, sameProcessStart } from './pid-guard'
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
  os?: string[] | string
  cpu?: string[] | string
  libc?: string[] | string
}
type PlatformConstraint = Pick<Manifest, 'os' | 'cpu' | 'libc'>
/** Family-internal edges of each resolved DSH package: what it requires (`dependencies`,
 * `peerDependencies`) and what it lists as optional, plus its own platform constraint.
 * npm may skip an optional package on platforms its manifest excludes, together with
 * whatever only that package requires; such packages still belong in the version
 * snapshot/overrides. */
interface FamilyEdges { hard: ReadonlySet<string>; optional: ReadonlySet<string>; platform: PlatformConstraint }
const FAMILY_EDGES = Symbol('familyEdges')
type ResolvedAgentPackages = Record<string, string> & { [FAMILY_EDGES]?: ReadonlyMap<string, FamilyEdges> }
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
const LOCK_STAGING_PREFIX = '.lock-staging-'
/** Far longer than mkdir -> holder file, including an older version's atomic PID write. */
const LOCK_PID_GRACE_MS = 30_000
/** Older versions verified a moved-aside lock and could rename it back; leave a recent one alone. */
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
  if (!state?.directory) throw new Error(`${agent} runtime 未安装，请运行 lodestar update --agents-only`)
  if (!existsSync(state.directory)) throw new Error(`${agent} runtime 安装目录不存在: ${state.directory}；请运行 lodestar update --agents-only`)
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
  const edges = new Map<string, FamilyEdges>()
  const family = (name: string) => name.startsWith('@deepseek-ai/dsh')
  while (pending.size) {
    const batch = [...pending].slice(0, 12)
    for (const name of batch) { pending.delete(name); seen.add(name) }
    const rows = await Promise.all(batch.map(name => name === main.name ? main : read(name, main.version)))
    for (const row of rows) {
      if (row.version !== main.version) throw new Error(`DSH release package mismatch: ${row.name}@${row.version}, expected ${main.version}`)
      dependencies[row.name] = row.version
      // npm lets an optionalDependencies entry override a same-named regular dependency.
      const optional = new Set(Object.keys(row.optionalDependencies ?? {}).filter(family))
      const hard = new Set(Object.keys({ ...row.dependencies, ...row.peerDependencies }).filter(name => family(name) && !optional.has(name)))
      edges.set(row.name, { hard, optional, platform: { os: row.os, cpu: row.cpu, libc: row.libc } })
      for (const name of [...hard, ...optional]) if (!seen.has(name)) pending.add(name)
    }
  }
  Object.defineProperty(dependencies, FAMILY_EDGES, { value: edges, enumerable: false })
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

/** npm's os/cpu list rule (npm-install-checks): `!x` excludes x, and a list made only of
 * exclusions allows everything else. */
function npmPlatformListAllows(list: string[] | string | undefined, value: string): boolean {
  if (list === undefined) return true
  const entries = typeof list === 'string' ? [list] : list
  if (entries.length === 1 && entries[0] === 'any') return true
  let excluded = 0
  let listed = false
  for (const entry of entries) {
    if (!entry.startsWith('!')) listed ||= entry === value
    else if (entry.slice(1) === value) return false
    else excluded++
  }
  return listed || excluded === entries.length
}

/** True only when npm certainly installs the package on this platform. A libc
 * constraint is never confirmed (Lodestar does not detect the C library), so such a
 * package counts as possibly excluded and its absence stays excused. */
function npmInstallsHere(platform: PlatformConstraint): boolean {
  return platform.libc === undefined && npmPlatformListAllows(platform.os, process.platform)
    && npmPlatformListAllows(platform.cpu, process.arch)
}

async function validateInstalledPackages(agent: UpdatedAgent, directory: string, versions: ResolvedAgentPackages): Promise<void> {
  const family = versions[FAMILY_EDGES]
  const missing = new Set<string>()
  for (const [name, version] of Object.entries(versions)) {
    let installed: Manifest
    try {
      installed = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8')) as Manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && family) { missing.add(name); continue }
      throw error
    }
    if (installed.name !== name || installed.version !== version) {
      throw new Error(`Invalid Agent runtime at ${directory}: expected ${name}@${version}, found ${installed.name}@${installed.version}`)
    }
  }
  // A DSH package npm skipped is excused only when nothing installed requires it: every
  // package that needs it lists it as optional, or is itself absent (reachable only
  // through a skipped optional package). A required one missing is a broken install, and
  // so is an optional one npm attempted (an installed package lists it) on a platform its
  // manifest does not exclude: npm exits 0 when such an install fails.
  for (const name of missing) {
    const requiredBy = PACKAGES.dsh.includes(name) ? name
      : [...family!].find(([dependent, edges]) => !missing.has(dependent) && edges.hard.has(name))?.[0]
    if (requiredBy) {
      throw new Error(`Invalid Agent runtime at ${directory}: ${name}@${versions[name]} is missing${requiredBy === name ? '' : ` but required by ${requiredBy}`}`)
    }
    const attemptedBy = [...family!].find(([dependent, edges]) => !missing.has(dependent) && edges.optional.has(name))?.[0]
    if (attemptedBy && npmInstallsHere(family!.get(name)?.platform ?? {})) {
      throw new Error(`Invalid Agent runtime at ${directory}: optional ${name}@${versions[name]} of ${attemptedBy} applies to ${process.platform}-${process.arch} but is missing (its installation failed)`)
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

/** Older versions' moved-aside locks and staging directories of lock creations that never
 * reached their rename; either name carries the time it was made. */
async function staleLockAbandoned(name: string, path: string): Promise<boolean> {
  const movedAt = Number(/^\.(?:stale-lock|lock-staging)-(\d+)-/.exec(name)?.[1])
  const age = Number.isSafeInteger(movedAt) ? Date.now() - movedAt : await ageMs(path)
  return age >= STALE_LOCK_SWEEP_AGE_MS
}

/** Staging directories of interrupted or cancelled installs belong to no updater once
 * this one holds the lock. One an orphaned installer may still own stays; without a
 * process table no staging is removed. Lock directories older versions moved aside
 * while reclaiming belong to no process at all and are removed without that check. */
async function pruneStaleStaging(agent: UpdatedAgent, directory: string, options: AgentUpdateOptions): Promise<void> {
  const report = (message: string) => { try { options.report?.(message) } catch {} }
  try {
    const stale: string[] = []
    const staleLocks: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      try {
        if (entry.name.startsWith('.install-')) { if (await stagingAbandoned(path)) stale.push(path) }
        else if ((entry.name.startsWith(STALE_LOCK_PREFIX) || entry.name.startsWith(LOCK_STAGING_PREFIX))
          && await staleLockAbandoned(entry.name, path)) staleLocks.push(path)
      } catch (error) {
        // Already removed by its own reclaimer; anything else keeps the directory.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    let removed = 0
    let failed = false
    for (const path of staleLocks) {
      if (options.signal?.aborted) break
      try {
        await retryAgentFileOperation(() => rm(path, { recursive: true, force: true }))
        removed++
      } catch { failed = true }
    }
    if (stale.length > 0) {
      const result = await removeUnusedDirectories(stale, options)
      if (!result) report(`${agent}: 中断安装的临时目录清理跳过（无法确认占用）`)
      else {
        removed += result.removed
        failed ||= result.failed
      }
    }
    if (removed > 0) report(`${agent}: 已清理 ${removed} 个中断安装的临时目录`)
    if (failed) report(`${agent}: 中断安装的临时目录清理未完成，保留原目录`)
  } catch {
    report(`${agent}: 中断安装的临时目录清理未完成，保留原目录`)
  }
}

/** A lock directory names its holder with one empty file, `holder-<pid>-<token>`: PID and
 * a random token in a single name. A new lock appears complete: its files are written into a
 * private `.lock-staging-<ms>-<token>` directory that one rename publishes as the lock, so no
 * other updater ever sees, or removes, a lock half made. Taking over a stale lock renames
 * exactly its holder file to the new holder's name: of all waiters that judged the same lock
 * stale only one succeeds, and a judgement made before the lock changed finds nothing to
 * rename; nothing is ever moved back. `start-<token>` records the holder's own process start
 * identity (`processStartId`); a live process whose identity differs got the holder's PID
 * later. The identity does not depend on the wall clock, which may step while a lock is held.
 * `pid` repeats the holder for older Lodestar versions, whose own locks (`pid` + `owner`) are
 * taken over through their `owner` file the same way. Older versions create the directory
 * first and fill it afterwards, and on POSIX a rename may replace such a still-empty
 * directory, so an old and a new version updating at the same moment are not strictly
 * serialized. A released lock is first renamed to `.stale-lock-<ms>-<uuid>`, freeing the path
 * at once; what an interrupted removal leaves there is swept later. Never the inode or the
 * timestamps of the directory: Linux gives the inode of a directory just removed to the next
 * one created; `mtimeMs` only dates an older version's directory without a holder. */
const LOCK_HOLDER = /^holder-([1-9]\d*)-([0-9a-f-]{36})$/
const lockHolderName = (pid: number, token: string): string => `holder-${pid}-${token}`
/** Holder files this process owns or is about to own. One naming this PID but missing here
 * was left by an earlier process that had the same PID (a daemon restarted after a reboot). */
const ownHolders = new Set<string>()
/** This process's start identity; a failed query is retried by the next lock. */
let ownStartId: string | null = null
async function currentProcessStartId(): Promise<string | null> {
  return ownStartId ??= await processStartId(process.pid)
}

interface ObservedLock {
  entries: string[]
  /** Holder file; absent only in an older version's lock. */
  holder: string | undefined
  pid: number | undefined
  /** An older version's complete lock: `pid` and `owner`, no holder file. */
  legacy: boolean
  /** The holder's start identity (`start-<token>`), if recorded yet. */
  start: string | undefined
  mtimeMs: number
}

async function observeLock(path: string): Promise<ObservedLock> {
  const { mtimeMs } = await stat(path)
  const entries = await readdir(path)
  const read = async (name: string): Promise<string | undefined> => {
    try { return await readFile(join(path, name), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }
  const holder = entries.find(name => LOCK_HOLDER.test(name))
  if (holder) {
    const [, pid, token] = LOCK_HOLDER.exec(holder)!
    const start = (await read(`start-${token}`))?.trim() || undefined
    return { entries, holder, pid: Number(pid), legacy: false, start, mtimeMs }
  }
  const recorded = entries.includes('pid') ? await read('pid') : undefined
  const pid = recorded === undefined ? undefined : Number(recorded)
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error(`Invalid runtime update lock: ${path}`)
  return { entries, holder: undefined, pid, legacy: pid !== undefined && entries.includes('owner'), start: undefined, mtimeMs }
}

/** What a waiter learned about one holder: a definite answer, or when to ask again after a
 * failed start-identity query (backing off up to half a minute). */
interface HolderCheck { reused?: boolean; retryAt: number; delay: number }

/** The recorded holder exited, or its PID now belongs to a process with another start
 * identity. Anything short of that proof (identity not recorded yet, query failed) counts as
 * the holder still running, and the lock is waited for. */
async function lockHolderGone(observed: ObservedLock, checks: Map<string, HolderCheck>): Promise<boolean> {
  const pid = observed.pid!
  if (pid === process.pid) return !observed.holder || !ownHolders.has(observed.holder)
  if (!processAlive(pid)) return true
  if (!observed.holder || observed.start === undefined) return false
  const check = checks.get(observed.holder)
  if (check?.reused !== undefined) return check.reused
  if (check && performance.now() < check.retryAt) return false
  const current = await processStartId(pid)
  if (current === null) {
    const delay = check ? Math.min(check.delay * 2, 30_000) : 1_000
    checks.set(observed.holder, { retryAt: performance.now() + delay, delay })
    return false
  }
  const reused = !sameProcessStart(current, observed.start)
  checks.set(observed.holder, { reused, retryAt: 0, delay: 0 })
  return reused
}

/** Publishes a complete lock held by `mine` with one rename of a private staging directory.
 * `exists` when a lock is already in place. The rename only runs when the path was free:
 * POSIX lets a rename replace an empty directory, which is how an older version's lock looks
 * between its creation and its first write (or after that version died there, which the
 * 30-second rule handles), so only that narrow moment remains open to it. */
async function createLock(directory: string, path: string, mine: string, files: Record<string, string>): Promise<'held' | 'exists'> {
  try {
    await stat(path)
    return 'exists'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const staging = join(directory, `${LOCK_STAGING_PREFIX}${Date.now()}-${randomUUID()}`)
  await mkdir(staging)
  try {
    // A private directory published by one rename: plain writes, retried while Windows
    // scanners briefly hold a new file.
    await retryAgentFileOperation(() => writeFile(join(staging, mine), '', { flag: 'wx', mode: 0o600 }))
    for (const [name, content] of Object.entries(files)) {
      await retryAgentFileOperation(() => writeFile(join(staging, name), content, { mode: 0o600 }))
    }
    try {
      await rename(staging, path)
      return 'held'
    } catch (error) {
      // POSIX refuses a non-empty target; Windows refuses any existing directory.
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'exists'
      throw error
    }
  } finally {
    // Gone after a successful rename; a leftover is swept by a later update.
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** Claims a lock judged stale for `mine`. `held`: the holder file is now this updater's;
 * `free`: the abandoned directory is gone and may be created again; `changed`: the lock
 * is no longer the one judged stale and the caller waits. */
async function reclaimLock(path: string, observed: ObservedLock, mine: string): Promise<'held' | 'free' | 'changed'> {
  const source = observed.holder ?? (observed.legacy ? 'owner' : undefined)
  if (source) {
    try {
      await retryAgentFileOperation(() => rename(join(path, source), join(path, mine)))
      return 'held'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'changed'
      throw error
    }
  }
  // No holder: an older version died right after creating the directory. Remove what was
  // seen in it, then the directory only if empty. A lock published meanwhile always holds
  // its holder file, so the removal fails and the caller waits.
  for (const name of observed.entries) await retryAgentFileOperation(() => rm(join(path, name), { recursive: true, force: true }))
  try {
    await rmdir(path)
    return 'free'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'free'
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') return 'changed'
    throw error
  }
}

/** Directory lock also serializes a manual CLI update with the daemon timer. */
async function lock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const path = join(directory, 'update.lock')
  const deadline = Date.now() + 360_000
  const token = randomUUID()
  const mine = lockHolderName(process.pid, token)
  const checks = new Map<string, HolderCheck>()
  const startId = await currentProcessStartId()
  const records = (): Record<string, string> => ({ pid: String(process.pid), ...(startId ? { [`start-${token}`]: startId } : {}) })
  // A lock already gone, or held by another updater, is not this updater's to remove. One
  // rename frees the path at once; a removal cut short leaves only an inert directory.
  const release = async (): Promise<void> => {
    try {
      await stat(join(path, mine))
      const aside = join(directory, `${STALE_LOCK_PREFIX}${Date.now()}-${randomUUID()}`)
      try { await retryAgentFileOperation(() => rename(path, aside)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        await retryAgentFileOperation(() => rm(path, { recursive: true }))
        return
      }
      await retryAgentFileOperation(() => rm(aside, { recursive: true, force: true })).catch(() => {})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally { ownHolders.delete(mine) }
  }
  /** After taking over a lock in place: its records still describe the previous holder. */
  const publish = async (): Promise<() => Promise<void>> => {
    try {
      // Other updaters may inspect the directory immediately: every file appears complete,
      // and none recreates a lock directory that is gone.
      for (const [name, content] of Object.entries(records())) {
        await retryAgentFileOperation(async () => writeStateFileAtomic(join(path, name), content, { createParent: false }))
      }
    } catch (error) {
      try { await release() }
      catch (cleanup) { throw new AggregateError([error, cleanup], `${errorMessage(error)}; runtime update lock cleanup failed: ${errorMessage(cleanup)}`) }
      throw error
    }
    return release
  }
  ownHolders.add(mine)
  try {
    for (;;) {
      signal?.throwIfAborted()
      if (await createLock(directory, path, mine, records()) === 'held') {
        await updateLockForTest.afterCreate?.()
        return release
      }
      try {
        const observed = await observeLock(path)
        const stale = observed.holder || observed.legacy ? await lockHolderGone(observed, checks)
          // A directory without a holder file: an older version died before publishing one
          // (`pid` without `owner`: it died between its two writes).
          : observed.pid !== undefined ? observed.pid === process.pid || !processAlive(observed.pid)
            : Date.now() - observed.mtimeMs >= LOCK_PID_GRACE_MS
        if (stale) {
          const outcome = await reclaimLock(path, observed, mine)
          if (outcome === 'held') return await publish()
          // A reclaim that finds another updater's lock in its place waits like any other waiter.
          if (outcome === 'free') continue
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for runtime update lock: ${path}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  } catch (error) {
    ownHolders.delete(mine)
    throw error
  }
}

/** Lock protocol steps exposed for concurrency tests (outdated judgements are replayed
 * directly); `afterCreate` runs right after this process published a new lock. */
export const updateLockForTest: {
  observe: typeof observeLock
  reclaim: typeof reclaimLock
  create: typeof createLock
  holderGone: typeof lockHolderGone
  holderName: typeof lockHolderName
  afterCreate?: () => Promise<void> | void
} = { observe: observeLock, reclaim: reclaimLock, create: createLock, holderGone: lockHolderGone, holderName: lockHolderName }

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
