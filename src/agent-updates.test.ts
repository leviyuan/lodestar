import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_UPDATE_INTERVAL_MS, retryAgentFileOperation, resolveAgentPackages, startAgentAutoUpdates, updateAgentRuntime, updateAgentRuntimes } from './agent-updates'
import { AgentInstallTerminationError } from './agent-install'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await retryAgentFileOperation(() => rm(path, { recursive: true }))
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

test('auto-update is disabled by default and never checks or schedules at startup', () => {
  const interval = spyOn(globalThis, 'setInterval')
  let checks = 0
  try {
    const update = async () => { checks++; return { checkedAt: 0 } }
    startAgentAutoUpdates(() => {}, { update })()
    startAgentAutoUpdates(() => {}, { enabled: { codex: false, claude: false, dsh: false }, update })()
    expect(checks).toBe(0)
    expect(interval).not.toHaveBeenCalled()
  } finally { interval.mockRestore() }
})

test.each(['codex', 'claude', 'dsh'] as const)('%s auto-update alone starts at the six-hour tick, avoids overlap, and cancels on stop', async agent => {
  let tick!: () => void
  const handle = { unref() {} } as ReturnType<typeof setInterval>
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(AGENT_UPDATE_INTERVAL_MS)
    tick = callback
    return handle
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let checks = 0
  let signal: AbortSignal | undefined
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(() => {}, { enabled: { [agent]: true }, update: async (updatedAgent, options) => {
      expect(updatedAgent).toBe(agent)
      checks++
      signal = options?.signal
      await done
      return { checkedAt: 0 }
    } })
    expect(interval).toHaveBeenCalledTimes(1)
    expect(checks).toBe(0)
    tick()
    tick()
    expect(checks).toBe(1)
    stop()
    expect(signal?.aborted).toBe(true)
    expect(clear).toHaveBeenCalledWith(handle)
  } finally {
    stop?.()
    finish()
    await done
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('a pending Codex update and a failed Claude update do not block each other or enable DSH', async () => {
  const ticks: Array<() => void> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    ticks.push(callback)
    return { unref() {} } as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let finishCodex!: () => void
  const codexDone = new Promise<void>(resolve => { finishCodex = resolve })
  const checks: string[] = []
  const signals = new Map<string, AbortSignal>()
  const reports: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(message => { reports.push(message) }, {
      enabled: { codex: true, claude: true, dsh: false },
      update: async (agent, options) => {
        checks.push(agent)
        signals.set(agent, options!.signal!)
        if (agent === 'codex') await codexDone
        else throw new Error('Claude registry failed')
        return { checkedAt: 0 }
      },
    })
    expect(ticks).toHaveLength(2)
    expect(checks).toEqual([])
    ticks[0]()
    ticks[1]()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reports).toEqual(['claude 自动更新未完成: Claude registry failed'])
    ticks[0]()
    ticks[1]()
    expect(checks).toEqual(['codex', 'claude', 'claude'])
    expect(signals.get('codex')).not.toBe(signals.get('claude'))
    stop()
    expect(clear).toHaveBeenCalledTimes(2)
    expect([...signals.values()].every(signal => signal.aborted)).toBe(true)
  } finally {
    stop?.()
    finishCodex()
    await codexDone
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('Windows file sharing violations retry the same operation and still surface final failure', async () => {
  let attempts = 0
  expect(await retryAgentFileOperation(async () => {
    if (++attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
    return 'published'
  }, 'win32')).toBe('published')
  expect(attempts).toBe(3)
  const error = Object.assign(new Error('file remains busy'), { code: 'EBUSY' })
  attempts = 0
  await expect(retryAgentFileOperation(async () => { attempts++; throw error }, 'win32')).rejects.toBe(error)
  expect(attempts).toBe(6)
  attempts = 0
  await expect(retryAgentFileOperation(async () => { attempts++; throw error }, 'linux')).rejects.toBe(error)
  expect(attempts).toBe(1)
})

test('unconfirmed installer termination preserves occupied staging files and reports the failure', async () => {
  const root = await scratch()
  let partial = ''
  await expect(updateAgentRuntime('codex', { root,
    metadata: async name => ({ name, version: '1.0.0' }),
    install: async directory => {
      partial = directory
      await writeFile(join(directory, 'installer-held.exe'), 'still owned by installer')
      throw new AgentInstallTerminationError(`installer PID 12345 termination unconfirmed; partial directory retained: ${directory}`)
    },
  })).rejects.toThrow('termination unconfirmed')
  expect(await readFile(join(partial, 'installer-held.exe'), 'utf8')).toBe('still owned by installer')
  expect(existsSync(join(root, 'codex/current.json'))).toBe(false)
})

test('updating while an old native executable is running never overwrites, moves, or deletes its runtime', async () => {
  const root = await scratch()
  const node = Bun.which('node')
  if (!node) throw new Error('Node is required for the occupied-executable update test')
  let version = '1.0.0'
  const options = { root, metadata: async (name: string) => ({ name, version }),
    install: async (directory: string) => {
      await install(directory)
      await copyFile(node, join(directory, 'agent.exe'))
      await chmod(join(directory, 'agent.exe'), 0o700)
    },
  }
  const first = await updateAgentRuntime('codex', options)
  const running = Bun.spawn([join(first.directory!, 'agent.exe'), '-e',
    'process.stdout.write("ready"); process.stdin.on("data", () => process.stdout.write("alive")); process.stdin.on("end", () => process.exit(0))',
  ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = running.stdout.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready')
    version = '2.0.0'
    const second = await updateAgentRuntime('codex', options)
    expect(second.directory).not.toBe(first.directory)
    await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
    running.stdin.write('ping')
    running.stdin.flush()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('alive')
    expect(running.exitCode).toBeNull()
    expect(JSON.parse(await readFile(join(first.directory!, 'node_modules/@openai/codex/package.json'), 'utf8')).version).toBe('1.0.0')
  } finally {
    running.stdin.end()
    await running.exited
    reader.releaseLock()
  }
}, 15_000)

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

test.each(['codex', 'claude', 'dsh'] as const)('%s installation failure retains the selected runtime and removes the partial install', async agent => {
  const root = await scratch()
  const selected = await updateAgentRuntime(agent, { root, install, metadata: async name => ({ name, version: '1.0.0' }) })
  await expect(updateAgentRuntime(agent, { root, metadata: async name => ({ name, version: '2.0.0' }),
    install: async () => { throw new Error('npm installation failed') } })).rejects.toThrow('npm installation failed')
  const state = JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8'))
  expect(state).toEqual(selected)
  expect((await readdir(join(root, agent))).some(name => name.startsWith('.install-') || name === 'update.lock')).toBe(false)
})

test('repeated registry failures leave the selected install unchanged until a successful update', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  const before = await updateAgentRuntime('codex', options)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
    const failed = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
    expect(failed).toEqual(before)
  }
  const after = await updateAgentRuntime('codex', options)
  expect(after.error).toBeUndefined()
  expect(after.directory).toBe(before.directory)
})

test('concurrent updater calls serialize and do not install the same release twice', async () => {
  const root = await scratch()
  let installed = 0
  const options = { root, metadata: async (name: string) => ({ name, version: '1.0.0' }),
    install: async (directory: string) => { installed++; await Bun.sleep(50); await install(directory) } }
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => updateAgentRuntime('codex', options)))
  const states = results.map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  expect(installed).toBe(1)
  expect(new Set(states.map(state => state.directory)).size).toBe(1)
  expect((await readdir(join(root, 'codex'))).includes('update.lock')).toBe(false)
})

test.each(['checking', 'completed'])('a %s report failure preserves the last committed installation', async phase => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }) }
  const first = await updateAgentRuntime('codex', options)
  version = '2.0.0'
  await expect(updateAgentRuntime('codex', { ...options, report: message => {
    if (message.includes(phase === 'checking' ? '检查' : '已更新')) throw new Error('report failed')
  } })).rejects.toThrow('report failed')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toBeUndefined()
  expect(state.versions['@openai/codex']).toBe(phase === 'checking' ? '1.0.0' : '2.0.0')
  if (phase === 'checking') expect(state.directory).toBe(first.directory)
  else expect(state.directory).not.toBe(first.directory)
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
  expect(existsSync(join(root, 'claude/current.json'))).toBe(false)
})

test('SDK loading ignores update failures and legacy diagnostics, while a missing installation still fails', async () => {
  const root = await scratch()
  const child = Bun.spawn([process.execPath, '-e', `
    import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const { updateAgentRuntime, loadClaudeSdk, agentRuntimeRoot, agentRuntimeState } = await import('./src/agent-updates')
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
    let updateFailure
    try { await updateAgentRuntime('claude', { ...options, metadata: async () => { throw new Error('registry failed') } }) }
    catch (error) { updateFailure = error.message }
    if (updateFailure !== 'registry failed') throw new Error('update failure was not surfaced')
    if ((await loadClaudeSdk()).query() !== '99.0.0') throw new Error('failed update prevented SDK loading')
    const retained = agentRuntimeRoot('claude')
    const selected = agentRuntimeState('claude')
    if (selected.error) throw new Error('failed update modified the selected installation')
    await writeFile(join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/claude/current.json'), JSON.stringify({ ...selected, error: 'legacy registry failure' }))
    if ((await loadClaudeSdk()).query() !== '99.0.0') throw new Error('legacy update failure prevented SDK loading')
    await rm(retained, { recursive: true })
    let failure
    try { agentRuntimeRoot('claude') } catch (error) { failure = error.message }
    if (!failure?.includes('安装目录不存在') || failure.includes('registry')) throw new Error('missing installation was not reported independently')
    console.log('runtime resolution passed')
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('runtime resolution passed')
})

test('a failed first install or a legacy error without a selected directory never guesses an installed runtime', async () => {
  const root = await scratch()
  const child = Bun.spawn([process.execPath, '-e', `
    import assert from 'node:assert/strict'
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const { updateAgentRuntime, agentRuntimeRoot, agentRuntimeState } = await import('./src/agent-updates')
    await assert.rejects(updateAgentRuntime('codex', {
      metadata: async () => { throw new Error('TLS disconnected') },
    }), /TLS disconnected/)
    assert.equal(agentRuntimeState('codex'), null)
    assert.throws(() => agentRuntimeRoot('codex'), /runtime 未安装.*lodestar-update --agents-only/)
    await writeFile(join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/codex/current.json'), JSON.stringify({ checkedAt: 1, error: 'TLS disconnected' }))
    // Old releases erased the selected path on failure. An unrelated directory is not a selection record.
    const unrelated = join(process.env.LODESTAR_DATA_DIR, 'agent-runtimes/codex/unselected/node_modules/@openai/codex')
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(unrelated, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0' }))
    assert.throws(() => agentRuntimeRoot('codex'), /runtime 未安装/)
  `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
})

test('lodestar-version displays only the selected installation, without update diagnostics or a failed exit code', async () => {
  const root = await scratch()
  const runtimeRoot = join(root, 'agent-runtimes')
  const selected = await updateAgentRuntime('codex', { root: runtimeRoot, install, metadata: async name => ({ name, version: '1.0.0' }) })
  await expect(updateAgentRuntime('codex', { root: runtimeRoot, metadata: async () => { throw new Error('TLS disconnected') } })).rejects.toThrow('TLS disconnected')
  await writeFile(join(runtimeRoot, 'codex/current.json'), JSON.stringify({ ...selected, error: 'legacy TLS disconnected' }))
  const child = Bun.spawn([process.execPath, 'src/version-cli.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('codex: @openai/codex@1.0.0')
  expect(stdout).toContain(selected.directory!)
  expect(stdout).not.toContain('更新失败')
  expect(stdout).not.toContain('TLS disconnected')
  expect(stdout).not.toContain('codex: MISS')
})

test('a failed scheduled update keeps the current install and succeeds on the next scheduled check', async () => {
  const root = await scratch()
  const selected = await updateAgentRuntime('codex', { root, install, metadata: async name => ({ name, version: '1.0.0' }) })
  let tick!: () => void
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(AGENT_UPDATE_INTERVAL_MS)
    tick = callback
    return { unref() {} } as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let pending!: ReturnType<typeof updateAgentRuntime>
  let checks = 0
  const reports: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startAgentAutoUpdates(message => { reports.push(message) }, { enabled: { codex: true }, update: (agent, options) => {
      checks++
      return pending = updateAgentRuntime(agent, { ...options, root, install, metadata: async name => {
        if (checks === 1) throw new Error('temporary TLS failure')
        return { name, version: '2.0.0' }
      } })
    } })
    expect(checks).toBe(0)
    tick()
    await expect(pending).rejects.toThrow('temporary TLS failure')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(checks).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(selected)
    expect(reports).toContain('codex 自动更新未完成: temporary TLS failure')
    tick()
    const updated = await pending
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(checks).toBe(2)
    expect(updated.versions?.['@openai/codex']).toBe('2.0.0')
    expect(updated.directory).not.toBe(selected.directory)
    expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(updated)
  } finally {
    stop?.()
    interval.mockRestore()
    clear.mockRestore()
  }
})
