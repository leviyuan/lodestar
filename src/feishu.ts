import { networkFetch } from './network'
import { FeishuRequestError, readFeishuResponse, withFeishuRetry } from './feishu-retry'
import { feishuErrorDetails, formatFeishuError } from './feishu-errors'
import { withChatMessageOrder } from './chat-message-order'
import { AGENT_PROVIDERS, isAgentProvider, isDshReasoningEffort } from './agent-process'
/**
 * Feishu (Lark) primitives: Lark client, tenant token cache, chat
 * directory, sendText/sendCard, reactions, attachment download, project
 * provisioning, and Codex ChatGPT-auth check.
 *
 * Higher layers (cardkit / session / daemon) build on this.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { config, type ProjectProfile } from './config'
import { isCodexReasoningEffort, resolveCodexBin } from './codex-process'
import {
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import {
  ALIVE_MARKER_FILE,
  INBOX_DIR,
  SESSION_CHAT_MAP_FILE,
  SESSION_MODEL_MAP_FILE,
  SESSION_RESUME_MAP_FILE,
  SESSION_TURNS_MAP_FILE,
  TEMP_SESSION_LEASES_FILE,
} from './paths'
import { log } from './log'
import { sync as spawnSync } from 'cross-spawn'
import { codexAccounts, DEFAULT_CODEX_ACCOUNT } from './codex-accounts'
import { writeJsonStateAtomic } from './state-store'
import { profileForWorkspace, resolveWorkspaceDir } from './workspace'
import { neutralizeMarkdownImagesInCard } from './cards/elements'
import {
  validateConversationLaunch,
  type ConversationBranchBase,
  type ConversationCheckpoint,
  type ConversationLaunch,
  type ConversationRef,
  type PendingConversationLaunch,
} from './conversation'

const APP_ID = config.feishu.app_id
const APP_SECRET = config.feishu.app_secret
export const PROJECTS_ROOT = config.runtime.projects_root

export interface TempSessionLease {
  sessionName: string
  chatId: string
  createdAt: number
}

const tempSessionLeaseByChat = new Map<string, TempSessionLease>()

function saveTempSessionLeases(): void {
  const value: Record<string, TempSessionLease> = {}
  for (const [chatId, lease] of tempSessionLeaseByChat) value[chatId] = lease
  writeJsonStateAtomic(TEMP_SESSION_LEASES_FILE, value)
}

export function loadTempSessionLeases(): void {
  tempSessionLeaseByChat.clear()
  try {
    const value = JSON.parse(readFileSync(TEMP_SESSION_LEASES_FILE, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lease file must contain an object')
    for (const [chatId, raw] of Object.entries(value)) {
      const lease = raw as Partial<TempSessionLease>
      if (
        typeof chatId !== 'string' || !chatId
        || lease.chatId !== chatId
        || typeof lease.sessionName !== 'string' || !tempProjectName(lease.sessionName)
        || typeof lease.createdAt !== 'number' || !Number.isFinite(lease.createdAt)
      ) {
        log(`feishu: rejected malformed temp-session lease chat=${chatId}`)
        continue
      }
      tempSessionLeaseByChat.set(chatId, {
        chatId,
        sessionName: lease.sessionName,
        createdAt: lease.createdAt,
      })
    }
    log(`feishu: loaded ${tempSessionLeaseByChat.size} temporary-session leases`)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') log(`feishu: load temp-session leases failed: ${error?.message ?? error}`)
  }
}

export function registerTempSessionLease(sessionName: string, chatId: string): void {
  if (!tempProjectName(sessionName)) throw new Error(`refusing to lease non-temporary session name "${sessionName}"`)
  if (!chatId) throw new Error('cannot lease a temporary session without chat_id')
  for (const lease of tempSessionLeaseByChat.values()) {
    if (lease.sessionName === sessionName && lease.chatId !== chatId) {
      throw new Error(`temporary session name "${sessionName}" is already leased to ${lease.chatId}`)
    }
  }
  const previous = tempSessionLeaseByChat.get(chatId)
  const lease = { sessionName, chatId, createdAt: Date.now() }
  tempSessionLeaseByChat.set(chatId, lease)
  try { saveTempSessionLeases() } catch (error) {
    if (previous) tempSessionLeaseByChat.set(chatId, previous)
    else tempSessionLeaseByChat.delete(chatId)
    throw error
  }
}

export function hasTempSessionLease(sessionName: string, chatId: string): boolean {
  const lease = tempSessionLeaseByChat.get(chatId)
  return lease?.sessionName === sessionName && lease.chatId === chatId
}

/** Per-project launch profile for `sessionName`, or undefined when the
 * project runs with Lodestar defaults. Sourced from `[projects.<name>].*`
 * in config.toml. Lets an external project (e.g. evolving) override cwd,
 * tool set, and MCP loading without touching other projects. */
export function projectProfile(sessionName: string): ProjectProfile | undefined {
  return config.projects[sessionName]
}

/** Session 与 worktree 共用项目目录解析，遵循 [projects.<name>].cwd。 */
export function resolveProjectDir(projectName: string): string {
  return resolveWorkspaceDir(projectName, PROJECTS_ROOT, config.projects)
}

export function projectProfileForDirectory(workDir: string): ProjectProfile | undefined {
  return profileForWorkspace(workDir, PROJECTS_ROOT, config.projects)
}

// Keep response headers until diagnostics have been extracted. The SDK's
// default response interceptor otherwise discards header-only request IDs.
type SdkHttp = NonNullable<ConstructorParameters<typeof lark.Client>[0]['httpInstance']>
const sdkRequest: SdkHttp['request'] = async <T = any, R = T, D = any>(options: Parameters<SdkHttp['request']>[0] & { data?: D }): Promise<R> => {
  try {
    // Use the original transport so the SDK's default options and request
    // interceptors (including its User-Agent) remain unchanged.
    const response = await lark.defaultHttpInstance.request({ ...options, $return_headers: true } as any) as any
    const details = feishuErrorDetails({ data: response.data, headers: response.headers })
    if (details.logId && response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
      response.data.log_id = details.logId
    }
    return ((options as any).$return_headers ? response : response.data) as R
  } catch (error) {
    // Preserve the SDK/Axios object, including permission scopes and retry data.
    if (error instanceof Error) {
      const details = feishuErrorDetails(error)
      error.message = formatFeishuError(error)
      Object.assign(error, { apiMessage: details.message, logId: details.logId })
    }
    throw error
  }
}
const sdkHttp: SdkHttp = {
  request: sdkRequest,
  get: (url, options) => sdkRequest({ ...options, url, method: 'GET' }),
  delete: (url, options) => sdkRequest({ ...options, url, method: 'DELETE' }),
  head: (url, options) => sdkRequest({ ...options, url, method: 'HEAD' }),
  options: (url, options) => sdkRequest({ ...options, url, method: 'OPTIONS' }),
  post: (url, data, options) => sdkRequest({ ...options, url, data, method: 'POST' }),
  put: (url, data, options) => sdkRequest({ ...options, url, data, method: 'PUT' }),
  patch: (url, data, options) => sdkRequest({ ...options, url, data, method: 'PATCH' }),
}

export const client = new lark.Client({
  appId: APP_ID, appSecret: APP_SECRET, disableTokenCache: false,
  httpInstance: sdkHttp,
})

function sdkApiError(label: string, raw: unknown): FeishuRequestError {
  const details = feishuErrorDetails(raw)
  return new FeishuRequestError(`${label} failed ${formatFeishuError(raw)}`, details.status, details.code, details.retryAfter, details.logId, details.message)
}

const RAW_FETCH_TIMEOUT_MS = 15_000

function rawFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return networkFetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
  })
}

async function fetchFeishuJson(input: string, init: RequestInit, label: string): Promise<any> {
  const signal = init.signal ?? AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS)
  try {
    return await readFeishuResponse(await rawFetch(input, { ...init, signal }), label)
  } catch (error) {
    // node-fetch reports our deadline as AbortError, including during body reads.
    // Restore only an actual timeout reason; caller cancellation stays permanent.
    if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason
    throw error
  }
}

// ── Tenant token (cached, used by raw fetch wrappers) ──────────────────
let cachedToken = ''
let tokenExpiry = 0
let tokenInFlight: Promise<string> | null = null
export async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  tokenInFlight ??= (async () => {
    const data = await fetchFeishuJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    }, 'tenant token')
    if (typeof data.tenant_access_token !== 'string' || !data.tenant_access_token.trim()) {
      throw new Error('feishu: tenant token MISS')
    }
    cachedToken = data.tenant_access_token
    tokenExpiry = Date.now() + Math.max(0, (data.expire ?? 7200) - 60) * 1000
    return cachedToken
  })().finally(() => { tokenInFlight = null })
  return tokenInFlight
}

// ── Chat directory ─────────────────────────────────────────────────────
export const chatNameCache = new Map<string, string>()
export const preferredChatForSession = new Map<string, string>()

export function loadSessionChatMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_CHAT_MAP_FILE, 'utf8'))
    for (const [name, id] of Object.entries(obj)) {
      if (typeof id === 'string') preferredChatForSession.set(name, id)
    }
    log(`feishu: loaded ${preferredChatForSession.size} session→chat bindings`)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') log(`feishu: load session-chat-map failed: ${e?.message ?? e}`)
  }
}

function saveSessionChatMap(): void {
  try { saveSessionChatMapChecked() }
  catch (e) { log(`feishu: save session-chat-map failed: ${e}`) }
}

function saveSessionChatMapChecked(): void {
  const obj: Record<string, string> = {}
  for (const [k, v] of preferredChatForSession) obj[k] = v
  writeJsonStateAtomic(SESSION_CHAT_MAP_FILE, obj)
}

export function bindSessionToChat(sessionName: string, chatId: string): void {
  if (preferredChatForSession.get(sessionName) === chatId) return
  const prev = preferredChatForSession.get(sessionName)
  preferredChatForSession.set(sessionName, chatId)
  saveSessionChatMap()
  log(`feishu: bound session "${sessionName}" → ${chatId}${prev ? ` (was ${prev})` : ''}`)
}

export function unbindSessionChat(sessionName: string): void {
  const prev = preferredChatForSession.get(sessionName)
  if (!prev) return
  preferredChatForSession.delete(sessionName)
  saveSessionChatMap()
  log(`feishu: unbound session "${sessionName}" from ${prev}`)
}

// ── Session resume map ────────────────────────────────────────────────
// `sessionName → provider → last-known backend conversation`. Persisted so
// daemon restarts don't strand the user with a fresh conversation when
// they next type `restart`. Updated when a turn starts, not when it
// finishes, so in-flight turns are resumable after daemon exit.
const lastSessionRefByName = new Map<string, Partial<Record<AgentProvider, ConversationRef>>>()

function setSessionResumeInMemory(sessionName: string, ref: ConversationRef): void {
  const entry = lastSessionRefByName.get(sessionName) ?? {}
  entry[ref.provider] = ref
  lastSessionRefByName.set(sessionName, entry)
}

function parsePersistedResumeRef(value: unknown, expectedProvider?: AgentProvider): ConversationRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const provider = isAgentProvider(record.provider)
    ? record.provider
    : expectedProvider ?? null
  if (!provider || (expectedProvider && provider !== expectedProvider)) return null
  const sessionId = typeof record.sessionId === 'string'
    ? record.sessionId.trim()
    : typeof record.session_id === 'string'
      ? record.session_id.trim()
      : ''
  if (!sessionId) return null

  // Missing cwd belongs to a pre-ConversationRef state shape. Preserve it as
  // null so callers can fail closed instead of resuming it in today's cwd.
  if (record.cwd === undefined || record.cwd === null) return { provider, sessionId, cwd: null }
  if (typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) return null
  return { provider, sessionId, cwd: record.cwd }
}

function validateSessionResumeWrite(ref: ConversationRef): ConversationRef {
  const sessionId = ref.sessionId.trim()
  if (!sessionId) throw new Error('cannot bind an empty conversation session id')
  if (!isAgentProvider(ref.provider)) {
    throw new Error(`cannot bind an unknown conversation provider: ${String(ref.provider)}`)
  }
  if (typeof ref.cwd !== 'string' || !isAbsolute(ref.cwd)) {
    throw new Error(`cannot bind a conversation without an absolute cwd: ${String(ref.cwd)}`)
  }
  return { provider: ref.provider, sessionId, cwd: ref.cwd }
}

function sessionResumeRefFromArgs(
  sessionIdOrRef: string | ConversationRef,
  provider?: AgentProvider,
  cwd?: string,
): ConversationRef {
  if (typeof sessionIdOrRef !== 'string') return validateSessionResumeWrite(sessionIdOrRef)
  if (!provider) throw new Error('cannot bind a conversation without a provider')
  return validateSessionResumeWrite({ provider, sessionId: sessionIdOrRef, cwd: cwd ?? null })
}

export function loadSessionResumeMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_RESUME_MAP_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('resume map must contain an object')
    }
    lastSessionRefByName.clear()
    for (const [name, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.trim()) {
        setSessionResumeInMemory(name, { provider: 'codex', sessionId: value.trim(), cwd: null })
        continue
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const singleRef = parsePersistedResumeRef(record)
      if (singleRef) {
        setSessionResumeInMemory(name, singleRef)
        continue
      }
      for (const p of AGENT_PROVIDERS) {
        const persisted = record[p]
        if (typeof persisted === 'string' && persisted.trim()) {
          setSessionResumeInMemory(name, { provider: p, sessionId: persisted.trim(), cwd: null })
          continue
        }
        const ref = parsePersistedResumeRef(persisted, p)
        if (ref) setSessionResumeInMemory(name, ref)
      }
    }
    log(`feishu: loaded ${lastSessionRefByName.size} session→resume bindings`)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') log(`feishu: load session-resume-map failed: ${e?.message ?? e}`)
  }
}

function saveSessionResumeMapChecked(): void {
  const obj: Record<string, Partial<Record<AgentProvider, ConversationRef>>> = {}
  for (const [sessionName, refs] of lastSessionRefByName) {
    const persisted: Partial<Record<AgentProvider, ConversationRef>> = {}
    if (refs.codex) persisted.codex = { ...refs.codex }
    if (refs.claude) persisted.claude = { ...refs.claude }
    if (refs.dsh) persisted.dsh = { ...refs.dsh }
    obj[sessionName] = persisted
  }
  writeJsonStateAtomic(SESSION_RESUME_MAP_FILE, obj)
}

export function bindSessionResumeChecked(sessionName: string, ref: ConversationRef): void
export function bindSessionResumeChecked(
  sessionName: string,
  sessionId: string,
  provider: AgentProvider,
  cwd: string,
): void
export function bindSessionResumeChecked(
  sessionName: string,
  sessionIdOrRef: string | ConversationRef,
  provider?: AgentProvider,
  cwd?: string,
): void {
  const ref = sessionResumeRefFromArgs(sessionIdOrRef, provider, cwd)
  const previous = lastSessionRefByName.get(sessionName)
  const previousCopy = previous ? { ...previous } : undefined
  const previousRef = previous?.[ref.provider]
  if (previousRef?.sessionId === ref.sessionId && previousRef.cwd === ref.cwd) return
  setSessionResumeInMemory(sessionName, ref)
  try { saveSessionResumeMapChecked() } catch (error) {
    if (previousCopy) lastSessionRefByName.set(sessionName, previousCopy)
    else lastSessionRefByName.delete(sessionName)
    throw error
  }
}

export function getSessionResumeRef(
  sessionName: string,
  provider: AgentProvider = 'codex',
): ConversationRef | null {
  const ref = lastSessionRefByName.get(sessionName)?.[provider]
  return ref ? { ...ref } : null
}

/** Remove one provider's resume id, or every provider id when omitted. */
export function clearSessionResumeChecked(sessionName: string, provider?: AgentProvider): void {
  const previous = lastSessionRefByName.get(sessionName)
  if (!previous || (provider && previous[provider] === undefined)) return
  const previousCopy = { ...previous }
  if (!provider) lastSessionRefByName.delete(sessionName)
  else {
    const next = { ...previous }
    delete next[provider]
    if (!next.codex && !next.claude) lastSessionRefByName.delete(sessionName)
    else lastSessionRefByName.set(sessionName, next)
  }
  try { saveSessionResumeMapChecked() } catch (error) {
    lastSessionRefByName.set(sessionName, previousCopy)
    throw error
  }
}

// ── Session turns map (fk/bk checkpoints) ──────────────────────────
// V4 persists `sessionName → { base, anchors, pendingLaunch? }`. base describes
// the exact backend-native history immediately before the first retained
// anchor. pendingLaunch keeps a Claude fork durable until its first input
// materializes a new session id. null base is legacy/unknown and must never be
// interpreted as a fresh conversation.
export interface TurnWrite {
  tool: string
  path: string
  body: string
}

export interface TurnAnchor {
  /** Provider-native completed-turn checkpoint, including its source conversation. */
  checkpoint: ConversationCheckpoint
  /** 本 turn 用户输入预览(首条文本,截断) */
  preview: string
  /** 时间戳 ms */
  ts: number
  /** 本 turn 的 Write 类工具记录(Write/Edit/NotebookEdit/MultiEdit),bk 回滚说明用 */
  writes: TurnWrite[]
}

interface SessionTurnsState {
  base: ConversationBranchBase
  anchors: TurnAnchor[]
  pendingLaunch?: PendingConversationLaunch
}

const turnsBySession = new Map<string, SessionTurnsState>()
const TURN_ANCHOR_MAX = 200

function parseConversationRef(value: unknown): ConversationRef | null {
  if (!value || typeof value !== 'object') return null
  const ref = value as Record<string, unknown>
  if (!isAgentProvider(ref.provider)) return null
  const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId.trim() : ''
  if (!sessionId) return null
  let cwd: string | null
  if (ref.cwd === undefined || ref.cwd === null) cwd = null
  else if (typeof ref.cwd === 'string' && ref.cwd.trim()) cwd = ref.cwd
  else return null
  return { provider: ref.provider, sessionId, cwd }
}

function parseCheckpoint(value: unknown): ConversationCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const checkpoint = value as Record<string, unknown>
  const source = checkpoint.source
  if (!source || typeof source !== 'object') return null
  const parsedSource = parseConversationRef(source)
  const id = typeof checkpoint.id === 'string' ? checkpoint.id.trim() : ''
  if (!id || !parsedSource) return null

  if (checkpoint.provider === 'dsh' && checkpoint.kind === 'event' && parsedSource.provider === 'dsh'
    && /^\d+$/.test(id) && Number.isSafeInteger(Number(id))) {
    return { provider: 'dsh', kind: 'event', id, source: { ...parsedSource, provider: 'dsh' } }
  }
  if (
    checkpoint.provider === 'claude'
    && checkpoint.kind === 'assistant-message'
    && parsedSource.provider === 'claude'
  ) {
    return {
      provider: 'claude',
      kind: 'assistant-message',
      id,
      source: { ...parsedSource, provider: 'claude' },
    }
  }
  if (
    checkpoint.provider === 'codex'
    && checkpoint.kind === 'turn'
    && parsedSource.provider === 'codex'
  ) {
    return {
      provider: 'codex',
      kind: 'turn',
      id,
      source: { ...parsedSource, provider: 'codex' },
    }
  }
  return null
}

function parseConversationLaunch(value: unknown): ConversationLaunch | null {
  if (!value || typeof value !== 'object') return null
  const launch = value as Record<string, unknown>
  if (launch.kind === 'fresh') return { kind: 'fresh' }
  if (launch.kind !== 'resume' && launch.kind !== 'fork') return null
  const source = parseConversationRef(launch.source)
  if (!source) return null
  const parsed: ConversationLaunch | null = launch.kind === 'resume'
    ? { kind: 'resume', source }
    : (() => {
        if (!Object.prototype.hasOwnProperty.call(launch, 'through')) return { kind: 'fork', source }
        const through = parseCheckpoint(launch.through)
        return through ? { kind: 'fork', source, through } : null
      })()
  if (!parsed) return null
  try {
    validateConversationLaunch(parsed, source.provider)
  } catch {
    return null
  }
  return parsed
}

function parseTurnWrites(value: unknown): TurnWrite[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((w: any) => w && typeof w.path === 'string')
    .map((w: any) => ({
      tool: String(w.tool ?? 'Write'),
      path: String(w.path),
      body: String(w.body ?? ''),
    }))
    .filter((w: TurnWrite) => w.path !== '' || w.body !== '')
}

function parseTurnAnchor(value: unknown, legacyProvider: 'claude' | null): TurnAnchor | null {
  if (!value || typeof value !== 'object') return null
  const anchor = value as Record<string, unknown>
  if (typeof anchor.ts !== 'number' || !Number.isFinite(anchor.ts)) return null

  const hasCheckpoint = Object.prototype.hasOwnProperty.call(anchor, 'checkpoint')
  let checkpoint = parseCheckpoint(anchor.checkpoint)
  if (hasCheckpoint && !checkpoint) return null
  if (!checkpoint) {
    // V1 did not persist provider. Older builds also wrote Codex agentMessage
    // item ids into this shape, so only migrate when the provider-aware resume
    // map proves that this whole anchor chain belongs to Claude.
    if (legacyProvider !== 'claude') return null
    const uuid = typeof anchor.uuid === 'string' ? anchor.uuid.trim() : ''
    const sid = typeof anchor.sid === 'string' ? anchor.sid.trim() : ''
    if (!uuid || !sid) return null
    checkpoint = {
      provider: 'claude',
      kind: 'assistant-message',
      id: uuid,
      source: { provider: 'claude', sessionId: sid, cwd: null },
    }
  }

  return {
    checkpoint,
    preview: String(anchor.preview ?? ''),
    ts: anchor.ts,
    writes: parseTurnWrites(anchor.writes),
  }
}

function parsePendingConversationLaunch(value: unknown): PendingConversationLaunch | null {
  if (!value || typeof value !== 'object') return null
  const pending = value as Record<string, unknown>
  const launch = parseConversationLaunch(pending.launch)
  if (
    launch?.kind !== 'fork'
    || launch.source.provider !== 'claude'
    || launch.source.cwd === null
  ) return null
  const previousRaw = pending.previousSessionId
  const previousSessionId = previousRaw === null
    ? null
    : typeof previousRaw === 'string' && previousRaw.trim()
      ? previousRaw.trim()
      : undefined
  if (previousSessionId === undefined) return null
  return { launch: { ...launch, source: { ...launch.source, provider: 'claude' } }, previousSessionId }
}

function clonePendingConversationLaunch(pending: PendingConversationLaunch): PendingConversationLaunch {
  const through = pending.launch.through
  if (
    pending.launch.source.provider !== 'claude'
    || (
      through
      && (
        through.provider !== 'claude'
        || through.kind !== 'assistant-message'
        || through.source.provider !== 'claude'
      )
    )
  ) {
    throw new Error('pending conversation launch is not a Claude fork')
  }
  return {
    launch: {
      kind: 'fork',
      source: { ...pending.launch.source, provider: 'claude' },
      ...(through
        ? {
            through: {
              ...through,
              provider: 'claude',
              kind: 'assistant-message',
              source: { ...through.source, provider: 'claude' },
            },
          }
        : {}),
    },
    previousSessionId: pending.previousSessionId,
  }
}

export function loadSessionTurnsMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_TURNS_MAP_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('turns map must contain an object')
    }
    turnsBySession.clear()
    let n = 0
    let rejected = 0
    for (const [name, value] of Object.entries(obj)) {
      let arr: unknown[]
      let base: ConversationBranchBase
      let pendingLaunch: PendingConversationLaunch | null = null
      if (Array.isArray(value)) {
        // V1/V2 stored only the anchor array, so its preceding branch baseline
        // is unknowable even when every individual checkpoint is usable.
        arr = value
        base = null
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const state = value as Record<string, unknown>
        if (!Array.isArray(state.anchors) || !Object.prototype.hasOwnProperty.call(state, 'base')) {
          rejected++
          continue
        }
        arr = state.anchors
        if (state.base === null) base = null
        else {
          const parsedBase = parseConversationLaunch(state.base)
          if (!parsedBase) {
            rejected++
            continue
          }
          base = parsedBase
        }
        if (Object.prototype.hasOwnProperty.call(state, 'pendingLaunch')) {
          const parsedPending = parsePendingConversationLaunch(state.pendingLaunch)
          if (!parsedPending) {
            rejected++
            continue
          }
          pendingLaunch = parsedPending
        }
      } else {
        rejected++
        continue
      }
      const resumes = lastSessionRefByName.get(name)
      // A V1 chain can contain ancestor Claude session ids, so equality with
      // the current resume id proves nothing. Only an unambiguous Claude-only
      // resume binding lets us interpret its provider-less UUID checkpoints.
      const legacyProvider: 'claude' | null = resumes?.claude !== undefined && resumes.codex === undefined
        ? 'claude'
        : null
      const clean: TurnAnchor[] = []
      for (const value of arr) {
        const anchor = parseTurnAnchor(value, legacyProvider)
        if (anchor) clean.push(anchor)
        else rejected++
      }
      if (clean.length || base !== null || pendingLaunch) {
        turnsBySession.set(name, {
          base,
          anchors: clean,
          ...(pendingLaunch ? { pendingLaunch } : {}),
        })
        n += clean.length
      }
    }
    log(`feishu: loaded ${n} turn anchors across ${turnsBySession.size} sessions`)
    if (rejected > 0) log(`feishu: rejected ${rejected} malformed turn anchors while loading`)
  } catch (e: any) {
    // ENOENT(首次启动无文件)静默;其他(JSON 损坏等)要暴露,符合 no-fallbacks。
    if (e?.code !== 'ENOENT') log(`feishu: load session-turns-map failed: ${e?.message ?? e}`)
  }
}

function saveSessionTurnsMapChecked(): void {
  const obj: Record<string, SessionTurnsState> = {}
  for (const [k, v] of turnsBySession) obj[k] = v
  writeJsonStateAtomic(SESSION_TURNS_MAP_FILE, obj)
}

export function appendTurnAnchorChecked(sessionName: string, anchor: TurnAnchor): void {
  const current = turnsBySession.get(sessionName)
  const anchors = [...(current?.anchors ?? []), anchor]
  let base = current?.base ?? null
  if (anchors.length > TURN_ANCHOR_MAX) {
    const discarded = anchors.splice(0, anchors.length - TURN_ANCHOR_MAX)
    const checkpoint = discarded[discarded.length - 1]!.checkpoint
    base = { kind: 'fork', source: checkpoint.source, through: checkpoint }
  }
  turnsBySession.set(sessionName, {
    base,
    anchors,
    ...(current?.pendingLaunch ? { pendingLaunch: current.pendingLaunch } : {}),
  })
  try { saveSessionTurnsMapChecked() } catch (error) {
    if (current) turnsBySession.set(sessionName, current)
    else turnsBySession.delete(sessionName)
    throw error
  }
}

export function getTurnAnchors(sessionName: string): TurnAnchor[] {
  return turnsBySession.get(sessionName)?.anchors ?? []
}

export function getSessionBranchBase(sessionName: string): ConversationBranchBase {
  return turnsBySession.get(sessionName)?.base ?? null
}

export function getPendingConversationLaunch(sessionName: string): PendingConversationLaunch | null {
  const pending = turnsBySession.get(sessionName)?.pendingLaunch
  return pending ? clonePendingConversationLaunch(pending) : null
}

export function setPendingConversationLaunchChecked(
  sessionName: string,
  pendingLaunch: PendingConversationLaunch | null,
): void {
  if (pendingLaunch) {
    if (pendingLaunch.launch.source.cwd === null) {
      throw new Error('pending conversation launch source cwd is missing')
    }
    validateConversationLaunch(
      pendingLaunch.launch,
      'claude',
      pendingLaunch.launch.source.cwd,
    )
  }
  const previous = turnsBySession.get(sessionName)
  const base = previous?.base ?? null
  const anchors = previous?.anchors.slice() ?? []
  if (!pendingLaunch && anchors.length === 0 && base === null) turnsBySession.delete(sessionName)
  else {
    turnsBySession.set(sessionName, {
      base,
      anchors,
      ...(pendingLaunch ? { pendingLaunch: clonePendingConversationLaunch(pendingLaunch) } : {}),
    })
  }
  try { saveSessionTurnsMapChecked() } catch (error) {
    if (previous) turnsBySession.set(sessionName, previous)
    else turnsBySession.delete(sessionName)
    throw error
  }
}

/** Atomically replace a branch's baseline and anchors with one checked state write. */
export function replaceTurnAnchors(
  sessionName: string,
  anchors: TurnAnchor[],
  base: ConversationBranchBase,
  pendingLaunch?: PendingConversationLaunch | null,
): void {
  const previous = turnsBySession.get(sessionName)
  const nextPendingRaw = pendingLaunch === undefined ? previous?.pendingLaunch : pendingLaunch ?? undefined
  const nextPending = nextPendingRaw ? clonePendingConversationLaunch(nextPendingRaw) : undefined
  if (anchors.length === 0 && base === null && !nextPending) turnsBySession.delete(sessionName)
  else {
    turnsBySession.set(sessionName, {
      base,
      anchors: anchors.slice(),
      ...(nextPending ? { pendingLaunch: nextPending } : {}),
    })
  }
  try {
    saveSessionTurnsMapChecked()
  } catch (error) {
    if (previous) turnsBySession.set(sessionName, previous)
    else turnsBySession.delete(sessionName)
    throw error
  }
}

// ── 临时群名(*MMDD-HHMM 后缀,同目录多会话) ─────────────────────────
// 与 worktree 的 [slug](独立目录 + git 分支)区分:*后缀 = 同一项目目录、新群、
// 新会话。workDir 解析靠 tempProjectName 剥后缀回原目录。
const TEMP_SUFFIX_RE = /\*[0-9]{4}-[0-9]{4}(-[0-9]+)?$/

/** 剥临时群 *MMDD-HHMM 后缀,返回原项目名;非临时群返回 null。 */
export function tempProjectName(sessionName: string): string | null {
  return TEMP_SUFFIX_RE.test(sessionName) ? sessionName.replace(TEMP_SUFFIX_RE, '') : null
}

/** 拼临时群名:projectName*MMDD-HHMM。同分钟已有同名则加 -2、-3… 去重。 */
export function tempChatName(projectName: string, additionallyUsed: Iterable<string> = []): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const used = new Set<string>([...chatNameCache.values(), ...turnsBySession.keys(), ...additionallyUsed])
  let name = `${projectName}*${stamp}`
  for (let seq = 2; used.has(name); seq++) name = `${projectName}*${stamp}-${seq}`
  return name
}

// ── Session model map ────────────────────────────────────────────────
// `sessionName → selected provider+model+effort`. This is a Lodestar
// preference, not a global CLI config edit: each Feishu group can choose
// independently and the selection is reapplied on thread start/resume.
// Loader accepts the older string value shape for compatibility; saver
// writes the provider-aware structured shape.
export interface SessionModelSelection {
  provider: AgentProvider
  /** token source 路径保存用户选中的真实 model slug；旧 Codex 记录可为 null。 */
  model: string | null
  effort: AgentReasoningEffort | null
  /** token source id(账号);新字段,旧数据无(构造时从 provider/model 推导)。 */
  tokenSourceId?: string | null
}

const selectedModelByName = new Map<string, SessionModelSelection>()

export function loadSessionModelMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_MODEL_MAP_FILE, 'utf8'))
    for (const [name, selection] of Object.entries(obj)) {
      if (typeof selection === 'string' && selection.trim()) {
        selectedModelByName.set(name, {
          provider: providerFromModel(selection),
          model: selection,
          effort: null,
        })
        continue
      }
      if (!selection || typeof selection !== 'object') continue
      const model = (selection as { model?: unknown }).model
      const providerRaw = (selection as { provider?: unknown }).provider
      const provider: AgentProvider = isAgentProvider(providerRaw)
        ? providerRaw
        : (typeof model === 'string' && model.trim() ? providerFromModel(model) : 'claude')
      const modelStr = typeof model === 'string' && model.trim() ? model : null
      // 兼容旧 Codex 空 model；Claude 必须有具体 model，否则丢弃。
      if (provider === 'claude' && !modelStr) continue
      const effort = (selection as { effort?: unknown }).effort
      const tokenSourceIdRaw = (selection as { tokenSourceId?: unknown }).tokenSourceId
      const tokenSourceId = typeof tokenSourceIdRaw === 'string' && tokenSourceIdRaw.trim()
        ? tokenSourceIdRaw.trim()
        : null
      const normalizedEffort = provider === 'dsh'
        ? isDshReasoningEffort(effort) ? effort : null
        : provider === 'claude'
        ? isClaudeReasoningEffort(effort) ? effort : null
        : isCodexReasoningEffort(effort) ? effort : null
      selectedModelByName.set(name, {
        provider,
        model: modelStr,
        effort: normalizedEffort,
        ...(tokenSourceId ? { tokenSourceId } : {}),
      })
    }
    log(`feishu: loaded ${selectedModelByName.size} session→model bindings`)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') log(`feishu: load session-model-map failed: ${e?.message ?? e}`)
  }
}

function saveSessionModelMap(): void {
  try { saveSessionModelMapChecked() }
  catch (e) { log(`feishu: save session-model-map failed: ${e}`) }
}

function saveSessionModelMapChecked(): void {
  const obj: Record<string, SessionModelSelection> = {}
  for (const [k, v] of selectedModelByName) obj[k] = v
  writeJsonStateAtomic(SESSION_MODEL_MAP_FILE, obj)
}

export function bindSessionModel(
  sessionName: string,
  provider: AgentProvider,
  model: string | null,
  effort: AgentReasoningEffort | null,
  tokenSourceId?: string | null,
): void {
  const prev = selectedModelByName.get(sessionName)
  if (prev?.provider === provider && prev.model === model && prev.effort === effort && (prev.tokenSourceId ?? null) === (tokenSourceId ?? null)) return
  selectedModelByName.set(sessionName, { provider, model, effort, ...(tokenSourceId ? { tokenSourceId } : {}) })
  saveSessionModelMap()
}

export function bindSessionModelChecked(
  sessionName: string,
  provider: AgentProvider,
  model: string | null,
  effort: AgentReasoningEffort | null,
  tokenSourceId?: string | null,
): void {
  const previous = selectedModelByName.get(sessionName)
  const next = { provider, model, effort, ...(tokenSourceId ? { tokenSourceId } : {}) }
  if (
    previous?.provider === provider && previous.model === model
    && previous.effort === effort && (previous.tokenSourceId ?? null) === (tokenSourceId ?? null)
  ) return
  selectedModelByName.set(sessionName, next)
  try { saveSessionModelMapChecked() } catch (error) {
    if (previous) selectedModelByName.set(sessionName, previous)
    else selectedModelByName.delete(sessionName)
    throw error
  }
}

export function getSessionModelSelection(sessionName: string): SessionModelSelection | null {
  // 临时群先查 direct routing snapshot（创建事务会写，bye 后清理）；旧临时群
  // 没有 direct 记录时才转发主群名，保持升级兼容。
  const direct = selectedModelByName.get(sessionName)
  if (direct) return direct
  const parent = tempProjectName(sessionName)
  return parent ? (selectedModelByName.get(parent) ?? null) : null
}

/**
 * Remove conversation-scoped state after a session has been permanently
 * deleted. Callers must not use this for ordinary provider switches/restarts.
 */
export function clearSessionConversationState(sessionName: string): void {
  const previousChat = preferredChatForSession.get(sessionName)
  const previousResume = lastSessionRefByName.get(sessionName)
  const previousModel = selectedModelByName.get(sessionName)
  const previousTurns = turnsBySession.get(sessionName)
  const previousLeases = [...tempSessionLeaseByChat.entries()]
    .filter(([, lease]) => lease.sessionName === sessionName)

  preferredChatForSession.delete(sessionName)
  lastSessionRefByName.delete(sessionName)
  selectedModelByName.delete(sessionName)
  turnsBySession.delete(sessionName)
  for (const [chatId] of previousLeases) tempSessionLeaseByChat.delete(chatId)

  try {
    saveSessionChatMapChecked()
    saveSessionResumeMapChecked()
    saveSessionModelMapChecked()
    saveSessionTurnsMapChecked()
    saveTempSessionLeases()
  } catch (error) {
    if (previousChat) preferredChatForSession.set(sessionName, previousChat)
    if (previousResume) lastSessionRefByName.set(sessionName, previousResume)
    if (previousModel) selectedModelByName.set(sessionName, previousModel)
    if (previousTurns) turnsBySession.set(sessionName, previousTurns)
    for (const [chatId, lease] of previousLeases) tempSessionLeaseByChat.set(chatId, lease)
    const failures: unknown[] = [error]
    for (const save of [
      saveSessionChatMapChecked,
      saveSessionResumeMapChecked,
      saveSessionModelMapChecked,
      saveSessionTurnsMapChecked,
      saveTempSessionLeases,
    ]) {
      try { save() } catch (restoreError) { failures.push(restoreError) }
    }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, `failed to clear and restore conversation state for ${sessionName}`)
  }
}

// ── Alive-on-shutdown marker ──────────────────────────────────────────
// Persists the list of session names that were still running when the
// daemon went down. Next boot reads the file and auto-spawns
// (via session.restart(true)) only those — sessions that were already
// `stop`ped before shutdown are deliberately NOT in this list, so they
// stay stopped after restart.

export function writeAliveMarker(sessionNames: string[]): void {
  writeJsonStateAtomic(ALIVE_MARKER_FILE, sessionNames)
}

/** Read without unlinking. The daemon keeps this marker current while
 * running, so a rapid second restart cannot lose the revive list after
 * the first boot consumes it but exits before a clean shutdown. */
export function readAliveMarker(): string[] {
  let raw: string
  try { raw = readFileSync(ALIVE_MARKER_FILE, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data) || data.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('invalid alive session marker: expected non-empty session names')
  }
  return data
}

export function chatIdForSession(sessionName: string): string | null {
  const preferred = preferredChatForSession.get(sessionName)
  if (preferred) {
    const cachedName = chatNameCache.get(preferred)
    if (cachedName && cachedName !== sessionName) {
      log(`feishu: chatIdForSession("${sessionName}"): persisted binding ${preferred} has cached name "${cachedName}", using persisted binding`)
    }
    return preferred
  }
  const matches: string[] = []
  for (const [id, name] of chatNameCache) if (name === sessionName) matches.push(id)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    log(`feishu: chatIdForSession("${sessionName}"): ${matches.length} candidates with no binding — [${matches.join(', ')}]`)
  }
  return null
}

export async function refreshChatList(): Promise<void> {
  try {
    let pageToken: string | undefined
    do {
      const res = await client.im.chat.list({
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      })
      if (res.code && res.code !== 0) throw sdkApiError('feishu chat.list', res)
      for (const chat of res.data?.items ?? []) {
        if (chat.chat_id && chat.name) chatNameCache.set(chat.chat_id, chat.name)
      }
      pageToken = res.data?.page_token
    } while (pageToken)
    log(`feishu: refreshed chat list — ${chatNameCache.size} groups`)
  } catch (e) { log(`feishu: refresh chat list failed: ${e}`) }
}

export async function listNormalChatIdsByName(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  let pageToken: string | undefined
  do {
    const res = await client.im.chat.list({
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    })
    if (res.code && res.code !== 0) throw sdkApiError('feishu chat.list', res)
    for (const chat of res.data?.items ?? []) {
      if (!chat.chat_id || !chat.name) continue
      if (chat.chat_status && chat.chat_status !== 'normal') continue
      chatNameCache.set(chat.chat_id, chat.name)
      const ids = out.get(chat.name) ?? []
      ids.push(chat.chat_id)
      out.set(chat.name, ids)
    }
    pageToken = res.data?.page_token
  } while (pageToken)
  return out
}

export async function findNormalChatIdByName(sessionName: string): Promise<string | null> {
  const cachedPreferred = preferredChatForSession.get(sessionName)
  if (cachedPreferred && chatNameCache.get(cachedPreferred) === sessionName) {
    const status = await fetchChatStatus(cachedPreferred)
    if (status.name === sessionName && isNormalChatStatus(status.status)) return cachedPreferred
    chatNameCache.delete(cachedPreferred)
    unbindSessionChat(sessionName)
  }
  const byName = await listNormalChatIdsByName()
  const matches = byName.get(sessionName) ?? []
  if (matches.length === 0) return null
  const preferred = preferredChatForSession.get(sessionName)
  if (preferred && matches.includes(preferred)) return preferred
  if (matches.length === 1) return matches[0]
  throw new Error(`multiple Feishu groups named "${sessionName}": ${matches.join(', ')}`)
}

export async function ensureChatForSession(sessionName: string, userOpenId: string): Promise<{ chatId: string; created: boolean; joined: boolean }> {
  if (!userOpenId) throw new Error('missing sender open_id; cannot add user to worktree group')
  const existing = await findNormalChatIdByName(sessionName)
  if (existing) {
    const joined = await ensureUserInChat(existing, userOpenId)
    bindSessionToChat(sessionName, existing)
    return { chatId: existing, created: false, joined }
  }

  const res = await client.im.chat.create({
    params: { user_id_type: 'open_id', uuid: randomUUID() },
    data: {
      name: sessionName,
      user_id_list: [userOpenId],
      group_message_type: 'chat',
    },
  })
  if (res.code && res.code !== 0) {
    throw sdkApiError('feishu chat.create', res)
  }
  const chatId = res.data?.chat_id
  if (!chatId) throw new Error('feishu chat.create returned no chat_id')
  chatNameCache.set(chatId, sessionName)
  bindSessionToChat(sessionName, chatId)
  return { chatId, created: true, joined: true }
}

/** Create a brand-new temporary chat; never join/reuse an existing same-name chat. */
export async function createTempChatForSession(
  sessionName: string,
  userOpenId: string,
): Promise<{ chatId: string; created: true; joined: true }> {
  if (!userOpenId) throw new Error('missing sender open_id; cannot create temporary group')
  const existing = await findNormalChatIdByName(sessionName)
  if (existing) throw new Error(`temporary group name already exists: ${sessionName}`)
  const res = await client.im.chat.create({
    params: { user_id_type: 'open_id', uuid: randomUUID() },
    data: {
      name: sessionName,
      user_id_list: [userOpenId],
      group_message_type: 'chat',
    },
  })
  if (res.code && res.code !== 0) {
    throw sdkApiError('feishu chat.create', res)
  }
  const chatId = res.data?.chat_id
  if (!chatId) throw new Error('feishu chat.create returned no chat_id')
  chatNameCache.set(chatId, sessionName)
  bindSessionToChat(sessionName, chatId)
  return { chatId, created: true, joined: true }
}

export async function disbandChatForSession(sessionName: string): Promise<{ chatId: string | null; disbanded: boolean }> {
  const chatId = await findNormalChatIdByName(sessionName)
  if (!chatId) {
    unbindSessionChat(sessionName)
    return { chatId: null, disbanded: false }
  }
  const res = await client.im.chat.delete({ path: { chat_id: chatId } })
  if (res.code && res.code !== 0) {
    throw sdkApiError('feishu chat.delete', res)
  }
  chatNameCache.delete(chatId)
  if (preferredChatForSession.get(sessionName) === chatId) unbindSessionChat(sessionName)
  return { chatId, disbanded: true }
}

/** Delete one already-resolved chat only after confirming its current name. */
export async function disbandChatForSessionExact(
  sessionName: string,
  chatId: string,
): Promise<{ chatId: string; disbanded: boolean }> {
  if (!chatId) throw new Error('cannot disband a temporary session without an exact chat_id')
  const status = await fetchChatStatus(chatId)
  if (status.name !== sessionName) {
    throw new Error(`refusing to delete chat ${chatId}: expected name "${sessionName}", got "${status.name ?? ''}"`)
  }
  if (!isNormalChatStatus(status.status)) {
    throw new Error(`refusing to delete chat ${chatId}: status=${status.status ?? 'unknown'}`)
  }
  const res = await client.im.chat.delete({ path: { chat_id: chatId } })
  if (res.code && res.code !== 0) {
    throw sdkApiError('feishu chat.delete', res)
  }
  chatNameCache.delete(chatId)
  return { chatId, disbanded: true }
}

async function ensureUserInChat(chatId: string, userOpenId: string): Promise<boolean> {
  let pageToken: string | undefined
  do {
    const res = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    })
    if (res.code && res.code !== 0) {
      throw sdkApiError('feishu chatMembers.get', res)
    }
    for (const item of res.data?.items ?? []) {
      if (item.member_id === userOpenId) return false
    }
    pageToken = res.data?.page_token
  } while (pageToken)

  const add = await client.im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: [userOpenId] },
  })
  if (add.code && add.code !== 0) {
    throw sdkApiError('feishu chatMembers.create', add)
  }
  return true
}

/** Resolve ONE chat's name by chat_id via `im.chat.get`, bypassing the
 * eventually-consistent `im.chat.list` that {@link refreshChatList} walks.
 * A group the bot was just added to can lag the list endpoint by several
 * seconds — exactly the window in which the user fires their first message
 * — so a direct point-lookup is what lets a freshly-created group resolve
 * on the first try instead of bouncing off "无法识别群名". Caches the name
 * on hit. Returns null when the API errors OR the chat genuinely has no
 * name (an unnamed group — the caller must surface that, since group-name
 * → project-dir is load-bearing and an empty name can't map anywhere).
 * Raw fetch + tenant token, same shape as urgentApp / sendTextRaw. */
export async function fetchChatName(chatId: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await rawFetch(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await readFeishuResponse(res, `fetchChatName ${chatId}`)
    const name = json.data?.name
    if (typeof name === 'string' && name) {
      chatNameCache.set(chatId, name)
      log(`feishu: fetchChatName ${chatId} → "${name}" (point lookup)`)
      return name
    }
    log(`feishu: fetchChatName ${chatId} — chat has no name (unnamed group?)`)
    return null
  } catch (e) {
    log(`feishu: fetchChatName ${chatId} failed: ${e}`)
    return null
  }
}

export * from './feishu-task'

// ── Outbound: text + card ──────────────────────────────────────────────
async function sendViaSdkWithRetry(
  what: 'Text' | 'Card' | 'Image' | 'File',
  chatId: string,
  msgType: 'text' | 'interactive' | 'image' | 'file',
  content: string,
  onFailure?: (error: unknown) => void,
): Promise<string | null> {
  // Same uuid across retries → Feishu dedupes on its side so a successful-
  // but-response-lost first attempt doesn't produce a duplicate message.
  const uuid = randomUUID()
  try {
    return await withFeishuRetry(`send${what} chat=${chatId}`, async () => {
      const res: any = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content, uuid },
      })
      if (res?.code !== 0) {
        throw sdkApiError(`send${what}`, res)
      }
      const messageId = res?.data?.message_id
      if (typeof messageId !== 'string' || !messageId.trim()) throw new Error(`send${what} message_id MISS`)
      return messageId
    })
  } catch (error) {
    onFailure?.(error)
    return null
  } // withFeishuRetry logs the final failure; callers surface null.
}

async function fetchChatStatus(chatId: string): Promise<{ name: string | null; status: string | null }> {
  const res = await client.im.chat.get({ path: { chat_id: chatId } })
  if (res.code && res.code !== 0) {
    throw sdkApiError('feishu chat.get', res)
  }
  return {
    name: res.data?.name ?? null,
    status: res.data?.chat_status ?? null,
  }
}

function isNormalChatStatus(status: string | null): boolean {
  return status === null || status === 'normal'
}

export async function sendText(chatId: string, text: string, onFailure?: (error: unknown) => void): Promise<string | null> {
  return withChatMessageOrder(chatId, () => sendViaSdkWithRetry('Text', chatId, 'text', JSON.stringify({ text }), onFailure))
}

export async function sendCard(chatId: string, card: object, onFailure?: (error: unknown) => void): Promise<string | null> {
  return withChatMessageOrder(chatId, () => sendViaSdkWithRetry(
    'Card',
    chatId,
    'interactive',
    JSON.stringify(neutralizeMarkdownImagesInCard(card)),
    onFailure,
  ))
}

/** Read the actual chat tail, including messages sent by users/other apps. */
export async function getChatTailMessageId(chatId: string): Promise<string | null> {
  const response = await client.im.message.list({ params: {
    container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: 1,
  } })
  if (response.code !== 0) throw sdkApiError('feishu message.list', response)
  if (!Array.isArray(response.data?.items)) throw new Error('feishu message.list items MISS')
  if (response.data.items.length === 0) return null
  const messageId = response.data.items[0]?.message_id
  if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('feishu message.list message_id MISS')
  return messageId
}

export async function updateCard(messageId: string, card: object): Promise<void> {
  const res: any = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(neutralizeMarkdownImagesInCard(card)) },
  })
  if (res?.code !== 0) {
    throw sdkApiError('feishu message.patch', res)
  }
}

/** Last-resort text send that bypasses the lark SDK and uses raw fetch
 * (which is what cardkit.ts uses and has never had stability issues on
 * this runtime). Used by callers that need to *surface a failure when
 * the SDK send path itself is the broken thing* — e.g. `openTurnCard`'s
 * `sendCard` exhausted retries on ECONNREFUSED and we still owe the
 * user a visible "your message was lost, please retry" notice. Do not
 * use this as a general-purpose send; it's the failure-surfacing
 * channel, not a silent fallback. */
export async function sendTextRaw(chatId: string, text: string): Promise<string | null> {
  return withChatMessageOrder(chatId, () => sendTextRawOrdered(chatId, text))
}

async function sendTextRawOrdered(chatId: string, text: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await rawFetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    const json = await readFeishuResponse(res, `sendTextRaw chat=${chatId}`)
    return json.data?.message_id ?? null
  } catch (e) {
    log(`feishu: sendTextRaw chat=${chatId} failed: ${e}`)
    return null
  }
}

// ── Reactions ──────────────────────────────────────────────────────────
/** Add an emoji reaction. Returns the new reaction_id on success (needed
 * to delete the reaction later via {@link deleteReaction}) or null on
 * failure. Failures are logged and swallowed — reactions are non-load-
 * bearing UX, not worth bubbling errors. */
export async function addReaction(messageId: string, emojiType: string): Promise<string | null> {
  if (!messageId) return null
  try {
    const res: any = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    if (res?.code && res.code !== 0) throw sdkApiError('feishu messageReaction.create', res)
    return res?.data?.reaction_id ?? null
  } catch (e) { log(`feishu: addReaction ${emojiType} on ${messageId} failed: ${e}`); return null }
}

/** Remove a previously-added reaction by its reaction_id (returned from
 * {@link addReaction}). Used for the "queued → released" lifecycle: the
 * OneSecond placed on arrival is *removed* when the daemon hands the
 * message off to the SDK's batch / system-reminder pipeline, instead of
 * stacking a second CheckMark on top — keeps the message's reaction row
 * uncluttered. Quiet on failure. */
export async function deleteReaction(messageId: string, reactionId: string): Promise<void> {
  if (!messageId || !reactionId) return
  try {
    const res = await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })
    if (res?.code && res.code !== 0) throw sdkApiError('feishu messageReaction.delete', res)
  } catch (e) { log(`feishu: deleteReaction ${reactionId} on ${messageId} failed: ${e}`) }
}

// ── Urgent push ───────────────────────────────────────────────────────
/** Fire Feishu's "加急 — 应用内" push for an already-sent message.
 * Bypasses chat-level mute and pops a full-screen prompt on the
 * recipient's phone. Bot must be the original sender of the message
 * AND must still be a member of the chat.
 *
 * Endpoint:
 *   PATCH /open-apis/im/v1/messages/{message_id}/urgent_app
 *   ?user_id_type=open_id
 *   body: { user_id_list: ["ou_..."] }
 *
 * Required app scope (either one):
 *   - `im:message.urgent`            (「发送应用内加急消息」)
 *   - `im:message.urgent:app_send`   (「…（历史版本）」)
 *
 * Limits: 50 QPS app-wide; per-recipient cap is 200 unread urgent
 * messages (230023). No daily quota.
 *
 * Common error codes:
 *   230012 — message not sent by this bot
 *   230023 — recipient has 200 unread urgent already
 *   230052 — missing scope / chat restricts urgent */
export async function urgentApp(messageId: string, openIds: string[]): Promise<void> {
  if (!messageId) { log(`feishu: urgentApp skip — missing messageId`); return }
  if (openIds.length === 0) { log(`feishu: urgentApp skip — empty openIds (msg=${messageId})`); return }
  const token = await getTenantToken()
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/urgent_app?user_id_type=open_id`
  try {
    const res = await rawFetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id_list: openIds }),
    })
    const json = await readFeishuResponse(res, `urgentApp ${messageId}`)
    const invalid = json.data?.invalid_user_id_list ?? []
    const delivered = openIds.length - invalid.length
    log(`feishu: urgentApp ${messageId} ok — delivered=${delivered}${invalid.length ? ` invalid=${invalid.length}` : ''}`)
  } catch (e) { log(`feishu: urgentApp ${messageId} failed: ${e}`) }
}

// ── Attachment download (image/file) ───────────────────────────────────
export async function downloadAttachment(
  messageId: string, key: string, type: 'image' | 'file', name?: string,
): Promise<string | undefined> {
  try {
    const token = await getTenantToken()
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`
    const res = await rawFetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      await readFeishuResponse(res, `download ${type}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const safeName = name
      ? name.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
    // The inbox is shared by every chat. Timestamps and sanitized names can
    // collide when simultaneous attachments arrive, so never overwrite a
    // previous message's bytes (including a pre-existing symlink).
    const path = join(INBOX_DIR, `${Date.now()}-${randomUUID()}-${safeName}`)
    writeFileSync(path, buf, { flag: 'wx' })
    log(`feishu: downloaded ${type} ${path} (${buf.length}B)`)
    return path
  } catch (e) {
    log(`feishu: download ${type} failed: ${e instanceof Error ? e.message : e}`)
    return undefined
  }
}

// ── Outbound: upload + send file/image ────────────────────────────────
// 用户约定的飞书出站文件上限，普通文件、图片和卡内图片共同遵守。
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])

function looksLikeImage(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase())
}

async function uploadMultipart(filePath: string, type: 'image' | 'file'): Promise<string> {
  const label = `upload${type === 'image' ? 'Image' : 'File'}`
  let file: Blob | undefined
  return withFeishuRetry(`${label} ${filePath}`, async () => {
    // Keep the same bytes across retries, even if the local path is overwritten.
    // Check the bytes as well as stat: the file may have grown since validation.
    file ??= new Blob([Uint8Array.from(await readFile(filePath))])
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${basename(filePath)} 超过 30 MB`)
    const token = await getTenantToken()
    // Rebuild the multipart body; the immutable Blob can be reused. Its copied
    // ArrayBuffer-backed view above also preserves Node 18 BlobPart compatibility.
    const form = new FormData()
    if (type === 'image') form.append('image_type', 'message')
    else {
      form.append('file_type', 'stream')
      form.append('file_name', basename(filePath))
    }
    form.append(type, file, basename(filePath))
    // Every attempt has its own 15s timeout, including response body reads.
    const data = await fetchFeishuJson(`https://open.feishu.cn/open-apis/im/v1/${type}s`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }, label)
    const key = data.data?.[`${type}_key`]
    if (typeof key !== 'string' || !key.trim()) throw new Error(`${label} ${type}_key MISS`)
    return key
  })
}

/** Upload a local image for embedding inside a Card Kit card. Returns the
 * Feishu-accessible `image_key`, or null on any failure (missing/oversize
 * file, API rejection). Mirrors `uploadAndSend`'s validation but yields the
 * key so the caller can place an `{tag:'image'}` element instead of sending
 * a standalone image message. */
export async function uploadImageKey(filePath: string, onFailure?: (error: unknown) => void): Promise<string | null> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      log(`feishu: uploadImageKey not a file — ${filePath}`)
      onFailure?.(new Error('路径不是普通文件'))
      return null
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      log(`feishu: uploadImageKey oversize — ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      onFailure?.(new Error(`${basename(filePath)} 超过 30 MB`))
      return null
    }
  } catch (e) {
    log(`feishu: uploadImageKey stat failed — ${filePath}: ${e}`)
    onFailure?.(e)
    return null
  }
  try { return await uploadMultipart(filePath, 'image') }
  catch (error) {
    onFailure?.(error)
    return null
  } // Final upload diagnostics are logged by withFeishuRetry.
}

export async function sendImage(chatId: string, imageKey: string, onFailure?: (error: unknown) => void): Promise<string | null> {
  return withChatMessageOrder(chatId, () => sendViaSdkWithRetry('Image', chatId, 'image', JSON.stringify({ image_key: imageKey }), onFailure))
}

export async function sendFile(chatId: string, fileKey: string, onFailure?: (error: unknown) => void): Promise<string | null> {
  return withChatMessageOrder(chatId, () => sendViaSdkWithRetry('File', chatId, 'file', JSON.stringify({ file_key: fileKey }), onFailure))
}

/** Upload a local file and post it as an image or file message in the
 * chat.  Type is inferred from extension.  Returns true on success.
 * All failures (missing file, oversize, upload reject, send reject)
 * log and surface an inline error message in the chat so the user
 * knows. */
export async function uploadAndSend(chatId: string, filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      log(`feishu: uploadAndSend not a file — ${filePath}`)
      await sendText(chatId, `❌ 出站文件: 路径不是文件 — ${filePath}`)
      return false
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      log(`feishu: uploadAndSend oversize — ${filePath} (${stats.size}B)`)
      await sendText(chatId, `❌ 出站文件: ${basename(filePath)} 超过 30 MB (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      return false
    }
  } catch (e) {
    log(`feishu: uploadAndSend stat failed — ${filePath}: ${e}`)
    await sendText(chatId, `❌ 出站文件: 无法读取 ${filePath} (${e})`)
    return false
  }
  const type = looksLikeImage(filePath) ? 'image' : 'file'
  const label = type === 'image' ? '出站图片' : '出站文件'
  try {
    const key = await uploadMultipart(filePath, type)
    let sendError: unknown
    const onFailure = (error: unknown) => { sendError = error }
    const msgId = await (type === 'image' ? sendImage(chatId, key, onFailure) : sendFile(chatId, key, onFailure))
    if (!msgId) {
      log(`feishu: uploadAndSend ${filePath} send failed after upload`)
      await sendText(chatId, `❌ ${label}发送失败: ${basename(filePath)}（上传已完成）\n${formatFeishuError(sendError)}`)
      return false
    }
    log(`feishu: uploadAndSend ${filePath} delivered msg=${msgId}`)
    return true
  } catch (e) {
    log(`feishu: uploadAndSend ${filePath} failed: ${e}`)
    await sendText(chatId, `❌ ${label}上传失败: ${basename(filePath)} — ${formatFeishuError(e)}`)
    return false
  }
}

// ── Project provisioning ──────────────────────────────────────────────
// Bootstrap ~/{name}: create dir, mark as trusted in ~/.codex/config.toml so
// Codex skips the project trust dialog, and `git init` so the project starts as
// a real repo.
export function provisionProject(workDir: string): void {
  mkdirSync(workDir, { recursive: true })
  log(`feishu: provisioned ${workDir}`)
  const codexConfigPath = join(homedir(), '.codex', 'config.toml')
  try {
    mkdirSync(join(homedir(), '.codex'), { recursive: true })
    let text = ''
    try { text = readFileSync(codexConfigPath, 'utf8') } catch {}
    const header = `[projects.${JSON.stringify(workDir)}]`
    if (!text.includes(header)) {
      const prefix = text.trimEnd()
      text = `${prefix}${prefix ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`
      writeFileSync(codexConfigPath, text)
    }
  } catch (e) { log(`feishu: codex trust write failed for ${workDir}: ${e}`) }
  try { execSync('git init -q', { cwd: workDir, stdio: 'ignore' }) } catch {}
}

export function isOpenAIChatGPTAuthenticated(accountId = DEFAULT_CODEX_ACCOUNT): boolean {
  const result = spawnSync(resolveCodexBin(), ['login', 'status', ...codexAccounts.cliArgs(accountId)], {
    timeout: 10_000, shell: false, encoding: 'utf8',
    env: codexAccounts.env(accountId, { ...process.env, ...config.codex.env }),
  })
  if (result.error) log(`codex login status failed: ${result.error.message}`)
  return result.status === 0 && /Logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`)
}

export function sanitizeSessionName(raw: string): string {
  // `*` 给临时群后缀(*MMDD-HHMM)用,和 worktree 的 `[]` 一样显式放行。
  return raw.replace(/[^\w一-鿿\-\[\]\*]/g, '_').slice(0, 64)
}
