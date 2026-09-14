import { expect, test } from 'bun:test'

test('main Agent launches select the group delivery rules for Codex, Claude and DSH', () => {
  // Isolate module mocks so no real Agent or Feishu service is started.
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import './src/feishu-test-mock'
    const launches = []
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      const entry = { provider: options.provider, instructions: options.developerInstructions, inputs: [] }
      launches.push(entry)
      return { sourceRevision: null, process: {
        provider: options.provider,
        sendUserText(text) { entry.inputs.push(text) },
      } }
    } }))
    const { Session } = await import('./src/session')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const mode of ['chat', 'drive']) {
        const session = new Session('launch-' + provider + '-' + mode, 'chat-' + mode)
        session.selectedProvider = provider
        session.selectedTokenSourceId = null
        session.selectedModel = 'test-model'
        session.selectedEffort = 'high'
        session.getFileDeliveryMode = () => mode
        const proc = session.spawnAgent()
        session.sendClaimedUserText(proc, '生成报告')
        session.sendClaimedUserText(proc, '继续')
      }
    }
    const broken = new Session('broken-delivery-config', 'chat-broken')
    broken.getFileDeliveryMode = () => { throw new Error('group config unreadable') }
    let error
    try { broken.spawnAgent() } catch (e) { error = e.message }
    console.log(JSON.stringify({ launches, error }))
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
  const { launches, error } = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
  expect(error).toBe('group config unreadable')
  expect(launches).toHaveLength(6)
  for (const [index, launch] of launches.entries()) {
    expect(launch.instructions).toContain('[[send: /abs/path]]')
    expect(launch.inputs).toEqual(['生成报告', '继续'])
    if (index % 2 === 0) {
      expect(launch.instructions).toContain('30 × 1024 × 1024')
      expect(launch.instructions).toContain('交付前检查文件大小')
    } else {
      expect(launch.instructions).not.toMatch(/30|大小|压缩|分卷|分片/)
    }
    const questionTool = { codex: 'request_user_input', claude: 'AskUserQuestion', dsh: 'ask_user_question' }[launch.provider as 'codex' | 'claude' | 'dsh']
    expect(launch.instructions).toContain(questionTool)
  }
})
