import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Native login records, their locks/backups and account/organization policy
// caches stay private. Everything else follows the global configuration.
export function isClaudeAccountPrivateEntry(name: string): boolean {
  return /^(?:\.credentials(?:[.-].*)?|\.oauth_refresh\.lock(?:\..*)?|\.claude(?:-[^/]*)?\.json(?:[.-].*)?|\.config\.json(?:[.-].*)?|\.session_ingress_token(?:\..*)?|hfi-auth\.json(?:\..*)?|remote-settings(?:[.-].*)?|policy-limits(?:[.-].*)?|mcp-needs-auth-cache\.json|backups)$/.test(name)
}

const GLOBAL_DIRECTORIES = ['skills', 'commands', 'agents', 'rules', 'plugins', 'hooks', 'workflows', 'output-styles',
  'agent-memory', 'themes', 'projects', 'tasks', 'file-history', 'plans', 'todos', 'sessions', 'teams',
  'cache', 'debug', 'logs', 'telemetry', 'session-env', 'shell-snapshots', 'paste-cache', 'image-cache',
  'uploads', 'dev-mods', 'feedback', 'feedback-bundles', 'statsig', 'usage-data', 'ide', 'jobs', 'daemon', 'worktrees']
const GLOBAL_FILES = ['CLAUDE.md', 'AGENTS.md', 'settings.json', 'keybindings.json', 'history.jsonl',
  'stats-cache.json', '.session-stats.json', '.last-cleanup', '.last-update-result.json']

function entry(path: string) {
  try { return lstatSync(path) }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
function linkedTo(path: string, target: string): boolean {
  if (!entry(path)?.isSymbolicLink()) return false
  if (resolve(dirname(path), readlinkSync(path)) === resolve(target)) return true
  try { return realpathSync(path) === realpathSync(target) }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
}

/** Global wins: discard named-account non-login entries and link the common
 * source. Enumerate both roots so new extension/state paths cannot be omitted.
 * History migration is fenced separately by ClaudeAccounts when requested. */
export function syncClaudeAccountConfig(accountDir: string, sharedDir: string, excluded: readonly string[] = []): void {
  try {
    const currentRoot = entry(accountDir)
    if (!currentRoot?.isDirectory() || currentRoot.isSymbolicLink()) throw new Error(`Claude 账号目录必须为独立目录：${accountDir}`)
    const account = realpathSync(accountDir)
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 })
    const shared = realpathSync(sharedDir)
    if (contains(account, shared) || contains(shared, account)) throw new Error('Claude 账号目录与全局配置目录重叠')
    const excludedNames = new Set(excluded)
    const names = new Set([...GLOBAL_DIRECTORIES, ...GLOBAL_FILES, ...readdirSync(shared), ...readdirSync(account)])
    // Validate sources before replacing any account entries. Missing global
    // files get dangling links, so a future global file is picked up directly.
    const plan = [...names].filter(name => !isClaudeAccountPrivateEntry(name) && !excludedNames.has(name)).map(name => {
      const source = join(shared, name), destination = join(account, name)
      const sourceEntry = entry(source)
      const sourceType = sourceEntry ? statSync(source) : null
      const isDirectory = sourceType?.isDirectory() ?? (GLOBAL_DIRECTORIES.includes(name) || !!entry(destination)?.isDirectory())
      if (sourceEntry?.isSymbolicLink()) {
        const target = realpathSync(source)
        if (contains(account, target) || sourceType?.isDirectory() && contains(target, account)) {
          throw new Error(`Claude 全局配置链接指向备注账号或其祖先，拒绝形成循环：${name}`)
        }
      }
      return { source, destination, sourceEntry, isDirectory }
    })
    for (const { source, destination, sourceEntry, isDirectory } of plan) {
      if (isDirectory && !sourceEntry) mkdirSync(source, { recursive: true, mode: 0o700 })
      if (linkedTo(destination, source)) continue
      if (entry(destination)) rmSync(destination, { recursive: true })
      try { symlinkSync(source, destination, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file') }
      catch (error: any) {
        if (error.code !== 'EEXIST' || !linkedTo(destination, source)) throw error
      }
    }
  } catch (error) {
    throw new Error(`Claude 全局配置共享失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
