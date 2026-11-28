/**
 * daemon 启动路径（`lodestar [start]`）：首次配置、PID guard 与 daemon 导入。
 *
 * 原本在 cli.ts 顶部直接执行；改成导出函数后由分发器在 `start`/无参数时调用，
 * 这样 `--help` / `--version` 不会触发配置检查或启动任何进程。
 *
 * 为什么先在这里判断配置：daemon.ts 会同步 import ./src/config，缺少
 * config.toml 时 loadConfig() 直接抛错；首次安装必须在导入 daemon 之前
 * 进入向导。向导写配置并拉起 detached daemon 后本进程退出。
 */

import { existsSync, unlinkSync } from 'node:fs'
import { CONFIG_FILE, PID_FILE } from './paths'
import { checkPidGuard } from './pid-guard'
import { C } from './cli-output'

export async function startDaemon(): Promise<number> {
  if (!existsSync(CONFIG_FILE)) {
    if (process.stdin.isTTY) {
      console.log()
      console.log(`${C.bold}${C.yellow}Lodestar: 未找到配置, 启动安装向导...${C.reset}`)
      const { runSetup } = await import('./setup')
      try {
        await runSetup()
      } catch (error) {
        // 交互式首次配置：把真实失败原样给操作者看，不用 daemon 的精简摘要。
        console.error(`\nlodestar setup: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
      // 向导写完 config + 拉起 detached daemon 就 rl.close，进程从这里干净退出。
      return 0
    }
    console.error('Lodestar: 未找到配置')
    console.error(`请在交互式终端里运行 ${C.green}lodestar setup${C.reset} 完成首次配置（或直接运行 ${C.green}lodestar${C.reset} 也会触发同一个向导）。`)
    return 1
  }

  // PID guard 上提到 daemon 导入之前：已有 daemon 时连飞书 Client 都不构造。
  // isOurDaemon 核对实际入口（Linux /proc、macOS ps、Windows CIM），查询失败
  // 显式报错，不能把无法确认身份当成允许启动。
  const guard = checkPidGuard(PID_FILE)
  if (guard.state === 'exit') {
    console.error('Lodestar: 已经有一个 daemon 在运行')
    console.error('  • 想看日志:'
      + (process.platform === 'win32'
          ? ' %LOCALAPPDATA%\\Lodestar\\daemon-YYYY-MM-DD.log'
          : ' ~/.local/share/lodestar/daemon-YYYY-MM-DD.log'))
    console.error('  • 想停: 终端前台启动的运行 lodestar stop')
    console.error('  • 交给 systemd / launchd / 任务计划托管时，由服务管理器重启或停止，不要用 lodestar stop（见 lodestar --help 的「更新」一节）')
    return 1
  }
  // PID 文件存在但 isOurDaemon 判否（stale + PID 回收）时顺手清掉，daemon 启动会写新的。
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE)
  }

  await import('../daemon')
  return 0
}
