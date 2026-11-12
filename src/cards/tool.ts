/**
 * Tool panel renderers for turn cards. Split from turn.ts so the main
 * conversation-card templates stay focused on turn/plan/goal structure.
 */

import { isAbsolute, relative } from 'node:path'
import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'
import { shellCommandPresentation, shellCommandDescription } from './shell-command'

const BASH_OUTPUT_PREVIEW_CHARS = 300

function isBashCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'exec_command' || name.endsWith('.exec_command')
}

function isShellSessionTool(name: string): boolean {
  return name === 'write_stdin' || name.endsWith('.write_stdin')
}

function isBashTool(name: string): boolean {
  return isBashCommandTool(name) || isShellSessionTool(name)
}

function isFileChangeTool(name: string): boolean {
  return name === 'FileChange' || name === 'fileChange'
}

function isWebSearchTool(name: string): boolean {
  return name === 'WebSearch' || name === 'webSearch'
}

function isWebFetchTool(name: string): boolean {
  return name === 'WebFetch' || name === 'webFetch'
}

function isMcpTool(name: string): boolean {
  return name === 'MCP'
}

function isImageGenerationTool(name: string): boolean {
  return name === 'ImageGeneration' || name === 'imageGeneration'
}

function isAgentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

function isFileReadTool(name: string): boolean {
  return name === 'Read'
}

function isFileWriteTool(name: string): boolean {
  return name === 'Write'
}

function isFileEditTool(name: string): boolean {
  return name === 'Edit' || name === 'NotebookEdit'
}

function isFileMultiEditTool(name: string): boolean {
  return name === 'MultiEdit'
}

function isPathSearchTool(name: string): boolean {
  return name === 'Glob' || name === 'Grep' || name === 'LS'
}

function isTodoTool(name: string): boolean {
  return name === 'TodoWrite'
}

function isExitPlanModeTool(name: string): boolean {
  return name === 'ExitPlanMode'
}

const SERVER_TOOL_PREFIX = 'server_tool:'

function isServerSideTool(name: string): boolean {
  return name.startsWith(SERVER_TOOL_PREFIX)
}

function serverSideToolName(name: string): string {
  return isServerSideTool(name) ? name.slice(SERVER_TOOL_PREFIX.length) : name
}

export function displayToolName(name: string): string {
  if (isServerSideTool(name)) return '服务端工具'
  if (isFileChangeTool(name)) return '文件变更'
  if (isWebSearchTool(name)) return '网页搜索'
  if (isWebFetchTool(name)) return '网页读取'
  if (isImageGenerationTool(name)) return '图片生成'
  if (isFileReadTool(name)) return '读取文件'
  if (isFileWriteTool(name)) return '写入文件'
  if (isFileEditTool(name) || isFileMultiEditTool(name)) return '编辑文件'
  if (name === 'Glob') return '匹配文件'
  if (name === 'Grep') return '搜索文件'
  if (name === 'LS') return '列目录'
  if (isTodoTool(name)) return '更新待办'
  if (isExitPlanModeTool(name)) return '确认计划'
  if (name === 'Task') return '子任务'
  return isBashTool(name) ? 'Bash' : name
}

/** Single-line summary used as a collapsible-panel header for a tool call. */
export function summarizeToolInput(name: string, input: any): string {
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  if (isServerSideTool(name)) return truncate(summarizeServerSideToolInput(name, input), 80)
  if (!input || typeof input !== 'object') return ''
  if (isBashCommandTool(name)) return summarizeBashInput(input)
  if (isShellSessionTool(name)) return summarizeShellSessionInput(input)
  if (isFileChangeTool(name)) return truncate(summarizeFileChangeInput(input), 80)
  if (isWebSearchTool(name)) return truncate(summarizeWebSearchInput(input), 80)
  if (isWebFetchTool(name)) return truncate(summarizeWebFetchInput(input), 80)
  if (isMcpTool(name)) return truncate(summarizeMcpInput(input), 80)
  if (isImageGenerationTool(name)) return truncate(summarizeImageGenerationInput(input), 80)
  if (isAgentTool(name)) return truncate(summarizeAgentInput(input), 80)
  if (isFileReadTool(name)) return truncate(summarizeReadInput(input), 80)
  if (isFileWriteTool(name)) return truncate(summarizeWriteInput(input), 80)
  if (isFileEditTool(name)) return truncate(summarizeEditInput(input), 80)
  if (isFileMultiEditTool(name)) return truncate(summarizeMultiEditInput(input), 80)
  if (isPathSearchTool(name)) return truncate(summarizePathSearchInput(name, input), 80)
  if (isTodoTool(name)) return truncate(summarizeTodoInput(input), 80)
  if (isExitPlanModeTool(name)) return truncate(firstStringField(input) || '提交计划', 80)
  switch (name) {
    case 'Skill':      return truncate(String(input.skill ?? ''), 80)
  }
  // generic fallback: first string-valued field
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return truncate(v, 80)
  }
  return ''
}

function summarizeServerSideToolInput(name: string, input: any): string {
  const tool = typeof input?.tool === 'string' && input.tool
    ? input.tool
    : serverSideToolName(name)
  const detail = firstStringField(input?.input)
  return detail ? `${tool}: ${detail}` : tool
}

function summarizeBashInput(input: any): string {
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s
  const info = bashPresentation(input)
  if (info.description) return truncate(info.description.replace(/\s+/g, ' '), 80)
  const command = info.command
  if (!command) return ''
  const lines = command.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  // 单行:命令本身;多行:Shell 脚本 + 首条有效命令(与后台卡/子 agent 的
  // shellCommandDescription 回退同构,各 surface 格式一致)。
  if (lines.length <= 1) return truncate(command.replace(/\s+/g, ' '), 80)
  return `Shell 脚本 · ${lines.length} 行 · ${truncate(shellCommandDescription(command), 46)}`
}

function shellSessionAction(input: any): string {
  const chars = typeof input?.chars === 'string' ? input.chars : ''
  if (chars === '') return '读取会话输出'
  if (chars === '\u0003') return '中断会话'
  return '发送输入'
}

function summarizeShellSessionInput(input: any): string {
  const session = input?.session_id ?? input?.sessionId
  const suffix = session === undefined ? '' : ` ${session}`
  return `${shellSessionAction(input)}${suffix}`
}

function bashPresentation(input: any): { description: string; command: string } {
  const rawCommand = String(input?.command ?? input?.cmd ?? input?.script ?? '')
  const explicit = String(input?.description ?? input?.reason ?? '').trim()
  // desc 注释 / 包装剥离统一走 shell-command 模块,与后台卡、子 agent 简报共用一份解析。
  const info = shellCommandPresentation(rawCommand)
  return { description: info.description || explicit, command: info.command }
}

function fenceBlock(text: string, lang = ''): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${lang}\n${text}\n${fence}`
}

function outputPreviewBlock(text: string, max = BASH_OUTPUT_PREVIEW_CHARS, lang = ''): string {
  if (text.length <= max) return fenceBlock(text, lang)
  const preview = text.slice(0, max).trimEnd()
  return [
    `_已截断: 仅显示前 ${max} / ${text.length} 字符。_`,
    fenceBlock(`${preview}\n... output 已截断 ...`, lang),
  ].join('\n')
}

function inlineCode(v: unknown): string {
  return '`' + String(v ?? '').replace(/`/g, "'") + '`'
}

function jsonBlock(value: unknown, max = 3000): string {
  return fenceBlock(JSON.stringify(value ?? null, null, 2).slice(0, max), 'json')
}

function firstStringField(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  for (const key of ['query', 'prompt', 'path', 'file_path', 'url', 'name', 'id']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

function renderBashBody(input: any, output: string | null, resolvedNote?: string): string {
  const info = bashPresentation(input)
  const command = info.command
  const reason = info.description
  const lines: string[] = []
  if (reason) lines.push(`**目的**: ${reason}`)
  const cwd = input?.cwd ?? input?.workdir
  if (cwd) lines.push(`**cwd**: ${inlineCode(cwd)}`)
  if (input?.source) lines.push(`**source**: ${inlineCode(input.source)}`)
  if (lines.length > 0) lines.push('')
  lines.push('**命令**')
  lines.push(fenceBlock(command || '(空命令)', 'bash'))
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(outputPreviewBlock(output))
  }
  return lines.join('\n')
}

function renderShellSessionBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const session = input?.session_id ?? input?.sessionId
  lines.push(`**操作**: ${shellSessionAction(input)}`)
  if (session !== undefined) lines.push(`**session**: ${inlineCode(session)}`)
  if (typeof input?.chars === 'string' && input.chars.length > 0) {
    const shown = input.chars === '\u0003' ? '^C' : input.chars
    lines.push('')
    lines.push('**输入**')
    lines.push(fenceBlock(shown))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(outputPreviewBlock(output))
  }
  return lines.join('\n')
}

function fileChangeEntries(input: any): any[] {
  return Array.isArray(input?.changes) ? input.changes : []
}

function fileChangeRoot(input: any): string | undefined {
  const root = input?.cwd ?? input?.grantRoot
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

function compactFilePath(path: unknown, root?: string): string {
  const raw = String(path ?? '')
  if (!raw) return '(无 path)'
  if (root && isAbsolute(raw) && isAbsolute(root)) {
    const rel = relative(root, raw)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  return raw
}

function fileChangeKind(change: any): string {
  const kind = change?.kind
  if (typeof kind === 'string') return kind.toLowerCase()
  if (typeof kind?.type === 'string') return kind.type.toLowerCase()
  if (typeof change?.type === 'string') return change.type.toLowerCase()
  return ''
}

function fileChangeMovePath(change: any): unknown {
  return change?.kind?.move_path ?? change?.kind?.movePath ?? change?.move_path ?? change?.movePath
}

function fileChangeLabel(change: any): string {
  const kind = fileChangeKind(change)
  const moved = fileChangeMovePath(change)
  if (moved) return kind === 'update' ? '移动/修改' : '移动'
  switch (kind) {
    case 'add': return '新增'
    case 'delete': return '删除'
    case 'update': return '修改'
    default: return '变更'
  }
}

function fileChangeDiff(change: any): string {
  const diff = change?.diff ?? change?.unified_diff
  return typeof diff === 'string' ? diff : ''
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

function addStats(a: { added: number; removed: number }, b: { added: number; removed: number }): { added: number; removed: number } {
  return { added: a.added + b.added, removed: a.removed + b.removed }
}

function formatDiffStats(stats: { added: number; removed: number }): string {
  return stats.added > 0 || stats.removed > 0 ? `+${stats.added} -${stats.removed}` : ''
}

function truncateDiff(diff: string): string {
  const max = 1800
  return diff.length > max ? diff.slice(0, max) + '\n... diff 已截断 ...' : diff
}

function summarizeFileChangeInput(input: any): string {
  const changes = fileChangeEntries(input)
  const root = fileChangeRoot(input)
  if (changes.length === 0) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    const grantRoot = input?.grantRoot ? compactFilePath(input.grantRoot) : ''
    if (reason && grantRoot) return `${reason} · ${grantRoot}`
    return reason || (grantRoot ? `申请修改 ${grantRoot}` : '')
  }

  const total = changes
    .map(change => diffStats(fileChangeDiff(change)))
    .reduce(addStats, { added: 0, removed: 0 })
  const stats = formatDiffStats(total)
  const labels = [...new Set(changes.map(fileChangeLabel))]
  const firstPath = compactFilePath(changes[0]?.path, root)
  const suffix = stats ? ` · ${stats}` : ''
  if (changes.length === 1) return `${labels[0]} ${firstPath}${suffix}`
  return `${changes.length} 个文件 · ${labels.join('/')} · ${firstPath} 等${suffix}`
}

function renderFileChangeBody(input: any, output: string | null, resolvedNote?: string): string {
  const changes = fileChangeEntries(input)
  const root = fileChangeRoot(input)
  const lines: string[] = []

  if (changes.length === 0) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (reason) lines.push(`**原因**: ${reason}`)
    if (input?.grantRoot) lines.push(`**范围**: ${inlineCode(compactFilePath(input.grantRoot))}`)
    if (resolvedNote) {
      lines.push('')
      lines.push(resolvedNote)
    }
    if (output != null) {
      lines.push('')
      lines.push('---')
      lines.push('**output:**')
      lines.push(fenceBlock(output.slice(0, 3000)))
    }
    return lines.length > 0 ? lines.join('\n') : fenceBlock(JSON.stringify(input ?? {}, null, 2).slice(0, 2000))
  }

  const total = changes
    .map(change => diffStats(fileChangeDiff(change)))
    .reduce(addStats, { added: 0, removed: 0 })
  const totalStats = formatDiffStats(total)
  lines.push(`**文件**: ${changes.length} 个`)
  if (totalStats) lines.push(`**行数**: ${totalStats}`)
  if (input?.status) lines.push(`**状态**: ${inlineCode(input.status)}`)

  const shown = changes.slice(0, 5)
  for (const change of shown) {
    const diff = fileChangeDiff(change)
    const stats = formatDiffStats(diffStats(diff))
    const path = compactFilePath(change?.path, root)
    const title = stats ? `**${fileChangeLabel(change)}** ${inlineCode(path)} · ${stats}` : `**${fileChangeLabel(change)}** ${inlineCode(path)}`
    lines.push('')
    lines.push(title)
    const movePath = fileChangeMovePath(change)
    if (movePath) lines.push(`来自 ${inlineCode(compactFilePath(movePath, root))}`)
    lines.push(diff ? fenceBlock(truncateDiff(diff), 'diff') : '_无 diff 内容_')
  }

  if (changes.length > shown.length) {
    lines.push('')
    lines.push(`还有 ${changes.length - shown.length} 个文件未展开显示。`)
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  return lines.join('\n')
}

function toolPath(input: any): string {
  return String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '')
}

function summarizeReadInput(input: any): string {
  const path = toolPath(input)
  const range = [
    input?.offset != null ? `offset ${input.offset}` : '',
    input?.limit != null ? `limit ${input.limit}` : '',
  ].filter(Boolean).join(' · ')
  return range && path ? `${path} · ${range}` : path
}

function summarizeWriteInput(input: any): string {
  const path = toolPath(input)
  const content = typeof input?.content === 'string' ? input.content : ''
  const lines = content ? content.split(/\r?\n/).length : 0
  return path && lines ? `${path} · ${lines} 行` : path
}

function summarizeEditInput(input: any): string {
  const path = toolPath(input)
  const mode = input?.replace_all ? '全局替换' : '替换'
  return path ? `${mode} ${path}` : mode
}

function summarizeMultiEditInput(input: any): string {
  const path = toolPath(input)
  const edits = Array.isArray(input?.edits) ? input.edits.length : 0
  const suffix = edits ? ` · ${edits} 处` : ''
  return path ? `批量编辑 ${path}${suffix}` : `批量编辑${suffix}`
}

function summarizePathSearchInput(name: string, input: any): string {
  if (name === 'Glob') {
    const pattern = String(input?.pattern ?? '')
    return input?.path ? `${pattern} · ${input.path}` : pattern
  }
  if (name === 'Grep') {
    const pattern = String(input?.pattern ?? '')
    return input?.path ? `${pattern} · ${input.path}` : pattern
  }
  return String(input?.path ?? '')
}

function todoStatusLabel(status: unknown): string {
  switch (status) {
    case 'pending': return '待办'
    case 'in_progress': return '进行中'
    case 'completed': return '完成'
    default: return String(status ?? '未知')
  }
}

function summarizeTodoInput(input: any): string {
  const todos = Array.isArray(input?.todos) ? input.todos : []
  if (todos.length === 0) return ''
  const counts = new Map<string, number>()
  for (const todo of todos) {
    const label = todoStatusLabel(todo?.status)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const summary = [...counts.entries()].map(([label, n]) => `${label} ${n}`).join(' · ')
  return `${todos.length} 项${summary ? ` · ${summary}` : ''}`
}

function summarizeWebFetchInput(input: any): string {
  const url = String(input?.url ?? '')
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
  return url && prompt ? `${url} · ${prompt}` : (url || prompt)
}

function appendResult(lines: string[], output: string | null): void {
  if (output == null) return
  lines.push('')
  lines.push('---')
  lines.push('**结果**')
  lines.push(outputPreviewBlock(output, 1200))
}

function renderReadBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const path = toolPath(input)
  if (path) lines.push(`**路径**: ${inlineCode(path)}`)
  if (input?.offset != null) lines.push(`**offset**: ${inlineCode(input.offset)}`)
  if (input?.limit != null) lines.push(`**limit**: ${inlineCode(input.limit)}`)
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  // Read 输出可能是源码或敏感文件内容；对话卡只展示路径和范围。
  if (output != null) {
    lines.push('')
    lines.push('_内容已读取，未展开到群聊卡片。_')
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function renderWriteBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const path = toolPath(input)
  const content = typeof input?.content === 'string' ? input.content : ''
  if (path) lines.push(`**路径**: ${inlineCode(path)}`)
  if (content) {
    const lineCount = content.split(/\r?\n/).length
    lines.push(`**内容**: ${lineCount} 行 / ${content.length} 字符`)
    lines.push(outputPreviewBlock(content, 1200))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function renderEditBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const path = toolPath(input)
  if (path) lines.push(`**路径**: ${inlineCode(path)}`)
  if (input?.cell_id) lines.push(`**cell**: ${inlineCode(input.cell_id)}`)
  if (input?.edit_mode) lines.push(`**模式**: ${inlineCode(input.edit_mode)}`)
  if (input?.replace_all) lines.push('**范围**: 全局替换')
  if (typeof input?.old_string === 'string') {
    lines.push('')
    lines.push('**查找**')
    lines.push(outputPreviewBlock(input.old_string, 800))
  }
  const newText = typeof input?.new_string === 'string'
    ? input.new_string
    : typeof input?.new_source === 'string'
      ? input.new_source
      : ''
  if (newText) {
    lines.push('')
    lines.push('**替换为**')
    lines.push(outputPreviewBlock(newText, 800))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function renderMultiEditBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  const path = toolPath(input)
  const edits = Array.isArray(input?.edits) ? input.edits : []
  if (path) lines.push(`**路径**: ${inlineCode(path)}`)
  lines.push(`**编辑**: ${edits.length} 处`)
  for (const [idx, edit] of edits.slice(0, 5).entries()) {
    lines.push('')
    lines.push(`**#${idx + 1}${edit?.replace_all ? ' · 全局替换' : ''}**`)
    if (typeof edit?.old_string === 'string') {
      lines.push('查找:')
      lines.push(outputPreviewBlock(edit.old_string, 500))
    }
    if (typeof edit?.new_string === 'string') {
      lines.push('替换为:')
      lines.push(outputPreviewBlock(edit.new_string, 500))
    }
  }
  if (edits.length > 5) {
    lines.push('')
    lines.push(`还有 ${edits.length - 5} 处编辑未展开显示。`)
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.join('\n')
}

function renderPathSearchBody(name: string, input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (name === 'Glob') {
    lines.push('**动作**: 匹配文件')
    if (input?.pattern) lines.push(`**pattern**: ${inlineCode(input.pattern)}`)
    if (input?.path) lines.push(`**path**: ${inlineCode(input.path)}`)
  } else if (name === 'Grep') {
    lines.push('**动作**: 搜索文件')
    if (input?.pattern) lines.push(`**pattern**: ${inlineCode(input.pattern)}`)
    if (input?.path) lines.push(`**path**: ${inlineCode(input.path)}`)
    if (input?.glob) lines.push(`**glob**: ${inlineCode(input.glob)}`)
    if (input?.type) lines.push(`**type**: ${inlineCode(input.type)}`)
    if (input?.output_mode) lines.push(`**output**: ${inlineCode(input.output_mode)}`)
  } else {
    lines.push('**动作**: 列目录')
    if (input?.path) lines.push(`**path**: ${inlineCode(input.path)}`)
    if (Array.isArray(input?.ignore) && input.ignore.length) {
      lines.push(`**ignore**: ${input.ignore.map(inlineCode).join(' ')}`)
    }
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.join('\n')
}

function renderTodoBody(input: any, output: string | null, resolvedNote?: string): string {
  const todos = Array.isArray(input?.todos) ? input.todos : []
  const lines: string[] = [`**待办**: ${todos.length} 项`]
  for (const todo of todos.slice(0, 12)) {
    const status = todoStatusLabel(todo?.status)
    const content = String(todo?.content ?? todo?.activeForm ?? '').trim() || '(空)'
    lines.push(`- ${status}: ${content}`)
  }
  if (todos.length > 12) lines.push(`- 还有 ${todos.length - 12} 项未显示`)
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.join('\n')
}

function parseJsonObject(text: string | null): any | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function webSearchAction(input: any, output: string | null): any {
  return parseJsonObject(output) ?? input?.action ?? {}
}

function webSearchQueries(input: any, output: string | null): string[] {
  const action = webSearchAction(input, output)
  const queries = Array.isArray(action?.queries)
    ? action.queries.filter((q: unknown): q is string => typeof q === 'string' && q.length > 0)
    : []
  const query = typeof action?.query === 'string' && action.query.length > 0
    ? action.query
    : typeof input?.query === 'string' && input.query.length > 0
      ? input.query
      : ''
  return queries.length > 0 ? queries : (query ? [query] : [])
}

function webSearchUrl(input: any, output: string | null): string {
  const action = webSearchAction(input, output)
  return String(action?.url ?? input?.url ?? '')
}

function summarizeWebSearchInput(input: any): string {
  const queries = webSearchQueries(input, null)
  if (queries.length === 1) return queries[0]
  if (queries.length > 1) return `${queries.length} 条查询 · ${queries[0]}`
  const url = webSearchUrl(input, null)
  if (url) return url
  const type = input?.action?.type
  return typeof type === 'string' && type !== 'other' ? type : ''
}

function summarizeWebSearchOutput(input: any, output: string | null): string {
  const queries = webSearchQueries(input, output)
  if (queries.length === 1) return queries[0]
  if (queries.length > 1) return `${queries.length} 条查询 · ${queries[0]}`
  const url = webSearchUrl(input, output)
  if (url) return url
  return summarizeWebSearchInput(input)
}

function renderWebSearchBody(input: any, output: string | null, resolvedNote?: string): string {
  const action = webSearchAction(input, output)
  const queries = webSearchQueries(input, output)
  const url = webSearchUrl(input, output)
  const lines: string[] = []
  const type = typeof action?.type === 'string' ? action.type : ''

  if (type === 'search' || queries.length > 0) {
    lines.push(`**动作**: 搜索`)
    if (queries.length > 0) {
      lines.push('')
      lines.push('**查询**')
      for (const q of queries.slice(0, 6)) lines.push(`- ${inlineCode(q)}`)
      if (queries.length > 6) lines.push(`- 还有 ${queries.length - 6} 条未显示`)
    }
  } else if (type === 'open_page') {
    lines.push(`**动作**: 打开页面`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
  } else if (type === 'find_in_page') {
    lines.push(`**动作**: 页内查找`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
    if (action?.pattern) lines.push(`**关键词**: ${inlineCode(action.pattern)}`)
  } else {
    lines.push(`**动作**: ${type ? inlineCode(type) : '网页搜索'}`)
    if (url) lines.push(`**URL**: ${inlineCode(url)}`)
  }

  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (lines.length === 1 && !queries.length && !url && output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**output:**')
    lines.push(fenceBlock(output.slice(0, 3000), 'json'))
  }
  return lines.join('\n')
}

function renderWebFetchBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = ['**动作**: 读取网页']
  if (input?.url) lines.push(`**URL**: ${inlineCode(input.url)}`)
  if (input?.prompt) {
    lines.push('')
    lines.push('**问题**')
    lines.push(String(input.prompt).slice(0, 1200))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  appendResult(lines, output)
  return lines.join('\n')
}

function summarizeMcpInput(input: any): string {
  const server = String(input?.server ?? '')
  const tool = String(input?.tool ?? '')
  const call = server && tool ? `${server}.${tool}` : (tool || server)
  const arg = firstStringField(input?.arguments)
  return arg && call ? `${call}: ${arg}` : call || arg
}

function renderMcpBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (input?.server) lines.push(`**server**: ${inlineCode(input.server)}`)
  if (input?.tool) lines.push(`**tool**: ${inlineCode(input.tool)}`)
  const args = input?.arguments
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('**arguments**')
    lines.push(jsonBlock(args, 2000))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    const parsed = parseJsonObject(output)
    lines.push('')
    lines.push('---')
    lines.push('**结果**')
    if (parsed && Array.isArray(parsed.content)) {
      const texts = parsed.content
        .map((c: any) => typeof c?.text === 'string' ? c.text : '')
        .filter(Boolean)
      if (texts.length > 0) lines.push(texts.join('\n').slice(0, 3000))
      if (parsed.structuredContent) {
        lines.push('')
        lines.push('**structuredContent**')
        lines.push(jsonBlock(parsed.structuredContent, 2000))
      }
      if (texts.length === 0 && !parsed.structuredContent) lines.push(jsonBlock(parsed, 3000))
    } else {
      lines.push(parsed ? jsonBlock(parsed, 3000) : fenceBlock(output.slice(0, 3000)))
    }
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function renderServerSideToolBody(name: string, input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = [
    `**类型**: 模型服务端内置工具`,
    `**tool**: ${inlineCode(typeof input?.tool === 'string' && input.tool ? input.tool : serverSideToolName(name))}`,
  ]
  const rawInput = input?.input
  if (rawInput && typeof rawInput === 'object') {
    lines.push('')
    lines.push('**input**')
    if (Object.keys(rawInput).length > 0) {
      lines.push(jsonBlock(rawInput, 2000))
    } else {
      lines.push('_provider 未提供结构化 input_')
    }
  } else if (rawInput != null && rawInput !== '') {
    lines.push(`**input**: ${inlineCode(rawInput)}`)
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**结果**')
    lines.push(outputPreviewBlock(output, 3000))
  }
  return lines.join('\n')
}

function summarizeImageGenerationInput(input: any): string {
  const status = typeof input?.status === 'string' ? input.status : ''
  return status
}

function renderImageGenerationBody(input: any, output: string | null, resolvedNote?: string, imageKey?: string): string {
  const lines: string[] = []
  if (input?.status) lines.push(`**状态**: ${inlineCode(input.status)}`)
  if (input?.prompt) {
    lines.push('', '**提示词**', fenceBlock(String(input.prompt)))
  }
  if (input?.revisedPrompt) {
    if (input.revisedPrompt !== input.prompt) {
      lines.push('', input.prompt ? '**实际提示词**' : '**提示词**', fenceBlock(String(input.revisedPrompt)))
    }
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (!imageKey && output != null && output.trim()) {
    lines.push('')
    lines.push('---')
    lines.push('**输出**')
    lines.push(inlineCode(output.trim()))
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

function summarizeAgentInput(input: any): string {
  const tool = typeof input?.tool === 'string' ? input.tool : ''
  const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
  const description = typeof input?.description === 'string' ? input.description : ''
  const subject = typeof input?.subject === 'string' ? input.subject : ''
  const title = description || subject || prompt
  return tool && title ? `${tool}: ${title}` : (title || tool)
}

function renderAgentBody(input: any, output: string | null, resolvedNote?: string): string {
  const lines: string[] = []
  if (input?.tool) lines.push(`**tool**: ${inlineCode(input.tool)}`)
  if (input?.model) lines.push(`**model**: ${inlineCode(input.model)}`)
  if (input?.description) lines.push(`**描述**: ${input.description}`)
  if (input?.subagent_type) lines.push(`**类型**: ${inlineCode(input.subagent_type)}`)
  if (input?.prompt) {
    if (lines.length > 0) lines.push('')
    lines.push('**prompt**')
    lines.push(String(input.prompt).slice(0, 2000))
  }
  if (resolvedNote) {
    lines.push('')
    lines.push(resolvedNote)
  }
  if (output != null) {
    lines.push('')
    lines.push('---')
    lines.push('**状态**')
    const parsed = parseJsonObject(output)
    lines.push(parsed ? jsonBlock(parsed, 3000) : fenceBlock(output.slice(0, 3000)))
  }
  return lines.length > 0 ? lines.join('\n') : jsonBlock(input ?? {}, 2000)
}

/** Element to insert for each tool call. Expandable for big results.
 *
 * Header is a one-line summary: status + name + summarized input.
 * Body holds the full input + (after completion) the full output.
 * `resolvedNote` is an optional one-liner appended below the input —
 * used to surface "✅ 允许 by Alice" inline after a permission decision
 * lands but before the actual tool execution completes. */
export function toolCallElement(
  i: number,
  name: string,
  input: any,
  output: string | null,
  status: '⏳' | '✅' | '❌' = '⏳',
  resolvedNote?: string,
  imageKey?: string,
): object {
  const rawSummary = isWebSearchTool(name) && output != null
    ? summarizeWebSearchOutput(input, output)
    : summarizeToolInput(name, input)
  const summary = rawSummary.length > 80 ? rawSummary.slice(0, 80) + '…' : rawSummary
  const toolName = displayToolName(name)
  const headerText = summary
    ? `${status} 🔧 ${toolName}: ${summary}`
    : `${status} 🔧 ${toolName}`
  const noteBlock = resolvedNote ? `\n\n${resolvedNote}` : ''
  const body = isBashCommandTool(name)
    ? renderBashBody(input, output, resolvedNote)
    : isShellSessionTool(name)
      ? renderShellSessionBody(input, output, resolvedNote)
      : isServerSideTool(name)
        ? renderServerSideToolBody(name, input, output, resolvedNote)
        : isFileChangeTool(name)
          ? renderFileChangeBody(input, output, resolvedNote)
          : isWebSearchTool(name)
            ? renderWebSearchBody(input, output, resolvedNote)
            : isWebFetchTool(name)
              ? renderWebFetchBody(input, output, resolvedNote)
              : isMcpTool(name)
                ? renderMcpBody(input, output, resolvedNote)
                : isImageGenerationTool(name)
                  ? renderImageGenerationBody(input, output, resolvedNote, imageKey)
                  : isFileReadTool(name)
                    ? renderReadBody(input, output, resolvedNote)
                    : isFileWriteTool(name)
                      ? renderWriteBody(input, output, resolvedNote)
                      : isFileEditTool(name)
                        ? renderEditBody(input, output, resolvedNote)
                        : isFileMultiEditTool(name)
                          ? renderMultiEditBody(input, output, resolvedNote)
                          : isPathSearchTool(name)
                            ? renderPathSearchBody(name, input, output, resolvedNote)
                            : isTodoTool(name)
                              ? renderTodoBody(input, output, resolvedNote)
                              : isExitPlanModeTool(name)
                                ? renderAgentBody({ prompt: firstStringField(input) || '提交计划' }, output, resolvedNote)
                                : isAgentTool(name)
                                  ? renderAgentBody(input, output, resolvedNote)
                                  : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
                                    + noteBlock
                                    + (output != null ? '\n---\n**output:**\n```\n' + output.slice(0, 3000) + '\n```' : '')
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [
      { tag: 'markdown', content: sanitizeMarkdownForCardKit(body) },
      ...(isImageGenerationTool(name) && imageKey ? [{
        tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: '生成的图片' },
        scale_type: 'fit_horizontal', preview: true,
      }] : []),
    ],
  }
}

/** Panel for one or more consecutive edit-family tool calls
 * (`Edit`/`MultiEdit`/`NotebookEdit`). Same philosophy as
 * `readBatchElement`: body lists paths + per-call edit counts only,
 * never the diff bodies. Header collapses to a single-item summary and
 * `编辑文件 · N 次` once a run has joined. */
export function editBatchElement(
  i: number,
  items: Array<{ input: any; output: string | null; isError: boolean }>,
): object {
  const n = items.length
  const anyError = items.some(it => it.isError)
  const allDone = items.every(it => it.output !== null)
  const status = anyError ? '❌' : allDone ? '✅' : '⏳'
  const headerText = n === 1
    ? (() => {
        const summary = summarizeEditBatchItem(items[0])
        return summary ? `${status} 🔧 编辑文件: ${summary}` : `${status} 🔧 编辑文件`
      })()
    : `${status} 🔧 编辑文件 · ${n} 次`
  const lines = items.map(it => {
    const detail = summarizeEditBatchItem(it)
    return detail ? `\`${detail}\`` : '`(无 path)`'
  })
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [{ tag: 'markdown', content: sanitizeMarkdownForCardKit(lines.join('\n')) }],
  }
}

/** One-line summary of a single edit-family call: `<path> · N 处`
 * (MultiEdit), `<path> · 全局替换` (replace_all Edit) or just the path. */
function summarizeEditBatchItem(item: { input: any }): string {
  const input = item.input ?? {}
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    return path ? `${path} · ${input.edits.length} 处` : `${input.edits.length} 处`
  }
  if (input.replace_all && path) return `${path} · 全局替换`
  return path
}

/** Panel for one or more `Read` tool calls in a row. Body lists file
 * paths only — never the contents, since piping repo source into a
 * Feishu group is the wrong default (chat history persists, the bot
 * runs as the user, so anything readable on disk is one tool-call away
 * from being archived in Lark). Header collapses to `Read: <path>` for
 * a single item and `Read · N 次` once a run has joined. */
export function readBatchElement(
  i: number,
  items: Array<{ input: any; output: string | null; isError: boolean }>,
): object {
  const n = items.length
  const anyError = items.some(it => it.isError)
  const allDone = items.every(it => it.output !== null)
  const status = anyError ? '❌' : allDone ? '✅' : '⏳'
  const headerText = n === 1
    ? (() => {
        const summary = summarizeToolInput('Read', items[0]?.input)
        return summary ? `${status} 🔧 Read: ${summary}` : `${status} 🔧 Read`
      })()
    : `${status} 🔧 Read · ${n} 次`
  const lines = items.map(it => `\`${String(it.input.file_path ?? '(无 path)')}\``)
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: false,
    elements: [{ tag: 'markdown', content: sanitizeMarkdownForCardKit(lines.join('\n')) }],
  }
}

/** Same tool panel as `toolCallElement`, but with the 🔐 status and
 * three inline action buttons (allow / allow_always / deny). Expanded
 * by default so the user can read the request without clicking through.
 * This is the "merge into tool panel" UX — the permission decision
 * lives on the same row as the tool call instead of as a separate
 * floating card. */
export function toolCallPermissionElement(
  i: number,
  name: string,
  input: any,
  requestId: string,
): object {
  const summary = summarizeToolInput(name, input)
  const toolName = displayToolName(name)
  const headerText = summary
    ? `🔐 等审批 · ${toolName}: ${summary}`
    : `🔐 等审批 · ${toolName}`
  const inputBlock = isBashCommandTool(name)
    ? renderBashBody(input, null)
    : isShellSessionTool(name)
      ? renderShellSessionBody(input, null)
      : isFileChangeTool(name)
        ? renderFileChangeBody(input, null)
        : isWebSearchTool(name)
          ? renderWebSearchBody(input, null)
          : isWebFetchTool(name)
            ? renderWebFetchBody(input, null)
            : isMcpTool(name)
              ? renderMcpBody(input, null)
              : isImageGenerationTool(name)
                ? renderImageGenerationBody(input, null)
                : isFileReadTool(name)
                  ? renderReadBody(input, null)
                  : isFileWriteTool(name)
                    ? renderWriteBody(input, null)
                    : isFileEditTool(name)
                      ? renderEditBody(input, null)
                      : isFileMultiEditTool(name)
                        ? renderMultiEditBody(input, null)
                        : isPathSearchTool(name)
                          ? renderPathSearchBody(name, input, null)
                          : isTodoTool(name)
                            ? renderTodoBody(input, null)
                            : isExitPlanModeTool(name)
                              ? renderAgentBody({ prompt: firstStringField(input) || '提交计划' }, null)
                              : isAgentTool(name)
                                ? renderAgentBody(input, null)
                                : '```\n' + JSON.stringify(input ?? {}, null, 2).slice(0, 2000) + '\n```'
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.tool(i),
    header: { title: { tag: 'plain_text', content: headerText } },
    expanded: true,
    elements: [
      { tag: 'markdown', content: inputBlock },
      {
        tag: 'column_set',
        columns: [
          permissionButtonColumn('✅ 允许', 'primary', requestId, 'allow'),
          permissionButtonColumn('♾️ 始终允许', 'default', requestId, 'allow_always'),
          permissionButtonColumn('❌ 拒绝', 'danger', requestId, 'deny'),
        ],
      },
    ],
  }
}

function permissionButtonColumn(label: string, type: string, requestId: string, decision: string): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      behaviors: [{ type: 'callback', value: { kind: 'permission', request_id: requestId, decision } }],
    }],
  }
}
