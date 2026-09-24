/**
 * CLI entry for `lodestar-stop` bin.
 *
 * 读 daemon.pid → 用 isOurDaemon 校验 cmdline (避免 PID 回收误杀) → 发
 * SIGTERM 让 daemon 走自己的 cleanup (清 PID 文件、写 alive marker、把
 * SIGINT 转给子进程)。然后轮询等 PID 文件被 cleanup 删掉,或超时报错。
 *
 * Windows 没有 POSIX SIGTERM, Node 的 process.kill(pid, 'SIGTERM') 在
 * Win32 上其实等价于无条件强杀 (TerminateProcess) — daemon 拿不到信号、
 * cleanup 跑不到、SIGBREAK handler 也不会触发。所以这里 Win 直接走
 * taskkill, 优雅 vs 强杀语义反正都没了, 让平台原生 API 接管就行。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PID_FILE } from './paths'
import { isOurDaemon, parseDaemonPid } from './pid-guard'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  let contents: string
  try {
    contents = readFileSync(PID_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    console.log(`${C.yellow}Lodestar daemon 未运行${C.reset} ${C.dim}(${PID_FILE} 不存在)${C.reset}`)
    return
  }

  const raw = contents.split('\n')
  const pid = parseDaemonPid(raw[0] ?? '')
  const marker = (raw[1] ?? '').trim()
  if (pid === null) throw new Error(`PID 文件格式坏: ${PID_FILE}`)
  if (!marker) throw new Error(`旧 PID 文件没有 daemon 入口标识，拒绝发送停止信号。请核对 PID ${pid} 的完整命令行后手动停止: ${PID_FILE}`)

  if (!isOurDaemon(pid, marker)) {
    console.log(`${C.yellow}PID ${pid} 上没有 daemon (stale 文件)${C.reset}`)
    console.log(`${C.dim}手删 ${PID_FILE} 后再试${C.reset}`)
    return
  }

  console.log(`${C.bold}停止 daemon${C.reset} (pid ${pid})...`)
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch (e: any) {
    console.error(`${C.red}发信号失败:${C.reset} ${e?.message ?? e}`)
    process.exit(1)
  }

  // 按原进程身份确认退出，不能把 PID 文件移除或替换当作已停止。
  // Windows 强制结束不会清 PID 文件；下一次启动会识别并清理 stale 记录。
  for (let i = 0; i < 50; i++) {
    if (!isOurDaemon(pid, marker)) {
      console.log(`${C.green}✓ daemon 已停${C.reset}`)
      return
    }
    await sleep(100)
  }
  throw new Error(`已发送停止请求，但 5s 内 PID ${pid} 的 daemon 仍未退出，可能还在收尾；请检查日志`)
}

main().catch((e: any) => {
  console.error(`${C.red}lodestar-stop:${C.reset} ${e?.message ?? e}`)
  process.exit(1)
})
