/**
 * 单聊（1:1）只读面板。用 `console.ts` 导出的活跃项目、主机与额度元素拼成，不改群里 `hi` 面板的模板。
 * 模板不判断可见性，只渲染调用方给的行；受限（外部联系人）时自己去掉账号名，并且不放主机与额度。
 */
import type { AccountUsage } from '../account-usage'
import type { SysInfo } from '../sysinfo'
import { consoleHostElement, consoleMainElement, consoleUsageElement, type ConsoleOpts } from './console'

type ConsolePeer = NonNullable<ConsoleOpts['peers']>[number]

/** 单聊面板底部的一行说明：单聊没有任何操作。 */
export const P2P_CONSOLE_HINT = '单聊只能查看；在项目群里发 hi / btw 使用。'

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

/** 单聊没有「当前」会话；受限时只留名字、状态、时长和后台计数。 */
function p2pPeer(peer: ConsolePeer, restricted: boolean): ConsolePeer {
  if (!restricted) return { ...peer, isCurrent: false }
  return { name: peer.name, status: peer.status, uptimeMs: peer.uptimeMs, isCurrent: false, workload: peer.workload }
}

/** 单聊（1:1）只读面板：没有会话名、当前模型和按钮。 */
export function p2pConsoleCard(opts: P2pConsoleOpts): object {
  const consoleOpts: ConsoleOpts = {
    sessionName: '',
    status: 'idle',
    peers: opts.peers.map(peer => p2pPeer(peer, opts.restricted)),
    accountUsages: opts.accountUsages,
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🌟 Lodestar' }, template: 'green' },
    body: {
      elements: [
        ...(opts.notice ? [{ tag: 'markdown', content: opts.notice }] : []),
        // 单聊里活跃项目是主要内容，默认展开。
        { ...consoleMainElement(consoleOpts), expanded: true },
        ...(opts.restricted ? [] : [consoleHostElement(opts.sysinfo), consoleUsageElement(consoleOpts)]),
        { tag: 'markdown', text_size: 'notation', content: P2P_CONSOLE_HINT },
      ],
    },
  }
}
