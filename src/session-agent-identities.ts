import { randomUUID } from 'node:crypto'
import type { Session } from './session'
import * as cards from './cards'
import * as feishu from './feishu'
import { getAgentIdentityCatalog } from './agent-identities'
import { pendingTokenSourceModelRefresh } from './token-source'
import type { ModelActionResult } from './session-util'

const PAGE_SIZE = 8
const PANEL_TTL_MS = 30 * 60 * 1000

interface AgentIdentityPanelState {
  ownerOpenId: string
  codexAccountId: string
  page: number
  createdAt: number
}

const panels = new Map<string, AgentIdentityPanelState>()

export async function showAgentIdentityPanel(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId.trim()) {
    await feishu.sendTextRaw(s.chatId, '❌ 无法确认操作者身份，未打开 agents 面板')
    return
  }
  prunePanels()
  await pendingTokenSourceModelRefresh()
  const panelId = `agents_${randomUUID()}`
  panels.set(panelId, { ownerOpenId: userOpenId, codexAccountId: s.codexAccountId(), page: 0, createdAt: Date.now() })
  const messageId = await feishu.sendCard(s.chatId, listCard(panelId))
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ agents 面板发送失败')
}

export function onAgentIdentityPage(
  panelId: string,
  pageRaw: unknown,
  userOpenId: string,
): ModelActionResult {
  const panel = requirePanel(panelId, userOpenId)
  const page = Number(pageRaw)
  if (!Number.isInteger(page)) return failure('无效页码')
  const totalPages = pageCount(panel.codexAccountId)
  panel.page = Math.max(0, Math.min(totalPages - 1, page))
  panel.createdAt = Date.now()
  return { ok: true, message: '已更新', card: listCard(panelId) }
}

function listCard(panelId: string): object {
  const panel = panels.get(panelId)
  if (!panel) throw new Error('Agent 身份面板已过期')
  const catalog = getAgentIdentityCatalog(panel.codexAccountId)
  const totalPages = Math.max(1, Math.ceil(catalog.identities.length / PAGE_SIZE))
  panel.page = Math.min(panel.page, totalPages - 1)
  const start = panel.page * PAGE_SIZE
  return cards.agentIdentityListCard({
    panelId,
    page: panel.page,
    totalPages,
    catalog: catalog.identities.slice(start, start + PAGE_SIZE),
    failures: catalog.sourceFailures,
  })
}

function pageCount(accountId: string): number {
  return Math.max(1, Math.ceil(getAgentIdentityCatalog(accountId).identities.length / PAGE_SIZE))
}

function requirePanel(panelId: string, userOpenId: string): AgentIdentityPanelState {
  prunePanels()
  const panel = panels.get(panelId)
  if (!panel) throw new Error('Agent 身份面板已过期，请重新发送 agents')
  if (!panel.ownerOpenId || !userOpenId || panel.ownerOpenId !== userOpenId) {
    throw new Error('只有打开该面板的用户可操作')
  }
  return panel
}

function failure(message: string): ModelActionResult {
  return { ok: false, message, card: cards.selectionResultCard({ title: 'agents', message, ok: false }) }
}

function prunePanels(): void {
  const cutoff = Date.now() - PANEL_TTL_MS
  for (const [id, panel] of panels) if (panel.createdAt < cutoff) panels.delete(id)
}
