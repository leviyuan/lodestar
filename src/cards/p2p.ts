/**
 * 单聊（1:1）只读面板：全局总览，以清晰为先。群里的 `hi` 只看本项目，全部项目、主机与全部账号额度都在这里。
 * 标题副标题写运行中的项目数，标签写出等审批、工作中的项目数和挂掉的服务数；活跃项目每个两行，
 * 账号额度每个账号一块、每个窗口一行。模板不判断可见性，只渲染调用方给的行；
 * 受限（外部联系人）时自己去掉账号名，并且不放主机与额度。
 */
import type { AccountUsage } from '../account-usage'
import { mainSessionName } from '../session-name'
import type { SysInfo } from '../sysinfo'
import { accountUsageBlock, escapeInlineMarkdown } from './account-usage'
import { consoleHostElement, failedServiceCount, fmtUptime, sessionStatusEmoji, sessionStatusLabel, type ConsolePeer } from './console'
import { ELEMENTS } from './elements'
import { sessionWorkloadLabel } from './task-kind'

/** 单聊面板底部的一行说明：单聊没有任何操作。 */
export const P2P_CONSOLE_HINT = '单聊只能查看；在项目群里发 hi / btw 使用。'

/** 一个 markdown 元素最多放这么多块（同 bl），避免项目或账号很多时单元素内容超限；卡片组件数也远低于 200。 */
const PROJECTS_PER_MARKDOWN = 20
const ACCOUNTS_PER_MARKDOWN = 10

export interface P2pConsoleOpts {
  /** 发起人可见的运行中会话。 */
  peers: ConsolePeer[]
  /** 外部联系人：行内不带账号名，不含主机与全部账号额度。 */
  restricted: boolean
  sysinfo?: SysInfo
  accountUsages?: AccountUsage[]
  /** 部分项目读取失败等提示，不含 ID。 */
  notice?: string
}

const grey = (text: string): string => `<font color='grey'>${text}</font>`

/** 多个块合进一个 markdown，块之间空一行；超过上限再开下一个元素。 */
function blockElements(blocks: string[], perElement: number): object[] {
  const elements: object[] = []
  for (let index = 0; index < blocks.length; index += perElement) {
    elements.push({ tag: 'markdown', content: blocks.slice(index, index + perElement).join('\n\n') })
  }
  return elements
}

/** 项目按所属主项目、再按名称排序：主群和它的 `名*` 临时群、`名[` wt 群总排在一起，
 * 不会被同前缀的其他项目（`名_v2`、`名-web`）隔开；每次顺序相同。 */
function byName(a: ConsolePeer, b: ConsolePeer): number {
  return mainSessionName(a.name).localeCompare(mainSessionName(b.name), 'zh-Hans-CN')
    || a.name.localeCompare(b.name, 'zh-Hans-CN')
}

/** 项目一块两行：首行状态圆点打头（各行对齐，一眼扫完）、项目名、状态与后台计数；次行灰字写实际账号与运行时长。
 * 受限时没有账号。 */
function projectBlock(peer: ConsolePeer, restricted: boolean): string {
  // 「空闲」只说明主线程空着；后台进程和子 Agent 仍在跑时紧跟状态写出数量。
  const workload = sessionWorkloadLabel(peer.workload)
  const head = `${sessionStatusEmoji(peer.status)} **\`${peer.name}\`**　${sessionStatusLabel(peer.status)}${workload ? ` · ${workload}` : ''}`
  const account = restricted ? null
    : peer.claudeAccountName !== undefined ? `Claude·${escapeInlineMarkdown(peer.claudeAccountName)}`
    : peer.codexAccountName !== undefined ? `Codex·${escapeInlineMarkdown(peer.codexAccountName)}`
    : null
  const uptime = peer.uptimeMs != null && peer.uptimeMs > 0 ? `已运行 ${fmtUptime(peer.uptimeMs)}` : null
  const details = [account, uptime].filter((part): part is string => part !== null)
  return details.length ? `${head}\n${grey(details.join(' · '))}` : head
}

function section(elementId: string, title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel', element_id: elementId, expanded: true,
    header: { title: { tag: 'plain_text', content: title }, background_color: 'blue-50' },
    border: { color: 'blue-100', corner_radius: '8px' }, padding: '8px', vertical_spacing: '8px',
    elements,
  }
}

function projectsSection(peers: ConsolePeer[], restricted: boolean): object {
  const blocks = [...peers].sort(byName).map(peer => projectBlock(peer, restricted))
  return section(ELEMENTS.consoleProjects, `🗂 活跃项目 (${peers.length})`,
    blocks.length ? blockElements(blocks, PROJECTS_PER_MARKDOWN) : [{ tag: 'markdown', content: grey('暂无运行中的项目') }])
}

function usageSection(rows: AccountUsage[] | undefined): object {
  return section(ELEMENTS.consoleUsage, '📊 账号额度',
    rows === undefined ? [{ tag: 'markdown', content: '加载中…' }]
      : rows.length ? blockElements(rows.map(accountUsageBlock), ACCOUNTS_PER_MARKDOWN)
      : [{ tag: 'markdown', content: grey('暂无已配置账号') }])
}

function textTag(content: string, color: string): object {
  return { tag: 'text_tag', text: { tag: 'plain_text', content }, color }
}

/** 单聊（1:1）只读面板：没有会话名、当前模型和按钮。 */
export function p2pConsoleCard(opts: P2pConsoleOpts): object {
  const count = (status: ConsolePeer['status']) => opts.peers.filter(peer => peer.status === status).length
  const awaiting = count('awaiting_permission')
  const working = count('working')
  const failed = opts.restricted ? 0 : failedServiceCount(opts.sysinfo)
  const subtitle = opts.peers.length ? `${opts.peers.length} 个项目运行中` : ''
  // 标题标签只写要留意的：等审批、工作中的项目数与挂掉的服务数（飞书最多显示 3 个）。
  const tags = [
    ...(awaiting ? [{ text: `等审批 ${awaiting}`, color: 'orange' }] : []),
    ...(working ? [{ text: `工作中 ${working}`, color: 'blue' }] : []),
    ...(failed ? [{ text: `服务失败 ${failed}`, color: 'red' }] : []),
  ]
  const summary = ['Lodestar', subtitle, ...tags.map(tag => tag.text)].filter(Boolean).join(' · ')
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: summary } },
    header: {
      title: { tag: 'plain_text', content: '🌟 Lodestar' },
      ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
      ...(tags.length ? { text_tag_list: tags.map(tag => textTag(tag.text, tag.color)) } : {}),
      template: awaiting ? 'orange' : working ? 'blue' : 'green',
    },
    body: {
      elements: [
        ...(opts.notice ? [{ tag: 'markdown', content: opts.notice }] : []),
        projectsSection(opts.peers, opts.restricted),
        ...(opts.restricted ? [] : [usageSection(opts.accountUsages), consoleHostElement(opts.sysinfo)]),
        { tag: 'markdown', text_size: 'notation', content: P2P_CONSOLE_HINT },
      ],
    },
  }
}
