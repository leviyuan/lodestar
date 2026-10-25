import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import { lstat, stat as followStat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeNativeConfigFile } from './claude-account-config-state'

type SyncSettings = { syncClaudeAiSkills?: boolean; syncClaudeAiPlugins?: boolean }
type Json = Record<string, unknown>
export interface ClaudeSyncWarmupOptions {
  configDir: string
  sharedConfigDir: string
  /** Capture before starting the native process, including its authentication request. */
  startedAt: number
  accountInfo: AccountInfo
  isAlive: () => boolean
  settings?: SyncSettings
  baseline?: ClaudeSyncWarmupSnapshot
  signal?: AbortSignal
  timeoutMs?: number
  intervalMs?: number
  /** Monotonic clock and wait injection for offline filesystem/lifecycle tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}
interface LaneSnapshot {
  state: string
  count: number
  pending: number
  trash: string[]
  proof?: string
}
export interface ClaudeSyncWarmupSnapshot {
  bucket: string
  skills: LaneSnapshot
  plugins: LaneSnapshot
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const COMPLETE = '.last-complete-round'
const MAX_JSON_BYTES = 16 * 1024 * 1024
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

async function stat(path: string, followSymlinks = false) {
  try { return await (followSymlinks ? followStat(path) : lstat(path)) }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}
async function readJson(path: string, followSymlinks = false): Promise<{ value: Json; text: string } | null> {
  const metadata = await stat(path, followSymlinks)
  if (!metadata) return null
  if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) throw new Error(`Claude 同步 JSON 文件无效：${path}`)
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  const value: unknown = JSON.parse(text)
  if (!object(value)) throw new Error(`Claude 同步 JSON 必须为对象：${path}`)
  return { value, text }
}
async function entries(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort() }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
}

/** Native replaces path separators and trims trailing dots/spaces in synced names.
 * Reject control/reserved names instead of following a malformed manifest outside its bucket. */
function itemDirectory(name: unknown, generation: unknown = 1): string | null {
  if (typeof name !== 'string' || /[\x00-\x1f\x7f\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/.test(name)) return null
  const normalized = name.replace(/[<>:"|?*\\/]/g, '_').replace(/[. ]+$/, '')
  if (!normalized || normalized.startsWith('.') || !Number.isSafeInteger(generation) || Number(generation) < 1) return null
  return Number(generation) > 1 ? `${normalized}~g${generation}` : normalized
}

async function lane(root: string, bucket: string, kind: 'skills' | 'plugins', disabled: boolean, startedAt: number,
  baseline?: LaneSnapshot): Promise<LaneSnapshot> {
  const directory = join(root, kind, 'synced', bucket)
  const trash = await entries(join(root, kind, '.trash'))
  const result: LaneSnapshot = { state: 'waiting', count: 0, pending: 0, trash }
  for (const staging of [join(directory, '.staging'), join(root, kind, '.staging'), join(root, kind, 'synced', '.staging')]) {
    if ((await entries(staging)).length) return { ...result, state: 'staging' }
  }
  // The native startup may still be pruning after an explicit disable. Staging
  // and stability remain required, without fabricating a completion marker.
  if (disabled) return { ...result, state: 'disabled', proof: 'disabled' }
  const bucketStat = await stat(directory)
  if (!bucketStat?.isDirectory() || bucketStat.isSymbolicLink()) return { ...result, state: 'bucket_missing' }
  const marker = join(directory, COMPLETE)
  const metadata = await stat(marker)
  if (!metadata?.isFile() || metadata.size > 1024 || metadata.mtimeMs < startedAt && baseline?.proof === undefined) return { ...result, state: 'completion_missing' }
  let token: string
  try { token = await readFile(marker, 'utf8') }
  catch (error: any) { if (error.code === 'ENOENT') return { ...result, state: 'completion_missing' }; throw error }
  if (!UUID.test(token.split(' ', 1)[0] ?? '')) return { ...result, state: 'completion_invalid' }
  const complete = (proof: string): LaneSnapshot => metadata.mtimeMs >= startedAt || proof === baseline?.proof
    ? { ...result, state: 'complete', proof } : { ...result, state: 'completion_missing' }
  let manifest: Awaited<ReturnType<typeof readJson>>
  try { manifest = await readJson(join(directory, 'manifest.json')) }
  catch (error) {
    if (error instanceof SyntaxError) return { ...result, state: 'manifest_invalid' }
    throw error
  }
  // A successful native no-changes round for an empty remote collection writes a
  // completion marker without necessarily creating manifest.json.
  if (!manifest) {
    const children = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!children) return { ...result, state: 'bucket_missing' }
    if (children.some(child => child.isDirectory() && !child.name.startsWith('.'))) return { ...result, state: 'manifest_missing' }
    return complete(token)
  }
  const rows = manifest.value[kind]
  if (!Array.isArray(rows)) return { ...result, state: 'manifest_invalid' }
  result.count = rows.length
  for (const field of ['pendingClaims', 'staleDirs']) {
    const claims = manifest.value[field]
    if (claims !== undefined && !Array.isArray(claims)) return { ...result, state: 'manifest_invalid' }
    if (Array.isArray(claims) && claims.length) return { ...result, pending: claims.length, state: field }
  }
  const names = new Set<string>()
  for (const row of rows) {
    const name = object(row) ? itemDirectory(row.name, kind === 'plugins' ? row.generation : undefined) : null
    if (!name || names.has(name.toLocaleLowerCase())) return { ...result, state: 'manifest_invalid' }
    names.add(name.toLocaleLowerCase())
    const item = join(directory, name)
    const itemStat = await stat(item)
    if (!itemStat?.isDirectory() || itemStat.isSymbolicLink()) return { ...result, state: 'item_missing' }
    if (kind === 'skills') {
      if (!(await stat(join(item, 'SKILL.md')))?.isFile()) return { ...result, state: 'skill_missing' }
    } else if (!(await entries(item)).length) return { ...result, state: 'plugin_empty' }
  }
  return complete(`${token}\n${manifest.text}`)
}

function normalizeEmail(value: string): string { return value.trim().normalize('NFC').toLowerCase() }
async function bucketFor(options: { configDir: string; accountInfo?: AccountInfo }): Promise<string> {
  const state = await readJson(claudeNativeConfigFile(options.configDir))
  const identity = state?.value.oauthAccount
  if (!object(identity) || typeof identity.accountUuid !== 'string' || !UUID.test(identity.accountUuid)
    || typeof identity.organizationUuid !== 'string' || !UUID.test(identity.organizationUuid)
    || typeof identity.emailAddress !== 'string'
    || options.accountInfo && (!options.accountInfo.email || normalizeEmail(identity.emailAddress) !== normalizeEmail(options.accountInfo.email))) {
    throw Object.assign(new Error('Claude 首次同步缺少与认证结果一致的原生账号/组织身份；不能确认同步桶'), { code: 'CLAUDE_SYNC_IDENTITY_MISSING' })
  }
  return `${identity.organizationUuid}_${identity.accountUuid}`
}

/** Snapshot already completed buckets before the native process starts. Native
 * may reuse its successful round without touching the marker's mtime. An exact
 * authenticated bucket/proof match is required before accepting that baseline. */
export async function captureClaudeSyncWarmup(options: Pick<ClaudeSyncWarmupOptions, 'configDir' | 'sharedConfigDir' | 'settings'>): Promise<ClaudeSyncWarmupSnapshot | undefined> {
  let bucket: string
  try { bucket = await bucketFor(options) }
  catch (error: any) { if (error.code === 'CLAUDE_SYNC_IDENTITY_MISSING') return undefined; throw error }
  const settings = (await readJson(join(options.sharedConfigDir, 'settings.json'), true))?.value ?? {}
  const disabled = (key: keyof SyncSettings) => (options.settings?.[key] ?? settings[key]) === false
  const [skills, plugins] = await Promise.all([
    lane(options.sharedConfigDir, bucket, 'skills', disabled('syncClaudeAiSkills'), 0),
    lane(options.sharedConfigDir, bucket, 'plugins', disabled('syncClaudeAiPlugins'), 0),
  ])
  return { bucket, skills, plugins }
}

function details(snapshot?: ClaudeSyncWarmupSnapshot): string {
  if (!snapshot) return '同步状态 MISS'
  const summary = (row: LaneSnapshot) => `${row.state}，条目 ${row.count}，待处理 ${row.pending}，回收站 ${row.trash.length}`
  return `桶 ${snapshot.bucket}；skills ${summary(snapshot.skills)}；plugins ${summary(snapshot.plugins)}`
}

/** Keep the caller's authenticated control process alive until native completion
 * evidence and files remain consistent across two polls. No user turn is sent.
 * These native filesystem markers are deliberately fail-closed: unknown layouts,
 * server-side gates without explicit local disable, and partial syncs time out. */
export async function waitForClaudeSyncWarmup(options: ClaudeSyncWarmupOptions): Promise<ClaudeSyncWarmupSnapshot> {
  const now = options.now ?? (() => performance.now())
  const started = now()
  const timeout = options.timeoutMs ?? 120_000
  const interval = options.intervalMs ?? 5_000
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('Claude 同步等待时间必须为正数')
  const bucket = await bucketFor(options)
  const baseline = options.baseline?.bucket === bucket ? options.baseline : undefined
  let previous: string | undefined
  let stableSince = started
  let snapshot: ClaudeSyncWarmupSnapshot | undefined
  while (true) {
    options.signal?.throwIfAborted()
    if (!options.isAlive()) throw Object.assign(new Error(`Claude 首次同步进程已退出；${details(snapshot)}`), { code: 'CLAUDE_SYNC_PROCESS_EXITED' })
    const settings = (await readJson(join(options.sharedConfigDir, 'settings.json'), true))?.value ?? {}
    const disabled = (key: keyof SyncSettings) => (options.settings?.[key] ?? settings[key]) === false
    const [skills, plugins] = await Promise.all([
      lane(options.sharedConfigDir, bucket, 'skills', disabled('syncClaudeAiSkills'), options.startedAt, baseline?.skills),
      lane(options.sharedConfigDir, bucket, 'plugins', disabled('syncClaudeAiPlugins'), options.startedAt, baseline?.plugins),
    ])
    snapshot = { bucket, skills, plugins }
    options.signal?.throwIfAborted()
    if (!options.isAlive()) throw Object.assign(new Error(`Claude 首次同步进程已退出；${details(snapshot)}`), { code: 'CLAUDE_SYNC_PROCESS_EXITED' })
    if (await bucketFor(options) !== bucket) throw Object.assign(new Error('Claude 首次同步期间原生账号/组织身份发生变化'), { code: 'CLAUDE_SYNC_IDENTITY_CHANGED' })
    const fingerprint = JSON.stringify(snapshot)
    if (skills.proof !== undefined && plugins.proof !== undefined && fingerprint === previous && now() - stableSince >= interval) return snapshot
    if (fingerprint !== previous) stableSince = now()
    previous = skills.proof !== undefined && plugins.proof !== undefined ? fingerprint : undefined
    const remaining = timeout - (now() - started)
    if (remaining <= 0) throw Object.assign(new Error(`Claude 首次同步未完成（${Math.round(timeout / 1000)}s 超时）；请稍后重试 hi 备注；${details(snapshot)}`), { code: 'CLAUDE_SYNC_TIMEOUT' })
    const delay = Math.min(interval, remaining)
    if (options.sleep) await options.sleep(delay)
    else await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(options.signal?.reason) }
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolve() }, delay)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
  }
}
