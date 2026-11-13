import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_UPDATE_INTERVAL_MS, retryAgentFileOperation, resolveAgentPackages, startAgentAutoUpdates, updateAgentRuntime, updateAgentRuntimes } from './agent-updates'
import { AGENT_INSTALLER_RECORD, AgentInstallTerminationError } from './agent-install'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await retryAgentFileOperation(() => rm(path, { recursive: true }))
})
/** A PID that belonged to a process which has already exited. */
async function exitedPid(): Promise<number> {
  const exited = Bun.spawn([process.execPath, '-e', ''])
  await exited.exited
  return exited.pid
}
async function recordInstaller(staging: string, pid: number): Promise<void> {
  await writeFile(join(staging, AGENT_INSTALLER_RECORD), JSON.stringify({ pid }))
}
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lodestar-agent-updates-test-'))
  temporary.push(root)
  return root
}
async function install(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const family = Object.fromEntries(Object.entries(manifest.overrides ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh')))
  for (const [name, version] of Object.entries({ ...family, ...manifest.dependencies })) {
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

test.each(['codex', 'claude', 'dsh'] as const)('%s installs shared and runtime-specific security fixes without adding Agent-only libraries to the daemon', async agent => {
  const root = await scratch()
  let manifest: any
  const host = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'))
  await updateAgentRuntime(agent, { root, metadata: async name => ({ name, version: '9.0.0' }),
    install: async directory => {
      manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      await install(directory)
    },
  })
  expect(manifest.overrides['@modelcontextprotocol/sdk']).toBe(host.overrides['@modelcontextprotocol/sdk'])
  expect(manifest.overrides['proxy-addr']).toBe(host.overrides['proxy-addr'])
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/core']) {
    expect(host.dependencies[name]).toBeUndefined()
    expect(manifest.overrides[name]).toBe(agent === 'dsh' ? host.agentRuntimeOverrides.dsh[name] : undefined)
  }
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

test('DSH preserves upstream peer placement while keeping the resolved plugin family on one release', async () => {
  const root = await scratch()
  const version = '9.0.0-rc.8'
  const state = await updateAgentRuntime('dsh', { root, install, metadata: async name => ({ name, version,
    ...(name === '@deepseek-ai/dsh' ? { dependencies: { '@deepseek-ai/dsh-cmdline': `^${version}`,
      '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/cordis-plugin-loader': '1.0.3' } }
      : name === '@deepseek-ai/dsh-cmdline' ? { peerDependencies: { '@deepseek-ai/cordis': '4.0.2',
        '@deepseek-ai/cordis-plugin-loader': '1.0.3' } } : {}),
  }) })
  const manifest = JSON.parse(await readFile(join(state.directory!, 'package.json'), 'utf8'))
  expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh': version,
    '@deepseek-ai/dsh-llm-pi-ai': version, '@deepseek-ai/dsh-tool-ask-user': version })
  expect(manifest.overrides['@deepseek-ai/dsh-cmdline']).toBe(version)
  expect(manifest.overrides['@deepseek-ai/cordis']).toBeUndefined()
  expect(state.versions?.['@deepseek-ai/dsh-cmdline']).toBe(version)
  expect(JSON.parse(await readFile(join(state.directory!, 'node_modules/@deepseek-ai/dsh-cmdline/package.json'), 'utf8')).version).toBe(version)
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

test.each(['missing', 'version', 'name'])('a cached runtime with a %s package cannot replace the current installation', async damage => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }) }
  const cached = await updateAgentRuntime('codex', options)
  version = '2.0.0'
  const current = await updateAgentRuntime('codex', options)
  const manifest = join(cached.directory!, 'node_modules/@openai/codex/package.json')
  if (damage === 'missing') await rm(manifest)
  else await writeFile(manifest, JSON.stringify({ name: damage === 'name' ? 'wrong-package' : '@openai/codex', version: damage === 'version' ? '0.0.0' : '1.0.0' }))
  version = '1.0.0'
  const reports: string[] = []
  await expect(updateAgentRuntime('codex', { ...options, report: message => reports.push(message) })).rejects.toThrow(
    damage === 'missing' ? 'ENOENT' : 'Invalid Agent runtime',
  )
  expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(current)
  expect(reports.some(message => message.includes('已更新') || message.includes('已是 latest'))).toBe(false)
  expect(existsSync(cached.directory!)).toBe(true)
  expect(existsSync(join(root, 'codex/update.lock'))).toBe(false)
})

test('a cached claude runtime without its native CLI binary cannot replace the current installation', async () => {
  const root = await scratch()
  const native = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const installWithNative = async (directory: string) => {
    await install(directory)
    await writeFile(join(directory, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '1.0.0', optionalDependencies: { [native]: '1.0.0' } }))
    await mkdir(join(directory, 'node_modules', native), { recursive: true })
    await writeFile(join(directory, 'node_modules', native, binary), '')
  }
  const options = { root, install: installWithNative, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  const current = await updateAgentRuntime('claude', options)
  expect(existsSync(join(current.directory!, 'node_modules', native, binary))).toBe(true)
  // npm exits 0 when an optional platform package cannot be extracted (for example ENOSPC).
  await rm(join(current.directory!, 'node_modules', native), { recursive: true })
  const reports: string[] = []
  await expect(updateAgentRuntime('claude', { ...options, report: message => reports.push(message) })).rejects.toThrow('native CLI binary')
  expect(JSON.parse(await readFile(join(root, 'claude/current.json'), 'utf8'))).toEqual(current)
  expect(reports.some(message => message.includes('已是 latest'))).toBe(false)
  expect(existsSync(join(root, 'claude/update.lock'))).toBe(false)
})

test('successful updates keep only the newest three runtimes', async () => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }), runningCommands: async () => [] }
  const states = []
  for (let i = 0; i < 5; i++) {
    states.push(await updateAgentRuntime('codex', options))
    version = `1.0.${i + 2}`
    await Bun.sleep(5)
  }
  const names = (await readdir(join(root, 'codex'))).filter(name => /^[0-9a-f]{20}$/.test(name))
  expect(names.length).toBe(3)
  expect(existsSync(states[0].directory!)).toBe(false)
  expect(existsSync(states[1].directory!)).toBe(false)
  for (const state of states.slice(2)) expect(existsSync(state.directory!)).toBe(true)
  expect(JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))).toEqual(states[4])
})

test('pruning keeps a runtime a live process still runs from', async () => {
  const root = await scratch()
  let version = '1.0.0'
  let running = ''
  const options = { root, install, metadata: async (name: string) => ({ name, version }),
    runningCommands: async () => [`codex ${running}/node_modules/.bin/codex`] }
  const states = []
  for (let i = 0; i < 5; i++) {
    const state = await updateAgentRuntime('codex', options)
    states.push(state)
    if (i === 0) running = state.directory!
    version = `1.0.${i + 2}`
    await Bun.sleep(5)
  }
  expect(existsSync(states[0].directory!)).toBe(true)
  expect(existsSync(states[1].directory!)).toBe(false)
  const names = (await readdir(join(root, 'codex'))).filter(name => /^[0-9a-f]{20}$/.test(name))
  expect(names.length).toBe(4)
})

test('pruning leaves old runtimes alone when the process table is unavailable', async () => {
  const root = await scratch()
  let version = '1.0.0'
  const options = { root, install, metadata: async (name: string) => ({ name, version }), runningCommands: async () => null }
  const reports: string[] = []
  for (let i = 0; i < 5; i++) {
    await updateAgentRuntime('codex', { ...options, report: message => reports.push(message) })
    version = `1.0.${i + 2}`
    await Bun.sleep(5)
  }
  const names = (await readdir(join(root, 'codex'))).filter(name => /^[0-9a-f]{20}$/.test(name))
  expect(names.length).toBe(5)
  expect(reports.some(message => message.includes('旧运行时清理跳过'))).toBe(true)
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

test.each(['missing', 'mismatched'])('lodestar-version reports a %s installed package instead of a successful recorded version', async damage => {
  const root = await scratch()
  const selected = await updateAgentRuntime('codex', { root: join(root, 'agent-runtimes'), install, metadata: async name => ({ name, version: '1.0.0' }) })
  const manifest = join(selected.directory!, 'node_modules/@openai/codex/package.json')
  if (damage === 'missing') await rm(manifest)
  else await writeFile(manifest, JSON.stringify({ name: '@openai/codex', version: '0.0.0' }))
  const child = Bun.spawn([process.execPath, 'src/version-cli.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(stdout).not.toContain('codex: @openai/codex@1.0.0')
  expect(stderr).toContain('codex: MISS')
  expect(stderr).toContain(damage === 'missing' ? 'ENOENT' : '安装包与记录不一致')
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

test('a later successful update removes staging left by interrupted installs but keeps one a live installer still owns', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  await updateAgentRuntime('codex', options)
  const crashed = join(root, 'codex/.install-crashed')
  const owned = join(root, 'codex/.install-owned')
  const lockAside = join(root, `codex/.stale-lock-${Date.now() - 10 * 60_000}-left`)
  for (const path of [crashed, owned, lockAside]) await mkdir(path, { recursive: true })
  await writeFile(join(crashed, 'package.json'), '{}')
  const dead = await exitedPid()
  await recordInstaller(crashed, dead)
  await recordInstaller(owned, dead)
  // Same release: the install itself is skipped, the sweep still runs under the lock.
  const reports: string[] = []
  await updateAgentRuntime('codex', { ...options, report: message => reports.push(message),
    runningCommands: async () => [`node /usr/lib/npm-cli.js install --prefix ${owned} --include=optional --no-fund`] })
  expect(existsSync(crashed)).toBe(false)
  expect(existsSync(lockAside)).toBe(false)
  expect(existsSync(owned)).toBe(true)
  expect(reports).toContain('codex: 已清理 2 个中断安装的临时目录')
})

test('stale staging stays when the process table is unavailable, and a failed update never sweeps', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  await updateAgentRuntime('codex', options)
  const crashed = join(root, 'codex/.install-crashed')
  await mkdir(crashed)
  await recordInstaller(crashed, await exitedPid())
  await expect(updateAgentRuntime('codex', { ...options, runningCommands: async () => [],
    metadata: async () => { throw new Error('registry offline') } })).rejects.toThrow('registry offline')
  expect(existsSync(crashed)).toBe(true)
  const reports: string[] = []
  await updateAgentRuntime('codex', { ...options, report: message => reports.push(message), runningCommands: async () => null })
  expect(existsSync(crashed)).toBe(true)
  expect(reports).toContain('codex: 中断安装的临时目录清理跳过（无法确认占用）')
})

test('a preserved staging directory of a cancelled install is removed only after its installer is gone', async () => {
  const root = await scratch()
  let partial = ''
  // Stands in for an orphaned npm lifecycle child: alive, but no command line names the staging path.
  const installer = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'])
  try {
    await expect(updateAgentRuntime('codex', { root, metadata: async name => ({ name, version: '1.0.0' }),
      install: async directory => {
        partial = directory
        await recordInstaller(directory, installer.pid)
        throw new AgentInstallTerminationError('termination unconfirmed')
      } })).rejects.toThrow('termination unconfirmed')
    const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
    await updateAgentRuntime('codex', { ...options, runningCommands: async () => [`npm install --prefix ${partial} --include=optional`] })
    expect(existsSync(partial)).toBe(true)
    await updateAgentRuntime('codex', { ...options, runningCommands: async () => [] })
    expect(existsSync(partial)).toBe(true)
    installer.kill()
    await installer.exited
    await updateAgentRuntime('codex', { ...options, runningCommands: async () => [] })
    expect(existsSync(partial)).toBe(false)
  } finally { installer.kill() }
})

test('staging without an installer record is kept until it is a day old', async () => {
  const root = await scratch()
  const options = { root, install, runningCommands: async () => [], metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  await updateAgentRuntime('codex', options)
  const unrecorded = join(root, 'codex/.install-unrecorded')
  await mkdir(unrecorded)
  await updateAgentRuntime('codex', options)
  expect(existsSync(unrecorded)).toBe(true)
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60_000)
  try { await updateAgentRuntime('codex', options) } finally { clock.mockRestore() }
  expect(existsSync(unrecorded)).toBe(false)
})

test('a lock another waiter just moved aside survives the sweep, and the holder still releases cleanly', async () => {
  const root = await scratch()
  const options = { root, install, runningCommands: async () => [], metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  await updateAgentRuntime('codex', options)
  const reclaiming = join(root, `codex/.stale-lock-${Date.now()}-inflight`)
  const legacyFresh = join(root, 'codex/.stale-lock-legacy')
  for (const path of [reclaiming, legacyFresh]) await mkdir(path)
  // The holder's own lock is moved aside mid-update (a waiter's reclaim) and not yet restored.
  const lockPath = join(root, 'codex/update.lock')
  const reports: string[] = []
  await updateAgentRuntime('codex', { ...options, report: message => {
    reports.push(message)
    if (message.includes('已是 latest') && existsSync(lockPath)) rmSync(lockPath, { recursive: true })
  } })
  expect(existsSync(reclaiming)).toBe(true)
  expect(existsSync(legacyFresh)).toBe(true)
  expect(existsSync(lockPath)).toBe(false)
  // A lock that another updater took after the holder's vanished is not the holder's to remove.
  await updateAgentRuntime('codex', { ...options, report: message => {
    if (!message.includes('已是 latest')) return
    rmSync(lockPath, { recursive: true })
    mkdirSync(lockPath)
  } })
  expect(existsSync(lockPath)).toBe(true)
})

test('a lock whose updater died before publishing its PID is reclaimed after the grace period, a fresh one is not', async () => {
  const root = await scratch()
  const lockPath = join(root, 'codex/update.lock')
  await mkdir(lockPath, { recursive: true })
  const controller = new AbortController()
  const waiting = updateAgentRuntime('codex', { root, install, signal: controller.signal, metadata: async name => ({ name, version: '1.0.0' }) })
  await Bun.sleep(300)
  expect(existsSync(join(root, 'codex/current.json'))).toBe(false)
  controller.abort(new Error('stopped waiting'))
  // 等锁循环此刻挂在 200ms 定时器上。Windows 上 Bun 的 expect(...).rejects 等这种 promise 时会满 CPU
  // 空转、定时器不再触发，整个测试进程卡到 CI 超时（实测 12 次卡 11 次）；先 await 取结果再断言。
  const stopped = await waiting.then(() => undefined, (error: unknown) => error)
  expect(stopped).toBeInstanceOf(Error)
  expect((stopped as Error).message).toBe('stopped waiting')
  expect(existsSync(lockPath)).toBe(true)
  const old = new Date(Date.now() - 60_000)
  await utimes(lockPath, old, old)
  const state = await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }) })
  expect(state.directory).toBeDefined()
  expect((await readdir(join(root, 'codex'))).filter(name => name === 'update.lock' || name.startsWith('.stale-lock-'))).toEqual([])
})

test('a lock held by an exited updater is reclaimed immediately', async () => {
  const root = await scratch()
  const exited = Bun.spawn([process.execPath, '-e', ''])
  await exited.exited
  await mkdir(join(root, 'codex/update.lock'), { recursive: true })
  await writeFile(join(root, 'codex/update.lock/pid'), String(exited.pid))
  const started = Date.now()
  await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }) })
  expect(Date.now() - started).toBeLessThan(5_000)
  expect((await readdir(join(root, 'codex'))).filter(name => name === 'update.lock' || name.startsWith('.stale-lock-'))).toEqual([])
})

test('stopping auto-updates aborts synchronously and resolves only after the in-flight update settled', async () => {
  let tick!: () => void
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback
    return { unref() {} } as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let signal: AbortSignal | undefined
  let settled = false
  try {
    const stop = startAgentAutoUpdates(() => {}, { enabled: { codex: true }, update: async (_agent, options) => {
      signal = options?.signal
      await released
      settled = true
      throw new Error('aborted')
    } })
    tick()
    let stopped = false
    const stopping = stop().then(() => { stopped = true })
    expect(signal?.aborted).toBe(true)
    await Bun.sleep(20)
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(settled).toBe(true)
    await startAgentAutoUpdates(() => {}, {})()
  } finally {
    release()
    interval.mockRestore()
    clear.mockRestore()
  }
})
