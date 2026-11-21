/**
 * `lodestar stop` 的实现。
 *
 * 读 daemon.pid → 用 isOurDaemon 校验实际入口（避免 PID 回收误杀）→ 发
 * SIGTERM 让 daemon 走自己的 cleanup（清 PID 文件、写 alive marker、把
 * SIGINT 转给子进程），然后按进程身份确认退出。
 *
 * Windows 没有 POSIX SIGTERM，Node 的 process.kill(pid, 'SIGTERM') 在
 * Win32 上等价于无条件强杀（TerminateProcess），daemon 拿不到信号、cleanup
 * 跑不到，所以这里直接走 taskkill，让平台原生 API 接管。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PID_FILE } from './paths'
import { isOurDaemon, parseDaemonPid } from './pid-guard'
import { C, type CliIo } from './cli-output'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 返回进程退出码：未运行与 stale 记录都按成功处理，真正的停止失败才抛错。 */
export async function stopDaemon(io: CliIo): Promise<number> {
  let contents: string
  try {
    contents = readFileSync(PID_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    io.out(`${C.yellow}Lodestar daemon 未运行${C.reset} ${C.dim}(${PID_FILE} 不存在)${C.reset}\n`)
    return 0
  }

  const raw = contents.split('\n')
  const pid = parseDaemonPid(raw[0] ?? '')
  const marker = (raw[1] ?? '').trim()
  if (pid === null) throw new Error(`PID 文件格式坏: ${PID_FILE}`)
  if (!marker) throw new Error(`旧 PID 文件没有 daemon 入口标识，拒绝发送停止信号。请核对 PID ${pid} 的完整命令行后手动停止: ${PID_FILE}`)

  if (!isOurDaemon(pid, marker)) {
    io.out(`${C.yellow}PID ${pid} 上没有 daemon (stale 文件)${C.reset}\n`)
    io.out(`${C.dim}手删 ${PID_FILE} 后再试${C.reset}\n`)
    return 0
  }

  io.out(`${C.bold}停止 daemon${C.reset} (pid ${pid})...\n`)
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch (e: any) {
    io.err(`${C.red}发信号失败:${C.reset} ${e?.message ?? e}\n`)
    return 1
  }

  // 按原进程身份确认退出，不能把 PID 文件移除或替换当作已停止。
  // Windows 强制结束不会清 PID 文件；下一次启动会识别并清理 stale 记录。
  for (let i = 0; i < 50; i++) {
    if (!isOurDaemon(pid, marker)) {
      io.out(`${C.green}✓ daemon 已停${C.reset}\n`)
      return 0
    }
    await sleep(100)
  }
  throw new Error(`已发送停止请求，但 5s 内 PID ${pid} 的 daemon 仍未退出，可能还在收尾；请检查日志`)
}
