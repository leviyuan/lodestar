/** Explicit/opt-in Agent updates follow latest independently of Lodestar releases. */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_RUNTIMES_DIR } from './paths'
import { AgentInstallTerminationError, installAgentPackages } from './agent-install'
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
  error?: string
}
export interface AgentUpdateOptions {
  root?: string
  signal?: AbortSignal
  report?: (message: string) => void
  /** Injectable registry and installer for isolated, offline lifecycle tests. */
  metadata?: (name: string, version: string) => Promise<Manifest>
  install?: (directory: string, signal?: AbortSignal) => Promise<void>
}

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

/** Constructors only read the selected local install; they never check versions. */
export function agentRuntimeRoot(agent: UpdatedAgent): string {
  // Tests explicitly use their own dependency tree; production never substitutes it.
  if (process.env.NODE_ENV === 'test' && process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT) {
    return process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT
  }
  const state = readState(agent)
  if (state?.error) throw new Error(`${agent} 更新失败: ${state.error}`)
  if (!state?.directory) throw new Error(`${agent} runtime 未安装，请运行 lodestar-update --agents-only`)
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
    const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: abort.signal })
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

/** Directory lock also serializes a manual CLI update with the daemon timer. */
async function lock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const path = join(directory, 'update.lock')
  const deadline = Date.now() + 360_000
  for (;;) {
    signal?.throwIfAborted()
    try {
      await mkdir(path)
      await writeFile(join(path, 'pid'), String(process.pid))
      return () => retryAgentFileOperation(() => rm(path, { recursive: true }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const pid = Number(await readFile(join(path, 'pid'), 'utf8'))
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid runtime update lock: ${path}`)
        try { process.kill(pid, 0) }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause
          await retryAgentFileOperation(() => rm(path, { recursive: true }))
          continue
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
    options.report?.(`${agent}: 检查 upstream latest`)
    const previous = readState(agent, root)
    const versions = await resolveAgentPackages(agent, options.metadata ?? ((name, version) => metadata(name, version, options.signal)))
    options.signal?.throwIfAborted()
    const security = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).overrides ?? {}
    const fingerprint = createHash('sha256').update(JSON.stringify({ installFormat: 2, versions: Object.entries(versions).sort(), security,
      platform: process.platform, arch: process.arch })).digest('hex').slice(0, 20)
    const destination = join(directory, fingerprint)
    if (!existsSync(destination)) {
      staging = await mkdtemp(join(directory, '.install-'))
      // Resolved versions are an installation snapshot, never a compatibility whitelist.
      await writeFile(join(staging, 'package.json'), JSON.stringify({ name: `lodestar-runtime-${agent}`, version: versions[PACKAGES[agent][0]], private: true, type: 'module',
        dependencies: versions, overrides: { ...security, ...(agent === 'dsh' ? versions : {}) } }) + '\n', { mode: 0o600 })
      await (options.install ?? installAgentPackages)(staging, options.signal)
      for (const [name, version] of Object.entries(versions)) {
        const installed = JSON.parse(await readFile(join(staging, 'node_modules', name, 'package.json'), 'utf8'))
        if (installed.version !== version) throw new Error(`npm installed ${name}@${installed.version}, expected ${version}`)
      }
      options.signal?.throwIfAborted()
      const completedInstall = staging
      await retryAgentFileOperation(() => rename(completedInstall, destination))
      staging = undefined
    }
    const state = { directory: destination, versions, checkedAt: Date.now() }
    await writeState(directory, state)
    options.report?.(`${agent}: ${PACKAGES[agent][0]}@${versions[PACKAGES[agent][0]]}${previous?.directory === destination ? ' 已是 latest' : ' 已更新，新进程使用新版'}`)
    return state
  } catch (error) {
    // Old processes own immutable paths. A failed refresh is visible and blocks new starts.
    failure = error
    preserveStaging = error instanceof AgentInstallTerminationError
    try { await writeState(directory, { checkedAt: Date.now(), error: errorMessage(error) }) }
    catch (stateError) {
      failure = new AggregateError([error, stateError], `${errorMessage(error)}; recording update failure also failed: ${errorMessage(stateError)}`)
      throw failure
    }
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
} = {}): () => void {
  const stops = AGENTS.filter(agent => options.enabled?.[agent] === true).map(agent => {
    const controller = new AbortController()
    let pending: Promise<unknown> | undefined
    const timer = setInterval(() => {
      if (pending) return
      pending = (options.update ?? updateAgentRuntime)(agent, { report, signal: controller.signal })
        .catch(error => report(`${agent} 自动更新未完成: ${errorMessage(error)}`))
        .finally(() => { pending = undefined })
    }, AGENT_UPDATE_INTERVAL_MS)
    timer.unref()
    return () => { clearInterval(timer); controller.abort() }
  })
  return () => { for (const stop of stops) stop() }
}
