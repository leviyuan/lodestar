import { expect, test } from 'bun:test'
import { channelInstructions } from './instructions'

test('main Agent launches share channel instructions without reading file delivery state', () => {
  // Isolate module mocks so no real Agent or Feishu service is started.
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import { writeFileSync } from 'node:fs'
    import './src/feishu-test-mock'
    const { FILE_DELIVERY_GROUPS_FILE } = await import('./src/paths')
    writeFileSync(FILE_DELIVERY_GROUPS_FILE, 'invalid delivery state')
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
      const session = new Session('launch-' + provider, 'chat-' + provider)
      session.selectedProvider = provider
      session.selectedTokenSourceId = null
      session.selectedModel = 'test-model'
      session.selectedEffort = 'high'
      const proc = session.spawnAgent()
      await session.sendClaimedUserText(proc, '生成报告')
      await session.sendClaimedUserText(proc, '继续')
    }
    console.log(JSON.stringify({ launches }))
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
  const { launches } = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
  expect(launches).toHaveLength(3)
  for (const launch of launches) {
    expect(launch.instructions).toBe(channelInstructions())
    expect(launch.inputs).toEqual(['生成报告', '继续'])
  }
})

test('BTW shares the main profile and WT keeps its own profile with identical instructions despite legacy delivery settings', () => {
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', `
    import { mock } from 'bun:test'
    import { writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { projectProfiles } from './src/feishu-test-mock'
    const feishu = await import('./src/feishu')
    const { FILE_DELIVERY_GROUPS_FILE } = await import('./src/paths')
    const mainDir = join(process.env.LODESTAR_DATA_DIR, 'repo')
    const wtDir = join(process.env.LODESTAR_DATA_DIR, 'project[feature]')
    projectProfiles.set('project', { cwd: mainDir, tools: 'Read', loadProjectMcp: false })
    projectProfiles.set('feature-profile', { cwd: wtDir, tools: 'Read,Edit', loadProjectMcp: true })
    feishu.preferredChatForSession.set('project', 'main-chat')
    writeFileSync(FILE_DELIVERY_GROUPS_FILE, JSON.stringify({ version: 1, groups: {
      'main-chat': { enabled: true, folder: { token: 'old', name: 'project', url: 'https://example.com/folder/old' } },
    } }))
    const launches = []
    mock.module('./src/agent-launch', () => ({ createAgentProcess: options => {
      launches.push(options)
      return { sourceRevision: null, process: { provider: options.provider } }
    } }))
    const { Session } = await import('./src/session')
    for (const provider of ['codex', 'claude', 'dsh']) {
      for (const name of ['project*0917-1234', 'project[feature]*0917-1234', 'project']) {
        const session = new Session(name, name === 'project' ? 'main-chat' : name)
        session.selectedProvider = provider
        session.selectedTokenSourceId = null
        session.selectedModel = 'test-model'
        session.selectedEffort = 'high'
        session.spawnAgent()
      }
    }
    console.log(JSON.stringify({ launches, mainDir, wtDir }))
  `], { env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const { launches, mainDir, wtDir } = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
  expect(launches).toHaveLength(9)
  for (const [index, launch] of launches.entries()) {
    const wt = index % 3 === 1
    expect(launch.workDir).toBe(wt ? wtDir : mainDir)
    expect(launch.profile.tools).toBe(wt ? 'Read,Edit' : 'Read')
    expect(launch.profile.loadProjectMcp).toBe(wt)
    expect(launch.developerInstructions).toBe(channelInstructions())
  }
})
