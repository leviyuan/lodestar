import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentPackages, updateAgentRuntime, updateAgentRuntimes } from './agent-updates'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true })
})
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lodestar-agent-updates-test-'))
  temporary.push(root)
  return root
}
async function install(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const target = join(directory, 'node_modules', name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name, version }))
  }
}

test('Claude Code and both SDKs independently follow latest, including future major versions', async () => {
  const requests: string[] = []
  const packages = await resolveAgentPackages('claude', async (name, version) => {
    requests.push(`${name}@${version}`)
    return { name, version: name.endsWith('claude-code') ? '99.0.0' : '42.0.0' }
  })
  expect(requests).toEqual(['@anthropic-ai/claude-code@latest', '@anthropic-ai/claude-agent-sdk@latest', '@anthropic-ai/sdk@latest'])
  expect(packages['@anthropic-ai/claude-code']).toBe('99.0.0')
  expect(packages['@anthropic-ai/claude-agent-sdk']).toBe('42.0.0')
})

test('DSH discovers new dependency and peer packages from the latest release without a fixed package whitelist', async () => {
  const calls: string[] = []
  const packages = await resolveAgentPackages('dsh', async (name, version) => {
    calls.push(`${name}@${version}`)
    return { name, version: '9.0.0-rc.8', ...(name === '@deepseek-ai/dsh' ? {
      dependencies: { '@deepseek-ai/dsh-future': '^9.0.0-rc.8', 'ordinary-library': '^1' },
    } : name === '@deepseek-ai/dsh-future' ? { peerDependencies: { '@deepseek-ai/dsh-new-peer': '^9.0.0-rc.8' } } : {}) }
  })
  expect(packages['@deepseek-ai/dsh-future']).toBe('9.0.0-rc.8')
  expect(packages['@deepseek-ai/dsh-new-peer']).toBe('9.0.0-rc.8')
  expect(calls.filter(call => call.endsWith('@latest'))).toEqual(['@deepseek-ai/dsh@latest'])
  expect(calls.some(call => call.startsWith('ordinary-library'))).toBe(false)
})

test('successful installs activate immediately without compatibility gating and preserve the old process directory', async () => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }) }
  const first = await updateAgentRuntime('codex', options)
  version = '99.0.0'
  const second = await updateAgentRuntime('codex', options)
  expect(second.directory).not.toBe(first.directory)
  expect(second.versions?.['@openai/codex']).toBe('99.0.0')
  const old = JSON.parse(await readFile(join(first.directory!, 'node_modules/@openai/codex/package.json'), 'utf8'))
  expect(old.version).toBe('1.0.0')
  const selected = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(selected.directory).toBe(second.directory)
})

test('installation failure records an error, removes the partial install, and never selects the old runtime', async () => {
  const root = await scratch()
  await updateAgentRuntime('codex', { root, install, metadata: async name => ({ name, version: '1.0.0' }) })
  await expect(updateAgentRuntime('codex', { root, metadata: async name => ({ name, version: '2.0.0' }),
    install: async () => { throw new Error('npm installation failed') } })).rejects.toThrow('npm installation failed')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toContain('npm installation failed')
  expect(state.directory).toBeUndefined()
  expect((await readdir(join(root, 'codex'))).some(name => name.startsWith('.install-') || name === 'update.lock')).toBe(false)
})

test('registry failure is visible even if a previous install exists; recovery rechecks latest', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  const before = await updateAgentRuntime('codex', options)
  await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
  expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8')).error).toContain('registry offline')
  const after = await updateAgentRuntime('codex', options)
  expect(after.error).toBeUndefined()
  expect(after.directory).toBe(before.directory)
})

test('concurrent updater calls serialize and do not install the same release twice', async () => {
  const root = await scratch()
  let installed = 0
  const options = { root, metadata: async (name: string) => ({ name, version: '1.0.0' }),
    install: async (directory: string) => { installed++; await Bun.sleep(50); await install(directory) } }
  const [one, two] = await Promise.all([updateAgentRuntime('codex', options), updateAgentRuntime('codex', options)])
  expect(installed).toBe(1)
  expect(one.directory).toBe(two.directory)
})

test('one Agent update failure does not prevent other Agents from getting their latest runtime', async () => {
  const root = await scratch()
  await expect(updateAgentRuntimes({ root, install, metadata: async name => {
    if (name.startsWith('@anthropic-ai/')) throw new Error('Claude registry failed')
    return { name, version: '7.0.0' }
  } })).rejects.toThrow('Claude registry failed')
  for (const agent of ['codex', 'dsh']) {
    expect(JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8')).directory).toBeTruthy()
  }
  expect(JSON.parse(await readFile(join(root, 'claude/current.json'), 'utf8')).error).toContain('Claude registry failed')
})

test('new queries load the newly installed SDK while existing module references retain their version', async () => {
  const root = await scratch()
  const child = Bun.spawn([process.execPath, '-e', `
    import { mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const { updateAgentRuntime, loadClaudeSdk, agentRuntimeRoot } = await import('./src/agent-updates')
    let version = '1.0.0'
    const options = { metadata: async name => ({ name, version }), install: async directory => {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        const target = join(directory, 'node_modules', name)
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'sdk.mjs' }))
        await writeFile(join(target, 'sdk.mjs'), 'export const query = () => ' + JSON.stringify(version))
      }
    } }
    await updateAgentRuntime('claude', options)
    const first = await loadClaudeSdk()
    version = '99.0.0'
    await updateAgentRuntime('claude', options)
    const second = await loadClaudeSdk()
    if (first.query() !== '1.0.0' || second.query() !== '99.0.0') throw new Error('SDK module resolution did not follow runtime update')
    try { await updateAgentRuntime('claude', { ...options, metadata: async () => { throw new Error('registry failed') } }) } catch {}
    let failure
    try { agentRuntimeRoot('claude') } catch (error) { failure = error.message }
    if (!failure?.includes('registry failed')) throw new Error('runtime resolver concealed update failure')
    console.log('runtime resolution passed')
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('runtime resolution passed')
})
