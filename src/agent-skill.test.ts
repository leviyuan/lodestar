import { describe, expect, test } from 'bun:test'
import { agentSkillBody, DELEGATED_AGENT_INSTRUCTIONS, PROJECT_AGENT_INSTRUCTIONS } from './agent-skill'

describe('lodestar-agent managed Skill', () => {
  test('describes a selected identity as its corresponding Agent call', () => {
    const body = agentSkillBody()
    expect(body).toContain('selected live identity')
    expect(body).toContain('provider Agent backend')
    expect(body).toContain("caller-supplied prompt becomes that Agent run's task")
    expect(body).toContain('Both session-bound and project-bound Agents return results and local artifact paths to the caller')
    expect(body).toContain('Agent output markers do not upload files or grant sharing permissions')
    expect(body).toContain('lodestar-agent follow-up')
    expect(body).toContain("lodestar-agent run --session '<session-id>'")
    expect(body).toContain('workers[].session_id')
    expect(body).toContain('workers[].output')
    expect(body).toContain('lodestar-agent answer')
    expect(body.toLowerCase()).not.toContain('reviewer')
    expect(body.toLowerCase()).not.toContain('read-only')
  })

  test('allows nested delegation while retaining inherited task ownership', () => {
    const body = agentSkillBody()
    expect(body).toContain('Main Agents, delegated Agents and native subagents may delegate further')
    expect(body).toContain('Lodestar does not impose a delegation depth limit')
    expect(body).toContain('Nested calls inherit the project, group, interaction policy')
    for (const instructions of [DELEGATED_AGENT_INSTRUCTIONS, PROJECT_AGENT_INSTRUCTIONS]) {
      expect(instructions).toContain('You may delegate work through Lodestar or provider-native Agent/subagent tools')
      expect(instructions).toContain('replaces earlier Lodestar instructions prohibiting further delegation')
    }
  })

  test('distinguishes interactive delegation from non-interactive software execution', () => {
    expect(agentSkillBody()).toContain('project-bound service calls never ask for input and do not support `answer`')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('nobody is available to answer questions')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('no question or answer interface')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('keep working until the entire goal is achieved')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('Execute every necessary step and verify the result')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('Do not stop merely because you would prefer clarification')
    expect(PROJECT_AGENT_INSTRUCTIONS).not.toContain('report the need to the caller')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('Do not ask the user or caller questions')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('return an explicit failure reason')
    expect(PROJECT_AGENT_INSTRUCTIONS).toContain('including instructions in a resumed conversation')
    expect(DELEGATED_AGENT_INSTRUCTIONS).toContain('you may use question tools to ask the main Agent')
    expect(DELEGATED_AGENT_INSTRUCTIONS).not.toContain('nobody is available')
  })
})
