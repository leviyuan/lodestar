import { describe, expect, test } from 'bun:test'
import { P2P_CONSOLE_HINT, p2pConsoleCard, type P2pConsoleOpts } from './p2p'
import type { SysInfo } from '../sysinfo'
import type { AccountUsage } from '../account-usage'

const sysinfo: SysInfo = {
  cpu: { cores: 8, load1: 0.42, load5: 0.37, load15: 0.29 },
  mem: { totalBytes: 16 * 1024 ** 3, availBytes: 6 * 1024 ** 3, usedBytes: 10 * 1024 ** 3, percent: 63 },
  disks: [],
  services: [{ name: 'codex-probe-runner', active: 'active', sub: 'running', lastActiveAgoSec: 120, stateAgoSec: 120 }],
  servicesError: null,
}
const accountUsages: AccountUsage[] = [
  { id: 'deepseek', label: 'DeepSeek', usage: { state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] } },
]
const peers: P2pConsoleOpts['peers'] = [
  // A caller may hand over a current mark and account names; the 1:1 card decides what to show.
  { name: 'foo', isCurrent: true, status: 'working', uptimeMs: 65_000, codexAccountName: '工作订阅', workload: { background: 2, subagents: 1 } },
  { name: 'foo*x', isCurrent: false, status: 'idle', claudeAccountName: '备用账号' },
]

function ids(card: any): unknown[] {
  return card.body.elements.map((element: any) => element.element_id)
}

describe('1:1 read-only panel card', () => {
  test('an internal requester sees projects with accounts, host and quota, but no session or model', () => {
    const card = p2pConsoleCard({ peers, restricted: false, sysinfo, accountUsages }) as any
    expect(card.header.title.content).toBe('🌟 Lodestar')
    const elements = card.body.elements
    expect(ids(card)).toEqual(['console_projects', 'console_host', 'console_usage', undefined])
    expect(elements[0].expanded).toBe(true)
    expect(elements[0].header.title.content).toBe('🗂 活跃项目 (2) · 工作中 1')
    expect(elements[0].elements[0].content.split('\n')).toEqual([
      '　· ⚙️ `foo` · 工作中 · 子Agent1·后台2 · 1m · Codex·工作订阅',
      '　· 🟢 `foo*x` · 闲 · Claude·备用账号',
    ])
    expect(elements[1].header.title.content).toBe('🖥 主机 · L0.42 · M63% · S1')
    expect(elements[2].elements[0].content).toBe('**DeepSeek**　余额 ¥12.34')
    expect(elements.at(-1)).toEqual({ tag: 'markdown', text_size: 'notation', content: P2P_CONSOLE_HINT })
    const body = JSON.stringify(card)
    expect(body).not.toContain('当前')
    expect(body).not.toContain('"button"')
    expect(body).not.toContain('callback')
  })

  test('an external requester sees only names, states, uptime and counts, even if accounts are passed in', () => {
    const card = p2pConsoleCard({ peers, restricted: true, sysinfo, accountUsages }) as any
    expect(ids(card)).toEqual(['console_projects', undefined])
    expect(card.body.elements[0].elements[0].content.split('\n')).toEqual([
      '　· ⚙️ `foo` · 工作中 · 子Agent1·后台2 · 1m',
      '　· 🟢 `foo*x` · 闲',
    ])
    const body = JSON.stringify(card)
    for (const hidden of ['工作订阅', '备用账号', 'Codex·', 'Claude·', '主机', '全部账号额度', 'DeepSeek', 'codex-probe-runner', '当前']) {
      expect(body).not.toContain(hidden)
    }
  })

  test('an empty list renders and a lookup note goes first', () => {
    const card = p2pConsoleCard({ peers: [], restricted: true, notice: '⚠️ 部分项目读取失败，已隐藏' }) as any
    const elements = card.body.elements
    expect(elements[0]).toEqual({ tag: 'markdown', content: '⚠️ 部分项目读取失败，已隐藏' })
    expect(elements[1].header.title.content).toBe('🗂 活跃项目 (0)')
    expect(elements[1].elements[0].content).toBe('_无_')
    expect(elements[2].content).toBe(P2P_CONSOLE_HINT)
  })

  test('element ids stay within the Card Kit limit and unique', () => {
    const card = p2pConsoleCard({ peers: [], restricted: false, sysinfo, accountUsages }) as any
    const elementIds = ids(card).filter(Boolean) as string[]
    for (const id of elementIds) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)
    expect(new Set(elementIds).size).toBe(elementIds.length)
  })
})
