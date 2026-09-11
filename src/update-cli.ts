/**
 * CLI entry for `lodestar-update` bin.
 *
 * 更新 Lodestar 与实际使用的 Agent runtimes；--agents-only 仅立即更新 Agent。
 * daemon 自身的服务生命周期仍由用户控制。
 */

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

async function main(): Promise<void> {
  const agentsOnly = process.argv.includes('--agents-only')
  if (process.argv.slice(2).some(arg => arg !== '--agents-only')) throw new Error('用法: lodestar-update [--agents-only]')
  console.log(`${C.bold}更新 ${agentsOnly ? '' : 'Lodestar + '}Codex、Claude Code/SDK、DSH${C.reset}`)
  if (!agentsOnly) {
    console.log(`${C.dim}npm i -g ${UPDATE_PACKAGES.join(' ')}${C.reset}\n`)
    const code = await runNpmInstall()
    if (code !== 0) throw new Error(`Lodestar 更新失败 (npm exit ${code})`)
  }
  await updateAgentRuntimes({ report: message => console.log(message) })

  console.log(`\n${C.green}✓ Agent 更新完成，新进程使用新版${C.reset}`)
  if (!agentsOnly && existsSync(PID_FILE)) {
    console.log()
    console.log(`${C.yellow}检测到 daemon 仍在跑老版本进程, 用新版本需要重启:${C.reset}`)
    console.log(`  ${C.dim}# Linux systemd --user 托管的:${C.reset}`)
    console.log(`  ${C.cyan}systemctl --user restart lodestar${C.reset}      ${C.dim}# Linux${C.reset}`)
    console.log(`  ${C.dim}# macOS launchd / Windows 任务计划:用对应服务管理器重启。${C.reset}`)
    console.log(`  ${C.dim}# 或手动重启:${C.reset}`)
    console.log(`  ${C.cyan}lodestar-stop && lodestar-daemon${C.reset}`)
  }
}

main().catch((e: any) => {
  console.error(`${C.red}lodestar-update:${C.reset} ${e?.message ?? e}`)
  process.exit(1)
})
