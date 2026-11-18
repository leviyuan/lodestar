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
  { id: 'glm', label: 'GLM', usage: { state: 'ok', windows: [{ kind: 'monthly', label: '月度工具', percent: 50, resetsAt: null }] } },
]
const peers: P2pConsoleOpts['peers'] = [
  // A caller may hand over account names; the 1:1 card decides what to show.
  { name: 'foo*x', status: 'idle', claudeAccountName: '备用账号' },
  { name: 'foo', status: 'working', uptimeMs: 65_000, codexAccountName: '工作订阅', workload: { background: 2, subagents: 1 } },
]

function ids(card: any): unknown[] {
  return card.body.elements.map((element: any) => element.element_id)
}

function section(card: any, id: string): any {
  return card.body.elements.find((element: any) => element.element_id === id)
}

/** Every project block of the active-projects section, in display order. */
function blocks(card: any): string[] {
  return section(card, 'console_projects').elements.flatMap((element: any) => element.content.split('\n\n'))
}

describe('1:1 read-only panel card', () => {
  test('an internal requester sees projects with accounts, every account quota and the host, but no session or model', () => {
    const card = p2pConsoleCard({ peers, restricted: false, sysinfo, accountUsages }) as any
    expect(card.header.title.content).toBe('🌟 Lodestar')
    expect(card.header.subtitle.content).toBe('2 个项目运行中')
    // Only what needs attention becomes a header tag.
    expect(card.header.text_tag_list).toEqual([{ tag: 'text_tag', text: { tag: 'plain_text', content: '工作中 1' }, color: 'blue' }])
    expect(card.header.template).toBe('blue')
    expect(card.config.summary.content).toBe('Lodestar · 2 个项目运行中 · 工作中 1')
    expect(ids(card)).toEqual(['console_projects', 'console_usage', 'console_host', undefined])
    const projects = section(card, 'console_projects')
    expect(projects.expanded).toBe(true)
    expect(projects.header.title.content).toBe('🗂 活跃项目 (2)')
    // Sorted by name, so a group's temp and wt groups sit next to it; the status dot leads each block.
    expect(blocks(card)).toEqual([
      "⚙️ **`foo`**　工作中 · 子Agent1·后台2\n<font color='grey'>Codex·工作订阅 · 已运行 1m</font>",
      "🟢 **`foo*x`**　空闲\n<font color='grey'>Claude·备用账号</font>",
    ])
    const usage = section(card, 'console_usage')
    expect(usage.expanded).toBe(true)
    expect(usage.header.title.content).toBe('📊 账号额度')
    expect(usage.elements).toEqual([{ tag: 'markdown', content:
      "**DeepSeek**　余额 ¥12.34\n\n**GLM**\n月工具　<font color='green'>▰▰▰▱▱▱</font> 50%" }])
    const host = section(card, 'console_host')
    expect(host.expanded).toBe(false)
    expect(host.header.title.content).toBe('🖥 主机 · 负载 0.42 · 内存 63% · 服务 1')
    expect(card.body.elements.at(-1)).toEqual({ tag: 'markdown', text_size: 'notation', content: P2P_CONSOLE_HINT })
    const body = JSON.stringify(card)
    expect(body).not.toContain('当前')
    expect(body).not.toContain('"button"')
    expect(body).not.toContain('callback')
  })

  test('an external requester sees only names, states, uptime and counts, even if accounts are passed in', () => {
    const failed = { ...sysinfo, services: [{ ...sysinfo.services[0]!, active: 'failed' }] }
    const card = p2pConsoleCard({ peers, restricted: true, sysinfo: failed, accountUsages }) as any
    expect(ids(card)).toEqual(['console_projects', undefined])
    expect(blocks(card)).toEqual([
      "⚙️ **`foo`**　工作中 · 子Agent1·后台2\n<font color='grey'>已运行 1m</font>",
      '🟢 **`foo*x`**　空闲',
    ])
    const body = JSON.stringify(card)
    for (const hidden of ['工作订阅', '备用账号', 'Codex·', 'Claude·', '主机', '账号额度', 'DeepSeek', 'codex-probe-runner', '服务失败']) {
      expect(body).not.toContain(hidden)
    }
  })

  test('approvals and failed services are called out in the header, approvals in orange', () => {
    const failed: SysInfo = { ...sysinfo, services: [
      { name: 'cc-a', active: 'failed', sub: 'failed', lastActiveAgoSec: 60, stateAgoSec: 60 },
      ...sysinfo.services,
    ] }
    const card = p2pConsoleCard({ restricted: false, sysinfo: failed, accountUsages: [], peers: [
      ...peers, { name: 'bar', status: 'awaiting_permission', uptimeMs: 8_000 },
    ] }) as any
    expect(card.header.template).toBe('orange')
    expect(card.header.text_tag_list.map((tag: any) => [tag.text.content, tag.color])).toEqual([
      ['等审批 1', 'orange'], ['工作中 1', 'blue'], ['服务失败 1', 'red'],
    ])
    expect(blocks(card)[0]).toBe("🔐 **`bar`**　<font color='orange'>等审批</font>\n<font color='grey'>已运行 8s</font>")
    expect(section(card, 'console_host').header.title.content).toBe('🖥 主机 · 负载 0.42 · 内存 63% · 服务 2 · ❌ 失败 1')
    expect(section(card, 'console_usage').elements[0].content).toBe("<font color='grey'>暂无已配置账号</font>")
  })

  test('a project\'s temp and wt groups stay next to it, even beside other projects sharing its prefix', () => {
    const names = ['feishu-web*x', 'feishu*btw', 'feishu_v2', 'feishu[wt]*x', 'feishu-web', 'feishu', 'feishu[wt]', 'alpha']
    const card = p2pConsoleCard({ restricted: true, peers: names.map(name => ({ name, status: 'idle' as const })) }) as any
    const shown = blocks(card).map(block => block.match(/`([^`]+)`/)![1])
    expect(shown).toHaveLength(names.length)
    expect(shown[0]).toBe('alpha')
    // Each project's own groups form one contiguous run, the project itself first.
    const run = (project: string) => shown.map((name, index) => [name, index] as const)
      .filter(([name]) => name === project || name.startsWith(`${project}*`) || name.startsWith(`${project}[`))
      .map(([, index]) => index)
    for (const [project, size] of [['feishu', 4], ['feishu_v2', 1], ['feishu-web', 2]] as const) {
      const indexes = run(project)
      expect(indexes).toHaveLength(size)
      expect(indexes.at(-1)! - indexes[0]!).toBe(size - 1)
      expect(shown[indexes[0]!]).toBe(project)
    }
  })

  test('an empty list renders and a lookup note goes first', () => {
    const card = p2pConsoleCard({ peers: [], restricted: true, notice: '⚠️ 部分项目读取失败，已隐藏' }) as any
    const elements = card.body.elements
    expect(elements[0]).toEqual({ tag: 'markdown', content: '⚠️ 部分项目读取失败，已隐藏' })
    expect(elements[1].header.title.content).toBe('🗂 活跃项目 (0)')
    expect(elements[1].elements).toEqual([{ tag: 'markdown', content: "<font color='grey'>暂无运行中的项目</font>" }])
    expect(elements[2].content).toBe(P2P_CONSOLE_HINT)
    expect(card.header.subtitle).toBeUndefined()
    expect(card.header.text_tag_list).toBeUndefined()
    expect(card.header.template).toBe('green')
  })

  test('many projects and accounts stay well inside the card component limit', () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ name: `p${String(index).padStart(2, '0')}`, status: 'idle' as const }))
    const usages = Array.from({ length: 25 }, (_, index) => ({ id: `a${index}`, label: `a${index}`, usage: accountUsages[0]!.usage }))
    const card = p2pConsoleCard({ peers: many, restricted: false, sysinfo, accountUsages: usages }) as any
    // 20 projects and 10 accounts per markdown element.
    expect(section(card, 'console_projects').elements).toHaveLength(3)
    expect(section(card, 'console_usage').elements).toHaveLength(3)
    expect(blocks(card)).toHaveLength(45)
    const count = (elements: any[]): number => elements.reduce((sum, element) => sum + 1 + count(element.elements ?? []), 0)
    expect(count(card.body.elements)).toBeLessThan(20)
  })

  test('element ids stay within the Card Kit limit and unique', () => {
    const card = p2pConsoleCard({ peers: [], restricted: false, sysinfo, accountUsages }) as any
    const elementIds = ids(card).filter(Boolean) as string[]
    for (const id of elementIds) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)
    expect(new Set(elementIds).size).toBe(elementIds.length)
  })
})
