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
        captured.push({ disallowedTools: options.disallowedTools ?? null, tools: options.tools, effort: options.effort })
        return { async *[Symbol.asyncIterator]() {}, close() {} }
      },
    }))
    const { ClaudeAgentProcess } = await import('./src/claude-agent-process')
    for (const allowDelegation of [undefined, false]) {
      const proc = new ClaudeAgentProcess({ workDir: process.cwd(), effort: 'high', allowDelegation })
      const closed = new Promise(resolve => proc.once('exit', resolve))
      proc.sendInitialize()
      await closed
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toEqual([
    { disallowedTools: null, tools: { type: 'preset', preset: 'claude_code' }, effort: 'high' },
    { disallowedTools: ['Agent', 'Task'], tools: { type: 'preset', preset: 'claude_code' }, effort: 'high' },
  ])
})

test('every delegated worker launch carries the policy and a worker role', () => {
  const captured = runIsolated(`
    import { mock } from 'bun:test'
    import { EventEmitter } from 'node:events'
    const captured = []
    mock.module('./src/token-source', () => ({ getTokenSourceForAccount: () => ({ id: 'test-source' }) }))
    mock.module('./src/agent-session-registry', () => ({ rememberAgentSession() {} }))
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      captured.push({ allowDelegation: options.allowDelegation, instructions: options.developerInstructions,
        role: options.hostEnv.LODESTAR_AGENT_ROLE, model: options.model, effort: options.effort, codexAccountId: options.codexAccountId })
      const proc = new EventEmitter()
      Object.assign(proc, { provider: options.provider, sessionId: 'test-session', alive: true,
        isAlive() { return this.alive }, sendInitialize() {},
        sendUserText() { queueMicrotask(() => this.emit('result', { is_error: false })) },
        async kill() { this.alive = false; this.emit('exit', { code: 0 }) },
      })
      return { process: proc }
    } }))
    const { startAgentWorker } = await import('./src/agent-runner')
    for (const provider of ['codex', 'claude']) {
      await startAgentWorker({ identity: { tokenSourceId: 'test-source', provider, model: 'worker-model', supportedEfforts: ['high'] },
        effort: 'high', codexAccountId: 'named-work', workDir: process.cwd(), prompt: 'task', developerInstructions: 'project rule',
        hostEnv: { LODESTAR_AGENT_ROLE: 'main' } }).done
    }
    console.log(JSON.stringify(captured))
  `)
  expect(captured).toHaveLength(2)
  for (const launch of captured) {
    expect(launch.allowDelegation).toBe(false)
    expect(launch.role).toBe('worker')
    expect(launch.model).toBe('worker-model')
    expect(launch.effort).toBe('high')
    expect(launch.codexAccountId).toBe('named-work')
    expect(launch.instructions).toContain('project rule')
    expect(launch.instructions).toContain('must not create or invoke any further Agents or subagents')
  }
})
