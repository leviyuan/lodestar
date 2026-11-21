/**
 * `lodestar version`：报告实际安装的 Agent 运行时，而不是全局 CLI 的版本。
 *
 * `lodestar --version` 只输出版本号；本命令输出人类可读明细（--verbose 附带目录），
 * 或 --json 的机器可读结构。Agent 未安装仍返回 0，安装记录与实际文件不一致返回 1。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS, agentRuntimeState, type UpdatedAgent } from './agent-updates'
import { UsageError } from './cli-errors'
import { commandHelp } from './cli-help'
import type { CliIo } from './cli-output'
import { lodestarVersion } from './version'

interface AgentReport {
  agent: string
  status: 'ok' | 'missing' | 'error'
  packages?: Array<{ name: string; version: string }>
  directory?: string
  error?: string
}

function inspectAgent(agent: UpdatedAgent, verbose: boolean): AgentReport {
  try {
    const state = agentRuntimeState(agent)
    if (!state?.directory) return { agent, status: 'missing' }
    if (!existsSync(state.directory)) throw new Error(`安装目录不存在: ${state.directory}`)
    const names = agent === 'dsh' ? ['@deepseek-ai/dsh'] : Object.keys(state.versions ?? {})
    if (!names.length) throw new Error('安装记录缺少包版本')
    const packages = names.map(name => {
      const installed = JSON.parse(readFileSync(join(state.directory!, 'node_modules', name, 'package.json'), 'utf8'))
      if (installed.name !== name || typeof installed.version !== 'string' || installed.version !== state.versions?.[name]) {
        throw new Error(`安装包与记录不一致: ${name}，记录 ${state.versions?.[name] ?? 'MISS'}，实际 ${installed.name}@${installed.version}`)
      }
      return { name, version: installed.version }
    })
    return { agent, status: 'ok', packages, ...(verbose ? { directory: state.directory } : {}) }
  } catch (error) {
    return { agent, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runVersion(argv: string[], io: CliIo): Promise<number> {
  let verbose = false
  let json = false
  for (const arg of argv) {
    if (arg === '--verbose') verbose = true
    else if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') { io.out(commandHelp('version') ?? ''); return 0 }
    else throw new UsageError(`未知选项: ${arg}\n用法: lodestar version [--verbose] [--json]`)
  }

  const version = lodestarVersion()
  const reports = AGENTS.map(agent => inspectAgent(agent, verbose))
  const failed = reports.some(report => report.status === 'error')

  if (json) {
    io.out(`${JSON.stringify({
      lodestar: version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      agents: Object.fromEntries(reports.map(({ agent, ...rest }) => [agent, rest])),
    }, null, 2)}\n`)
    return failed ? 1 : 0
  }

  io.out(`Lodestar v${version}\n`)
  for (const report of reports) {
    if (report.status === 'missing') io.out(`${report.agent}: MISS（尚未安装）\n`)
    else if (report.status === 'error') { io.err(`${report.agent}: MISS（${report.error}）\n`) }
    else {
      io.out(`${report.agent}: ${report.packages!.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}\n`)
      if (report.directory) io.out(`  ${report.directory}\n`)
    }
  }
  if (verbose) io.out(`Runtime: ${process.version} (${process.platform}-${process.arch})\n`)
  return failed ? 1 : 0
}
