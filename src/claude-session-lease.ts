import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Resolve existing aliases without creating state for a control-only query. */
export function canonicalClaudeHistoryRoot(path: string, depth = 0): string {
  if (depth > 40) throw new Error(`Claude history path has too many symbolic links: ${path}`)
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  // A not-yet-created target can still be reached through a directory link.
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      return canonicalClaudeHistoryRoot(resolve(dirname(absolute), readlinkSync(absolute)), depth + 1)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return join(canonicalClaudeHistoryRoot(parent, depth), basename(absolute))
}

type LeaseState = { writer: { owner: symbol; isActive(): boolean } | null; readers: Set<symbol> }
const leases = new Map<string, LeaseState>()

export interface ClaudeSessionLease {
  readonly historyRoot: string
  readonly sessionId: string
  /** A fork's source becomes independent once native init has loaded its snapshot. */
  releaseSource(): void
  /** Call only once the native process has actually exited (or never started). */
  release(): void
}

/** All main/delegated Claude processes in this daemon share this registry. */
export function acquireClaudeSessionLease(options: {
  historyRoot: string
  sessionId: string
  sourceSessionId?: string
  /** A completed native checkpoint is safe to snapshot during later append-only turns. */
  sourceCheckpointId?: string
  /** Writer ownership lasts until exit; a completed idle process can still be forked. */
  isActive?(): boolean
}): ClaudeSessionLease {
  if (!options.sessionId) throw new Error('Claude session lease requires a session ID')
  const historyRoot = canonicalClaudeHistoryRoot(options.historyRoot)
  const historyKey = process.platform === 'win32' ? historyRoot.toLowerCase() : historyRoot
  const key = (id: string) => `${historyKey}\0${id}`
  const destination = key(options.sessionId)
  const source = options.sourceSessionId ? key(options.sourceSessionId) : undefined
  if (source === destination) throw new Error('Claude fork destination must differ from its source session')
  const state = leases.get(destination)
  if (state?.writer || state?.readers.size) {
    throw new Error(`Claude 会话正在使用，请先停止该会话再恢复：${options.sessionId}`)
  }
  if (source && !options.sourceCheckpointId && leases.get(source)?.writer?.isActive()) {
    throw new Error(`Claude 原会话正在运行，暂时不能分叉：${options.sourceSessionId}`)
  }
  const owner = Symbol(options.sessionId)
  leases.set(destination, { writer: { owner, isActive: options.isActive ?? (() => true) }, readers: new Set() })
  if (source) {
    const readers = leases.get(source) ?? { writer: null, readers: new Set<symbol>() }
    readers.readers.add(owner)
    leases.set(source, readers)
  }
  let sourceReleased = false
  let released = false
  const releaseSource = () => {
    if (sourceReleased) return
    sourceReleased = true
    if (!source) return
    const current = leases.get(source)
    current?.readers.delete(owner)
    if (current && !current.writer && current.readers.size === 0) leases.delete(source)
  }
  return {
    historyRoot,
    sessionId: options.sessionId,
    releaseSource,
    release() {
      if (released) return
      released = true
      releaseSource()
      const current = leases.get(destination)
      if (current?.writer?.owner === owner) {
        current.writer = null
        // A fork may still be loading the source after its original writer exits.
        if (current.readers.size === 0) leases.delete(destination)
      }
    },
  }
}
