/** `lodestar-update` flow, separated from the bin entry so it runs without spawning real installers in tests. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PID_FILE } from './paths'
import { updateAgentRuntimes } from './agent-updates'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
}

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
  if (!script) return Promise.reject(new Error('无法确定 lodestar-update 入口路径，Agent 未更新；请运行 lodestar-update --agents-only'))
  return new Promise((resolve, reject) => {
    const child = spawnProcess(execPath, [script, '--agents-only'], { stdio: 'inherit', windowsHide: true })
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
  if (args.some(arg => arg !== '--agents-only')) throw new Error('用法: lodestar-update [--agents-only]')
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
    print(`${C.yellow}检测到 daemon 仍在跑老版本进程, 用新版本需要重启:${C.reset}`)
    print(`  ${C.dim}# Linux systemd --user 托管的:${C.reset}`)
    print(`  ${C.cyan}systemctl --user restart lodestar${C.reset}      ${C.dim}# Linux${C.reset}`)
    print(`  ${C.dim}# macOS launchd / Windows 任务计划:用对应服务管理器重启。${C.reset}`)
    print(`  ${C.dim}# 或手动重启:${C.reset}`)
    print(`  ${C.cyan}lodestar-stop && lodestar-daemon${C.reset}`)
  }
  return 0
}

export const UPDATE_ERROR_PREFIX = `${C.red}lodestar-update:${C.reset}`
