import { expect, test } from 'bun:test'

function runIsolated(script: string): any {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
}

test('the Claude SDK receives worker-only delegation restrictions while retaining normal coding tools', () => {
  const captured = runIsolated(`
    import { mock } from 'bun:test'
    const captured = []
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ options }) => {
        captured.push({ disallowedTools: options.disallowedTools ?? null, tools: options.tools, effort: options.effort,
          systemPrompt: options.systemPrompt })
        return { async *[Symbol.asyncIterator]() {}, close() {} }
      },
    }))
    const { ClaudeAgentProcess } = await import('./src/claude-agent-process')
    for (const policy of [{}, { allowDelegation: false }, { allowDelegation: false, allowUserInput: false }]) {
      const proc = new ClaudeAgentProcess({ workDir: process.cwd(), effort: 'high', appendSystemPrompt: 'current invocation policy', ...policy })
      const closed = new Promise(resolve => proc.once('exit', resolve))
      proc.sendInitialize()
      await closed
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toEqual([
    { disallowedTools: null, tools: { type: 'preset', preset: 'claude_code' }, effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'current invocation policy', snapshot: false } },
    { disallowedTools: ['Agent', 'Task', 'Workflow'], tools: { type: 'preset', preset: 'claude_code' }, effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'current invocation policy', snapshot: false } },
    { disallowedTools: ['Agent', 'Task', 'Workflow', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], tools: { type: 'preset', preset: 'claude_code' }, effort: 'high',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'current invocation policy', snapshot: false } },
  ])
})

test('new and resumed workers use caller-owned delivery and binding-specific input policy across all backends', () => {
  const captured = runIsolated(`
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    const captured = []
    mock.module('./src/token-source', () => ({ getTokenSourceForAccount: () => ({ id: 'test-source' }) }))
    mock.module('./src/agent-session-registry', () => ({ rememberAgentSession() {} }))
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      captured.push({ allowDelegation: options.allowDelegation, allowUserInput: options.allowUserInput, instructions: options.developerInstructions,
        role: options.hostEnv.LODESTAR_AGENT_ROLE, model: options.model, effort: options.effort,
        codexAccountId: options.codexAccountId, launch: options.launch })
      const proc = new EventEmitter()
      Object.assign(proc, { provider: options.provider, sessionId: 'test-session', alive: true,
        isAlive() { return this.alive }, sendInitialize() {},
        sendUserText() { queueMicrotask(() => this.emit('result', { is_error: false })) },
        async kill() { this.alive = false; this.emit('exit', { code: 0 }) },
      })
      return { process: proc }
    } }))
    const { startAgentWorker } = await import('./src/agent-runner')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const projectBound of [false, true]) {
        for (const resumeSessionId of [undefined, 'test-session']) {
          await startAgentWorker({ identity: { tokenSourceId: 'test-source', provider, model: 'worker-model', supportedEfforts: ['high'] },
            projectBound, resumeSessionId, effort: 'high', codexAccountId: 'named-work', workDir: process.cwd(),
            prompt: 'task', developerInstructions: 'project rule', hostEnv: { LODESTAR_AGENT_ROLE: 'main' } }).done
        }
      }
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toHaveLength(12)
  expect(captured.map((launch: any) => launch.allowUserInput)).toEqual([
    true, true, false, false, true, true, false, false, true, true, false, false,
  ])
  expect(captured.filter((launch: any) => launch.launch.kind === 'resume')).toHaveLength(6)
  for (const launch of captured) {
    expect(launch.allowDelegation).toBe(false)
    expect(launch.role).toBe('worker')
    expect(launch.model).toBe('worker-model')
    expect(launch.effort).toBe('high')
    expect(launch.codexAccountId).toBe('named-work')
    expect(launch.instructions).toContain('project rule')
    expect(launch.instructions).toContain('must not create or invoke any further Agents or subagents')
    expect(launch.instructions).toContain('Return task results and local artifact paths to the caller')
    expect(launch.instructions).toContain('Do not emit file-delivery markers')
    expect(launch.instructions).toContain('replace any earlier Lodestar file-delivery instructions')
    expect(launch.instructions).not.toMatch(/\[\[send:|30 MB|files on|需要交付文件时直接提交/)
    if (!launch.allowUserInput) {
      expect(launch.instructions).toContain('nobody is available to answer questions')
      expect(launch.instructions).toContain('no question or answer interface')
      expect(launch.instructions).toContain('keep working until the entire goal is achieved')
      expect(launch.instructions).toContain('return an explicit failure reason')
      expect(launch.instructions).toContain('including instructions in a resumed conversation')
    } else {
      expect(launch.instructions).toContain('you may use question tools to ask the main Agent')
    }
  }
})
