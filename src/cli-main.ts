/**
 * `lodestar` 统一入口：子命令路由、帮助/版本、`--no-color` 与退出码。
 *
 * 约定：
 *   - `--help` / `--version` 在任何 IO 之前判定，不读配置、不读状态、不起进程。
 *   - 用法错误退出码 2，运行失败 1，中断 130。
 */

import { HelpRequest, UsageError } from './cli-errors'
import { commandHelp, topLevelHelp } from './cli-help'
import { disableColor, processIo, type CliIo } from './cli-output'
import { lodestarVersion } from './version'

export type CliCommand = (argv: string[], io: CliIo) => Promise<number | void>

export interface CliCommands {
  start: CliCommand
  setup: CliCommand
  stop: CliCommand
  update: CliCommand
  version: CliCommand
  agent: CliCommand
  claude: CliCommand
}

export interface RunCliOptions {
  io?: CliIo
  /** 只提供部分命令时其余走默认实现；测试用来替换真实副作用。 */
  commands?: Partial<CliCommands>
}

type CommandName = keyof CliCommands

const COMMANDS: readonly CommandName[] = ['start', 'setup', 'stop', 'update', 'version', 'agent', 'claude']

const USAGE_LINES: Partial<Record<CommandName, string>> = {
  start: 'lodestar [start]',
  setup: 'lodestar setup',
  stop: 'lodestar stop',
}

function isCommand(name: string): name is CommandName {
  return (COMMANDS as readonly string[]).includes(name)
}

function ensureNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function defaultCommands(): CliCommands {
  return {
    start: async () => (await import('./daemon-entry')).startDaemon(),
    setup: async () => {
      const { runSetup } = await import('./setup')
      await runSetup()
    },
    stop: async (_argv, io) => (await import('./stop-command')).stopDaemon(io),
    update: async (argv, io) => (await import('./update-command')).runUpdate(argv, io),
    version: async (argv, io) => (await import('./version-command')).runVersion(argv, io),
    agent: async argv => {
      const { main } = await import('./agent-main')
      await main(argv)
    },
    claude: async argv => {
      const { main } = await import('./claude-main')
      await main(argv)
    },
  }
}

async function helpFor(name: CommandName): Promise<string> {
  const text = commandHelp(name)
  if (text) return text
  if (name === 'agent') {
    const { usage } = await import('./agent-main')
    return ensureNewline(usage())
  }
  if (name === 'claude') {
    const { usage } = await import('./claude-main')
    return ensureNewline(usage)
  }
  return `${name}\n`
}

function reportCommandError(name: CommandName, error: unknown, io: CliIo): number {
  if (error instanceof HelpRequest) {
    io.out(ensureNewline(error.text))
    return 0
  }
  const message = error instanceof Error ? error.message : String(error)
  io.err(`lodestar ${name}: ${message}\n`)
  return error instanceof UsageError ? 2 : 1
}

async function runHelp(rest: string[], io: CliIo): Promise<number> {
  const topic = rest[0]
  if (!topic) {
    io.out(topLevelHelp())
    return 0
  }
  if (!isCommand(topic)) {
    io.err(`lodestar: 未知命令 "${topic}"\n运行 lodestar --help 查看可用命令\n`)
    return 2
  }
  io.out(await helpFor(topic))
  return 0
}

async function runCommand(name: CommandName, rest: string[], commands: CliCommands, io: CliIo): Promise<number> {
  if (rest[0] === '--help' || rest[0] === '-h') {
    io.out(await helpFor(name))
    return 0
  }
  const usage = USAGE_LINES[name]
  if (usage && rest.length) {
    io.err(`lodestar ${name}: 接受 0 个参数\n用法: ${usage}\n`)
    return 2
  }
  try {
    return (await commands[name](rest, io)) ?? 0
  } catch (error) {
    // daemon 启动失败要保留 ConfigError 与安全日志语义，交给进程入口处理。
    if (name === 'start' && !(error instanceof UsageError)) throw error
    return reportCommandError(name, error, io)
  }
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? processIo
  const commands: CliCommands = { ...defaultCommands(), ...options.commands }
  const args = argv.slice()

  let noColor = false
  while (args[0] === '--no-color' || args[0] === '--color') {
    if (args.shift() === '--no-color') noColor = true
  }
  if (noColor) disableColor()

  const first = args[0]
  if (first === undefined) return runCommand('start', [], commands, io)
  if (first === '--version' || first === '-V') {
    io.out(`${lodestarVersion()}\n`)
    return 0
  }
  if (first === '--help' || first === '-h') {
    io.out(topLevelHelp())
    return 0
  }
  if (first === 'help') return runHelp(args.slice(1), io)
  // 安装新版本后，update 会以 `--agents-only` 重新执行当前入口，由新版本继续更新 Agent。
  if (first === '--agents-only') return runCommand('update', args, commands, io)

  const name = first
  if (!isCommand(name)) {
    io.err(`lodestar: 未知命令 "${first}"\n运行 lodestar --help 查看可用命令\n`)
    return 2
  }
  return runCommand(name, args.slice(1), commands, io)
}
