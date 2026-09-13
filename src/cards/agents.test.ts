import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import type { AgentRunSnapshot } from '../agent-run-types'
import { agentIdentityListCard, agentRunCard, agentRunSummary, agentRunElementId } from './agents'

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
      runId: 'agent_r', sessionName: 'project', chatId: 'chat', workDir: '/repo', description: '检查接口', prompt: 'do it',
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
    expect(card).toContain(agentRunElementId(run.runId))
    expect(rendered.header).toBeUndefined()
    expect(rendered.body.elements).toHaveLength(1)
    expect(rendered.body.elements[0].expanded).toBe(false)
    expect(rendered.body.elements[0].header.title.content).toBe('❓ 等待主 Agent 回复 · 检查接口')
    expect(rendered.body.elements[0].header.title.content).not.toContain('do it')
    expect(card).not.toContain('depth')
    expect(card).not.toContain('private-session-id')
    expect(card).not.toContain('private-request-id')
    expect(agentRunSummary(run)).not.toContain('depth')
  })

  test('keeps completed and failed results collapsed with all details available', () => {
    const run: AgentRunSnapshot = {
      runId: 'r', sessionName: 'project', chatId: 'chat', workDir: '/repo', description: '检查接口', prompt: '检查接口',
      depth: 0, status: 'completed', createdAt: '2026-09-06T00:00:00Z', finishedAt: '2026-09-06T00:01:05Z',
      workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'completed', output: '接口检查通过', durationMs: 65_000, steps: [],
      }],
    }
    const card = agentRunCard(run) as any
    expect(card.body.elements[0].elements[0].content).toContain('完成 1/1')
    expect(card.body.elements[0].elements[0].content).toContain('用时 1.1m')
    expect(card.body.elements[0].elements[0].content).not.toContain('失败 0')
    const panel = card.body.elements.find((item: any) => item.element_id === agentRunElementId(run.runId))
    expect(panel.expanded).toBe(false)
    expect(panel.elements[0].content).toContain('用时 1.1m')
    expect(JSON.stringify(panel)).toContain('接口检查通过')

    run.status = 'failed'
    run.workers[0]!.status = 'failed'
    run.workers[0]!.error = '连接失败'
    const failedCard = agentRunCard(run) as any
    expect(failedCard.body.elements[0].expanded).toBe(false)
    expect(failedCard.body.elements[0].header.title.content).toContain('❌ 委派失败')
    const failed = JSON.stringify(failedCard)
    expect(failed).toContain('失败原因')
    expect(failed).toContain('连接失败')
    expect(failed).toContain('已生成的内容')
    expect(failed).toContain('接口检查通过')
  })

  test('keeps parallel workers in one row and namespaces repeated identities by run', () => {
    const run: AgentRunSnapshot = {
      runId: 'r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: '并行检查', description: '并行检查',
      depth: 0, status: 'running', createdAt: '2026-09-06T00:00:00Z', workers: ['a', 'b'].map(id => ({
        identityId: id, identityName: id, tokenSourceId: 'glm', provider: 'claude', model: 'GLM-5.3',
        effort: 'max', status: 'running', output: '检查结果', steps: [],
      })),
    }
    const card = agentRunCard(run) as any
    expect(card.body.elements).toHaveLength(1)
    expect(card.body.elements[0].expanded).toBe(false)
    expect(card.body.elements[0].header.title.content).toContain('并行检查 · 0/2')
    expect(card.body.elements[0].elements[0].content).toContain('**⏳ 运行中 · a**')
    expect(card.body.elements[0].elements[0].content).toContain('**⏳ 运行中 · b**')
    const next = agentRunCard({ ...run, runId: 'next' }) as any
    expect(next.body.elements[0].element_id).not.toBe(card.body.elements[0].element_id)
    expect(card.body.elements[0].element_id.length).toBeLessThanOrEqual(20)
  })
})
