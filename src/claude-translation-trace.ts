import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync,
  type Stats,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { CLAUDE_TRANSLATION_TRACES_DIR } from './paths'

export type ClaudeTranslationTraceRecord =
  | { event: 'request'; requestId: string; direction: 'en' | 'zh'; body: unknown; endpoint?: string }
  | { event: 'response'; requestId: string; status: number; bodyText: string }
  | { event: 'result'; requestId: string; text?: string; fields?: string[] }
  | { event: 'error'; requestId: string; message: string; cancelled?: boolean }

export interface ClaudeTranslationTraceOptions {
  workDir: string
  sourceId?: string | null
  /** Test isolation; production callers use the path declared in paths.ts. */
  directory?: string
}

export class ClaudeTranslationTraceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeTranslationTraceError'
  }
}

type Identity = Pick<Stats, 'dev' | 'ino'>

function sameIdentity(actual: Identity, expected: Identity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino
}

function checkPrivatePath(stat: Stats, path: string, directory: boolean): void {
  if (stat.isSymbolicLink()) throw new Error(`Trace path must not be a symlink: ${path}`)
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Trace path must be a ${directory ? 'directory' : 'regular file'}: ${path}`)
  }
  const mode = directory ? 0o700 : 0o600
  if ((stat.mode & 0o7777) !== mode) throw new Error(`Trace permissions must be ${mode.toString(8)}: ${path}`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Trace path must belong to the current user: ${path}`)
  }
  if (!directory && stat.nlink !== 1) throw new Error(`Trace file must not have hard links: ${path}`)
}

function textRedactor(secrets: readonly string[]): (text: string) => string {
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (typeof secret !== 'string') throw new Error('Trace secrets must be strings')
    if (!secret) continue
    variants.add(secret)
    // An HTTP body can already contain a JSON-escaped copy of a credential.
    variants.add(JSON.stringify(secret).slice(1, -1))
  }
  if (!variants.size) return text => text
  const pattern = new RegExp([...variants].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return text => text.replace(pattern, '[REDACTED]')
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key),
    /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|auth_token|access_token)$/i.test(key)
      ? '[REDACTED]' : redactValue(item, redact),
  ]))
}

/** Complete, append-only private JSONL evidence. It never writes to the daemon
 * logger. A failed append poisons this trace: callers must surface the failure,
 * not continue with a silently incomplete trace or recreate a removed file. */
export class ClaudeTranslationTrace {
  readonly traceId = randomUUID()
  readonly filePath: string
  private readonly directory: string
  private readonly workDir: string
  private readonly sourceId: string | null
  private sessionId: string | null = null
  private directoryIdentity: Identity | null = null
  private fileIdentity: Identity | null = null
  private failure: ClaudeTranslationTraceError | null = null
  /** A later context can contain an earlier credential after account rotation. */
  private readonly knownSecrets = new Set<string>()

  constructor(options: ClaudeTranslationTraceOptions) {
    if (!options.workDir.trim()) throw new ClaudeTranslationTraceError('Translation trace workDir is required')
    this.directory = resolve(options.directory ?? CLAUDE_TRANSLATION_TRACES_DIR)
    this.workDir = resolve(options.workDir)
    this.sourceId = options.sourceId ?? null
    this.filePath = join(this.directory, `${this.traceId}.jsonl`)
  }

  bindSession(sessionId: string): void {
    if (this.failure) throw this.failure
    if (!sessionId.trim()) throw new ClaudeTranslationTraceError('Translation trace sessionId is required')
    if (this.sessionId === sessionId) return
    if (this.sessionId !== null) throw new ClaudeTranslationTraceError('Translation trace session mismatch')
    this.write({ event: 'session_bound', requestId: null }, [], sessionId)
    this.sessionId = sessionId
  }

  append(record: ClaudeTranslationTraceRecord, secrets: readonly string[] = []): void {
    if (this.failure) throw this.failure
    if (!record.requestId?.trim()) throw new ClaudeTranslationTraceError('Translation trace requestId is required')
    // Explicitly copy only the supported fields: request headers are not part
    // of this API and cannot accidentally be spread into the log envelope.
    let payload: Record<string, unknown>
    switch (record.event) {
      case 'request':
        if (!['en', 'zh'].includes(record.direction) || record.body === undefined) {
          throw new ClaudeTranslationTraceError('Translation trace request requires direction and body')
        }
        payload = { direction: record.direction, body: record.body, ...(record.endpoint ? { endpoint: record.endpoint } : {}) }
        break
      case 'response':
        if (!Number.isInteger(record.status) || typeof record.bodyText !== 'string') {
          throw new ClaudeTranslationTraceError('Translation trace response requires HTTP status and bodyText')
        }
        payload = { status: record.status, bodyText: record.bodyText }
        break
      case 'result':
        if (record.text === undefined && record.fields === undefined
          || record.text !== undefined && typeof record.text !== 'string'
          || record.fields !== undefined && (!Array.isArray(record.fields) || record.fields.some(field => typeof field !== 'string'))) {
          throw new ClaudeTranslationTraceError('Translation trace result requires text or string fields')
        }
        payload = { ...(record.text !== undefined ? { text: record.text } : {}),
          ...(record.fields !== undefined ? { fields: record.fields } : {}) }
        break
      case 'error':
        if (typeof record.message !== 'string' || record.cancelled !== undefined && typeof record.cancelled !== 'boolean') {
          throw new ClaudeTranslationTraceError('Translation trace error requires message and an optional cancellation flag')
        }
        payload = { message: record.message, ...(record.cancelled !== undefined ? { cancelled: record.cancelled } : {}) }
        break
      default:
        throw new ClaudeTranslationTraceError('Unknown translation trace event')
    }
    this.write({ event: record.event, requestId: record.requestId, ...payload }, secrets, this.sessionId)
  }

  private ensureDirectory(): Stats {
    let stat: Stats
    try { stat = lstatSync(this.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.directoryIdentity) throw error
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      stat = lstatSync(this.directory)
    }
    checkPrivatePath(stat, this.directory, true)
    if (this.directoryIdentity && !sameIdentity(stat, this.directoryIdentity)) {
      throw new Error(`Trace directory changed: ${this.directory}`)
    }
    return stat
  }

  private write(record: Record<string, unknown>, secrets: readonly string[], sessionId: string | null): void {
    if (this.failure) throw this.failure
    let fd: number | null = null
    let error: unknown
    let failed = false
    let redact = (text: string) => text
    try {
      for (const secret of secrets) if (secret) this.knownSecrets.add(secret)
      redact = textRedactor([...this.knownSecrets])
      const envelope = { ...record, version: 1, time: new Date().toISOString(), traceId: this.traceId,
        workDir: this.workDir, sourceId: this.sourceId, sessionId }
      // Match JSON request semantics (including toJSON/undefined) before
      // recursively redacting both string values and object keys.
      const json = JSON.parse(JSON.stringify(envelope))
      const line = JSON.stringify(redactValue(json, redact)) + '\n'
      const directory = this.ensureDirectory()
      if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Trace requires no-follow file opens')
      if (this.fileIdentity) checkPrivatePath(lstatSync(this.filePath), this.filePath, false)
      fd = openSync(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
        | (this.fileIdentity ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
      const file = fstatSync(fd)
      checkPrivatePath(file, this.filePath, false)
      if (this.fileIdentity && !sameIdentity(file, this.fileIdentity)) throw new Error(`Trace file changed: ${this.filePath}`)
      const currentDirectory = this.ensureDirectory()
      if (!sameIdentity(currentDirectory, directory)) throw new Error(`Trace directory changed during open: ${this.directory}`)
      const currentFile = lstatSync(this.filePath)
      checkPrivatePath(currentFile, this.filePath, false)
      if (!sameIdentity(file, currentFile)) throw new Error(`Trace file changed during open: ${this.filePath}`)
      this.directoryIdentity = directory
      this.fileIdentity = file
      writeFileSync(fd, line, 'utf8')
      fsyncSync(fd)
    } catch (caught) { error = caught; failed = true }
    finally {
      if (fd !== null) {
        try { closeSync(fd) } catch (closeError) {
          error = failed ? new AggregateError([error, closeError], `${String(error)}; trace close failed: ${String(closeError)}`) : closeError
          failed = true
        }
      }
    }
    if (failed) {
      this.failure = new ClaudeTranslationTraceError(`Claude translation trace write failed: ${redact(error instanceof Error ? error.message : String(error))}`)
      throw this.failure
    }
  }
}
