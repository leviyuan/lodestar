import type { ContextCompactedNotification } from './codex-process'
import { logDiagnostic } from './log'

const COMPACTION_METHODS = new Set([
  'thread/compacted',
  'context/compacted',
  'context_compacted',
  'contextCompacted',
])

const COMPACTION_TYPES = new Set([
  'compacted',
  'compaction',
  'compaction_trigger',
  'context_compacted',
  'context_compaction',
  'contextCompaction',
  'ContextCompaction',
])

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' ? v as Record<string, unknown> : null
}

/** Only fixed protocol diagnoses enter ordinary logs; payloads can contain
 * user text, tool output, source paths and conversation identifiers. */
export function logUnhandledAppServerEvent(reason: string): void {
  switch (reason) {
    case 'RAW_MESSAGE':
      logDiagnostic('codex-process: unsupported protocol message')
      return
    case 'NOTIFICATION':
      logDiagnostic('codex-process: unsupported protocol notification')
      return
    case 'ITEM_STARTED_UNMAPPED':
    case 'ITEM_COMPLETED_UNMAPPED':
      logDiagnostic('codex-process: unsupported protocol item')
      return
    case 'SERVER_REQUEST_UNSUPPORTED':
    case 'APPROVAL_RESPONSE_UNSUPPORTED':
      logDiagnostic('codex-process: unsupported control request')
      return
    default:
      logDiagnostic('codex-process: malformed protocol event')
  }
}

function compactionTypeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return COMPACTION_TYPES.has(v) ? v : null
}

function compactionPhase(sourceType: string | null, method: string): 'start' | 'end' | 'event' {
  if (method === 'item/started') return 'start'
  if (method === 'item/completed' || method === 'rawResponseItem/completed') return 'end'
  if (sourceType === 'compacted') return 'start'
  if (sourceType === 'context_compacted' || COMPACTION_METHODS.has(method)) return 'end'
  return 'event'
}

/** Codex exposes context compaction through more than one surface:
 * `thread/compacted` notifications in the app-server protocol, raw response
 * items in newer builds, and `event_msg {type:"context_compacted"}` in the
 * persisted rollout stream. Match only structured type/method fields; never
 * scan free-form text, because prompts and instructions may legitimately
 * mention compaction without an event having occurred. */
export function contextCompactionNoticeFromNotification(
  method: string,
  params: unknown,
): ContextCompactedNotification | null {
  return contextCompactionNoticeFromObject(method, objectOrNull(params) ?? {})
}

export function contextCompactionNoticeFromMessage(msg: unknown): ContextCompactedNotification | null {
  const root = objectOrNull(msg)
  if (!root) return null
  const method = stringOrUndefined(root.method) ?? stringOrUndefined(root.type) ?? 'raw_message'
  return contextCompactionNoticeFromObject(method, root)
}

function contextCompactionNoticeFromObject(
  method: string,
  root: Record<string, unknown>,
): ContextCompactedNotification | null {
  const payload = objectOrNull(root.payload)
  const candidates = [
    root,
    objectOrNull(root.event),
    payload,
    objectOrNull(root.item),
    objectOrNull(root.responseItem),
    objectOrNull(root.rawItem),
  ].filter((v): v is Record<string, unknown> => v != null)

  let sourceType: string | null = null
  for (const candidate of candidates) {
    sourceType = compactionTypeOf(candidate.type)
    if (sourceType) break
  }

  if (!COMPACTION_METHODS.has(method) && !sourceType) return null

  const rootItem = objectOrNull(root.item) ?? objectOrNull(root.responseItem) ?? objectOrNull(root.rawItem)
  const data = sourceType === 'compacted' && payload
    ? payload
    : rootItem && compactionTypeOf(rootItem.type)
      ? rootItem
      : root
  const item = objectOrNull(data.item) ?? objectOrNull(data.responseItem) ?? objectOrNull(data.rawItem) ?? rootItem ?? {}
  return {
    ...data,
    threadId:
      stringOrUndefined(data.threadId) ??
      stringOrUndefined(data.thread_id) ??
      stringOrUndefined(root.threadId) ??
      stringOrUndefined(root.thread_id),
    turnId:
      stringOrUndefined(data.turnId) ??
      stringOrUndefined(data.turn_id) ??
      stringOrUndefined(root.turnId) ??
      stringOrUndefined(root.turn_id),
    itemId:
      stringOrUndefined(data.itemId) ??
      stringOrUndefined(data.item_id) ??
      stringOrUndefined(item.id) ??
      stringOrUndefined(item.itemId) ??
      stringOrUndefined(item.item_id),
    timestamp: stringOrUndefined(root.timestamp) ?? stringOrUndefined(data.timestamp),
    recordType: stringOrUndefined(root.type),
    phase: compactionPhase(sourceType, method),
    sourceMethod: method,
    sourceType: sourceType ?? method,
  }
}
