import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import type { AgentRunSnapshot } from '../agent-run-types'
import { agentIdentityListCard, agentRunCard, agentRunSummary, agentWorkerElementId } from './agents'
import { ELEMENTS } from './elements'

const identity: AgentIdentity = {
  id: 'agent:a', displayName: 'GLM · 5.3', tokenSourceId: 'glm', tokenSourceDisplay: 'GLM',
  provider: 'claude', model: 'GLM-5.3', modelDisplay: '5.3', defaultEffort: 'max',
  supportedEfforts: ['low', 'max'], sourceDefault: true, status: 'ready',
}

describe('delegated Agent cards', () => {
  test('renders the catalog as executable Agents without reviewer controls', () => {
    const card = JSON.stringify(agentIdentityListCard({ panelId: 'p', page: 0, totalPages: 1, catalog: [identity], failures: [] }))
    expect(card).toContain('主 Agent 统一分配和汇总')
    expect(card).toContain('agent_identity_page')
    expect(card).not.toContain('评审角色')
  })

  test('shows questions and progress without exposing internal delegation metadata', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'do it',
      depth: 1, status: 'needs_input', createdAt: new Date().toISOString(), workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'needs_input', output: '', sessionId: 'private-session-id', steps: [],
        pendingInput: { requestId: 'private-request-id', questions: [{ id: 'q', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
      }],
    }
    const rendered = agentRunCard(run) as any
    const card = JSON.stringify(rendered)
    expect(card).toContain('等待主 Agent 回答')
    expect(card).toContain('Proceed?')
    expect(card).toContain(agentWorkerElementId(identity.id))
    expect(rendered.body.elements[0].element_id).toBe(ELEMENTS.agentRunFooter)
    expect(card).not.toContain('depth')
    expect(card).not.toContain('private-session-id')
    expect(card).not.toContain('private-request-id')
    expect(agentRunSummary(run)).not.toContain('depth')
  })

  test('opens a single completed result and separates partial output from failure details', () => {
    const run: AgentRunSnapshot = {
      runId: 'r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: '检查接口',
      depth: 0, status: 'completed', createdAt: '2026-09-06T00:00:00Z', finishedAt: '2026-09-06T00:01:05Z',
      workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'completed', output: '接口检查通过', durationMs: 65_000, steps: [],
      }],
    }
    const card = agentRunCard(run) as any
    expect(card.body.elements[0].content).toContain('完成 1/1')
    expect(card.body.elements[0].content).toContain('用时 1.1m')
    expect(card.body.elements[0].content).not.toContain('失败 0')
    const panel = card.body.elements.find((item: any) => item.element_id === agentWorkerElementId(identity.id))
    expect(panel.expanded).toBe(true)
    expect(panel.elements[0].content).toContain('用时 1.1m')
    expect(JSON.stringify(panel)).toContain('接口检查通过')

    run.status = 'failed'
    run.workers[0]!.status = 'failed'
    run.workers[0]!.error = '连接失败'
    const failed = JSON.stringify(agentRunCard(run))
    expect(failed).toContain('失败原因')
    expect(failed).toContain('连接失败')
    expect(failed).toContain('已生成的内容')
    expect(failed).toContain('接口检查通过')
  })

  test('keeps parallel results independently expandable with stable, unique element IDs', () => {
    const run: AgentRunSnapshot = {
      runId: 'r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: '并行检查',
      depth: 0, status: 'running', createdAt: '2026-09-06T00:00:00Z', workers: ['a', 'b'].map(id => ({
        identityId: id, identityName: id, tokenSourceId: 'glm', provider: 'claude', model: 'GLM-5.3',
        effort: 'max', status: 'completed', output: '检查结果', steps: [],
      })),
    }
    const card = agentRunCard(run) as any
    expect(card.body.elements).toHaveLength(run.workers.length + 2)
    const panels = card.body.elements.filter((item: any) => item.element_id?.startsWith('aw_'))
    expect(panels.map((item: any) => item.expanded)).toEqual([false, false])
    expect(new Set(panels.map((item: any) => item.element_id)).size).toBe(2)
    expect(panels.every((item: any) => item.element_id.length <= 20)).toBe(true)
  })
})
