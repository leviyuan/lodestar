import { spawn } from 'node:child_process'
import type { RelayConfig } from './config'
import type { UsageSnapshotUnified } from './token-source'

const SCRIPT_TIMEOUT_MS = 15_000

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Execute the optional balance script without a shell. The key is sent only
 * through stdin and never appears in argv or diagnostic text. */
export async function readRelayUsage(siteId: string, cfg: RelayConfig, protocol: string): Promise<UsageSnapshotUnified> {
  const script = cfg.balance_script?.trim()
  if (!script) return { state: 'not_applicable', kind: 'balance', windows: [], reason: '未配置余额脚本' }
  const input = JSON.stringify({ site_id: siteId, base_url: cfg.base_url ?? '', protocol,
    api_key: cfg.api_key ?? '' })
  return new Promise<UsageSnapshotUnified>((resolve) => {
    let stdout = '', stderr = '', settled = false
    const child = spawn(script, [], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, LODESTAR_RELAY_USAGE: '1' } })
    const finish = (value: UsageSnapshotUnified) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ state: 'network', windows: [], reason: '余额脚本超时' }) }, SCRIPT_TIMEOUT_MS)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1_000_000) child.kill('SIGTERM') })
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16_384) stderr = stderr.slice(-16_384) })
    child.once('error', error => finish({ state: 'network', windows: [], reason: error.message }))
    child.once('close', code => {
      if (code !== 0) return finish({ state: 'network', windows: [], reason: `余额脚本退出码 ${code ?? 'MISS'}` })
      try {
        const parsed: unknown = JSON.parse(stdout)
        if (!object(parsed) || typeof parsed.state !== 'string' || !Array.isArray(parsed.windows)) {
          throw new Error('余额脚本返回格式无效')
        }
        const snapshot = parsed as unknown as UsageSnapshotUnified
        if (!['ok', 'no_credentials', 'not_applicable', 'rate_limited', 'network'].includes(snapshot.state)) {
          throw new Error(`余额脚本返回未知状态: ${snapshot.state}`)
        }
        if (snapshot.state === 'not_applicable' && !snapshot.kind) snapshot.kind = 'balance'
        finish(snapshot)
      } catch (error) {
        finish({ state: 'network', windows: [], reason: error instanceof Error ? error.message : String(error) })
      }
    })
    child.stdin.end(input + '\n')
  })
}
