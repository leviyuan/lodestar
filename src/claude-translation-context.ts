import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CLAUDE_TRANSLATION_CONTEXT_DIR } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { findMarkdownFencedCodeRanges } from './claude-translation-code'

/** Semantic provenance only: these labels never contain event IDs or native
 * schemas. Callers choose the label at the visible-text extraction boundary. */
export const CLAUDE_TRANSLATION_ORIGINS = {
  userMessage: 'Feishu user → Claude Code: user message.',
  userAnswer: 'Feishu user → Claude Code: answer to a question.',
  reply: 'Claude Code → Feishu user: conversational reply.',
  commandExplanation: 'Claude Code → Feishu user: explanation accompanying a command.',
  taskText: 'Claude Code → Feishu user: task title, description or progress text.',
  question: 'Claude Code → Feishu user: question or answer option.',
  toolResult: 'Tool → Claude Code, also shown to the Feishu user: visible tool result.',
  subagentOutput: 'Claude Code subagent → parent agent, also shown to the Feishu user: visible subagent text.',
  delegatedRequest: 'Caller → delegated Claude Code agent, also shown to the Feishu user: delegated task request.',
  delegatedAnswer: 'Caller → delegated Claude Code agent, also shown to the Feishu user: answer to a delegated-agent question.',
  delegatedQuestion: 'Delegated Claude Code agent → caller, also shown to the Feishu user: question or answer option.',
  delegatedOutput: 'Delegated agent → caller, also shown to the Feishu user: visible delegated-task text.',
  backgroundUpdate: 'Claude Code background task → Feishu user: visible task update.',
  scheduledPrompt: 'Scheduled task → Claude Code, also shown to the Feishu user: scheduled prompt.',
  error: 'Claude Code runtime → Feishu user: visible error.',
  legacyUserMessage: 'User or caller → Claude Code: message (older record did not distinguish the input source).',
  legacyUserAnswer: 'User or caller → Claude Code: answer to a question (older record did not distinguish the input source).',
  legacyVisibleOutput: 'Conversation → Feishu user: visible output (older record did not identify the source more precisely).',
  legacyUnknown: 'Visible conversation text (older record did not identify its sender, recipient or source).',
} as const

/** Older ledgers did not distinguish all display sources. Preserve what their
 * role really proves; never guess that a general output was a main-agent reply. */
export function claudeTranslationOriginForRole(role: string): string {
  switch (role) {
    case 'user': return CLAUDE_TRANSLATION_ORIGINS.legacyUserMessage
    case 'user/answer': return CLAUDE_TRANSLATION_ORIGINS.legacyUserAnswer
    case 'assistant/question': return CLAUDE_TRANSLATION_ORIGINS.question
    case 'assistant/command-description': return CLAUDE_TRANSLATION_ORIGINS.commandExplanation
    case 'assistant/task-text': return CLAUDE_TRANSLATION_ORIGINS.taskText
    case 'assistant/tool-result': return CLAUDE_TRANSLATION_ORIGINS.toolResult
    case 'assistant/error': return CLAUDE_TRANSLATION_ORIGINS.error
    case 'assistant/background': return CLAUDE_TRANSLATION_ORIGINS.backgroundUpdate
    case 'assistant/scheduled': return CLAUDE_TRANSLATION_ORIGINS.scheduledPrompt
    default: return role === 'assistant' || role.startsWith('assistant/')
      ? CLAUDE_TRANSLATION_ORIGINS.legacyVisibleOutput : CLAUDE_TRANSLATION_ORIGINS.legacyUnknown
  }
}

export type ClaudeTranslationContextEntry = {
  role: string
  /** Who speaks to whom, and on which visible surface; no protocol metadata. */
  origin?: string
  /** Plain conversational pair used to build the translator's chat history. */
  original: string
  translated: string
  uuid?: string
  status?: 'pending' | 'consumed'
}

export type ClaudeTranslationContextSnapshot = {
  sessionId: string | null
  sourceSessionId: string | null
  /** Only exchanges observed since boundary recording was enabled are present.
   * This is not Claude's complete native conversation or internal context. */
  coverage: 'since-enabled'
  entries: ReadonlyArray<Readonly<ClaudeTranslationContextEntry>>
}

type ContextOptions = {
  workDir: string
  resumeSessionId?: string
  resumeSessionAt?: string
  forkSession?: boolean
  storeDir?: string
}

type StoredEntry = ClaudeTranslationContextEntry & { sequence: number; key?: string }
type ToolName = { id: string; name: string; sequence: number }
type Checkpoint = { uuid: string; sequence: number }
type DisplayRecord = {
  tools?: ReadonlyArray<{ id: string; name: string }>
  output?: { kind: string; original: string; display: string; uuid?: string; key?: string; origin?: string }
  checkpoint?: string
}
type Ledger = {
  version: 2
  workDir: string
  sessionId: string
  coverage: 'since-enabled'
  sequence: number
  entries: StoredEntry[]
  tools: ToolName[]
  checkpoints: Checkpoint[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim()
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Keep conversational wording, including inline names and paths, but not code
 * bodies or host file-delivery protocol. No replacement metadata is invented. */
function conversationProse(text: string): string {
  let result = '', position = 0
  for (const range of findMarkdownFencedCodeRanges(text)) {
    result += text.slice(position, range.start)
    position = range.end
  }
  return (result + text.slice(position))
    .replace(/\[\[send:\s*[^\]\n]+\]\]|\[file:\s*[^\]\n]+\]/g, '')
    .trim()
}

/** Version 1 stored pairs as known prose wrappers. Ambiguous or unknown legacy
 * text must fail explicitly; native history is never used to reconstruct it. */
function legacyPair(role: string, text: string, sessionId: string): { original: string; translated: string } {
  const invalid = (): never => { throw new Error(`Claude translation context legacy pair is malformed or ambiguous: ${sessionId}`) }
  let prefix: string, separator: string
  if (role === 'user') {
    prefix = 'Original user text:\n'
    separator = '\nEnglish submitted text:\n'
  } else if (role === 'user/answer') {
    prefix = 'Original user answer:\n'
    separator = '\nSubmitted answer:\n'
  } else if (role.startsWith('assistant/')) {
    prefix = 'Original Claude output:\n'
    separator = '\nVerified display text:\n'
  } else return invalid()
  if (!text.startsWith(prefix)) return invalid()
  const parts = text.slice(prefix.length).split(separator)
  if (parts.length !== 2) return invalid()
  // Old ledgers deliberately did not retain code. Remove their omission note;
  // never recover missing code or identifiers from native files.
  const clean = (value: string) => conversationProse(value.replaceAll('[Code omitted from translation context.]', ''))
  return { original: clean(parts[0]!), translated: clean(parts[1]!) }
}

function checkPrivatePath(path: string, directory: boolean): boolean {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Claude translation context path is not a regular ${directory ? 'directory' : 'file'}: ${path}`)
  }
  const expected = directory ? 0o700 : 0o600
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== expected) {
    throw new Error(`Claude translation context permissions must be ${expected.toString(8)}: ${path}`)
  }
  return true
}

function validateLedger(value: unknown, workDir: string, sessionId: string): Ledger {
  const invalid = (): never => { throw new Error(`Claude translation context ledger is malformed: ${sessionId}`) }
  if (!isRecord(value)) return invalid()
  if (value.workDir !== workDir || value.sessionId !== sessionId) {
    throw new Error(`Claude translation context session/cwd mismatch for ${sessionId}`)
  }
  if (value.version !== 1 && value.version !== 2 || value.coverage !== 'since-enabled' || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0 || !Array.isArray(value.entries) || !Array.isArray(value.tools)
    || !Array.isArray(value.checkpoints)) return invalid()
  const maximum = value.sequence as number
  const validSequence = (sequence: unknown): sequence is number =>
    Number.isSafeInteger(sequence) && (sequence as number) >= 0 && (sequence as number) <= maximum
  const sequences = new Set<number>()
  const keys = new Set<string>()
  const entries: StoredEntry[] = []
  let previousEntrySequence = 0
  for (const entry of value.entries) {
    const fields = value.version === 1 ? ['role', 'text', 'uuid', 'status', 'sequence', 'key']
      : ['role', 'text', 'original', 'translated', 'origin', 'uuid', 'status', 'sequence', 'key']
    if (!isRecord(entry) || Object.keys(entry).some(key => !fields.includes(key)) || !nonempty(entry.role) || entry.status !== 'consumed'
      || !validSequence(entry.sequence) || entry.sequence === 0
      || entry.origin !== undefined && !nonempty(entry.origin)
      || entry.uuid !== undefined && !nonempty(entry.uuid)
      || entry.key !== undefined && !nonempty(entry.key)) return invalid()
    if (value.version === 1 && !nonempty(entry.text)) return invalid()
    if (value.version === 2 && (typeof entry.original !== 'string' || typeof entry.translated !== 'string'
      || entry.text !== undefined && typeof entry.text !== 'string')) return invalid()
    if (entry.sequence <= previousEntrySequence || sequences.has(entry.sequence) || typeof entry.key === 'string' && keys.has(entry.key)) return invalid()
    previousEntrySequence = entry.sequence
    sequences.add(entry.sequence)
    if (typeof entry.key === 'string') keys.add(entry.key)
    // Early ledgers duplicated the pair in a diagnostic `text` wrapper. Read
    // v1 through that wrapper, but retain only the pair in memory and on write.
    const { text, ...pair } = entry
    entries.push({ ...pair, origin: entry.origin ?? claudeTranslationOriginForRole(entry.role),
      ...(value.version === 1 ? legacyPair(entry.role, text as string, sessionId) : {}) } as StoredEntry)
  }
  const tools = new Set<string>()
  for (const tool of value.tools) {
    if (!isRecord(tool) || Object.keys(tool).some(key => !['id', 'name', 'sequence'].includes(key)) || !nonempty(tool.id) || !nonempty(tool.name) || !validSequence(tool.sequence)
      || tool.sequence === 0 || tools.has(tool.id) || sequences.has(tool.sequence)) return invalid()
    tools.add(tool.id)
    sequences.add(tool.sequence)
  }
  const checkpoints = new Set<string>()
  for (const checkpoint of value.checkpoints) {
    if (!isRecord(checkpoint) || Object.keys(checkpoint).some(key => !['uuid', 'sequence'].includes(key)) || !nonempty(checkpoint.uuid) || !validSequence(checkpoint.sequence)
      || checkpoints.has(checkpoint.uuid)) return invalid()
    checkpoints.add(checkpoint.uuid)
  }
  return { ...value, version: 2, entries } as Ledger
}

/** Per-Claude-session ledger of explicitly submitted user text and visible
 * Claude output. It never accesses SDK history or Claude's native transcript. */
export class ClaudeTranslationContext {
  private readonly options: ContextOptions
  private workDir = ''
  private sessionId: string | null = null
  private entries: StoredEntry[] = []
  /** A stop can beat buffered native consumption receipts. These entries are
   * hidden from GLM and disk until a receipt confirms they were consumed. */
  private stoppedInputs = new Map<string, StoredEntry>()
  private tools: ToolName[] = []
  private checkpoints: Checkpoint[] = []
  private sequence = 0
  private initialization: Promise<void> | null = null
  private initialized = false

  constructor(options: ContextOptions) {
    this.options = options
  }

  initialize(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.initialization) this.initialization = this.loadHistory(signal)
    return this.initialization.then(() => { signal.throwIfAborted() })
  }

  private async loadHistory(signal: AbortSignal): Promise<void> {
    const { resumeSessionId, resumeSessionAt, forkSession, workDir } = this.options
    if (!resumeSessionId && (resumeSessionAt || forkSession)) {
      throw new Error('Claude translation context requires a fork/resume source session')
    }
    this.workDir = realpathSync(resolve(workDir))
    if (resumeSessionId !== undefined && !nonempty(resumeSessionId)) throw new Error('Claude translation context session id is empty')
    if (resumeSessionId) {
      const ledger = this.readLedger(resumeSessionId)
      if (ledger) {
        let boundary = ledger.sequence
        if (resumeSessionAt) {
          const checkpoint = ledger.checkpoints.find(item => item.uuid === resumeSessionAt)
          if (!checkpoint) throw new Error(`Claude translation context checkpoint not found: ${resumeSessionAt}`)
          boundary = checkpoint.sequence
        }
        this.entries = ledger.entries.filter(entry => entry.sequence <= boundary)
        this.tools = ledger.tools.filter(tool => tool.sequence <= boundary)
        this.checkpoints = ledger.checkpoints.filter(checkpoint => checkpoint.sequence <= boundary)
        this.sequence = boundary
      }
      // An older session may predate this ledger entirely. Its unrecorded
      // history is explicitly absent; never reconstruct it from native files.
      this.sessionId = forkSession ? null : resumeSessionId
    }
    signal.throwIfAborted()
    this.initialized = true
  }

  private storeRoot(): string {
    return resolve(this.options.storeDir ?? CLAUDE_TRANSLATION_CONTEXT_DIR)
  }

  private workspaceDir(): string {
    return join(this.storeRoot(), hash(this.workDir))
  }

  private filePath(id: string): string {
    return join(this.workspaceDir(), `${hash(id)}.json`)
  }

  private readLedger(id: string): Ledger | null {
    if (!checkPrivatePath(this.storeRoot(), true) || !checkPrivatePath(this.workspaceDir(), true)) return null
    const path = this.filePath(id)
    if (!checkPrivatePath(path, false)) return null
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      throw new Error(`Claude translation context ledger cannot be read: ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return validateLedger(value, this.workDir, id)
  }

  private persist(): void {
    if (!this.sessionId) return
    for (const directory of [this.storeRoot(), this.workspaceDir()]) {
      if (!checkPrivatePath(directory, true)) mkdirSync(directory, { recursive: true, mode: 0o700 })
      checkPrivatePath(directory, true)
    }
    const path = this.filePath(this.sessionId)
    checkPrivatePath(path, false)
    const ledger: Ledger = {
      version: 2, workDir: this.workDir, sessionId: this.sessionId, coverage: 'since-enabled',
      sequence: this.sequence, entries: this.entries.filter(entry => entry.status === 'consumed'),
      tools: this.tools, checkpoints: this.checkpoints,
    }
    writeJsonStateAtomic(path, ledger)
    checkPrivatePath(path, false)
  }

  /** Persistence failures must leave the operation visibly failed and prevent
   * an uncommitted interaction from leaking into the next GLM snapshot. */
  private change(action: () => void): void {
    const previous = { entries: this.entries, stoppedInputs: this.stoppedInputs,
      tools: this.tools, checkpoints: this.checkpoints, sequence: this.sequence }
    this.entries = this.entries.map(entry => ({ ...entry }))
    this.stoppedInputs = new Map([...this.stoppedInputs].map(([id, entry]) => [id, { ...entry }]))
    this.tools = this.tools.map(tool => ({ ...tool }))
    this.checkpoints = this.checkpoints.map(checkpoint => ({ ...checkpoint }))
    try {
      action()
      this.persist()
    } catch (error) {
      Object.assign(this, previous)
      throw error
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Claude translation context has not initialized')
  }

  bindSession(id: string): void {
    this.assertInitialized()
    if (!nonempty(id)) throw new Error('Claude translation context session id is empty')
    if (this.options.forkSession && id === this.options.resumeSessionId) {
      throw new Error('Claude translation fork context cannot bind to the source session')
    }
    if (this.sessionId && this.sessionId !== id) {
      throw new Error(`Claude translation context session mismatch: expected ${this.sessionId}, received ${id}`)
    }
    if (this.sessionId === id) return
    if (!this.sessionId && this.readLedger(id)) throw new Error(`Claude translation context session already exists: ${id}`)
    const previous = this.sessionId
    this.sessionId = id
    try { this.persist() } catch (error) { this.sessionId = previous; throw error }
  }

  snapshot(): ClaudeTranslationContextSnapshot {
    this.assertInitialized()
    return Object.freeze({
      sessionId: this.sessionId,
      sourceSessionId: this.options.resumeSessionId ?? null,
      coverage: 'since-enabled' as const,
      entries: Object.freeze(this.entries.map(({ sequence: _sequence, key: _key, ...entry }) => Object.freeze(entry))),
    })
  }

  toolName(toolUseId: string): string | undefined {
    this.assertInitialized()
    return this.tools.find(tool => tool.id === toolUseId)?.name
  }

  stageInput(id: string, original: string, translated: string, origin: string = CLAUDE_TRANSLATION_ORIGINS.userMessage): void {
    this.assertInitialized()
    if (!nonempty(origin)) throw new Error('Claude translation context origin is empty')
    if (!nonempty(id) || this.stoppedInputs.has(id) || this.entries.some(entry => entry.role === 'user' && entry.uuid === id)) {
      throw new Error('Claude translation input id is empty or duplicated')
    }
    this.entries.push({
      role: 'user', origin, uuid: id, status: 'pending', sequence: 0,
      original: conversationProse(original), translated: conversationProse(translated),
    })
  }

  confirmInput(id: string): void {
    this.assertInitialized()
    if (!this.entries.some(entry => entry.uuid === id && entry.status === 'pending') && !this.stoppedInputs.has(id)) return
    this.change(() => {
      const entry = this.entries.find(candidate => candidate.uuid === id && candidate.status === 'pending')
        ?? this.stoppedInputs.get(id)!
      entry.status = 'consumed'
      entry.sequence = ++this.sequence
      this.stoppedInputs.delete(id)
      this.entries = this.entries.filter(candidate => candidate !== entry)
      this.entries.push(entry)
    })
  }

  cancelPendingInputs(): void {
    this.assertInitialized()
    for (const entry of this.entries) {
      if (entry.status === 'pending') this.stoppedInputs.set(entry.uuid!, entry)
    }
    this.entries = this.entries.filter(entry => entry.status !== 'pending')
  }

  cancelInput(id: string): void {
    this.assertInitialized()
    this.entries = this.entries.filter(entry => entry.uuid !== id || entry.status !== 'pending')
    this.stoppedInputs.delete(id)
  }

  recordInteraction(role: string, original: string, translated: string, origin = claudeTranslationOriginForRole(role)): void {
    this.assertInitialized()
    if (!nonempty(role)) throw new Error('Claude translation context interaction role is empty')
    if (!nonempty(origin)) throw new Error('Claude translation context origin is empty')
    const originalText = conversationProse(original), translatedText = conversationProse(translated)
    if (originalText || translatedText) this.change(() => { this.entries.push({ role, origin,
      original: originalText, translated: translatedText, status: 'consumed', sequence: ++this.sequence }) })
  }

  recordOutput(kind: string, original: string, display: string, uuid?: string, key?: string, origin?: string): void {
    this.recordDisplay({ output: { kind, original, display, uuid, key, origin } })
  }

  /** One native message's tool identities, visible prose and fork checkpoint
   * commit together. A failed write cannot leave an undisplayed output behind. */
  recordDisplay(record: DisplayRecord): void {
    this.assertInitialized()
    const tools: Array<{ id: string; name: string }> = []
    const knownTools = new Map(this.tools.map(tool => [tool.id, tool.name]))
    for (const tool of record.tools ?? []) {
      if (!nonempty(tool.id) || !nonempty(tool.name)) throw new Error('Claude translation context tool id/name is empty')
      const existing = knownTools.get(tool.id)
      if (existing !== undefined) {
        if (existing !== tool.name) throw new Error(`Claude translation context tool name mismatch: ${tool.id}`)
      } else {
        knownTools.set(tool.id, tool.name)
        tools.push(tool)
      }
    }
    const output = record.output
    if (output && (!nonempty(output.kind) || output.uuid !== undefined && !nonempty(output.uuid)
      || output.key !== undefined && !nonempty(output.key))) {
      throw new Error('Claude translation context output kind/uuid/key is empty')
    }
    if (output?.origin !== undefined && !nonempty(output.origin)) throw new Error('Claude translation context origin is empty')
    if (record.checkpoint !== undefined && !nonempty(record.checkpoint)) {
      throw new Error('Claude translation context checkpoint uuid is empty')
    }
    const addOutput = output && (output.original.trim() || output.display.trim())
      && (!output.key || !this.entries.some(entry => entry.key === output.key))
    // Replayed UUIDs must not move their fork boundary into later exchanges.
    const addCheckpoint = record.checkpoint !== undefined
      && !this.checkpoints.some(checkpoint => checkpoint.uuid === record.checkpoint)
    if (!tools.length && !addOutput && !addCheckpoint) return
    this.change(() => {
      for (const tool of tools) this.tools.push({ ...tool, sequence: ++this.sequence })
      if (addOutput && output) this.entries.push({ role: `assistant/${output.kind}`, status: 'consumed', sequence: ++this.sequence,
        origin: output.origin ?? claudeTranslationOriginForRole(`assistant/${output.kind}`),
        original: conversationProse(output.original), translated: conversationProse(output.display),
        ...(output.uuid ? { uuid: output.uuid } : {}), ...(output.key ? { key: output.key } : {}),
      })
      if (addCheckpoint) this.checkpoints.push({ uuid: record.checkpoint!, sequence: this.sequence })
    })
  }
}
