/** `lodestar claude` 的实现：用指定账号目录运行原生 Claude Code，不做登录或收录自动化。 */
import { spawn } from 'cross-spawn'
import { constants } from 'node:os'
import { claudeAccounts } from './claude-accounts'
import { agentBin } from './agent-updates'
import { UsageError } from './cli-errors'
import { lodestarVersion } from './version'

export const usage = [
  '用法：lodestar claude <备注名|default> [-- <Claude 原生参数...>]',
  '  lodestar claude 工作号',
  '  lodestar claude 工作号 auth login',
  '  lodestar claude default --help',
  '  lodestar claude 工作号 mcp add srv -- npx -y pkg',
  '',
  '备注名之后的参数原样交给原生 Claude Code；只有紧跟备注名的 -- 是分隔符，其后的 -- 原样保留。',
  '使用 Lodestar 当前选中的 Claude 原生运行时，保留当前终端的 HOME、工作目录和其他环境。',
  '额外账号使用 ~/.claude-accounts/备注名；首次登录前准备共享配置，但不代办登录或收录账号。',
  '账号目录只保留登录状态，其余以全局配置为准并链接共享，备注账号的旧内容会被替换。',
  'default 保留当前终端 CLAUDE_CONFIG_DIR 的未设置状态或原始路径，不读取 Lodestar 的 [claude.env]。',
  '仅供用户本机终端使用；受管 Agent 任务请使用 lodestar agent。',
].join('\n')

/** Keep the same managed-context boundary as lodestar agent --project. */
function assertUserTerminal(): void {
  if (['LODESTAR_AGENT_ROLE', 'LODESTAR_AGENT_URL', 'LODESTAR_AGENT_CAPABILITY', 'DSH_LODESTAR_AGENT_CONTEXT']
    .some(key => process.env[key] !== undefined)) {
    throw new Error('lodestar claude 仅供用户本机终端使用；受管 Agent 任务须通过 lodestar agent 绑定当前会话，不能绕过 Claude 订阅调用限制')
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-V') {
    process.stdout.write(`${lodestarVersion()}\n`)
    return
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${usage}\n`)
    return
  }
  // 只有紧跟备注名的 `--` 是 lodestar 的分隔符；之后再出现的 `--` 属于原生命令本身
  // （如 `mcp add <名称> -- <命令>`），和备注名之后的其余参数一样原样交给原生 Claude Code。
  const [name] = argv
  const args = argv[1] === '--' ? argv.slice(2) : argv.slice(1)
  if (!name?.trim() || name === '--') throw new UsageError(usage)
  assertUserTerminal()
  const env = claudeAccounts.nativeCliEnv(name, process.env)
  const executable = agentBin('claude', 'claude')
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit', shell: false })
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const handlers = signals.map(signal => {
      const forward = () => {
        try { child.kill(signal) }
        catch (error) { process.stderr.write(`lodestar claude: 转发 ${signal} 失败：${error instanceof Error ? error.message : String(error)}\n`) }
      }
      process.on(signal, forward)
      return { signal, forward }
    })
    const cleanup = () => { for (const { signal, forward } of handlers) process.off(signal, forward) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal }) })
  })
  if (result.signal) {
    // Remove forwarding handlers before preserving the native signal termination.
    process.exitCode = 128 + (constants.signals[result.signal] ?? 0)
    process.kill(process.pid, result.signal)
  } else process.exitCode = result.code ?? 1
}

/** 统一入口与旧 bin 共用的错误出口。 */
export function reportClaudeError(error: unknown): void {
  process.stderr.write(`lodestar claude: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof UsageError ? 2 : 1
}
