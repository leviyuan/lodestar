import { describe, expect, test } from 'bun:test'
import { agentSkillBody, DELEGATED_AGENT_INSTRUCTIONS } from './agent-skill'

describe('lodestar-agent managed Skill', () => {
  test('describes a selected identity as its corresponding Agent call', () => {
    const body = agentSkillBody()
    expect(body).toContain('selected live identity')
    expect(body).toContain('provider Agent backend')
    expect(body).toContain("caller-supplied prompt becomes that Agent run's task")
    expect(body).toContain('lodestar-agent follow-up')
    expect(body).toContain("lodestar-agent run --session '<session-id>'")
    expect(body).toContain('workers[].session_id')
    expect(body).toContain('workers[].output')
    expect(body).toContain('lodestar-agent answer')
    expect(body.toLowerCase()).not.toContain('reviewer')
    expect(body.toLowerCase()).not.toContain('read-only')
  })

  test('makes the worker prohibition apply to native tools', () => {
    const body = agentSkillBody()
    expect(body).toContain('Only the main Agent may delegate work')
    expect(body).toContain('do not delegate further')
    expect(body).toContain('Native subagents are also delegated Agents')
    expect(DELEGATED_AGENT_INSTRUCTIONS).toContain('must not create or invoke any further Agents or subagents')
    expect(DELEGATED_AGENT_INSTRUCTIONS).toContain('report the need to the main Agent')
  })
})
