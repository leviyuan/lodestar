import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ReclaudeRuntime {
  proxyUrl: string
  caFile: string
}

/** 读取官方客户端的登录和运行状态，不启动服务，也不改写 Claude 登录。 */
export function readReclaudeRuntime(root = join(homedir(), '.reclaude'),
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): ReclaudeRuntime {
  const device = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8'))
  if (typeof device?.sk !== 'string' || !device.sk.startsWith('sk-rec-') || device.sk.length <= 7) {
    throw new Error('ReClaude 设备未登录；请先运行 reclaude login')
  }
  const credentials = JSON.parse(readFileSync(join(claudeConfigDir, '.credentials.json'), 'utf8'))
  if (credentials?.claudeAiOauth?.accessToken !== device.sk) {
    throw new Error('本机 Claude 登录与 ReClaude 设备不匹配；请运行 reclaude 完成账号同步')
  }
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  const daemon = state?.daemon
  if (daemon?.running !== true || !Number.isInteger(daemon.pid) || daemon.pid <= 0) {
    throw new Error('ReClaude 后台未运行；请先运行 reclaude daemon --detach')
  }
  if (!Number.isInteger(daemon.port) || daemon.port < 1 || daemon.port > 65535) {
    throw new Error('ReClaude 后台端口无效')
  }
  // 不能使用退出进程残留的 state.json，也不能换用本机其他订阅。
  process.kill(daemon.pid, 0)
  if (state.gateway?.healthy !== true) throw new Error('ReClaude 接入服务当前不可用')
  const caFile = join(root, 'ca.pem')
  if (!statSync(caFile).isFile()) throw new Error('ReClaude 本地 CA 证书不可用')
  return { proxyUrl: `http://127.0.0.1:${daemon.port}`, caFile }
}
