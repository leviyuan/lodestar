import type { ClaudeTranslation } from './claude-translation'
import type { AgentTranslationPresentationSurface } from './agent-process'
import { shellCommandPresentation } from './cards/shell-command'
import { CLAUDE_TRANSLATION_ORIGINS } from './claude-translation-context'

const NATURAL_FIELDS = new Set([
  'description', 'reason', 'summary', 'message', 'subject', 'activeForm', 'title',
  'explanation', 'prompt', 'revisedPrompt', 'revised_prompt', 'question', 'preview',
  'justification', 'plan',
])

// These are payloads, executable values, identity or protocol fields, even when
// they contain a property also named "description" or "message".
const LITERAL_FIELDS = new Set([
  'command', 'cmd', 'script', 'code', 'diff', 'patch', 'unified_diff', 'changes',
  'old_string', 'new_string', 'new_source', 'source', 'edits', 'file', 'files',
  'path', 'paths', 'file_path', 'notebook_path', 'cwd', 'workdir', 'grantRoot',
  'url', 'urls', 'uri', 'link', 'links', 'id', 'ids', 'name', 'status', 'type',
  'taskId', 'task_id', 'tool_use_id', 'session_id', 'agent_id', 'owner', 'recipient', 'recipients',
  'env', 'environment', 'headers', 'metadata', '_meta', 'schema', 'inputSchema',
  'outputSchema', 'structuredContent', 'resource', 'resources', 'data', 'blob',
  'stdout', 'stderr', 'output', 'raw', 'raw_output', 'chars', 'pattern', 'glob',
])

const FILE_TOOLS = new Set([
  'read', 'write', 'edit', 'notebookedit', 'multiedit', 'glob', 'grep', 'ls',
  'filechange', 'apply_patch',
])

type Field = { object: Record<string, unknown>; key: string; value: string }
type Collection = { fields: Field[]; finish: Array<() => void> }
type FieldOptions = { todos?: boolean; textBlocks?: boolean }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toolKind(name: string): string {
  return name.replace(/^server_tool:/, '').split('.').at(-1)!.toLowerCase()
}

function shellTool(name: string): boolean {
  return ['bash', 'exec_command', 'write_stdin', 'bashoutput'].includes(toolKind(name))
}

/** Plain provenance for selected visible text, never a tool schema or ID. */
export function claudeToolInputOrigin(name: string): string {
  if (shellTool(name)) return CLAUDE_TRANSLATION_ORIGINS.commandExplanation
  const kind = toolKind(name)
  if (['taskcreate', 'taskupdate', 'taskget', 'tasklist', 'todowrite'].includes(kind)) return CLAUDE_TRANSLATION_ORIGINS.taskText
  if (kind === 'agent' || kind === 'task') return CLAUDE_TRANSLATION_ORIGINS.delegatedRequest
  if (kind === 'askuserquestion') return CLAUDE_TRANSLATION_ORIGINS.question
  return 'Claude Code → Feishu user: explanation accompanying a tool call.'
}

function shellInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return name.startsWith('server_tool:') && record(input.input) ? input.input : input
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Only named natural-language fields cross the translator boundary. In
 * particular, JSON is parsed locally and keys/statuses never go to the model. */
function collectFields(value: unknown, keys: ReadonlySet<string>, collected: Collection, options: FieldOptions = {}, parent = ''): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFields(item, keys, collected, options, parent)
    return
  }
  if (!record(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (LITERAL_FIELDS.has(key)) continue
    const todoContent = options.todos && key === 'content' && parent === 'todos'
    const textBlock = options.textBlocks && key === 'text' && value.type === 'text'
    if (typeof child === 'string') {
      if (textBlock) {
        // MCP text blocks may themselves encode JSON. Parse it rather than
        // asking the model to rewrite keys or unrecognized machine values.
        const structured = parseStructured(child)
        if (structured) {
          const before = collected.fields.length
          collectFields(structured.value, keys, collected, options)
          if (collected.fields.length > before) collected.finish.push(() => { value[key] = JSON.stringify(structured.value, null, 2) })
          continue
        }
      }
      if ((keys.has(key) || todoContent || textBlock) && child.trim()) collected.fields.push({ object: value, key, value: child })
    } else if (key !== 'content' || Array.isArray(child)) {
      collectFields(child, keys, collected, options, key)
    }
  }
}

function parseStructured(text: string): { value: unknown } | null {
  if (!/^[\s]*[\[{]/.test(text)) return null
  try { return { value: JSON.parse(text) } }
  catch { return null } // A tool result is allowed to be ordinary prose.
}

function hiddenSuccessReceipt(name: string, isError: boolean, receiptVisible: boolean): boolean {
  return !isError && !receiptVisible
    && (name === 'AskUserQuestion' || name === 'TaskCreate' || name === 'TaskUpdate')
}

function hiddenTaskBoardError(name: string, isError: boolean, surface: AgentTranslationPresentationSurface): boolean {
  // The main task panel shows the existing board and an error status, never
  // the failed receipt. Preserve that receipt in the native event unchanged.
  return surface === 'main' && isError && ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(name)
}

function mainTaskSnapshot(name: string, surface: AgentTranslationPresentationSurface): boolean {
  return surface === 'main' && (name === 'TaskList' || name === 'TaskGet')
}

/** Select only the JSON snapshot properties that applyTaskTool consumes.
 * Plain-text receipts and recursively nested lookalike fields are not shown
 * by the main task board. Background steps use their separate result policy. */
function collectTaskSnapshot(name: string, value: unknown, collected: Collection): void {
  const tasks = name === 'TaskList'
    ? record(value) && Array.isArray(value.tasks) ? value.tasks : Array.isArray(value) ? value : []
    : [record(value) ? value.task ?? value : null]
  for (const task of tasks) {
    if (!record(task) || task.status === 'deleted') continue
    const subjectKey = task.subject != null ? 'subject' : 'content'
    if (name === 'TaskList' && !String(task[subjectKey] ?? '').trim()) continue
    for (const key of [subjectKey, 'activeForm']) {
      const text = task[key]
      if (typeof text === 'string' && text.trim()) collected.fields.push({ object: task, key, value: text })
    }
  }
}

function taskInputFields(name: string, surface: AgentTranslationPresentationSurface): Set<string> {
  return surface === 'main' && (name === 'TaskCreate' || name === 'TaskUpdate')
    ? new Set(['subject', 'activeForm'])
    : new Set(NATURAL_FIELDS)
}

function taskResultFields(name: string, isError: boolean): Set<string> {
  const kind = toolKind(name)
  return kind === 'tasklist' || kind === 'taskget'
    ? new Set(['subject', 'activeForm', 'description', ...(isError ? ['message', 'reason'] : [])])
    : new Set(NATURAL_FIELDS)
}

/** Matches the delegated runner's one-line progress description. All other
 * input fields stay native because that consumer never displays them. */
function workerDescription(input: unknown): { key: string; value: string } | null {
  if (!record(input)) return null
  for (const key of ['__displayDescription', 'description']) {
    if (typeof input[key] === 'string') return { key, value: input[key] as string }
  }
  const command = input.command ?? input.cmd ?? input.script
  if (typeof command === 'string') return { key: '__displayDescription', value: shellCommandPresentation(command).description }
  return typeof input.subject === 'string' ? { key: 'subject', value: input.subject } : null
}

/** Select the same natural-language tool result fields for conversation
 * context, without invoking GLM or changing the native protocol payload.
 * receiptVisible retains internal receipts that a consumer actually displays,
 * such as the native child-task steps; it does not change other tool policies. */
export function claudeToolResultContext(name: string, content: string, isError: boolean, receiptVisible = false, surface: AgentTranslationPresentationSurface = 'main'): string[] {
  if (surface === 'worker') return []
  if (!content.trim()) return []
  const kind = toolKind(name)
  if (hiddenTaskBoardError(name, isError, surface)) return []
  if (hiddenSuccessReceipt(name, isError, receiptVisible)) return []
  const structured = parseStructured(content)
  const collected: Collection = { fields: [], finish: [] }
  if (mainTaskSnapshot(name, surface)) {
    if (structured) collectTaskSnapshot(name, structured.value, collected)
    return collected.fields.map(field => field.value)
  }
  if (shellTool(name) || FILE_TOOLS.has(kind)) {
    if (!isError) return []
    if (structured) collectFields(structured.value, new Set(['message', 'reason']), collected)
    else if (!shellTool(name)) return [content]
  } else if (structured) {
    const keys = taskResultFields(name, isError)
    if (kind === 'agent' || kind === 'task' || kind === 'webfetch') {
      keys.add('result')
      keys.add('content')
      keys.add('text')
    }
    collectFields(structured.value, keys, collected, {
      textBlocks: kind !== 'tasklist' && kind !== 'taskget', todos: kind === 'todowrite',
    })
  } else return [content]
  return collected.fields.map(field => field.value)
}

/** Tool input prose uses the same literal-field boundaries as presentation;
 * executable commands contribute only their explicit introductory comment. */
export function claudeToolInputContext(name: string, input: unknown, surface: AgentTranslationPresentationSurface = 'main'): string[] {
  if (surface === 'worker') {
    const description = workerDescription(input)
    return description?.value.trim() ? [description.value] : []
  }
  const collected: Collection = { fields: [], finish: [] }
  const keys = taskInputFields(name, surface)
  const kind = toolKind(name)
  if (shellTool(name) && record(input)) {
    const commandInput = shellInput(name, input)
    const description = typeof input.__displayDescription === 'string' ? input.__displayDescription
      : typeof commandInput.__displayDescription === 'string' ? commandInput.__displayDescription
        : shellCommandPresentation(commandInput.command ?? commandInput.cmd ?? commandInput.script).description
          || (typeof commandInput.description === 'string' ? commandInput.description : '')
          || (typeof commandInput.reason === 'string' ? commandInput.reason : '')
    if (name.startsWith('server_tool:')) {
      // The server-tool panel shows its argument JSON as well as the selected
      // purpose; ordinary Bash panels show only the latter.
      collectFields(commandInput, keys, collected)
      const fields = collected.fields.map(field => field.value)
      if (description.trim()) fields.push(description)
      return fields
    }
    return description.trim() ? [description] : []
  }
  if (kind === 'websearch') keys.add('query')
  if (kind === 'sendmessage') keys.add('content')
  if (kind === 'askuserquestion') {
    keys.add('header')
    keys.add('label')
  }
  collectFields(input, keys, collected, { todos: kind === 'todowrite' })
  const prose = collected.fields.map(field => field.value)
  return prose
}

/** Produces display-only copies. Callers must retain original tool input and
 * output for execution, protocol parsing, SDK responses and task bookkeeping. */
export class ClaudePresentationTranslation {
  constructor(private readonly translator: Pick<ClaudeTranslation, 'toChineseFields'>) {}

  private async translateFields({ fields, finish }: Collection, signal: AbortSignal, origin: string): Promise<void> {
    signal.throwIfAborted()
    if (!fields.length) return
    const translated = await this.translator.toChineseFields(fields.map(field => field.value), signal, origin)
    signal.throwIfAborted()
    if (translated.length !== fields.length || translated.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('GLM 展示翻译返回了无效字段')
    }
    fields.forEach((field, index) => { field.object[field.key] = translated[index]! })
    for (const complete of finish) complete()
  }

  /** Batch explicitly selected presentation properties, preserving unknown
   * fields and opaque payloads. The returned object never shares mutable state. */
  async naturalFields<T>(data: T, keys: readonly string[], signal: AbortSignal, origin: string = CLAUDE_TRANSLATION_ORIGINS.reply): Promise<T> {
    const display = clone(data)
    const collected: Collection = { fields: [], finish: [] }
    collectFields(display, new Set(keys), collected)
    await this.translateFields(collected, signal, origin)
    return display
  }

  async toolInput<T>(name: string, input: T, signal: AbortSignal, surface: AgentTranslationPresentationSurface = 'main', origin: string = claudeToolInputOrigin(name)): Promise<T> {
    const display = clone(input)
    signal.throwIfAborted()
    const collected: Collection = { fields: [], finish: [] }
    if (surface === 'worker') {
      const description = workerDescription(display)
      if (record(display) && description?.value.trim()) {
        const target: Record<string, unknown> = display
        target[description.key] = description.value
        collected.fields.push({ object: target, key: description.key, value: description.value })
      }
      await this.translateFields(collected, signal, origin)
      return display
    }
    const keys = taskInputFields(name, surface)
    const kind = toolKind(name)
    if (kind === 'websearch') keys.add('query')
    if (kind === 'sendmessage') keys.add('content')
    if (kind === 'askuserquestion') {
      keys.add('header')
      keys.add('label')
    }
    if (shellTool(name) && record(display)) {
      // Regular shell cards and native child steps show the chosen purpose,
      // not both the comment and explicit description. Server-tool cards also
      // expose their structured arguments, so keep those visible fields there.
      if (!name.startsWith('server_tool:') && (kind === 'bash' || kind === 'exec_command')) keys.clear()
      const commandInput = shellInput(name, display)
      const command = commandInput.command ?? commandInput.cmd ?? commandInput.script
      const description = shellCommandPresentation(command).description
        || (typeof commandInput.description === 'string' ? commandInput.description : '')
        || (typeof commandInput.reason === 'string' ? commandInput.reason : '')
      if (description.trim()) {
        const shellDisplay: Record<string, unknown> = display
        shellDisplay.__displayDescription = description
        keys.add('__displayDescription')
      }
    }
    collectFields(display, keys, collected, { todos: kind === 'todowrite' })
    await this.translateFields(collected, signal, origin)
    return display
  }

  /** receiptVisible controls only whether an internal success receipt has a
   * presentation consumer. Raw results and ordinary/error policies stay exact. */
  async toolResult(name: string, content: string, isError: boolean, signal: AbortSignal, receiptVisible = false, surface: AgentTranslationPresentationSurface = 'main', origin: string = CLAUDE_TRANSLATION_ORIGINS.toolResult): Promise<string> {
    signal.throwIfAborted()
    if (surface === 'worker') return content
    if (!content.trim()) return content
    const kind = toolKind(name)
    if (hiddenTaskBoardError(name, isError, surface)) return content
    // Main question/task panels use their own translated fields. Child-task
    // steps also show receipts, so their visible prose still crosses Flash.
    if (hiddenSuccessReceipt(name, isError, receiptVisible)) return content
    const structured = parseStructured(content)
    if (mainTaskSnapshot(name, surface)) {
      if (!structured) return content
      const display = clone(structured.value)
      const collected: Collection = { fields: [], finish: [] }
      collectTaskSnapshot(name, display, collected)
      if (!collected.fields.length) return content
      await this.translateFields(collected, signal, origin)
      return JSON.stringify(display, null, 2)
    }

    // File bytes and command stdout/stderr remain exact, including an erroring
    // process's output. An explicit structured error message is presentation.
    if (shellTool(name) || FILE_TOOLS.has(kind)) {
      if (!isError) return content
      if (structured) return this.structuredResult(structured.value, content, new Set(['message', 'reason']), signal, origin)
      if (shellTool(name)) return content
      return this.prose(content, signal, origin)
    }

    if (structured) {
      const keys = taskResultFields(name, isError)
      // These tool contracts return prose in result/content; arbitrary tool
      // JSON strings and unrecognized machine fields remain unchanged.
      if (kind === 'agent' || kind === 'task' || kind === 'webfetch') {
        keys.add('result')
        keys.add('content')
        keys.add('text')
      }
      return this.structuredResult(structured.value, content, keys, signal, origin, {
        textBlocks: kind !== 'tasklist' && kind !== 'taskget', todos: kind === 'todowrite',
      })
    }
    return this.prose(content, signal, origin)
  }

  private async structuredResult(value: unknown, original: string, keys: ReadonlySet<string>, signal: AbortSignal, origin: string, options: FieldOptions = {}): Promise<string> {
    const display = clone(value)
    const collected: Collection = { fields: [], finish: [] }
    collectFields(display, keys, collected, options)
    if (!collected.fields.length) return original
    await this.translateFields(collected, signal, origin)
    return JSON.stringify(display, null, 2)
  }

  private async prose(content: string, signal: AbortSignal, origin: string): Promise<string> {
    const data = { message: content }
    const display = await this.naturalFields(data, ['message'], signal, origin)
    return display.message
  }
}
