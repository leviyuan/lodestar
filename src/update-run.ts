/** `lodestar update` flow, separated from the command entry so tests never spawn real installers. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PID_FILE } from './paths'
import { updateAgentRuntimes } from './agent-updates'
import { UsageError } from './cli-errors'

import { C, colorEnabled } from './cli-output'

const UPDATE_PACKAGES = [
  '@leviyuan/lodestar@latest',
] as const

function runNpmInstall(): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const child = spawn(
      npm,
      ['install', '-g', '--include=optional', ...UPDATE_PACKAGES],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    )
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (e) => {
      console.error(`${C.red}spawn npm 失败:${C.reset} ${e.message}`)
      resolve(1)
    })
  })
}

/** The package on disk is now the new release; this process still holds the
 * old code. Agent installation logic and overrides ship with the package, so
 * the new updater entry performs the Agent update. */
export function runInstalledAgentUpdate(spawnProcess: typeof spawn = spawn, execPath = process.execPath, script = process.argv[1]): Promise<number> {
  if (!script) return Promise.reject(new Error('无法确定更新入口路径，Agent 未更新；请运行 lodestar update --agents-only'))
  // 子进程参数固定为 `<入口> --agents-only`（跨版本协议）；关闭颜色（含 --no-color）经 NO_COLOR 传下去。
  const env = colorEnabled() ? process.env : { ...process.env, NO_COLOR: '1' }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(execPath, [script, '--agents-only'], { stdio: 'inherit', windowsHide: true, env })
    child.on('error', error => reject(new Error(`启动新版 Agent 更新失败: ${error.message}`)))
    child.on('exit', code => resolve(code ?? 1))
  })
}

export interface LodestarUpdateDeps {
  npmInstall?: () => Promise<number>
  updateAgents?: typeof updateAgentRuntimes
  installedAgentUpdate?: () => Promise<number>
  daemonRunning?: () => boolean
  print?: (line?: string) => void
}

/** Resolves the process exit code; usage and package-install failures throw. */
export async function runLodestarUpdate(args: string[], deps: LodestarUpdateDeps = {}): Promise<number> {
  const print = deps.print ?? ((line = '') => console.log(line))
  const agentsOnly = args.includes('--agents-only')
  if (args.some(arg => arg !== '--agents-only')) throw new UsageError('用法: lodestar update [--agents-only]')
  print(`${C.bold}更新 ${agentsOnly ? '' : 'Lodestar + '}Codex、Claude Code/SDK、DSH${C.reset}`)
  if (agentsOnly) {
    await (deps.updateAgents ?? updateAgentRuntimes)({ report: message => print(message) })
    print(`\n${C.green}✓ Agent 更新完成，新进程使用新版${C.reset}`)
    return 0
  }
  print(`${C.dim}npm i -g ${UPDATE_PACKAGES.join(' ')}${C.reset}\n`)
  const code = await (deps.npmInstall ?? runNpmInstall)()
  if (code !== 0) throw new Error(`Lodestar 更新失败 (npm exit ${code})`)
  // The child reports its own progress, failures and completion line.
  const agents = await (deps.installedAgentUpdate ?? (() => runInstalledAgentUpdate()))()
  if (agents !== 0) return agents
  if ((deps.daemonRunning ?? (() => existsSync(PID_FILE)))()) {
    print()
    print(`${C.yellow}新版本已装好，但 daemon 仍在跑旧代码；重启服务后才会生效:${C.reset}`)
    print(`  ${C.dim}systemd --user  :${C.reset} ${C.cyan}systemctl --user restart <你的 unit>${C.reset}`)
    print(`  ${C.dim}macOS launchd   :${C.reset} ${C.cyan}launchctl kickstart -k gui/$(id -u)/<你的 label>${C.reset}`)
    print(`  ${C.dim}Windows 任务计划:${C.reset} ${C.cyan}schtasks /End /TN <任务名> && schtasks /Run /TN <任务名>${C.reset}`)
    print(`  ${C.dim}前台手动运行时  :${C.reset} ${C.cyan}lodestar stop && lodestar start${C.reset}`)
    print(`  ${C.dim}重启后用 lodestar version 确认新版本已生效。${C.reset}`)
  }
  return 0
}
