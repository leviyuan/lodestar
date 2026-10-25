import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AgentProcess } from './agent-process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CLAUDE_ACCOUNTS_DIR, CLAUDE_ACCOUNTS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { syncClaudeAccountConfig } from './claude-account-config'
import { claudeNativeConfigFile, syncClaudeAccountConfigState } from './claude-account-config-state'

export const DEFAULT_CLAUDE_ACCOUNT = 'default'
export const CLAUDE_SHARED_DIRS = ['projects', 'tasks', 'file-history', 'plans'] as const
type SharedDir = typeof CLAUDE_SHARED_DIRS[number]
type Env = Record<string, string | undefined>
export interface ClaudeAccount {
  id: string
  name: string
  /** Keep the native spelling: unset and explicit ~/.claude have different Keychain namespaces. */
  configDir?: string
  state: 'candidate' | 'authenticating' | 'syncing' | 'sync_failed' | 'enrolling' | 'ready'
  generation: number
  /** SHA-256 of native email + organization; no credentials or raw email are stored. */
  identity?: string
  /** Private recovery diagnostics; never emitted to ordinary logs. */
  syncFailure?: { message: string; attempts: number; retryAt: number }
}
interface StoredAccount extends ClaudeAccount {
  configDir: string
  state: Exclude<ClaudeAccount['state'], 'candidate'>
  directoryKey: string
  linked: SharedDir[]
}
interface AccountState {
  version: 1
  native?: { namespace: string; generation: number; identity?: string }
  sharedConfigDir?: string
  accounts: StoredAccount[]
}
export interface ClaudeAccountsOptions {
  home?: string
  accountsDir?: string
  stateFile?: string
  env?: Env
}

// The daemon is the only registry writer. No persistent lock survives a crashed owner.
const enrollmentQueues = new Map<string, Promise<unknown>>()
const initializingDirectories = new Set<string>()
const directoryUses = new Map<string, Set<symbol>>()

function stat(path: string) {
  try { return lstatSync(path) } catch (error: any) { if (error.code !== 'ENOENT') throw error; return null }
}
/** Resolve existing ancestors without creating a missing native directory. */
function canonical(path: string): string {
  const absolute = resolve(path)
  if (stat(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute))
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a) }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function nativeConfigDirectory(value: string | undefined): string | undefined {
  if (value !== undefined && (!value || !isAbsolute(value))) {
    throw new Error('CLAUDE_CONFIG_DIR 必须为非空绝对路径；未设置时才使用原生默认目录')
  }
  return value
}
function clone(account: ClaudeAccount): ClaudeAccount {
  return { id: account.id, name: account.name, ...(account.configDir !== undefined ? { configDir: account.configDir } : {}),
    state: account.state, generation: account.generation, ...(account.identity ? { identity: account.identity } : {}),
    ...(account.syncFailure ? { syncFailure: { ...account.syncFailure } } : {}) }
}
/** The callback owns authentication, first sync and confirmed native exit. Call
 * syncing immediately after authentication, while that same process is alive. */
type AuthenticateClaudeAccount = (candidate: ClaudeAccount, syncing: (info: AccountInfo) => void) => Promise<AccountInfo>
function nameKey(name: string): string { return name.normalize('NFC').toLowerCase() }
function defaultName(name: string): boolean { return !name.trim() || ['default', '默认'].includes(nameKey(name.trim())) }
function accountName(name: string): string {
  if (!name || name !== name.trim() || name.length > 80 || /[\x00-\x1f\x7f/\\<>:"|?*]/.test(name)
    || ['.', '..', 'default', '默认'].includes(nameKey(name)) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Claude 备注名须为 1–80 个字符，不能包含路径分隔符、控制字符或系统保留名称')
  }
  return name.normalize('NFC')
}
function accountId(name: string): string { return `claude-${digest(nameKey(name)).slice(0, 32)}` }
function authError(message: string): Error {
  return Object.assign(new Error(message), { code: 'CLAUDE_SUBSCRIPTION_AUTH_MISSING' })
}
function nativeIdentity(info: AccountInfo): string {
  if (!info.subscriptionType?.trim() || info.apiProvider !== 'firstParty'
    || (info.apiKeySource && info.apiKeySource !== 'none')) {
    throw authError('Claude 账号未通过原生第一方订阅认证；请先在该账号目录完成 claude auth login')
  }
  if (!info.email?.trim()) throw authError('Claude 原生认证未返回稳定账号身份，不能收录或复用该账号的额度缓存')
  return digest(JSON.stringify([info.email.trim().normalize('NFC').toLowerCase(), info.organization?.trim().normalize('NFC') ?? '']))
}

/** Registry metadata only. No credential reading, login, account-directory scan, or import-time writes. */
export class ClaudeAccounts {
  readonly home: string
  readonly root: string
  readonly stateFile: string
  private nativeConfigDir: string | undefined
  private readonly authenticationCandidates = new WeakMap<ClaudeAccount, { directory: string; leases: Set<symbol> }>()

  constructor(options: ClaudeAccountsOptions = {}) {
    this.home = options.home ?? homedir()
    this.root = options.accountsDir ?? (options.home ? join(options.home, '.claude-accounts') : CLAUDE_ACCOUNTS_DIR)
    this.stateFile = options.stateFile ?? CLAUDE_ACCOUNTS_FILE
    this.nativeConfigDir = nativeConfigDirectory((options.env ?? process.env).CLAUDE_CONFIG_DIR)
  }
  /** Bootstrap from the same process + [claude.env] merge as native launch, without importing config here. */
  configureNativeEnv(env: Env): void { this.nativeConfigDir = nativeConfigDirectory(env.CLAUDE_CONFIG_DIR) }
  private namespace(): string { return JSON.stringify([this.nativeConfigDir ?? null]) }
  sharedConfigDir(): string { return resolve(this.nativeConfigDir || join(this.home, '.claude')) }
  private shareConfig(account: ClaudeAccount, excludeHistory = true, syncMcp = false): void {
    const shared = this.sharedConfigDir()
    if (syncMcp) {
      const nativeState = claudeNativeConfigFile(shared, join(this.nativeConfigDir || this.home, '.claude.json'))
      syncClaudeAccountConfigState(account.configDir!, shared, nativeState)
    }
    syncClaudeAccountConfig(account.configDir!, shared, excludeHistory ? CLAUDE_SHARED_DIRS : [])
  }

  private read(): AccountState {
    const file = stat(this.stateFile)
    if (!file) return { version: 1, accounts: [] }
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('Claude 账号记录必须为独立文件')
    const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as AccountState
    const validIdentity = (id: unknown) => id === undefined || typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
    const generation = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
    if (!state || state.version !== 1 || !Array.isArray(state.accounts)
      || state.sharedConfigDir !== undefined && (typeof state.sharedConfigDir !== 'string' || !isAbsolute(state.sharedConfigDir))
      || state.native && (typeof state.native.namespace !== 'string' || !generation(state.native.generation) || !validIdentity(state.native.identity))) {
      throw new Error('Claude 账号记录格式无效')
    }
    const ids = new Set<string>(), names = new Set<string>(), identities = new Set<string>()
    if (state.native?.namespace === this.namespace() && state.native.identity) identities.add(state.native.identity)
    for (const row of state.accounts) {
      if (!row || typeof row.name !== 'string') throw new Error('Claude 账号记录缺少备注名')
      accountName(row.name)
      if (row.id !== accountId(row.name) || ids.has(row.id) || names.has(nameKey(row.name))
        || row.configDir !== join(this.root, row.name) || typeof row.directoryKey !== 'string' || !isAbsolute(row.directoryKey)
        || !['authenticating', 'syncing', 'sync_failed', 'enrolling', 'ready'].includes(row.state) || !generation(row.generation) || !validIdentity(row.identity)
        || row.syncFailure !== undefined && (!row.syncFailure || typeof row.syncFailure.message !== 'string'
          || !Number.isSafeInteger(row.syncFailure.attempts) || row.syncFailure.attempts < 1
          || !Number.isSafeInteger(row.syncFailure.retryAt) || row.syncFailure.retryAt < 0)
        || !Array.isArray(row.linked) || row.linked.some(key => !CLAUDE_SHARED_DIRS.includes(key))
        || new Set(row.linked).size !== row.linked.length
        || row.identity && identities.has(row.identity)) throw new Error('Claude 账号记录重复或无效')
      if (row.state === 'ready' && CLAUDE_SHARED_DIRS.some(key => !row.linked.includes(key))) throw new Error('Claude ready 账号缺少共享目录完成记录')
      if (row.identity) identities.add(row.identity)
      ids.add(row.id); names.add(nameKey(row.name))
    }
    return state
  }
  private native(state: AccountState): ClaudeAccount {
    const old = state.native
    const sameNamespace = old?.namespace === this.namespace()
    return { id: DEFAULT_CLAUDE_ACCOUNT, name: '默认', ...(this.nativeConfigDir !== undefined ? { configDir: this.nativeConfigDir } : {}),
      state: 'ready', generation: sameNamespace ? old!.generation : old ? old.generation + 1 : 0,
      ...(sameNamespace && old?.identity ? { identity: old.identity } : {}) }
  }
  private revisionOf(account: ClaudeAccount): string {
    return JSON.stringify([account.id, account.configDir ?? null, account.generation, account.identity ?? null, account.state])
  }
  list(): ClaudeAccount[] {
    const state = this.read()
    return [this.native(state), ...state.accounts.filter(row => row.state === 'ready').map(clone)]
  }
  get(id: string): ClaudeAccount {
    const state = this.read()
    if (id === DEFAULT_CLAUDE_ACCOUNT) return this.native(state)
    const row = state.accounts.find(row => row.id === id)
    if (!row) throw new Error(`Claude 账号不存在：${id}`)
    return clone(row)
  }
  find(name = ''): ClaudeAccount {
    if (defaultName(name)) return this.get(DEFAULT_CLAUDE_ACCOUNT)
    const key = nameKey(accountName(name))
    const row = this.read().accounts.find(row => nameKey(row.name) === key)
    if (!row) throw new Error(`Claude 账号尚未收录：${name}；发送 hi ${name} 校验并收录`)
    return clone(row)
  }
  candidate(name: string): ClaudeAccount {
    if (defaultName(name)) return this.get(DEFAULT_CLAUDE_ACCOUNT)
    const normalized = accountName(name)
    const state = this.read()
    const old = state.accounts.find(row => nameKey(row.name) === nameKey(normalized))
    const candidate: ClaudeAccount = old ? clone(old)
      : { id: accountId(normalized), name: normalized, configDir: join(this.root, normalized), state: 'candidate', generation: 0 }
    this.inspect(candidate, state, old)
    return candidate
  }
  revision(id: string): string { return this.revisionOf(this.get(id)) }
  assertReady(id: string): ClaudeAccount {
    const account = this.get(id)
    if (account.state === 'syncing') throw new Error(`Claude 账号 ${account.name} 已登录，正在完成首次同步；请稍后重试`)
    if (account.state === 'sync_failed') throw new Error(`Claude 账号 ${account.name} 首次同步未完成：${account.syncFailure?.message ?? 'MISS'}；请稍后重试 hi ${account.name}`)
    if (account.state !== 'ready') throw new Error(`Claude 账号 ${account.name} 尚未完成收录，请显式发送 hi ${account.name} 重试`)
    return account
  }

  /** Prepare shared non-login config even for the first native terminal login.
   * Directory creation does not authenticate or enroll the account. */
  nativeCliEnv(name: string, base: Env): Env {
    if (defaultName(name)) return this.env(DEFAULT_CLAUDE_ACCOUNT, base)
    const normalized = accountName(name)
    const old = this.read().accounts.find(row => nameKey(row.name) === nameKey(normalized))
    const candidate: ClaudeAccount = old ? clone(old)
      : { id: accountId(normalized), name: normalized, configDir: join(this.root, normalized), state: 'candidate', generation: 0 }
    mkdirSync(candidate.configDir!, { recursive: true, mode: 0o700 })
    this.shareConfig(candidate, false, true)
    return this.candidateEnv(candidate, base)
  }

  candidateEnv(candidate: ClaudeAccount, base: Env): Env {
    const env = { ...base }
    if (candidate.id === DEFAULT_CLAUDE_ACCOUNT) {
      if (this.nativeConfigDir === undefined) delete env.CLAUDE_CONFIG_DIR
      else env.CLAUDE_CONFIG_DIR = this.nativeConfigDir
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = this.nativeConfigDir ?? ''
    } else {
      if (candidate.id !== accountId(accountName(candidate.name)) || candidate.configDir !== join(this.root, candidate.name)) {
        throw new Error('Claude 候选账号目录与备注不匹配')
      }
      env.CLAUDE_CONFIG_DIR = candidate.configDir
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = candidate.configDir
    }
    return env
  }
  env(id: string, base: Env): Env {
    // Native launches must not create or read a default credential directory here.
    if (id === DEFAULT_CLAUDE_ACCOUNT) return this.candidateEnv({ id, name: '默认', state: 'ready', generation: 0 }, base)
    const account = this.assertReady(id)
    this.validateShared(id)
    return this.candidateEnv(account, base)
  }

  private inspect(candidate: ClaudeAccount, state: AccountState, stored?: StoredAccount): { directory: string; shared: string } {
    const path = candidate.configDir!
    const directoryStat = stat(path)
    if (!directoryStat) throw new Error(`Claude 账号目录不存在：${path}；请先在该目录完成原生登录`)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Claude 额外账号目录必须为独立目录，不能是软链接')
    const directory = canonical(path), shared = canonical(this.sharedConfigDir())
    if (overlaps(directory, shared)) throw new Error('Claude 额外账号目录与默认共享目录相同或存在祖先重叠，拒绝收录')
    if (contains(directory, canonical(this.stateFile))) throw new Error('Claude 账号状态文件不能放在额外账号目录内部')
    if (stored && stored.directoryKey !== directory) throw new Error('Claude 账号目录实际位置已变化，拒绝复用旧账号记录')
    if (state.sharedConfigDir && state.sharedConfigDir !== shared) throw new Error('Claude 默认共享目录已变化，不能把已收录历史自动改指向其他目录')
    const credentials = stat(join(path, '.credentials.json'))
    if (credentials && (credentials.isSymbolicLink() || !credentials.isFile())) throw new Error('Claude 额外账号凭据必须为独立文件，不能复用其他目录的凭据链接')
    const inspectSharedDir = (key: SharedDir) => {
      const target = join(shared, key)
      let targetStat = stat(target)
      if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) throw new Error(`Claude 默认共享目录不是独立目录：${key}`)
      const source = join(path, key), sourceStat = stat(source)
      if (!sourceStat) {
        const linked = stored?.state === 'ready' || !!stored?.linked.includes(key)
        return { key, source, target, missingLink: linked, missingTarget: linked && !targetStat }
      }
      if (sourceStat.isSymbolicLink()) {
        let linked: string
        try { linked = realpathSync(source) } catch (error: any) {
          // Native cleanup can remove the shared target while retaining the
          // account link. Resolve its spelling through existing ancestors so
          // only the expected directory can be recreated, never another path.
          if (error.code !== 'ENOENT') throw new Error(`Claude 共享链接已损坏：${key}（${error.message}）`)
          targetStat = stat(target)
          if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) throw new Error(`Claude 默认共享目录不是独立目录：${key}`)
          linked = canonical(resolve(dirname(source), readlinkSync(source)))
        }
        if (linked !== target) throw new Error(`Claude 共享链接指向其他位置：${key}`)
      } else if (!sourceStat.isDirectory() || stored?.state === 'ready' || stored?.linked.includes(key)) {
        throw new Error(`Claude 共享目录已被替换，拒绝清理：${key}`)
      }
      return { key, source, target, missingLink: false, missingTarget: sourceStat.isSymbolicLink() && !targetStat }
    }
    // Check every entry before repairing anything. Repairs only add missing
    // directories/links; existing history and account identity stay untouched.
    for (let attempt = 0; ; attempt++) {
      const repairs = CLAUDE_SHARED_DIRS.map(inspectSharedDir).filter(item => item.missingLink || item.missingTarget)
      if (!repairs.length) break
      if (attempt === 3) throw new Error(`Claude 共享目录修复后再次缺失：${repairs.map(item => item.key).join('、')}`)
      for (const { key } of repairs) {
        const { source, target, missingLink, missingTarget } = inspectSharedDir(key)
        if (missingTarget) mkdirSync(target, { recursive: true, mode: 0o700 })
        if (missingLink) {
          try { symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir') }
          catch (error: any) { if (error.code !== 'EEXIST') throw error }
        }
      }
    }
    return { directory, shared }
  }
  /** Environment resolution and use leases repair cleaned directories, but never sync MCP. */
  private validateShared(id: string): StoredAccount | undefined {
    if (id === DEFAULT_CLAUDE_ACCOUNT) return undefined
    const state = this.read(), row = state.accounts.find(row => row.id === id)
    if (!row || row.state !== 'ready') throw new Error('Claude 账号尚未完成收录，请显式发送 hi 备注重试')
    this.inspect(row, state, row)
    if (initializingDirectories.has(row.directoryKey)) throw new Error(`Claude 账号 ${row.name} 正在校验收录，请稍后重试`)
    return row
  }

  /** Called once before an actual account launch, never by background probes. */
  prepareShared(id: string): void {
    const row = this.validateShared(id)
    if (row) this.shareConfig(row, true, true)
  }

  acquireUse(id: string): () => void {
    this.validateShared(id)
    const key = canonical(id === DEFAULT_CLAUDE_ACCOUNT ? this.sharedConfigDir() : this.get(id).configDir!)
    if (initializingDirectories.has(key)) throw new Error('Claude 账号正在收录，不能同时启动任务或额度查询')
    return this.useDirectory(key)
  }
  /** Only the active enrollment callback may retain its native auth process until confirmed exit. */
  acquireCandidateUse(candidate: ClaudeAccount): () => void {
    const key = canonical(candidate.id === DEFAULT_CLAUDE_ACCOUNT ? this.sharedConfigDir() : candidate.configDir ?? '')
    this.candidateEnv(candidate, {}) // Validate exact candidate path/name before granting the exception.
    const owner = this.authenticationCandidates.get(candidate)
    if (!owner || owner.directory !== key || !initializingDirectories.has(key)) {
      throw new Error('Claude 候选认证租约只能在该账号正在执行的收录回调中取得')
    }
    const lease = Symbol(candidate.id), release = this.useDirectory(key)
    owner.leases.add(lease)
    return () => { release(); owner.leases.delete(lease) }
  }
  private useDirectory(key: string): () => void {
    const lease = Symbol(key), uses = directoryUses.get(key) ?? new Set<symbol>()
    uses.add(lease); directoryUses.set(key, uses)
    return () => { uses.delete(lease); if (!uses.size && directoryUses.get(key) === uses) directoryUses.delete(key) }
  }

  /** Optional expected revision fences late native probes from an older identity generation. */
  observeIdentity(id: string, info: AccountInfo, expectedRevision?: string): string {
    const state = this.read()
    const row = id === DEFAULT_CLAUDE_ACCOUNT ? this.native(state) : state.accounts.find(row => row.id === id)
    if (!row) throw new Error('Claude 账号身份查询完成时记录已不存在')
    if (row.state !== 'ready') throw new Error('Claude 账号尚未完成收录，不能发布普通身份查询结果')
    if (expectedRevision !== undefined && this.revisionOf(row) !== expectedRevision) {
      throw Object.assign(new Error('Claude 账号身份已更新，忽略旧代次查询结果'), { code: 'CLAUDE_ACCOUNT_REVISION_CHANGED' })
    }
    const identity = nativeIdentity(info)
    const duplicate = this.duplicate(state, id, identity)
    if (duplicate) {
      // Invalidate a previous successful identity before reporting the conflict.
      if (row.identity) {
        delete row.identity; row.generation++
        if (id === DEFAULT_CLAUDE_ACCOUNT) state.native = { namespace: this.namespace(), generation: row.generation }
        writeJsonStateAtomic(this.stateFile, state)
      }
      throw authError(`Claude 账号与已收录账号「${duplicate}」是同一订阅身份，不能重复使用`)
    }
    if (row.identity !== identity) {
      row.identity = identity; row.generation++
      if (id === DEFAULT_CLAUDE_ACCOUNT) state.native = { namespace: this.namespace(), generation: row.generation, identity }
      writeJsonStateAtomic(this.stateFile, state)
    }
    return this.revisionOf(row)
  }
  private duplicate(state: AccountState, id: string, identity: string): string | undefined {
    if (id !== DEFAULT_CLAUDE_ACCOUNT && this.native(state).identity === identity) return '默认'
    return state.accounts.find(row => row.id !== id && row.identity === identity)?.name
  }

  enroll(name: string, authenticate: AuthenticateClaudeAccount): Promise<ClaudeAccount> {
    const queueKey = canonical(this.stateFile)
    const before = enrollmentQueues.get(queueKey) ?? Promise.resolve()
    const task = before.catch(() => {}).then(() => this.enrollExclusive(name, authenticate))
    enrollmentQueues.set(queueKey, task)
    void task.then(() => { if (enrollmentQueues.get(queueKey) === task) enrollmentQueues.delete(queueKey) },
      () => { if (enrollmentQueues.get(queueKey) === task) enrollmentQueues.delete(queueKey) })
    return task
  }
  private async authenticateCandidate(candidate: ClaudeAccount, authenticate: AuthenticateClaudeAccount): Promise<AccountInfo> {
    const owner = { directory: canonical(candidate.id === DEFAULT_CLAUDE_ACCOUNT ? this.sharedConfigDir() : candidate.configDir!), leases: new Set<symbol>() }
    this.authenticationCandidates.set(candidate, owner)
    try {
      const info = await authenticate(candidate, info => {
        const identity = nativeIdentity(info)
        if (candidate.id === DEFAULT_CLAUDE_ACCOUNT) return
        const state = this.read(), row = state.accounts.find(row => row.id === candidate.id)
        if (!row || row.state === 'ready') throw new Error('Claude 首次同步状态与当前收录不匹配')
        this.inspect(candidate, state, row)
        const duplicate = this.duplicate(state, candidate.id, identity)
        if (duplicate) throw authError(`Claude 账号与已收录账号「${duplicate}」是同一订阅身份，未清理该目录的历史`)
        if (row.identity !== identity) { row.identity = identity; row.generation++ }
        row.state = 'syncing'
        writeJsonStateAtomic(this.stateFile, state)
      })
      if (owner.leases.size) throw new Error('Claude 原生认证连接退出尚未确认，保留账号占用且不清理历史')
      return info
    } finally { this.authenticationCandidates.delete(candidate) }
  }
  private async enrollExclusive(name: string, authenticate: AuthenticateClaudeAccount): Promise<ClaudeAccount> {
    const candidate = this.candidate(name)
    if (candidate.id === DEFAULT_CLAUDE_ACCOUNT) {
      const key = canonical(this.sharedConfigDir())
      if (initializingDirectories.has(key)) throw new Error('Claude 默认账号正在收录校验')
      initializingDirectories.add(key)
      try {
        const revision = this.revision(DEFAULT_CLAUDE_ACCOUNT)
        const info = await this.authenticateCandidate(candidate, authenticate)
        // Existing normal default processes need no migration; only this callback's auth lease must close.
        this.observeIdentity(DEFAULT_CLAUDE_ACCOUNT, info, revision)
        return this.get(DEFAULT_CLAUDE_ACCOUNT)
      } finally { initializingDirectories.delete(key) }
    }
    const key = canonical(candidate.configDir!)
    if (directoryUses.get(key)?.size || initializingDirectories.has(key)) throw new Error(`Claude 账号 ${candidate.name} 正在使用或收录，结束任务和查询后再试`)
    if (candidate.syncFailure && candidate.syncFailure.retryAt > Date.now()) {
      throw new Error(`Claude 账号 ${candidate.name} 首次同步未完成；请在 ${Math.ceil((candidate.syncFailure.retryAt - Date.now()) / 1000)} 秒后重试 hi ${candidate.name}。${candidate.syncFailure.message}`)
    }
    initializingDirectories.add(key)
    try {
      if (candidate.state !== 'ready') {
        const state = this.read(), old = state.accounts.find(row => row.id === candidate.id)
        const { directory, shared } = this.inspect(candidate, state, old)
        const row: StoredAccount = old ?? { ...candidate, configDir: candidate.configDir!, state: 'authenticating', directoryKey: directory, linked: [] }
        row.state = 'authenticating'
        if (!old) state.accounts.push(row)
        state.sharedConfigDir = shared
        writeJsonStateAtomic(this.stateFile, state)
        // Share before spawning: replacing a skills/plugins directory while the
        // native startup sync is writing it can itself interrupt the first round.
        // Login state and all legacy session histories are still untouched.
        this.shareConfig(candidate)
      }
      // Authentication retains one raw control connection through first sync;
      // its confirmed exit still precedes any legacy history migration.
      const info = await this.authenticateCandidate(clone(candidate), authenticate)
      if (directoryUses.get(key)?.size) throw new Error('Claude 原生认证连接退出尚未确认，保留账号占用且不清理历史')
      const identity = nativeIdentity(info)
      const state = this.read()
      const old = state.accounts.find(row => row.id === candidate.id)
      const { directory, shared } = this.inspect(candidate, state, old)
      if (directory !== key) throw new Error('Claude 认证期间账号目录已被替换，拒绝清理历史')
      if (old?.state === 'ready') {
        this.shareConfig(old)
        this.observeIdentity(old.id, info, this.revisionOf(candidate))
        return this.get(old.id)
      }
      const duplicate = this.duplicate(state, candidate.id, identity)
      if (duplicate) throw authError(`Claude 账号与已收录账号「${duplicate}」是同一订阅身份，未清理该目录的历史`)
      this.shareConfig(candidate)
      const row: StoredAccount = old ?? { ...candidate, configDir: candidate.configDir!, state: 'enrolling', directoryKey: directory, linked: [] }
      if (row.identity !== identity) { row.identity = identity; row.generation++ }
      row.state = 'enrolling'
      if (!old) state.accounts.push(row)
      state.sharedConfigDir = shared
      // Persist intent before any destructive operation. A new daemon retries this phase without stale locks.
      writeJsonStateAtomic(this.stateFile, state)
      mkdirSync(shared, { recursive: true, mode: 0o700 })
      for (const child of CLAUDE_SHARED_DIRS) mkdirSync(join(shared, child), { recursive: true, mode: 0o700 })
      for (const child of CLAUDE_SHARED_DIRS) {
        this.inspect(row, state, row)
        const path = join(row.configDir, child), current = stat(path)
        if (!current?.isSymbolicLink()) {
          if (current) rmSync(path, { recursive: true })
          symlinkSync(join(shared, child), path, process.platform === 'win32' ? 'junction' : 'dir')
        }
        if (!row.linked.includes(child)) row.linked.push(child)
        writeJsonStateAtomic(this.stateFile, state)
      }
      row.state = 'ready'
      delete row.syncFailure
      writeJsonStateAtomic(this.stateFile, state)
      return clone(row)
    } catch (error) {
      const state = this.read(), row = state.accounts.find(row => row.id === candidate.id)
      if (row?.state === 'syncing') {
        const attempts = (row.syncFailure?.attempts ?? 0) + 1
        row.state = 'sync_failed'
        row.syncFailure = { message: error instanceof Error ? error.message : String(error), attempts,
          retryAt: Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(attempts - 1, 3)) }
        writeJsonStateAtomic(this.stateFile, state)
      }
      throw error
    } finally { initializingDirectories.delete(key) }
  }
}

export const claudeAccounts = new ClaudeAccounts()
const processAccounts = new WeakMap<object, string>()
/** Mapping only; the process owner releases its separate use lease after native exit. */
export function bindProcessClaudeAccount(process: AgentProcess, id: string): void { processAccounts.set(process, id) }
export function processClaudeAccount(process?: AgentProcess | null): string | null {
  return process ? processAccounts.get(process) ?? null : null
}
