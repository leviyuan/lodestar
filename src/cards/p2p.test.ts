import { describe, expect, test } from 'bun:test'
import { P2P_CONSOLE_HINT, p2pConsoleCard, type P2pConsoleOpts } from './p2p'
import type { SysInfo } from '../sysinfo'
import type { AccountUsage } from '../account-usage'

const sysinfo: SysInfo = {
  cpu: { cores: 8, load1: 0.42, load5: 0.37, load15: 0.29 },
  mem: { totalBytes: 16 * 1024 ** 3, availBytes: 6 * 1024 ** 3, usedBytes: 10 * 1024 ** 3, percent: 63 },
  // 工作目录所在磁盘：80% 已用，剩 15G。
  disks: [{ totalBytes: 75 * 1024 ** 3, availBytes: 15 * 1024 ** 3, usedBytes: 60 * 1024 ** 3, percent: 80 }],
  services: [{ name: 'codex-probe-runner', active: 'active', sub: 'running', lastActiveAgoSec: 120, stateAgoSec: 120 }],
  servicesError: null,
}
const accountUsages: AccountUsage[] = [
  { id: 'deepseek', label: 'DeepSeek', usage: { state: 'ok', kind: 'balance', balance: { remaining: 12.34, currency: 'CNY' }, windows: [] } },
  { id: 'glm', label: 'GLM', usage: { state: 'ok', windows: [{ kind: 'monthly', label: '月度工具', percent: 50, resetsAt: null }] } },
]
const peers: P2pConsoleOpts['peers'] = [
  // A caller may hand over account names and the live model; the 1:1 card decides what to show.
  { name: 'foo*x', status: 'idle', claudeAccountName: '备用账号', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'foo', status: 'working', uptimeMs: 65_000, codexAccountName: '工作订阅', model: 'gpt-5.2-codex', effort: 'high', workload: { background: 2, subagents: 1 } },
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
  test('the panel shows projects with accounts and models, every account quota and the host, without any reader gating', () => {
    const card = p2pConsoleCard({ peers, sysinfo, accountUsages }) as any
    expect(card.header.title.content).toBe('🌟 Lodestar')
    expect(card.header.subtitle.content).toBe('2 个项目运行中')
    // Only what needs attention becomes a header tag.
    expect(card.header.text_tag_list).toEqual([{ tag: 'text_tag', text: { tag: 'plain_text', content: '工作中 1' }, color: 'blue' }])
    expect(card.header.template).toBe('blue')
    expect(card.config.summary.content).toBe('Lodestar · 2 个项目运行中 · 工作中 1')
    expect(ids(card)).toEqual(['console_projects', 'console_usage', 'console_host', undefined])
    // Smaller body text and tighter spacing keep the whole overview compact.
    expect(card.body.padding).toBe('8px')
    expect(card.body.vertical_spacing).toBe('8px')
    const projects = section(card, 'console_projects')
    expect(projects.expanded).toBe(true)
    expect(projects.padding).toBe('6px')
    expect(projects.vertical_spacing).toBe('4px')
    expect(projects.elements[0].text_size).toBe('notation')
    expect(projects.header.title.content).toBe('🗂 活跃项目 (2)')
    // Sorted by name, so a group's temp and wt groups sit next to it; the status dot leads each block
    // and already says idle/working, so the row carries no status words; the counts and the uptime keep
    // their own line, and the account shares one line with the model the project actually runs.
    expect(blocks(card)).toEqual([
      "⚙️ **`foo`**\n<font color='grey'>🤖1·⏳2 · 已运行 1m</font>\n<font color='grey'>Codex·工作订阅 · gpt-5.2-codex/high</font>",
      "🟢 **`foo*x`**\n<font color='grey'>Claude·备用账号 · claude-opus-5-5/high</font>",
    ])
    const usage = section(card, 'console_usage')
    expect(usage.expanded).toBe(true)
    expect(usage.header.title.content).toBe('📊 账号额度')
    expect(usage.elements).toEqual([{ tag: 'markdown', text_size: 'notation', content:
      "**DeepSeek**　余额 ¥12.34\n\n**GLM**\n月工具　<font color='green'>▰▰▰▱▱▱</font> 50%" }])
    const host = section(card, 'console_host')
    // The host opens with the card, titled by its section name; the values are in the body.
    expect(host.expanded).toBe(true)
    expect(host.header.title.content).toBe('🖥 主机')
    // 硬盘按工作目录所在的磁盘显示占用与剩余。
    expect(host.elements[0].content).toContain('**硬盘**　占用 80% · 剩余 15G')
    expect(card.body.elements.at(-1)).toEqual({ tag: 'markdown', text_size: 'notation', content: P2P_CONSOLE_HINT })
    const body = JSON.stringify(card)
    expect(body).not.toContain('当前')
    expect(body).not.toContain('"button"')
    expect(body).not.toContain('callback')
  })

  test('approvals and failed services are called out in the header, approvals in orange', () => {
    const failed: SysInfo = { ...sysinfo, services: [
      { name: 'cc-a', active: 'failed', sub: 'failed', lastActiveAgoSec: 60, stateAgoSec: 60 },
      ...sysinfo.services,
    ] }
    const card = p2pConsoleCard({ sysinfo: failed, accountUsages: [], peers: [
      ...peers, { name: 'bar', status: 'awaiting_permission', uptimeMs: 8_000 },
    ] }) as any
    expect(card.header.template).toBe('orange')
    expect(card.header.text_tag_list.map((tag: any) => [tag.text.content, tag.color])).toEqual([
      ['等审批 1', 'orange'], ['工作中 1', 'blue'], ['服务失败 1', 'red'],
    ])
    expect(blocks(card)[0]).toBe("🔐 **`bar`**\n<font color='grey'>已运行 8s</font>")
    expect(section(card, 'console_host').header.title.content).toBe('🖥 主机')
    expect(section(card, 'console_usage').elements[0].content).toBe("<font color='grey'>暂无已配置账号</font>")
  })

  test('a project\'s temp and wt groups stay next to it, even beside other projects sharing its prefix', () => {
    const names = ['feishu-web*x', 'feishu*btw', 'feishu_v2', 'feishu[wt]*x', 'feishu-web', 'feishu', 'feishu[wt]', 'alpha']
    const card = p2pConsoleCard({ peers: names.map(name => ({ name, status: 'idle' as const })) }) as any
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
    const card = p2pConsoleCard({ peers: [], notice: '⚠️ 部分项目读取失败，已隐藏' }) as any
    const elements = card.body.elements
    expect(elements[0]).toEqual({ tag: 'markdown', text_size: 'notation', content: '⚠️ 部分项目读取失败，已隐藏' })
    expect(elements[1].header.title.content).toBe('🗂 活跃项目 (0)')
    expect(elements[1].elements).toEqual([{ tag: 'markdown', text_size: 'notation', content: "<font color='grey'>暂无运行中的项目</font>" }])
    expect(elements.at(-1).content).toBe(P2P_CONSOLE_HINT)
    expect(card.header.subtitle).toBeUndefined()
    expect(card.header.text_tag_list).toBeUndefined()
    expect(card.header.template).toBe('green')
  })

  test('failed accounts keep only MISS inline and their reasons fold into a collapsed panel', () => {
    const failed: AccountUsage = { id: 'glm', label: 'GLM', usage: { state: 'network', reason: 'upstream <offline>', windows: [] } }
    const ok: AccountUsage = { id: 'deepseek', label: 'DeepSeek', usage: { state: 'ok', kind: 'balance', balance: { remaining: 1, currency: 'CNY' }, windows: [] } }
    const card = p2pConsoleCard({ peers: [], accountUsages: [ok, failed] }) as any
    const usage = section(card, 'console_usage')
    expect(usage.elements[0].content).toBe("**DeepSeek**　余额 ¥1.00\n\n**GLM**　<font color='red'>MISS</font>")
    const details = usage.elements[1]
    expect(details.tag).toBe('collapsible_panel')
    expect(details.expanded).toBe(false)
    expect(details.header.title.content).toBe('⚠️ 额度读取失败 (1)')
    // 原因完整放进折叠面板，并且按行内文本转义，不注入卡片标签。
    expect(details.elements[0].content).toContain('GLM')
    expect(details.elements[0].content).toContain('upstream &#60;offline&#62;')
    // 主机读不到服务列表时也只留 MISS，原因折叠。
    const hostCard = p2pConsoleCard({ peers: [], accountUsages: [], sysinfo: { ...sysinfo, servicesError: 'launchctl MISS' } }) as any
    const host = section(hostCard, 'console_host')
    expect(host.elements[0].content).toContain("<font color='red'>MISS</font>")
    expect(host.elements[0].content).not.toContain('launchctl MISS')
    expect(host.elements[1].expanded).toBe(false)
    expect(host.elements[1].header.title.content).toBe('⚠️ 主机读取失败')
    expect(host.elements[1].elements[0].content).toBe('服务列表：launchctl MISS')
  })

  test('many projects and accounts stay well inside the card component limit', () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ name: `p${String(index).padStart(2, '0')}`, status: 'idle' as const }))
    const usages = Array.from({ length: 25 }, (_, index) => ({ id: `a${index}`, label: `a${index}`, usage: accountUsages[0]!.usage }))
    const card = p2pConsoleCard({ peers: many, sysinfo, accountUsages: usages }) as any
    // 20 projects and 10 accounts per markdown element.
    expect(section(card, 'console_projects').elements).toHaveLength(3)
    expect(section(card, 'console_usage').elements).toHaveLength(3)
    expect(blocks(card)).toHaveLength(45)
    const count = (elements: any[]): number => elements.reduce((sum, element) => sum + 1 + count(element.elements ?? []), 0)
    expect(count(card.body.elements)).toBeLessThan(20)
  })

  test('element ids stay within the Card Kit limit and unique', () => {
    const card = p2pConsoleCard({ peers: [], sysinfo, accountUsages }) as any
    const elementIds = ids(card).filter(Boolean) as string[]
    for (const id of elementIds) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)
    expect(new Set(elementIds).size).toBe(elementIds.length)
  })
})
