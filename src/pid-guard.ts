/** PID 文件保存进程号和入口路径，检查时核对实际入口，避免 PID 回收误判。 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, win32 } from 'node:path'

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
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function commandLine(pid: number): string | null {
  if (!processExists(pid)) return null
  try {
    let command: string
    if (process.platform === 'linux') {
      command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
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
  if (!runtime || !/^(?:node|nodejs|bun)(?:\.exe)?$/.test(runtime)) return null
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
    return win32.normalize(entry).toLowerCase() === win32.normalize(marker).toLowerCase()
  }
  // macOS ps 的无引号空格无法区分入口路径与后续参数，禁止猜测。
  if (process.platform === 'darwin' && marker.startsWith(`${entry} `)) {
    throw new Error(`PID ${pid} 的入口包含无法区分的空格，不能安全核对 daemon 身份`)
  }
  if (!isAbsolute(entry)) entry = resolve(processCwd(pid), entry)
  return resolve(entry) === resolve(marker)
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
