import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_UPDATE_INTERVAL_MS, retryAgentFileOperation, resolveAgentPackages, startAgentAutoUpdates, updateAgentRuntime, updateAgentRuntimes, updateLockForTest } from './agent-updates'
import { writeStateFileAtomic } from './state-store'
import * as pidGuard from './pid-guard'
import { processStartId } from './pid-guard'
import { AGENT_INSTALLER_RECORD, AgentInstallTerminationError } from './agent-install'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await retryAgentFileOperation(() => rm(path, { recursive: true }))
})
/** Windows CI (AGENTS.md): settle first, then assert. Bun on Windows can spin inside
 * expect(promise).rejects while the promise waits on a timer or a retry. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(() => undefined, (error: unknown) => error)
  if (!(outcome instanceof Error)) throw new Error('expected the promise to reject')
  return outcome
}
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
  expect(await rejection(retryAgentFileOperation(async () => { attempts++; throw error }, 'win32'))).toBe(error)
  expect(attempts).toBe(6)
  attempts = 0
  expect(await rejection(retryAgentFileOperation(async () => { attempts++; throw error }, 'linux'))).toBe(error)
  expect(attempts).toBe(1)
})

test('unconfirmed installer termination preserves occupied staging files and reports the failure', async () => {
  const root = await scratch()
  let partial = ''
  expect((await rejection(updateAgentRuntime('codex', { root,
    metadata: async name => ({ name, version: '1.0.0' }),
    install: async directory => {
      partial = directory
      await writeFile(join(directory, 'installer-held.exe'), 'still owned by installer')
      throw new AgentInstallTerminationError(`installer PID 12345 termination unconfirmed; partial directory retained: ${directory}`)
    },
  }))).message).toContain('termination unconfirmed')
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
    expect((await rejection(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } }))).message).toContain('registry offline')
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

/** An OS other than this one: what a platform package for another system declares. */
const ELSEWHERE = process.platform === 'darwin' ? 'linux' : 'darwin'

test('DSH optional platform packages may be absent while staying in the snapshot', async () => {
  const root = await scratch()
  const version = '9.0.0-rc.8'
  const optional = '@deepseek-ai/dsh-experimental-cua-macos'
  const state = await updateAgentRuntime('dsh', {
    root,
    metadata: async name => ({ name, version,
      ...(name === '@deepseek-ai/dsh' ? { dependencies: { '@deepseek-ai/dsh-cua-bundle': version } } : {}),
      ...(name === '@deepseek-ai/dsh-cua-bundle' ? { optionalDependencies: { [optional]: version } } : {}),
      ...(name === optional ? { os: [ELSEWHERE] } : {}) }),
    install: async directory => {
      await install(directory)
      await rm(join(directory, 'node_modules', optional), { recursive: true, force: true })
    },
  })
  expect(state.versions?.[optional]).toBe(version)
  expect(existsSync(join(state.directory!, 'node_modules', optional))).toBe(false)
})

test('a DSH package is excused only when nothing installed requires it', async () => {
  const version = '9.0.0'
  const macOnly = '@deepseek-ai/dsh-experimental-cua-macos'
  const helper = '@deepseek-ai/dsh-cua-protocol'
  const core = '@deepseek-ai/dsh-core'
  const attempt = async (manifests: Record<string, object>, absent: string[]) => {
    const root = await scratch()
    const result = await updateAgentRuntime('dsh', { root, runningCommands: async () => [],
      metadata: async name => ({ name, version, ...manifests[name] }),
      install: async directory => {
        await install(directory)
        for (const name of absent) await rm(join(directory, 'node_modules', name), { recursive: true, force: true })
      },
    }).then(state => state, (error: unknown) => error)
    return { result, selected: existsSync(join(root, 'dsh/current.json')) }
  }
  // npm skips the platform package and, with it, what only that package requires.
  const transitive = await attempt({
    '@deepseek-ai/dsh': { dependencies: { '@deepseek-ai/dsh-cua-bundle': version } },
    '@deepseek-ai/dsh-cua-bundle': { optionalDependencies: { [macOnly]: version } },
    [macOnly]: { os: [ELSEWHERE], dependencies: { [helper]: version } },
  }, [macOnly, helper])
  expect(transitive.result).not.toBeInstanceOf(Error)
  expect(transitive.selected).toBe(true)
  // npm attempted an optional package this platform does not exclude: its install failed (npm exits 0).
  for (const platform of [{ os: [process.platform], cpu: [process.arch] }, {}, { os: [`!${ELSEWHERE}`] }]) {
    const failed = await attempt({
      '@deepseek-ai/dsh': { dependencies: { '@deepseek-ai/dsh-cua-bundle': version } },
      '@deepseek-ai/dsh-cua-bundle': { optionalDependencies: { [macOnly]: version } },
      [macOnly]: platform,
    }, [macOnly])
    expect((failed.result as Error).message).toContain(`optional ${macOnly}@${version} of @deepseek-ai/dsh-cua-bundle applies to ${process.platform}-${process.arch} but is missing`)
    expect(failed.selected).toBe(false)
  }
  // Excluded here (an exclusion, another CPU) or not judged (libc): still excused.
  for (const platform of [{ os: [`!${process.platform}`] }, { cpu: [process.arch === 'arm64' ? 'x64' : 'arm64'] }, { libc: ['musl'] }]) {
    const skipped = await attempt({
      '@deepseek-ai/dsh': { dependencies: { '@deepseek-ai/dsh-cua-bundle': version } },
      '@deepseek-ai/dsh-cua-bundle': { optionalDependencies: { [macOnly]: version } },
      [macOnly]: platform,
    }, [macOnly])
    expect(skipped.result).not.toBeInstanceOf(Error)
    expect(skipped.selected).toBe(true)
  }
  // Optional for one package but required by an installed one: a broken install.
  const required = await attempt({
    '@deepseek-ai/dsh': { dependencies: { [core]: version } },
    '@deepseek-ai/dsh-llm-pi-ai': { optionalDependencies: { [core]: version } },
  }, [core])
  expect((required.result as Error).message).toContain(`${core}@${version} is missing but required by @deepseek-ai/dsh`)
  expect(required.selected).toBe(false)
  // A root package is never optional.
  const root = await attempt({}, ['@deepseek-ai/dsh-tool-ask-user'])
  expect((root.result as Error).message).toContain('@deepseek-ai/dsh-tool-ask-user@9.0.0 is missing')
  expect(root.selected).toBe(false)
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
  expect((await rejection(updateAgentRuntime(agent, { root, metadata: async name => ({ name, version: '2.0.0' }),
    install: async () => { throw new Error('npm installation failed') } }))).message).toContain('npm installation failed')
  const state = JSON.parse(await readFile(join(root, agent, 'current.json'), 'utf8'))
  expect(state).toEqual(selected)
  expect((await readdir(join(root, agent))).some(name => name.startsWith('.install-') || name === 'update.lock')).toBe(false)
})

test('repeated registry failures leave the selected install unchanged until a successful update', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  const before = await updateAgentRuntime('codex', options)
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await rejection(updateAgentRuntime('codex', { ...options, metadata: async () => { throw new Error('registry offline') } }))).message).toContain('registry offline')
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
  expect((await rejection(updateAgentRuntime('codex', { ...options, report: message => reports.push(message) }))).message).toContain(
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
  expect((await rejection(updateAgentRuntime('claude', { ...options, report: message => reports.push(message) }))).message).toContain('native CLI binary')
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
  expect((await rejection(updateAgentRuntime('codex', { ...options, report: message => {
    if (message.includes(phase === 'checking' ? '检查' : '已更新')) throw new Error('report failed')
  } }))).message).toContain('report failed')
  const state = JSON.parse(await readFile(join(root, 'codex/current.json'), 'utf8'))
  expect(state.error).toBeUndefined()
  expect(state.versions['@openai/codex']).toBe(phase === 'checking' ? '1.0.0' : '2.0.0')
  if (phase === 'checking') expect(state.directory).toBe(first.directory)
  else expect(state.directory).not.toBe(first.directory)
})

test('one Agent update failure does not prevent other Agents from getting their latest runtime', async () => {
  const root = await scratch()
  expect((await rejection(updateAgentRuntimes({ root, install, metadata: async name => {
    if (name.startsWith('@anthropic-ai/')) throw new Error('Claude registry failed')
    return { name, version: '7.0.0' }
  } }))).message).toContain('Claude registry failed')
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
    assert.throws(() => agentRuntimeRoot('codex'), /runtime 未安装.*lodestar update --agents-only/)
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

test('lodestar version displays only the selected installation, without update diagnostics or a failed exit code', async () => {
  const root = await scratch()
  const runtimeRoot = join(root, 'agent-runtimes')
  const selected = await updateAgentRuntime('codex', { root: runtimeRoot, install, metadata: async name => ({ name, version: '1.0.0' }) })
  expect((await rejection(updateAgentRuntime('codex', { root: runtimeRoot, metadata: async () => { throw new Error('TLS disconnected') } }))).message).toContain('TLS disconnected')
  await writeFile(join(runtimeRoot, 'codex/current.json'), JSON.stringify({ ...selected, error: 'legacy TLS disconnected' }))
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, 'cli.ts', 'version', ...args], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: root }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, stdout, stderr }
  }
  const plain = await run([])
  expect({ code: plain.code, stderr: plain.stderr }).toEqual({ code: 0, stderr: '' })
  expect(plain.stdout).toContain('codex: @openai/codex@1.0.0')
  expect(plain.stdout).not.toContain(selected.directory!)
  const verbose = await run(['--verbose'])
  expect({ code: verbose.code, stderr: verbose.stderr }).toEqual({ code: 0, stderr: '' })
  expect(verbose.stdout).toContain('codex: @openai/codex@1.0.0')
  expect(verbose.stdout).toContain(selected.directory!)
  expect(verbose.stdout).not.toContain('更新失败')
  expect(verbose.stdout).not.toContain('TLS disconnected')
  expect(verbose.stdout).not.toContain('codex: MISS')
})

test.each(['missing', 'mismatched'])('lodestar version reports a %s installed package instead of a successful recorded version', async damage => {
  const root = await scratch()
  const selected = await updateAgentRuntime('codex', { root: join(root, 'agent-runtimes'), install, metadata: async name => ({ name, version: '1.0.0' }) })
  const manifest = join(selected.directory!, 'node_modules/@openai/codex/package.json')
  if (damage === 'missing') await rm(manifest)
  else await writeFile(manifest, JSON.stringify({ name: '@openai/codex', version: '0.0.0' }))
  const child = Bun.spawn([process.execPath, 'cli.ts', 'version'], {
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
    expect((await rejection(pending)).message).toContain('temporary TLS failure')
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
  expect((await rejection(updateAgentRuntime('codex', { ...options, runningCommands: async () => [],
    metadata: async () => { throw new Error('registry offline') } }))).message).toContain('registry offline')
  expect(existsSync(crashed)).toBe(true)
  const reports: string[] = []
  await updateAgentRuntime('codex', { ...options, report: message => reports.push(message), runningCommands: async () => null })
  expect(existsSync(crashed)).toBe(true)
  expect(reports).toContain('codex: 中断安装的临时目录清理跳过（无法确认占用）')
})

test('locks an older version moved aside are swept even without a process table (Windows)', async () => {
  const root = await scratch()
  const options = { root, install, metadata: async (name: string) => ({ name, version: '1.0.0' }) }
  await updateAgentRuntime('codex', { ...options, runningCommands: async () => [] })
  const left = join(root, `codex/.stale-lock-${Date.now() - 10 * 60_000}-left`)
  const recent = join(root, `codex/.stale-lock-${Date.now()}-inflight`)
  for (const path of [left, recent]) await mkdir(path)
  const reports: string[] = []
  await updateAgentRuntime('codex', { ...options, report: message => reports.push(message), runningCommands: async () => null })
  expect(existsSync(left)).toBe(false)
  expect(existsSync(recent)).toBe(true)
  expect(reports).toContain('codex: 已清理 1 个中断安装的临时目录')
})

test('a preserved staging directory of a cancelled install is removed only after its installer is gone', async () => {
  const root = await scratch()
  let partial = ''
  // Stands in for an orphaned npm lifecycle child: alive, but no command line names the staging path.
  const installer = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'])
  try {
    expect((await rejection(updateAgentRuntime('codex', { root, metadata: async name => ({ name, version: '1.0.0' }),
      install: async directory => {
        partial = directory
        await recordInstaller(directory, installer.pid)
        throw new AgentInstallTerminationError('termination unconfirmed')
      } }))).message).toContain('termination unconfirmed')
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

test('of waiters that judged the same dead lock stale only one takes it over; an outdated judgement changes nothing', async () => {
  const root = await scratch()
  const { observe, reclaim, holderName } = updateLockForTest
  const lockPath = join(root, 'codex/update.lock')
  // An older version's lock (`pid` + `owner`), then the current layout, each left by an exited updater.
  await mkdir(lockPath, { recursive: true })
  await writeFile(join(lockPath, 'pid'), String(await exitedPid()))
  await writeFile(join(lockPath, 'owner'), 'dead-owner')
  for (const layout of ['legacy', 'current']) {
    if (layout === 'current') {
      await rm(lockPath, { recursive: true })
      await mkdir(lockPath)
      await writeFile(join(lockPath, holderName(await exitedPid(), randomUUID())), '')
    }
    const seenByA = await observe(lockPath)
    const seenByB = await observe(lockPath)
    const a = holderName(process.pid, randomUUID())
    expect(await reclaim(lockPath, seenByA, a)).toBe('held')
    // B finds no file it judged: nothing is moved, nothing has to be moved back.
    expect(await reclaim(lockPath, seenByB, holderName(process.pid, randomUUID()))).toBe('changed')
    expect((await readdir(lockPath)).filter(name => name.startsWith('holder-'))).toEqual([a])
    expect((await readdir(join(root, 'codex'))).filter(name => name.startsWith('.stale-lock-'))).toEqual([])
  }
})

test('an abandoned lock directory is removed only while it has no holder; a lock appears complete', async () => {
  const root = await scratch()
  const { observe, reclaim, create, holderName } = updateLockForTest
  const directory = join(root, 'codex')
  const lockPath = join(directory, 'update.lock')
  // An older version's directory that never got a holder, left for over 30 seconds.
  await mkdir(lockPath, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  await utimes(lockPath, old, old)
  const seen = await observe(lockPath)
  expect(seen.holder).toBeUndefined()
  expect(await reclaim(lockPath, seen, holderName(process.pid, randomUUID()))).toBe('free')
  // A new lock is published by one rename with its holder and records already inside.
  const live = holderName(process.pid, randomUUID())
  expect(await create(directory, lockPath, live, { pid: String(process.pid) })).toBe('held')
  expect((await readdir(lockPath)).sort()).toEqual([live, 'pid'])
  // The outdated judgement finds a directory that is not empty: nothing is removed or shared.
  expect(await reclaim(lockPath, seen, holderName(process.pid, randomUUID()))).toBe('changed')
  expect(await create(directory, lockPath, holderName(process.pid, randomUUID()), {})).toBe('exists')
  expect((await readdir(lockPath)).filter(name => name.startsWith('holder-'))).toEqual([live])
  expect((await readdir(directory)).filter(name => name.startsWith('.lock-staging-'))).toEqual([])
  // Records written after a takeover never recreate a lock directory removed meanwhile.
  await rm(lockPath, { recursive: true })
  let late: unknown
  try { writeStateFileAtomic(join(lockPath, 'pid'), String(process.pid), { createParent: false }) } catch (error) { late = error }
  expect((late as NodeJS.ErrnoException).code).toBe('ENOENT')
  expect(existsSync(lockPath)).toBe(false)
})

test('an outdated reclaim of an abandoned directory cannot remove or share a lock published meanwhile', async () => {
  const root = await scratch()
  const { observe, reclaim, create, holderName } = updateLockForTest
  const directory = join(root, 'codex')
  const lockPath = join(directory, 'update.lock')
  await mkdir(lockPath, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  await utimes(lockPath, old, old)
  // B judged the abandoned directory as well, then stalled; this updater reclaims it, publishes
  // its own lock, and only then does B act on its judgement.
  const seenByB = await observe(lockPath)
  let outcomeB: string | undefined
  let holders: string[] = []
  updateLockForTest.afterCreate = async () => {
    updateLockForTest.afterCreate = undefined
    outcomeB = await reclaim(lockPath, seenByB, holderName(process.pid, randomUUID()))
    if (outcomeB === 'free') await create(directory, lockPath, holderName(process.pid, randomUUID()), {})
    holders = (await readdir(lockPath)).filter(name => name.startsWith('holder-'))
  }
  try {
    await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }) })
  } finally { updateLockForTest.afterCreate = undefined }
  expect(outcomeB).toBe('changed')
  expect(holders).toHaveLength(1)
})

test.each(['dead updater', 'abandoned directory'] as const)('concurrent updaters on a lock of a %s take turns and all finish', async left => {
  const root = await scratch()
  const lockPath = join(root, 'codex/update.lock')
  await mkdir(lockPath, { recursive: true })
  if (left === 'dead updater') {
    await writeFile(join(lockPath, 'pid'), String(await exitedPid()))
    await writeFile(join(lockPath, 'owner'), 'dead-owner')
  } else {
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
  }
  let inside = 0
  let most = 0
  const run = () => {
    let entered = false
    return updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => {
      if (!entered) {
        entered = true
        most = Math.max(most, ++inside)
      }
      await Bun.sleep(20)
      return { name, version: '1.0.0' }
    } }).then(() => true, () => false).finally(() => { if (entered) inside-- })
  }
  expect(await Promise.all([run(), run(), run(), run()])).toEqual([true, true, true, true])
  expect(most).toBe(1)
  expect((await readdir(join(root, 'codex'))).filter(name => name === 'update.lock' || name.startsWith('.stale-lock-'))).toEqual([])
})

test('a lock naming this process\'s PID that it does not hold is reclaimed (the PID of a daemon before a restart)', async () => {
  const root = await scratch()
  const lockPath = join(root, 'codex/update.lock')
  await mkdir(lockPath, { recursive: true })
  // An earlier daemon that had the same PID (deterministic after a reboot) died holding the lock.
  await writeFile(join(lockPath, updateLockForTest.holderName(process.pid, randomUUID())), '')
  const started = Date.now()
  await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }) })
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(existsSync(lockPath)).toBe(false)
})

test('a lock is reclaimed only when its PID now has another start identity, whatever the wall clock does', async () => {
  const root = await scratch()
  const lockPath = join(root, 'codex/update.lock')
  const live = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'])
  const hold = async (start: string | undefined): Promise<string> => {
    await rm(lockPath, { recursive: true, force: true })
    await mkdir(lockPath, { recursive: true })
    const token = randomUUID()
    const holder = updateLockForTest.holderName(live.pid, token)
    await writeFile(join(lockPath, holder), '')
    if (start !== undefined) await writeFile(join(lockPath, `start-${token}`), start)
    return holder
  }
  const waitedFor = async (holder: string) => {
    const controller = new AbortController()
    const waiting = updateAgentRuntime('codex', { root, install, signal: controller.signal, runningCommands: async () => [],
      metadata: async name => ({ name, version: '2.0.0' }) })
    await Bun.sleep(800)
    controller.abort(new Error('stopped waiting'))
    // Windows CI: never expect(...).rejects on a promise parked on the 200 ms wait timer.
    const stopped = await waiting.then(() => undefined, (error: unknown) => error)
    expect((stopped as Error).message).toBe('stopped waiting')
    expect(await readdir(lockPath)).toContain(holder)
  }
  const clock = spyOn(Date, 'now')
  const realNow = clock.getMockImplementation() ?? (() => performance.timeOrigin + performance.now())
  try {
    await Bun.sleep(200)
    const identity = await processStartId(live.pid)
    expect(identity).not.toBeNull()
    // The process with this PID started at another time than the recorded holder: reused.
    await hold(identity!.replace(/\d+$/, digits => String(Number(digits) + 5_000)))
    const started = performance.now()
    await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }) })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(existsSync(lockPath)).toBe(false)
    // Still the recorded holder, even after the wall clock stepped either way while it held the lock.
    for (const step of [30_000, -30_000]) {
      clock.mockImplementation(() => realNow() + step)
      await waitedFor(await hold(identity!))
    }
    clock.mockRestore()
    // Nothing recorded yet proves nothing either.
    await waitedFor(await hold(undefined))
  } finally {
    clock.mockRestore()
    live.kill()
  }
})

test('a failed start-identity query is asked again after a backoff, not remembered as an answer', async () => {
  const live = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'])
  const query = spyOn(pidGuard, 'processStartId')
  const clock = spyOn(performance, 'now')
  try {
    await Bun.sleep(200)
    const identity = await processStartId(live.pid)
    expect(identity).not.toBeNull()
    // The recorded holder had another start: the PID was reused, once the query can tell.
    const observed = { entries: [], holder: updateLockForTest.holderName(live.pid, randomUUID()), pid: live.pid, legacy: false,
      start: identity!.replace(/\d+$/, digits => String(Number(digits) + 5_000)), mtimeMs: 0 }
    const checks = new Map()
    query.mockClear()
    query.mockResolvedValue(null)
    clock.mockReturnValue(1_000)
    expect(await updateLockForTest.holderGone(observed, checks)).toBe(false)
    clock.mockReturnValue(1_500)
    expect(await updateLockForTest.holderGone(observed, checks)).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
    query.mockRestore()
    clock.mockReturnValue(2_100)
    expect(await updateLockForTest.holderGone(observed, checks)).toBe(true)
  } finally {
    query.mockRestore()
    clock.mockRestore()
    live.kill()
  }
})

test.skipIf(process.platform === 'win32')('a release cut short leaves only an inert directory; the lock path is free at once', async () => {
  const root = await scratch()
  const lockPath = join(root, 'codex/update.lock')
  let blocked = ''
  // While the lock is held, put something in it the removal cannot delete.
  await updateAgentRuntime('codex', { root, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }),
    install: async directory => {
      blocked = join(lockPath, 'kept')
      await mkdir(blocked)
      await writeFile(join(blocked, 'file'), '')
      await chmod(blocked, 0o500)
      await install(directory)
    } })
  try {
    expect(existsSync(lockPath)).toBe(false)
    const aside = (await readdir(join(root, 'codex'))).filter(name => name.startsWith('.stale-lock-'))
    expect(aside).toHaveLength(1)
    // The next updater takes the free path without waiting for anything.
    const started = performance.now()
    await updateAgentRuntime('codex', { root, install, runningCommands: async () => [], metadata: async name => ({ name, version: '2.0.0' }) })
    expect(performance.now() - started).toBeLessThan(5_000)
  } finally {
    for (const name of (await readdir(join(root, 'codex'))).filter(name => name.startsWith('.stale-lock-'))) {
      await chmod(join(root, 'codex', name, 'kept'), 0o700).catch(() => {})
    }
  }
})

test.skipIf(process.platform === 'win32')('a live updater started through a symlinked path keeps its own lock', async () => {
  const root = await scratch()
  // The holder takes the lock itself (its own records), started through a directory symlink:
  // Bun reports the resolved script path, ps shows the path it was started with.
  const real = join(root, 'real')
  await mkdir(real)
  await writeFile(join(real, 'holder.ts'), `
    import { mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { updateAgentRuntime } from ${JSON.stringify(join(import.meta.dir, 'agent-updates.ts'))}
    const [root, marker] = process.argv.slice(2)
    await updateAgentRuntime('codex', { root, runningCommands: async () => [], metadata: async name => ({ name, version: '1.0.0' }),
      install: async directory => {
        await writeFile(marker, 'installing')
        await new Promise(resolve => setTimeout(resolve, 5_000))
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        for (const [name, version] of Object.entries(manifest.dependencies)) {
          await mkdir(join(directory, 'node_modules', name), { recursive: true })
          await writeFile(join(directory, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
        }
      } })
  `)
  symlinkSync(real, join(root, 'linked'), 'dir')
  const marker = join(root, 'holder-installing')
  const holder = Bun.spawn([process.execPath, join(root, 'linked', 'holder.ts'), root, marker], { stdout: 'ignore', stderr: 'ignore' })
  try {
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(100)
    expect(existsSync(marker)).toBe(true)
    let installedMeanwhile = false
    const controller = new AbortController()
    const waiting = updateAgentRuntime('codex', { root, signal: controller.signal, runningCommands: async () => [],
      metadata: async name => ({ name, version: '2.0.0' }), install: async () => { installedMeanwhile = true } })
    await Bun.sleep(1_500)
    controller.abort(new Error('stopped waiting'))
    const stopped = await waiting.then(() => undefined, (error: unknown) => error)
    expect((stopped as Error).message).toBe('stopped waiting')
    expect(installedMeanwhile).toBe(false)
    expect(holder.exitCode).toBeNull()
  } finally {
    holder.kill()
    await holder.exited
  }
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
