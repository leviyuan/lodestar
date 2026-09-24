/**
 * Lodestar entry — thin shim ahead of daemon.ts.
 *
 * Why this exists: `daemon.ts` imports `./src/config` synchronously, and
 * `loadConfig()` throws on missing config.toml. Fresh-install users
 * never see a config until they run the wizard, so we gate that import
 * behind an existsSync check up here. If config is missing AND we're
 * on a TTY (= user invoked us interactively, the only path that makes
 * sense for first-run setup) we dynamic-import the wizard, run it, and
 * exit — the wizard itself spawns a detached daemon after writing the
 * config. If the config exists, we fall through to the daemon body via
 * `await import('./daemon')`.
 *
 * This is the canonical first-run wizard trigger. postinstall.cjs used
 * to auto-launch the wizard by hijacking /dev/tty, but that was fragile:
 * on some mac installs the wizard's readline got no input and deadlocked
 * against npm's wait (terminal froze, killing it tripped npm's rollback).
 * Postinstall cleans retired Skills and prints a banner; the wizard runs here, on the
 * first `lodestar-daemon`, where the TTY check is trivially true.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { CONFIG_FILE, PID_FILE } from './src/paths'
import { checkPidGuard } from './src/pid-guard'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  yellow:'\x1b[33m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
}

async function main(): Promise<void> {
  if (!existsSync(CONFIG_FILE)) {
    if (process.stdin.isTTY) {
      console.log()
      console.log(`${C.bold}${C.yellow}Lodestar: 未找到配置, 启动安装向导...${C.reset}`)
      const { runSetup } = await import('./src/setup')
      await runSetup()
      // 向导写完 config + 拉起 detached daemon 就 rl.close, 进程从这里干净退出。
      return
    }
    console.error(`${C.red}Lodestar: 未找到配置 ${CONFIG_FILE}${C.reset}`)
    console.error(`请在交互式 cmd / PowerShell 里运行 ${C.green}lodestar-setup${C.reset} 完成首次配置 (或直接运行 ${C.green}lodestar-daemon${C.reset} 也会触发同一个向导)。`)
    process.exit(1)
  }

  // PID guard 上提到 daemon 导入之前 —— 这样如果已经有一个 daemon 在跑,
  // 我们连 feishu/Lark Client 都不构造, 直接退出。比放在 daemon.ts 里
  // 干净, 旧的 `[info]: client ready` + "already running" 双行错乱也消失。
  // 旧版只调 `process.kill(pid, 0)` 问 OS 这 pid 上有没有进程, 在 Windows
  // 上 PID 回收快, 旧 daemon 死后那号被别的程序占了就会冤枉拦下新启动。
  // isOurDaemon 核对实际入口 (Linux /proc、macOS ps、Windows CIM)，
  // 查询失败显式报错，不能把无法确认身份当成允许启动。
  const guard = checkPidGuard(PID_FILE)
  if (guard.state === 'exit') {
    console.error(`${C.yellow}Lodestar: 已经有一个 daemon 在运行 (pid ${guard.pid})${C.reset}`)
    console.error('  • 想看日志:'
      + (process.platform === 'win32'
          ? ' %LOCALAPPDATA%\\Lodestar\\daemon-YYYY-MM-DD.log'
          : ' ~/.local/share/lodestar/daemon-YYYY-MM-DD.log'))
    console.error('  • 想停: 任务管理器结束 pid 上面那个号 (Windows) / `kill ' + guard.pid + '` (Linux/macOS)')
    console.error(`  • 误判 / 已经死了: 手删 ${PID_FILE} 后再跑`)
    process.exit(1)
  }
  // 如果 PID 文件存在但 isOurDaemon 判否 (stale + 回收), 顺手清掉, 后面
  // daemon 启动会写新的。
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE)
  }

  await import('./daemon')
}

main().catch((e: any) => {
  console.error('lodestar fatal:', e?.message ?? e)
  process.exit(1)
})
