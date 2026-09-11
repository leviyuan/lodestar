import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEX_ACCOUNTS_DIR, CODEX_ACCOUNTS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'

export const DEFAULT_CODEX_ACCOUNT = 'default'
type Env = Record<string, string | undefined>
export interface CodexAccount {
  id: string
  name: string
  email?: string | null
  planType?: string
  /** Changes only after explicit login, not when Codex refreshes its tokens. */
  revision?: string
}
interface AccountState {
  version: 1
  accounts: CodexAccount[]
  selections: Record<string, string>
}

const SHARED_DIRS = [
  'sessions', 'archived_sessions', 'skills', 'rules', 'prompts', 'plugins',
  'memories', 'generated_images', 'thread-writer-locks',
]
const SHARED_FILES = ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'hooks.json',
  'history.jsonl', 'session_index.jsonl', 'installation_id']

/** Credentials never enter this registry. Constructing/reading it does not alter native Codex state. */
export class CodexAccounts {
  constructor(
    readonly defaultHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    readonly root = CODEX_ACCOUNTS_DIR,
    readonly stateFile = CODEX_ACCOUNTS_FILE,
  ) {}

  private read(): AccountState {
    if (!existsSync(this.stateFile)) return { version: 1, accounts: [], selections: {} }
    const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as AccountState
    if (!state || state.version !== 1 || !Array.isArray(state.accounts) || !state.selections
      || typeof state.selections !== 'object' || Array.isArray(state.selections)) {
      throw new Error('Codex 账号记录格式无效')
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const account of state.accounts) {
      if (!account || !/^[a-f0-9-]{36}$/.test(account.id) || typeof account.name !== 'string'
        || ids.has(account.id) || names.has(this.nameKey(account.name))) throw new Error('Codex 账号记录重复或无效')
      this.validateName(account.name)
      ids.add(account.id)
      names.add(this.nameKey(account.name))
    }
    for (const id of Object.values(state.selections)) {
      if (id !== DEFAULT_CODEX_ACCOUNT && !ids.has(id)) throw new Error('Codex 账号选择指向不存在的账号')
    }
    return state
  }

  private nameKey(name: string): string { return name.normalize('NFC').trim().toLowerCase() }
  private validateName(name: string): void {
    if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f/\\]/.test(name)
      || ['default', '默认', '.', '..'].includes(this.nameKey(name))) {
      throw new Error('备注名须为 1–80 个字符，不能包含换行或路径分隔符；default/默认为保留名称')
    }
  }

  list(): CodexAccount[] {
    return [{ id: DEFAULT_CODEX_ACCOUNT, name: '默认' }, ...this.read().accounts.map(a => ({ ...a }))]
  }
  get(id: string): CodexAccount {
    const account = this.list().find(a => a.id === id)
    if (!account) throw new Error(`Codex 账号不存在：${id}`)
    return account
  }
  find(name = ''): CodexAccount {
    if (!name.trim() || ['default', '默认'].includes(this.nameKey(name))) return this.get(DEFAULT_CODEX_ACCOUNT)
    const account = this.list().find(a => this.nameKey(a.name) === this.nameKey(name))
    if (!account) throw new Error(`Codex 账号不存在：${name}；先发送 codex-login ${name}`)
    return account
  }
  ensure(name = ''): CodexAccount {
    if (!name.trim() || ['default', '默认'].includes(this.nameKey(name))) return this.get(DEFAULT_CODEX_ACCOUNT)
    this.validateName(name)
    const state = this.read()
    const existing = state.accounts.find(a => this.nameKey(a.name) === this.nameKey(name))
    if (existing) return { ...existing }
    const account = { id: randomUUID(), name: name.normalize('NFC').trim() }
    state.accounts.push(account)
    writeJsonStateAtomic(this.stateFile, state)
    return account
  }
  selected(sessionName: string): string {
    const selections = this.read().selections
    return Object.prototype.hasOwnProperty.call(selections, sessionName) ? selections[sessionName] : DEFAULT_CODEX_ACCOUNT
  }
  /** No explicit preference means automatic selection at process startup. */
  preferred(sessionName: string): string | null {
    const selections = this.read().selections
    return Object.prototype.hasOwnProperty.call(selections, sessionName) ? selections[sessionName] : null
  }
  selectAuto(sessionName: string): void {
    const state = this.read()
    delete state.selections[sessionName]
    writeJsonStateAtomic(this.stateFile, state)
  }
  select(sessionName: string, id: string): void {
    this.get(id)
    const state = this.read()
    Object.defineProperty(state.selections, sessionName, { value: id, enumerable: true, writable: true, configurable: true })
    writeJsonStateAtomic(this.stateFile, state)
  }
  recordLogin(id: string, account: { email?: string | null; planType?: string }): void {
    const state = this.read()
    if (id !== DEFAULT_CODEX_ACCOUNT) {
      const row = state.accounts.find(a => a.id === id)
      if (!row) throw new Error('登录完成时账号记录已不存在')
      Object.assign(row, { email: account.email, planType: account.planType, revision: randomUUID() })
      writeJsonStateAtomic(this.stateFile, state)
    }
  }
  home(id = DEFAULT_CODEX_ACCOUNT): string {
    return id === DEFAULT_CODEX_ACCOUNT ? this.defaultHome : join(this.root, this.get(id).id)
  }
  revision(id: string): string {
    const account = this.get(id)
    return JSON.stringify([this.home(id), account.revision ?? null])
  }

  /** Directory symlinks keep native thread history and locks together. Never link auth or model caches. */
  prepareHome(id: string): string {
    const home = this.home(id)
    if (id === DEFAULT_CODEX_ACCOUNT) return home
    let existingHome
    try { existingHome = lstatSync(home) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    if (existingHome?.isSymbolicLink()) throw new Error('额外账号目录不能是软链接')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(this.defaultHome, { recursive: true, mode: 0o700 })
    if (realpathSync(home) === realpathSync(this.defaultHome)) throw new Error('额外账号不能使用默认认证目录')
    let auth
    try { auth = lstatSync(join(home, 'auth.json')) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    if (auth?.isSymbolicLink() || (auth && !auth.isFile())) throw new Error('额外账号的 auth.json 必须为独立文件')
    // Ensure a single shared config even on a machine that has never created config.toml.
    try { writeFileSync(join(this.defaultHome, 'config.toml'), '', { flag: 'wx', mode: 0o600 }) }
    catch (error: any) { if (error.code !== 'EEXIST') throw error }
    for (const name of SHARED_DIRS) {
      const target = join(this.defaultHome, name)
      mkdirSync(target, { recursive: true, mode: 0o700 })
      this.link(target, join(home, name), true)
    }
    const files = new Set([...SHARED_FILES, ...readdirSync(this.defaultHome).filter(n => n.endsWith('.config.toml'))])
    for (const name of files) {
      const target = join(this.defaultHome, name)
      if (existsSync(target)) this.link(target, join(home, name), false)
    }
    return home
  }
  private link(target: string, path: string, directory: boolean): void {
    let stat
    try { stat = lstatSync(path) }
    catch (e: any) { if (e.code !== 'ENOENT') throw e }
    if (stat) {
      if (!stat.isSymbolicLink() || realpathSync(path) !== realpathSync(target)) {
        throw new Error(`Codex 共享路径已被替换或指向其他位置：${path}`)
      }
      return
    }
    symlinkSync(target, path, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file')
  }

  env(id: string, base: Env, prepare = true, login = false): Env {
    if (!login && isCodexLoginPending(id)) throw new Error('该 Codex 账号正在登录，请等待授权完成')
    const home = prepare ? this.prepareHome(id) : this.home(id)
    const env: Env = { ...base, CODEX_HOME: home }
    if (id !== DEFAULT_CODEX_ACCOUNT) {
      // Native config.sqlite_home, when present, remains authoritative. Otherwise use the same DB directory.
      env.CODEX_SQLITE_HOME = base.CODEX_SQLITE_HOME || this.defaultHome
      for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN',
        'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) delete env[key]
    }
    return env
  }
  cliArgs(id: string): string[] {
    this.get(id)
    return id === DEFAULT_CODEX_ACCOUNT ? [] : ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"']
  }

  /** Hash only stable account/workspace identity; never return the token bundle or token-derived secrets. */
  fingerprint(id: string): string | null {
    const file = join(this.home(id), 'auth.json')
    if (!existsSync(file)) return null // Native keyring credentials have no file identity.
    const auth = JSON.parse(readFileSync(file, 'utf8'))
    const tokens = auth?.tokens
    if (!tokens?.account_id || typeof tokens.id_token !== 'string') return null
    const part = tokens.id_token.split('.')[1]
    if (!part) throw new Error('Codex 身份 Token 格式无效')
    const identity = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (typeof identity.sub !== 'string' || !identity.sub) return null
    return createHash('sha256').update(JSON.stringify([tokens.account_id, identity.sub])).digest('hex')
  }
}

export const codexAccounts = new CodexAccounts()
const processAccounts = new WeakMap<object, string>()
interface OwnedCodexProcess { isAlive(): boolean; once(event: 'exit', listener: () => void): unknown }
const ownedProcesses = new Map<OwnedCodexProcess, string>()
export function bindProcessCodexAccount(proc: OwnedCodexProcess, id: string, ownsNativeProcess = true): void {
  processAccounts.set(proc, id)
  if (!ownsNativeProcess) return
  if (!ownedProcesses.has(proc)) proc.once('exit', () => ownedProcesses.delete(proc))
  ownedProcesses.set(proc, id)
}
export function codexAccountInUse(id: string): boolean {
  return [...ownedProcesses].some(([proc, accountId]) => accountId === id && proc.isAlive())
}
const loginLeases = new Map<string, symbol>()
export function isCodexLoginPending(id: string): boolean { return loginLeases.has(id) }
export function reserveCodexLogin(id: string): () => void {
  if (loginLeases.has(id)) throw new Error('该账号已有登录任务')
  if (codexAccountInUse(id)) throw new Error('该 Codex 账号正在使用中')
  const lease = Symbol(id)
  loginLeases.set(id, lease)
  return () => { if (loginLeases.get(id) === lease) loginLeases.delete(id) }
}
export function processCodexAccount(proc: object | null | undefined): string {
  return proc ? processAccounts.get(proc) ?? DEFAULT_CODEX_ACCOUNT : DEFAULT_CODEX_ACCOUNT
}
