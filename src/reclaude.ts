/** reclaude：经第三方启动器运行 Claude Code。定位命令、读取本机绑定状态。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const RECLAUDE_DIAGNOSTIC_PREFIX = 'reclaude:'
const STATUS_TIMEOUT_MS = 20_000

/** 一个组织在本机的绑定；Claude Code 的配置、登录态与会话记录都在它的目录下。 */
export interface ReclaudeBinding {
  orgId: string
  /** reclaude 以设备号命名绑定目录。 */
  deviceId: string
  configDir: string
}

export interface ReclaudeStatus {
  loginState: string
  /** reclaude 对登录状态的补充说明，例如在线检查超时。 */
  loginDetail?: string
  bindings: ReclaudeBinding[]
  /** `reclaude org use` 选定的默认绑定。 */
  current: ReclaudeBinding | null
}

type Lookup = { pathEnv?: string; homeDir?: string; platform?: NodeJS.Platform; exists?: (path: string) => boolean }

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** reclaude 靠系统命令读取系统代理（macOS 上在 /usr/sbin）；服务管理器给的 PATH 不一定含这些目录，
 * 缺了它的在线检查会超时。只追加缺少的系统目录，不改变已有顺序。 */
export function reclaudePath(path: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path ?? ''
  const entries = (path ?? '').split(delimiter).filter(Boolean)
  return [...entries, ...SYSTEM_PATH.filter(directory => !entries.includes(directory))].join(delimiter)
}

/** 显式配置的路径必须存在；未配置时在 PATH 和 reclaude 的默认安装目录中查找。 */
export function findReclaude(configured: string | undefined, lookup: Lookup = {}): string | null {
  const exists = lookup.exists ?? existsSync
  const bin = configured?.trim()
  if (bin) {
    const path = bin === '~' || bin.startsWith('~/') ? join(lookup.homeDir ?? homedir(), bin.slice(1)) : bin
    if (!exists(path)) throw new Error(`[token_source.reclaude].bin 指向的文件不存在: ${bin}`)
    return path
  }
  const platform = lookup.platform ?? process.platform
  const names = platform === 'win32' ? ['reclaude.exe', 'reclaude.cmd'] : ['reclaude']
  const directories = [...(lookup.pathEnv ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter),
    join(lookup.homeDir ?? homedir(), '.local', 'bin')].filter(Boolean)
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function binding(value: unknown, dataDir: string): ReclaudeBinding | null {
  if (!object(value)) return null
  const { org_id: orgId, device_id: deviceId } = value
  const valid = (id: unknown): id is number | string => Number.isSafeInteger(id) || typeof id === 'string' && /^[\w-]+$/.test(id)
  if (!valid(orgId) || !valid(deviceId)) return null
  return { orgId: String(orgId), deviceId: String(deviceId), configDir: join(dataDir, 'claude', 'accounts', String(deviceId), 'config') }
}

/** 解析 `reclaude status --check --json`；缺少所需字段时报错，不猜测目录。 */
export function parseReclaudeStatus(raw: unknown): ReclaudeStatus {
  const unknown = (field: string) => new Error(`reclaude status 输出缺少 ${field}，可能与当前 reclaude 版本不兼容`)
  if (!object(raw)) throw unknown('JSON 对象')
  const dataDir = object(raw.global) ? raw.global.data_dir : undefined
  if (typeof dataDir !== 'string' || !dataDir) throw unknown('global.data_dir')
  const claude = raw.claude
  if (!object(claude)) throw unknown('claude')
  const login = object(claude.login) ? claude.login : {}
  const loginState = login.state
  if (typeof loginState !== 'string') throw unknown('claude.login.state')
  const loginDetail = typeof login.detail === 'string' && login.detail.trim() ? login.detail.trim().slice(0, 200) : undefined
  if (!Array.isArray(claude.bindings)) throw unknown('claude.bindings')
  const bindings = claude.bindings.map(item => binding(item, dataDir)).filter((item): item is ReclaudeBinding => item !== null)
  const current = binding(claude.current, dataDir)
  return { loginState, ...(loginDetail ? { loginDetail } : {}), bindings,
    current: current && (bindings.find(item => item.deviceId === current.deviceId) ?? current) }
}

/** 默认跟随 reclaude 的当前组织；配置了 org 时固定使用该组织。 */
export function selectReclaudeBinding(status: ReclaudeStatus, org: string | undefined): ReclaudeBinding {
  // 在线检查没做成不等于登录失效：如实说明，等下一次刷新，不让用户去重新登录。
  if (status.loginState === 'unavailable') {
    throw new Error(`reclaude 暂时无法确认登录状态${status.loginDetail ? `（${status.loginDetail}）` : ''}；请检查本机网络与 reclaude 后台服务，稍后自动重试`)
  }
  if (status.loginState !== 'valid') throw new Error('reclaude 未登录或登录已失效；请在运行 Lodestar 的本机执行 reclaude login')
  if (org) {
    const selected = status.bindings.find(item => item.orgId === org)
    if (!selected) throw new Error(`reclaude 尚未绑定组织 ${org}；请在本机执行 reclaude org bind ${org}`)
    return selected
  }
  if (!status.current) throw new Error('reclaude 没有当前组织；请在本机执行 reclaude org use <组织 ID>')
  return status.current
}

/** 只读查询：`--check` 不下载也不修改本机安装。 */
export function readReclaudeStatus(
  bin: string, env: NodeJS.ProcessEnv = { ...process.env, PATH: reclaudePath(process.env.PATH) },
): Promise<ReclaudeStatus> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--check', '--json'], { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // 检查出问题时（如在线检查超时）reclaude 以非零退出，但仍输出完整状态：以状态内容为准。
        if (error && String(stdout).trim()) {
          try { resolve(parseReclaudeStatus(JSON.parse(String(stdout)))); return } catch {}
        }
        if (error) {
          // reclaude 自己的报错行可直接给用户；其余 stderr 不保留。
          const detail = String(stderr).split(/\r?\n/).map(line => line.trim())
            .filter(line => line.startsWith(RECLAUDE_DIAGNOSTIC_PREFIX)).slice(-2).join('；')
          const reason = detail || ((error as NodeJS.ErrnoException).code === 'ENOENT' ? '命令不存在'
            : error.killed ? `超时（${STATUS_TIMEOUT_MS / 1000}s）` : `退出码 ${(error as { code?: unknown }).code ?? 'MISS'}`)
          reject(new Error(`reclaude status 查询失败：${reason}`))
          return
        }
        try { resolve(parseReclaudeStatus(JSON.parse(String(stdout)))) }
        catch (cause) {
          reject(cause instanceof SyntaxError ? new Error('reclaude status 输出不是有效 JSON') : cause)
        }
      })
  })
}
