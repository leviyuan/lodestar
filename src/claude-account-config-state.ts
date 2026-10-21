import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

type State = Record<string, unknown>
type Snapshot = { value: State; text?: string; stat?: Stats }
const PROJECT_MCP_FIELDS = ['mcpServers', 'enabledMcpServers', 'disabledMcpServers'] as const

/** Match native legacy selection; an empty legacy file must not hide current state. */
export function claudeNativeConfigFile(configDir: string, current = join(configDir, '.claude.json')): string {
  const legacy = join(configDir, '.config.json')
  try {
    const stat = statSync(legacy)
    if (stat.isFile() && (stat.size > 0 || (stat.mode & 0o222) !== 0 && !existsSync(current))) return legacy
  } catch { /* Native also ignores an unavailable optional legacy candidate. */ }
  return current
}

function inspect(path: string): Stats | undefined {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function canonical(path: string): string {
  if (inspect(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? resolve(path) : join(canonical(parent), basename(path))
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function object(value: unknown): value is State {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readState(path: string): Snapshot {
  const stat = inspect(path)
  if (!stat) return { value: {} }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`原生配置状态必须为独立文件：${path}`)
  const text = readFileSync(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error(`原生配置状态 JSON 无效：${path}`) }
  if (!object(value)) throw new Error(`原生配置状态必须为 JSON 对象：${path}`)
  return { value, text, stat }
}

function projects(state: State): State {
  if (!Object.hasOwn(state, 'projects')) return {}
  if (!object(state.projects)) throw new Error('原生配置 projects 必须为 JSON 对象')
  return state.projects
}

function mcpFields(project: unknown): State {
  if (!object(project)) return {}
  return Object.fromEntries(PROJECT_MCP_FIELDS.filter(key => Object.hasOwn(project, key)).map(key => [key, project[key]]))
}

function mcpConfig(state: State): State {
  const entries = Object.entries(projects(state)).map(([path, project]): [string, State] => [path, mcpFields(project)])
  return {
    ...(Object.hasOwn(state, 'mcpServers') ? { mcpServers: state.mcpServers } : {}),
    projects: Object.fromEntries(entries.filter(([, fields]) => Object.keys(fields).length)),
  }
}

/** Replace only currently used native MCP fields. Keep every other target field,
 * including unknown future login state, preferences, trust and legacy MCP approvals.
 * Legacy approvals migrate to settings.local.json natively; never import them back. */
function mergeMcp(target: State, source: State): State {
  const next = { ...target }
  if (Object.hasOwn(source, 'mcpServers')) next.mcpServers = source.mcpServers
  else delete next.mcpServers
  const ownProjects = new Map(Object.entries(projects(target)))
  for (const path of Object.keys(mcpConfig(source).projects as State)) {
    if (!ownProjects.has(path)) ownProjects.set(path, {})
  }
  const sourceProjects = projects(source)
  for (const [path, old] of ownProjects) {
    const desired = mcpFields(Object.hasOwn(sourceProjects, path) ? sourceProjects[path] : undefined)
    if (!object(old)) {
      if (Object.keys(desired).length) throw new Error(`原生配置项目必须为 JSON 对象：${path}`)
      continue
    }
    const project = { ...old }
    for (const key of PROJECT_MCP_FIELDS) {
      if (Object.hasOwn(desired, key)) project[key] = desired[key]
      else delete project[key]
    }
    ownProjects.set(path, project)
  }
  if (Object.hasOwn(target, 'projects') || ownProjects.size) next.projects = Object.fromEntries(ownProjects)
  return next
}

function unchanged(before: Snapshot, after: Snapshot): boolean {
  return before.text === after.text && before.stat?.dev === after.stat?.dev && before.stat?.ino === after.stat?.ino
}

/** Startup-only synchronous MCP comparison. Equal MCP means zero writes, even
 * when native lock files exist. This code never creates, waits for or removes locks.
 * Byte/inode rechecks detect observed external writes; atomic rename prevents
 * partial JSON, but neither is a cross-process compare-and-swap guarantee. */
export function syncClaudeAccountConfigState(accountDir: string, sharedDir: string, nativeConfigFile: string): void {
  try {
    if (![accountDir, sharedDir, nativeConfigFile].every(isAbsolute)) throw new Error('Claude 配置路径必须为绝对路径')
    const account = inspect(accountDir)
    if (!account?.isDirectory() || account.isSymbolicLink()) throw new Error('Claude 账号根目录必须为独立目录，不能是软链接')
    const accountRoot = canonical(accountDir), sharedRoot = canonical(sharedDir)
    if (contains(accountRoot, sharedRoot) || contains(sharedRoot, accountRoot)) throw new Error('Claude 全局配置目录与账号目录重叠')
    if (contains(accountRoot, canonical(nativeConfigFile))) throw new Error('Claude 全局状态文件不能位于账号目录内')
    // Only the file native Claude will read is relevant. Leave inactive files alone.
    const target = claudeNativeConfigFile(accountDir)
    for (let attempt = 0; attempt < 3; attempt++) {
      const sourcePath = canonical(nativeConfigFile)
      if (contains(accountRoot, sourcePath)) throw new Error('Claude 全局状态文件实际位于账号目录内')
      const source = readState(sourcePath), old = readState(target)
      if (old.stat && source.stat && old.stat.dev === source.stat.dev && old.stat.ino === source.stat.ino) {
        throw new Error(`账号原生状态与全局状态指向同一文件：${target}`)
      }
      if (isDeepStrictEqual(mcpConfig(old.value), mcpConfig(source.value))) return
      const next = mergeMcp(old.value, source.value)
      const temporary = join(accountDir, `${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
      let temporaryExists = false
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        temporaryExists = true
        if (canonical(nativeConfigFile) !== sourcePath || !unchanged(source, readState(sourcePath))
          || !unchanged(old, readState(target))) continue
        renameSync(temporary, target)
        temporaryExists = false
        return
      } finally { if (temporaryExists) unlinkSync(temporary) }
    }
    throw new Error('原生配置在 MCP 同步期间持续变化，未覆盖；请重试启动')
  } catch (error) {
    throw new Error(`Claude MCP 配置同步失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
