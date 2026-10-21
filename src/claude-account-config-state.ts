import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

type State = Record<string, unknown>

// Native performLogout clears these account-scoped bootstrap/entitlement caches.
// Never import them from the default login, even when the named account has none.
const ACCOUNT_FIELDS = new Set([
  'oauthAccount', 'primaryApiKey', 'customApiKeyResponses',
  'hasCompletedOnboarding', 'hasAvailableSubscription', 'lastOnboardingVersion', 'subscriptionNoticeCount',
  'userID', 'machineID', 'summonSidKey', 'remoteControlMachineId',
  'additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelCostsCache',
  'modelAccessCache', 'orgModelDefaultCache', 'cachedArtifactRoster', 'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache', 'clientDataCacheSlots', 'autoCompactWindowsCache', 'cachedUsageUtilization',
  'githubWebConnectionStatusCache', 'startupPrefetchedAt',
  'cachedDynamicConfigs', 'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt',
  'cachedExperimentFeatures', 'cachedExperimentData',
])

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

function readState(path: string): { value: State; text?: string; stat?: Stats } {
  const stat = inspect(path)
  if (!stat) return { value: {} }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`原生配置状态必须为独立文件：${path}`)
  const text = readFileSync(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error(`原生配置状态 JSON 无效：${path}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`原生配置状态必须为 JSON 对象：${path}`)
  return { value: value as State, text, stat }
}

interface HeldLock { path: string; stat: Stats; acquired: number }

// Claude's native filesystem writer uses proper-lockfile with an explicit
// `${configFile}.lock` directory, a 10s stale threshold and ~5s heartbeat.
// This synchronous transaction takes the same lock and finishes before 5s;
// it never steals even an apparently stale lock or falls back to an unlocked write.
// Native custom storage backends/unlocked fallback writers cannot be coordinated
// by a filesystem lock; compare the original bytes again immediately before commit.
function acquireLock(path: string): HeldLock {
  const lockPath = `${path}.lock`
  try { mkdirSync(lockPath, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`原生配置正在被写入，未覆盖：${path}`)
    throw error
  }
  return { path: lockPath, stat: lstatSync(lockPath), acquired: performance.now() }
}

function verifyLock(lock: HeldLock): void {
  const stat = inspect(lock.path)
  if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== lock.stat.dev || stat.ino !== lock.stat.ino) {
    throw new Error(`原生配置写锁已变化，拒绝覆盖：${lock.path}`)
  }
  if (performance.now() - lock.acquired >= 5_000) throw new Error(`原生配置共享持锁超时，拒绝覆盖：${lock.path}`)
}

/** Copy ordinary native state while leaving every account's login metadata independent.
 * The caller supplies the effective global JSON path (including its legacy priority).
 * Settings/Skills/etc. are shared separately; credentials are never read here. */
export function syncClaudeAccountConfigState(accountDir: string, sharedDir: string, nativeConfigFile: string): void {
  const locks: HeldLock[] = []
  let failure: unknown
  try {
    if (![accountDir, sharedDir, nativeConfigFile].every(isAbsolute)) throw new Error('Claude 配置路径必须为绝对路径')
    const account = inspect(accountDir)
    if (!account?.isDirectory() || account.isSymbolicLink()) throw new Error('Claude 账号根目录必须为独立目录，不能是软链接')
    const accountRoot = canonical(accountDir), sharedRoot = canonical(sharedDir)
    if (contains(accountRoot, sharedRoot) || contains(sharedRoot, accountRoot)) throw new Error('Claude 全局配置目录与账号目录重叠')
    if (contains(accountRoot, canonical(nativeConfigFile))) throw new Error('Claude 全局状态文件不能位于账号目录内')

    // Native prefers .config.json when it exists. Update any existing inactive
    // .claude.json too, preserving that file's own identity instead of copying it.
    const legacy = join(accountDir, '.config.json'), current = join(accountDir, '.claude.json')
    const paths = inspect(legacy) ? [legacy, ...(inspect(current) ? [current] : [])] : [current]
    const sourcePresent = inspect(nativeConfigFile) !== undefined
    const source = canonical(nativeConfigFile)
    if (sourcePresent && contains(accountRoot, source)) throw new Error('Claude 全局状态文件实际位于账号目录内')
    // Validate every destination before even placing a lock in a source directory.
    for (const path of paths) {
      const stat = inspect(path)
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`原生配置状态必须为独立文件：${path}`)
    }
    if (!sourcePresent && paths.every(path => !inspect(path))) return
    const lockFiles = new Map<string, string>()
    for (const path of [...paths, ...(sourcePresent ? [nativeConfigFile, source] : [])]) {
      lockFiles.set(canonical(`${path}.lock`), path)
    }
    for (const path of [...lockFiles.values()].sort()) locks.push(acquireLock(path))
    const global = sourcePresent ? readState(source) : { value: {} as State, text: undefined, stat: undefined }
    const ordinary = Object.fromEntries(Object.entries(global.value).filter(([key]) => !ACCOUNT_FIELDS.has(key)))
    const plans = paths.map(path => {
      const old = readState(path)
      if (old.stat && global.stat && old.stat.dev === global.stat.dev && old.stat.ino === global.stat.ino) {
        throw new Error(`账号原生状态与全局状态指向同一文件：${path}`)
      }
      const own = Object.fromEntries(Object.entries(old.value).filter(([key]) => ACCOUNT_FIELDS.has(key)))
      return { path, old, next: { ...ordinary, ...own } }
    })
    for (const plan of plans) {
      if (isDeepStrictEqual(plan.old.value, plan.next)) continue
      const temporary = join(accountDir, `${basename(plan.path)}.${process.pid}.${randomUUID()}.tmp`)
      let temporaryExists = false
      try {
        writeFileSync(temporary, `${JSON.stringify(plan.next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        temporaryExists = true
        for (const lock of locks) verifyLock(lock)
        if (canonical(nativeConfigFile) !== source || readState(source).text !== global.text) {
          throw new Error('全局原生配置在共享期间发生变化，拒绝覆盖')
        }
        const latest = readState(plan.path)
        if (latest.text !== plan.old.text || latest.stat?.ino !== plan.old.stat?.ino || latest.stat?.dev !== plan.old.stat?.dev) {
          throw new Error(`原生配置在共享期间发生变化，拒绝覆盖：${plan.path}`)
        }
        renameSync(temporary, plan.path)
        temporaryExists = false
      } finally { if (temporaryExists) unlinkSync(temporary) }
    }
  } catch (error) { failure = error }
  finally {
    for (const lock of locks.reverse()) {
      try {
        const stat = inspect(lock.path)
        if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== lock.stat.dev || stat.ino !== lock.stat.ino) {
          throw new Error(`原生配置写锁已被替换，未删除他人锁：${lock.path}`)
        }
        rmdirSync(lock.path)
      } catch (error) { failure = failure ? new AggregateError([failure, error], '配置状态共享与释放写锁均失败') : error }
    }
  }
  if (failure) throw new Error(`Claude 全局配置状态共享失败：${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure })
}
