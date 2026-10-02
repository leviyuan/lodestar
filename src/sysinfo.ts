/**
 * Lightweight host snapshot for the `hi` console panel —— CPU 负载、
 * 内存、根/家目录磁盘、以及当前用户下的 cc-* / codex-* 服务。
 *
 * 服务前缀约定:AI 助手拉起的常驻进程通常走
 *   systemd-run --user --unit=cc-<project>-<purpose> -- <cmd>
 *   systemd-run --user --unit=codex-<project>-<purpose> -- <cmd>
 * `hi` 面板只列这两个前缀,是要让 daemon 这台机器上的"AI 拉起来的活儿"
 * 一眼可见,跟系统自带 / 第三方服务区分开。
 *
 * 所有数据源都是本机文件 / 系统调用,没有网络往返:
 *   os.loadavg()          —— Linux / macOS 的 1m / 5m / 15m
 *   /proc/meminfo          —— Linux Total / Available
 *   vm_stat + os.totalmem —— macOS 应用、wired、压缩内存
 *   statfsSync(path)       —— 各挂载点容量
 *   /proc/uptime           —— monotonic seconds since boot (uptime 推算)
 *   systemctl --user show  —— cc-* / codex-* 服务的状态与启动时间
 *   launchctl list + ps    —— macOS 当前用户服务状态与进程运行时长
 *
 * 失败可见: 任何一段读不到就把对应字段标 null,卡片层按 null 渲染
 * `MISS`,绝不假数据 (no_fallbacks)。
 */

import { execFile } from 'node:child_process'
import { readFileSync, statfsSync, statSync } from 'node:fs'
import { cpus, homedir, loadavg, totalmem } from 'node:os'
import { promisify } from 'node:util'
import { log } from './log'

const execFileAsync = promisify(execFile)

export interface CpuInfo {
  cores: number
  load1: number
  load5: number
  load15: number
}

export interface MemInfo {
  /** Bytes — Linux MemTotal / macOS os.totalmem() */
  totalBytes: number
  /** Bytes — Linux MemAvailable;macOS 总量减应用、wired 和压缩内存。 */
  availBytes: number
  usedBytes: number
  /** 0–100 */
  percent: number
}

export interface DiskInfo {
  /** 显示用的标签 ('/' 或 '$HOME') */
  label: string
  /** 实际查询的路径 */
  path: string
  totalBytes: number
  availBytes: number
  usedBytes: number
  /** 0–100;按 used / total */
  percent: number
}

export interface ServiceInfo {
  /** systemd 不带 .service 后缀;launchd 使用完整 label。 */
  name: string
  /** systemd ActiveState: active | inactive | failed | activating | deactivating */
  active: string
  /** SubState: running | exited | dead | start | stop-sigterm | ... */
  sub: string
  /** 自最近一次进入 active 状态起的秒数。从未活跃过则为 null。
   * 对 active 服务等于 "已运行 X 秒";对 inactive/failed 等于
   * "上次跑起来到现在过了 X 秒"。launchd 停止后无此数据。 */
  lastActiveAgoSec: number | null
  /** 当前 ActiveState 的持续秒数 (StateChangeTimestamp → 现在)。
   * 对 active 服务等于 lastActiveAgoSec;对 inactive 服务等于
   * "已停了多久";对 activating/deactivating 等于"切换中多久"。 */
  stateAgoSec: number | null
  /** false 仅表示系统明确报告从未启动;null/缺失表示未知。 */
  hasStarted?: boolean | null
  /** launchctl 的上一退出状态;负数表示终止信号。 */
  lastExitStatus?: number
  /** 已读取状态但无法读取运行时长时保留服务及具体错误。 */
  error?: string
}

export interface SysInfo {
  cpu: CpuInfo | null
  mem: MemInfo | null
  disks: DiskInfo[]
  services: ServiceInfo[]
  /** 查询失败时返回具体错误;只有成功且无匹配服务才为空数组 + null。 */
  servicesError: string | null
}

/** 用户态 systemd / launchd 服务的统一前缀。 */
export const SERVICE_PREFIXES = ['cc-', 'codex-'] as const
export const SERVICE_LABEL = 'cc-* / codex-*'

function readCpu(): CpuInfo | null {
  try {
    const [load1, load5, load15] = loadavg()
    const cores = cpus().length
    if (!cores || ![load1, load5, load15].every(n => Number.isFinite(n) && n >= 0)) {
      throw new Error('CPU 核数或负载无效')
    }
    return { cores, load1, load5, load15 }
  } catch (e) {
    log(`sysinfo: read CPU failed: ${e}`)
    return null
  }
}

function readMem(): MemInfo | null {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8')
    const find = (k: string): number => {
      const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm'))
      if (!m) throw new Error(`/proc/meminfo 缺少 ${k}`)
      return Number(m[1]) * 1024
    }
    const totalBytes = find('MemTotal')
    const availBytes = find('MemAvailable')
    if (totalBytes <= 0 || availBytes > totalBytes) throw new Error('/proc/meminfo 内存数据无效')
    const usedBytes = totalBytes - availBytes
    return {
      totalBytes, availBytes, usedBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
    }
  } catch (e) {
    log(`sysinfo: read /proc/meminfo failed: ${e}`)
    return null
  }
}

/** macOS 的已用内存 = 应用（anonymous - purgeable）+ wired + compressor。
 * 压缩部分取 occupied 而非 stored（压缩前页数），页大小取真实输出，兼容
 * Intel 的 4 KiB 和 Apple Silicon 的 16 KiB。不把可回收文件缓存算成已用。 */
export function parseMacMemory(raw: string, totalBytes: number): MemInfo {
  const pageMatch = raw.match(/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)/m)
  if (!pageMatch) throw new Error('vm_stat 缺少 page size')
  const pageSize = Number(pageMatch[1])
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error('macOS 内存总量或 page size 无效')
  }
  const pages = (key: string): number => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\.\\s*$`, 'm'))
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`vm_stat 缺少或无效 ${key}`)
    return Number(match[1])
  }
  const appPages = pages('Anonymous pages') - pages('Pages purgeable')
  const usedBytes = (appPages + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize
  if (appPages < 0 || !Number.isSafeInteger(usedBytes) || usedBytes > totalBytes) {
    throw new Error('vm_stat 内存数据超出物理内存范围')
  }
  return { totalBytes, availBytes: totalBytes - usedBytes, usedBytes, percent: Math.round(usedBytes / totalBytes * 100) }
}

type HostCommand = (file: string, args: string[]) => Promise<string>

const runHostCommand: HostCommand = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  return stdout
}

export async function readMacMemory(command: HostCommand = runHostCommand): Promise<MemInfo | null> {
  try {
    return parseMacMemory(await command('/usr/bin/vm_stat', []), totalmem())
  } catch (e) {
    log(`sysinfo: read macOS memory failed: ${e}`)
    return null
  }
}

interface LaunchdService extends ServiceInfo { pid: number | null }

/** launchctl list 的三列协议: PID / 上次退出状态（负值为信号）/ Label。
 * 只看当前用户 bootstrap domain，不枚举系统服务，不读取 plist 中的环境变量。 */
export function parseLaunchctlList(raw: string): LaunchdService[] {
  const lines = raw.trim().split(/\r?\n/)
  if (!/^PID\s+Status\s+Label$/.test(lines.shift()?.trim() ?? '')) throw new Error('launchctl list 表头无效')
  const services: LaunchdService[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const match = line.trim().match(/^(\d+|-)\s+(-?\d+)\s+(\S+)$/)
    if (!match) throw new Error(`launchctl list 行无效: ${line.trim()}`)
    const [, pidText, statusText, name] = match
    if (!SERVICE_PREFIXES.some(prefix => name!.startsWith(prefix))) continue
    const pid = pidText === '-' ? null : Number(pidText)
    const lastExitStatus = Number(statusText)
    if ((pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) || !Number.isSafeInteger(lastExitStatus)) {
      throw new Error(`launchctl list PID 或退出状态无效: ${name}`)
    }
    services.push({
      name: name!, pid, lastExitStatus,
      active: pid !== null ? 'active' : lastExitStatus === 0 ? 'inactive' : 'failed',
      sub: pid !== null ? 'running' : lastExitStatus < 0 ? 'signal' : 'exited',
      hasStarted: pid !== null || lastExitStatus !== 0 ? true : null,
      lastActiveAgoSec: null, stateAgoSec: null,
    })
  }
  return services.sort((a, b) => a.name.localeCompare(b.name))
}

/** BSD ps etime: [[dd-]hh:]mm:ss;不解析受语言和时区影响的启动日期。 */
export function parseProcessElapsed(raw: string): Map<number, number> {
  const times = new Map<number, number>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const match = line.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
    if (!match) throw new Error(`ps etime 行无效: ${line.trim()}`)
    const pid = Number(match[1])
    const days = match[2] === undefined ? 0 : Number(match[2])
    const hours = match[3] === undefined ? 0 : Number(match[3])
    const minutes = Number(match[4])
    const seconds = Number(match[5])
    const elapsed = ((days * 24 + hours) * 60 + minutes) * 60 + seconds
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(elapsed) || minutes >= 60 || seconds >= 60 || (match[2] !== undefined && (match[3] === undefined || hours >= 24))) {
      throw new Error(`ps etime 数值无效: ${line.trim()}`)
    }
    times.set(pid, elapsed)
  }
  return times
}

export async function readMacServices(command: HostCommand = runHostCommand): Promise<{ services: ServiceInfo[]; error: string | null }> {
  let jobs: LaunchdService[]
  try {
    jobs = parseLaunchctlList(await command('/bin/launchctl', ['list']))
  } catch (e) {
    log(`sysinfo: launchctl list failed: ${e}`)
    return { services: [], error: `launchctl 查询失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  const running = jobs.filter(job => job.pid !== null)
  if (running.length > 0) {
    try {
      const times = parseProcessElapsed(await command('/bin/ps', ['-p', running.map(job => job.pid).join(','), '-o', 'pid=,etime=']))
      for (const job of running) {
        const elapsed = times.get(job.pid!)
        if (elapsed === undefined) {
          job.error = 'ps 未返回该进程，运行时长 MISS'
          log(`sysinfo: ${job.name}: ${job.error}`)
        } else {
          job.lastActiveAgoSec = elapsed
          job.stateAgoSec = elapsed
        }
      }
    } catch (e) {
      log(`sysinfo: read launchd process elapsed failed: ${e}`)
      for (const job of running) job.error = `运行时长 MISS: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { services: jobs.map(({ pid: _pid, ...service }) => service), error: null }
}

/** statfsSync 拿到的 blocks/bavail 都按 f_frsize 计算 bytes —— 注意
 * `usedBytes` 用 total - avail (不是 total - free),跟 `df` 的 Use% 列
 * 一致 (排除 root 保留块)。 */
function readDiskFor(label: string, path: string): DiskInfo | null {
  try {
    const s = statfsSync(path, { bigint: false }) as {
      bsize: number; blocks: number; bavail: number
    }
    const totalBytes = s.blocks * s.bsize
    const availBytes = s.bavail * s.bsize
    const usedBytes = Math.max(0, totalBytes - availBytes)
    if (!totalBytes) return null
    return {
      label, path, totalBytes, availBytes, usedBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
    }
  } catch (e) {
    log(`sysinfo: statfs ${path} failed: ${e}`)
    return null
  }
}

/** 取 `/` 和 `$HOME`;如果两者属于同一文件系统(同一 device id),
 * 只返回 `/`,避免面板上挂两条一样的数据 (用户在 AskUserQuestion
 * 时知情的选择)。 */
function readDisks(): DiskInfo[] {
  const out: DiskInfo[] = []
  const root = readDiskFor('/', '/')
  if (root) out.push(root)
  const home = homedir()
  if (home && home !== '/') {
    let homeOnSameFs = false
    try {
      const rs = statSync('/')
      const hs = statSync(home)
      homeOnSameFs = rs.dev === hs.dev
    } catch {}
    if (!homeOnSameFs) {
      const homeDisk = readDiskFor('$HOME', home)
      if (homeDisk) out.push(homeDisk)
    }
  }
  return out
}

/** /proc/uptime 第一个数是 monotonic 自启动以来的秒数。 */
function readMonotonicSec(): number | null {
  try {
    const raw = readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)
    return parseFloat(raw[0] ?? '0')
  } catch {
    return null
  }
}

/** 用 `node:child_process.execFile` 跑 `systemctl --user` —— 跨 Bun /
 * Node 通用,超时(默认 2s)由 execFile 内置 timeout 处理,非零退出码
 * execFile 会 reject,被外层 catch 统一兜成 null,跟旧版 Bun.spawn 行为
 * 一致(调用方拿 null 走 error 分支)。仅由 readSysInfo 的 Linux 分支调用。 */
async function runSystemctl(args: string[], timeoutMs = 2000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    log(`sysinfo: systemctl ${args.join(' ')} failed: ${e}`)
    return null
  }
}

function isManagedServiceUnit(unit: string): boolean {
  return SERVICE_PREFIXES.some(prefix => unit.startsWith(prefix)) && unit.endsWith('.service')
}

/** 列 `${SERVICE_LABEL}` 服务并解析:第 1 步用 list-units 拿名字,
 * 第 2 步用单次 show -p 拿状态 + ActiveEnterTimestampMonotonic。两步
 * 都是本地调用,加起来 < 100ms。 */
async function readServices(): Promise<{ services: ServiceInfo[]; error: string | null }> {
  // list-units 输出每行: "<unit> <load> <active> <sub> <description>"。
  // --all 把 inactive 也列出来 (用户停过的服务也值得在面板看到)。
  // 加 --plain --no-legend 关掉表格修饰和 footer,方便机器解析。
  const listOut = await runSystemctl([
    'list-units', '--type=service', '--all', '--no-legend', '--plain',
    ...SERVICE_PREFIXES.map(prefix => `${prefix}*`),
  ])
  if (listOut === null) {
    return { services: [], error: 'systemctl 不可用' }
  }
  const lines = listOut.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length === 0) return { services: [], error: null }

  const names: string[] = []
  for (const line of lines) {
    // 第一列是 unit 全名,可能带前缀●;.service 后缀去掉。
    const cols = line.replace(/^●\s*/, '').split(/\s+/)
    const unit = cols[0]
    if (!unit) continue
    if (!isManagedServiceUnit(unit)) continue
    names.push(unit)
  }
  if (names.length === 0) return { services: [], error: null }

  // 一次性 show 多个 unit:每个 unit 输出一段属性,段之间空行分隔。
  // ActiveEnter = 最近一次进入 active 的时刻 (即使现在已 inactive 也保留);
  // StateChange = 当前 ActiveState 进入时刻。两者对 active 服务相同,
  // 对 inactive 服务分别是"上次活跃"与"停了多久"。
  const showOut = await runSystemctl([
    'show', ...names,
    '-p', 'Id',
    '-p', 'ActiveState',
    '-p', 'SubState',
    '-p', 'ActiveEnterTimestampMonotonic',
    '-p', 'StateChangeTimestampMonotonic',
  ])
  if (showOut === null) return { services: [], error: 'systemctl show 失败' }

  const monotonicNowSec = readMonotonicSec()
  const blocks = showOut.split(/\n\s*\n/)
  const services: ServiceInfo[] = []
  const ageFrom = (microStr: string | undefined): number | null => {
    const micro = parseInt(microStr ?? '0', 10)
    if (micro <= 0 || monotonicNowSec === null) return null
    return Math.max(0, monotonicNowSec - micro / 1_000_000)
  }
  for (const block of blocks) {
    const props: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      props[line.slice(0, eq)] = line.slice(eq + 1)
    }
    const id = props.Id ?? ''
    if (!isManagedServiceUnit(id)) continue
    services.push({
      name: id.replace(/\.service$/, ''),
      active: props.ActiveState ?? 'unknown',
      sub: props.SubState ?? '',
      lastActiveAgoSec: ageFrom(props.ActiveEnterTimestampMonotonic),
      stateAgoSec: ageFrom(props.StateChangeTimestampMonotonic),
      hasStarted: props.ActiveEnterTimestampMonotonic === '0' ? false : null,
    })
  }
  services.sort((a, b) => a.name.localeCompare(b.name))
  return { services, error: null }
}

export async function readSysInfo(): Promise<SysInfo> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    const platform = process.platform === 'win32' ? 'Windows' : process.platform
    return { cpu: null, mem: null, disks: [], services: [], servicesError: `${platform}: sysinfo 暂未支持` }
  }
  const cpu = readCpu()
  const disks = readDisks()
  const [mem, { services, error }] = await Promise.all([
    process.platform === 'darwin' ? readMacMemory() : readMem(),
    process.platform === 'darwin' ? readMacServices() : readServices(),
  ])
  return { cpu, mem, disks, services, servicesError: error }
}
