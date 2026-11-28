/** PID 文件保存进程号和入口路径，检查时核对实际入口，避免 PID 回收误判。 */

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function ourMarker(): string {
  if (!process.argv[1]) throw new Error('无法确定 daemon 入口路径')
  return resolve(process.argv[1])
}

export function parseDaemonPid(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value.trim())) return null
  const pid = Number(value.trim())
  return Number.isSafeInteger(pid) && pid <= 0x7fffffff ? pid : null
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // 进程存在但属于其他用户（PID 被系统进程回收时常见）；是否为 daemon 仍由命令行核对决定。
    if (code === 'EPERM') return true
    throw error
  }
}

const PF_KTHREAD = 0x00200000

/** Linux 上僵尸进程与内核线程的命令行恒为空，它们不可能是 daemon；exec 切换瞬间也会短暂读到空值，需要重读。 */
function linuxCommandLine(pid: number): string | null {
  for (let attempt = 0; ; attempt++) {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (command.trim()) return command
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm 可含空格与括号，状态字段从最后一个右括号之后开始：state ppid pgrp session tty tpgid flags。
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    if (fields[0] === 'Z' || (Number(fields[6]) & PF_KTHREAD) !== 0) return null
    if (attempt >= 4) return command
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}

function commandLine(pid: number): string | null {
  if (!processExists(pid)) return null
  try {
    let command: string
    if (process.platform === 'linux') {
      const linux = linuxCommandLine(pid)
      if (linux === null) return null
      command = linux
    } else if (process.platform === 'darwin') {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 })
    } else if (process.platform === 'win32') {
      command = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CommandLine`],
      { encoding: 'utf8', timeout: 5000 })
    } else {
      throw new Error(`不支持查询 ${process.platform} 平台的进程入口`)
    }
    if (!command.trim()) throw new Error(`PID ${pid} 的命令行为空，无法核对 daemon 身份`)
    return command.trim()
  } catch (error) {
    // 查询期间正常退出可视为不存在；权限、工具缺失、超时等必须阻止继续操作。
    if (!processExists(pid)) return null
    throw new Error(`无法读取 PID ${pid} 的命令行: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** 这里只跳过运行时选项；入口之后的普通参数不能冒充 daemon 入口。 */
const nodeOptionsWithValue = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C',
  '--inspect-port', '--title', '--icu-data-dir', '--openssl-config', '--redirect-warnings',
  '--diagnostic-dir', '--report-directory', '--report-filename', '--env-file', '--env-file-if-exists',
  '--watch-path', '--unhandled-rejections', '--max-old-space-size', '--max-semi-space-size', '--stack-size',
])
const nodeFlags = new Set([
  '--enable-source-maps', '--no-warnings', '--trace-warnings', '--trace-uncaught',
  '--preserve-symlinks', '--preserve-symlinks-main', '--inspect', '--inspect-brk',
  '--watch', '--watch-preserve-output', '--experimental-strip-types', '--experimental-transform-types',
])
const bunOptionsWithValue = new Set(['--preload', '--cwd', '--config', '-c', '--env-file', '--tsconfig-override'])
const bunFlags = new Set(['--hot', '--watch', '--smol', '--no-clear-screen', '--silent', '--bun', '--no-install'])

function entryOffset(args: string[]): number | null {
  const runtime = args[0]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase()
  // 带版本号的运行时文件名（node-22、node22、nodejs-22、bun-1.3）同样是 Node/Bun。
  if (!runtime || !/^(?:node|nodejs|bun)(?:[-_.]?v?\d+(?:\.\d+)*)?(?:\.exe)?$/.test(runtime)) return null
  const bun = runtime.startsWith('bun')
  const optionsWithValue = bun ? bunOptionsWithValue : nodeOptionsWithValue
  const flags = bun ? bunFlags : nodeFlags
  let consumedRun = false
  let index = 1
  while (index < args.length) {
    const arg = args[index]!
    if (/^-[ep]/.test(arg) || arg === '--eval' || arg === '--print' || /^(?:--eval|--print)=/.test(arg)) return null
    if (!bun && (arg === '-c' || arg === '--check' || arg === '--run' || arg.startsWith('--run='))) return null
    if (arg === '--') return index + 1
    if (!arg.startsWith('-')) {
      if (bun && !consumedRun && arg === 'run') { consumedRun = true; index++; continue }
      return index
    }
    const name = arg.split('=')[0]!
    if (optionsWithValue.has(name)) {
      index += arg.includes('=') ? 1 : 2
    } else if (flags.has(name)) {
      index++
    } else {
      throw new Error(`无法安全核对 daemon 入口: 未识别的 ${runtime} 选项 ${arg}`)
    }
  }
  return null
}

function processCwd(pid: number): string {
  if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`)
  if (process.platform === 'darwin') {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 2000 })
    const cwd = output.split('\n').find(line => line.startsWith('n'))?.slice(1)
    if (cwd) return cwd
  }
  throw new Error(`无法确定 PID ${pid} 的工作目录，不能核对相对 daemon 入口`)
}

/** 给定 pid 上是否确实运行保存的 daemon 入口；查询失败会抛错。 */
export function isOurDaemon(pid: number, marker: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || !marker) return false
  const command = commandLine(pid)
  if (command === null) return false
  // Linux 保留真正的 argv 边界。ps / Windows CommandLine 保留引号或空格形式。
  const args = process.platform === 'linux'
    ? command.split('\0').filter(Boolean)
    : (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(arg => arg.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2'))
  const offset = entryOffset(args)
  if (offset === null || !args[offset]) return false
  let entry = args[offset]!
  if (process.platform === 'win32') {
    if (!win32.isAbsolute(entry)) throw new Error(`PID ${pid} 使用相对入口，无法安全核对 daemon 身份`)
    return win32.normalize(entry).toLowerCase() === win32.normalize(marker).toLowerCase() || sameRealPath(entry, marker)
  }
  // macOS ps 的无引号空格无法区分入口路径与后续参数，禁止猜测。
  if (process.platform === 'darwin' && marker.startsWith(`${entry} `)) {
    throw new Error(`PID ${pid} 的入口包含无法区分的空格，不能安全核对 daemon 身份`)
  }
  if (!isAbsolute(entry)) entry = resolve(processCwd(pid), entry)
  return resolve(entry) === resolve(marker) || sameRealPath(entry, marker)
}

/** ps、/proc 与 Windows 查询给出的是启动时的原样路径（Node 不改写），Bun 的 argv[1]
 * 却已解开符号链接并规范大小写：两边各取真实路径再比，同一个文件才算同一入口。
 * 取不到真实路径（文件已删除、无权限）时只认字面相同，不放宽。 */
function sameRealPath(a: string, b: string): boolean {
  try {
    const left = realpathSync.native(a)
    const right = realpathSync.native(b)
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  } catch { return false }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Linux 启动标识：/proc/<pid>/stat 第 22 字段 starttime 的原始值（开机后的时钟滴答）。
 * 进程名可含空格和括号，从最后一个右括号之后数（那里是第 3 字段）。 */
export function linuxStartId(stat: string): string | null {
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : null
}

/** 进程启动标识：同一进程每次查询都得到同一个值，与此后墙钟是否跳变无关。Linux 是
 * /proc/<pid>/stat 的原始 starttime（开机后的时钟滴答），macOS 是 `ps -o lstart` 的绝对启动
 * 时刻（按 UTC 输出，精确到秒），Windows 是 StartTime（毫秒）。PID 上的标识与当初记录的不同，
 * 就是另一个进程拿到了这个 PID。无法查询时为 null；异步查询，不阻塞事件循环。 */
export async function processStartId(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null
  try {
    if (process.platform === 'linux') return linuxStartId(await readFile(`/proc/${pid}/stat`, 'utf8'))
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)],
        { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })
      const match = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(stdout)
      const month = match ? MONTHS.indexOf(match[1]!) : -1
      if (!match || month < 0) return null
      const [day, hours, minutes, seconds, year] = match.slice(2).map(Number)
      return `darwin:${Date.UTC(year!, month, day!, hours!, minutes!, seconds!)}`
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; [DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`],
      // PowerShell 启动慢只拖慢这个等待者，不阻塞事件循环。
      { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      const started = stdout.trim()
      return /^\d+$/.test(started) ? `win32:${started}` : null
    }
  } catch {}
  return null
}

/** 两个启动标识是否属于同一进程：Linux 的滴答数须完全相同；macOS、Windows 的启动时刻
 * 允许 1 秒误差。不同平台或格式的标识不算同一进程。 */
export function sameProcessStart(a: string, b: string): boolean {
  const [platformA, valueA] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)]
  const [platformB, valueB] = [b.slice(0, b.indexOf(':')), b.slice(b.indexOf(':') + 1)]
  if (platformA !== platformB || !/^\d+$/.test(valueA) || !/^\d+$/.test(valueB)) return false
  if (platformA === 'linux') return valueA === valueB
  return Math.abs(Number(valueA) - Number(valueB)) <= 1000
}

export function checkPidGuard(pidFile: string): { state: 'continue' } | { state: 'exit'; pid: number } {
  let raw: string
  try {
    raw = readFileSync(pidFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'continue' }
    throw error
  }
  const lines = raw.split('\n')
  const pid = parseDaemonPid(lines[0] ?? '')
  const savedMarker = (lines[1] ?? '').trim()
  if (pid === null) throw new Error(`PID 文件格式坏: ${pidFile}`)
  // 老格式没有入口标识，只能保守阻止重复启动，不能用于终止进程。
  if (!savedMarker) return processExists(pid) ? { state: 'exit', pid } : { state: 'continue' }
  return isOurDaemon(pid, savedMarker) ? { state: 'exit', pid } : { state: 'continue' }
}

export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, `${process.pid}\n${ourMarker()}`)
}
