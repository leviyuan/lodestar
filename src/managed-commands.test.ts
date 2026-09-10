import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureLodestarAgentCommand,
  resolveAgentCliLaunch,
} from './managed-commands'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar command-')))
  roots.push(root)
  return root
}

describe('managed lodestar-agent command', () => {
  test('resolves Bun source and Node release layouts without substituting a missing entry', () => {
    const root = tempRoot()
    const daemonEntry = join(root, 'daemon.ts')
    const source = join(root, 'src', 'agent-cli.ts')
    const bundle = join(root, 'dist', 'lodestar-agent.js')
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dist'))
    writeFileSync(daemonEntry, '')
    writeFileSync(source, '')
    writeFileSync(join(root, 'dist', 'lodestar.js'), '')
    writeFileSync(bundle, '')
    expect(resolveAgentCliLaunch({
      daemonEntry,
      runtime: '/opt/bun/bin/bun',
    })).toEqual({ runtime: '/opt/bun/bin/bun', entry: source })
    expect(resolveAgentCliLaunch({
      daemonEntry: join(root, 'dist', 'lodestar.js'),
      runtime: '/usr/bin/node',
    })).toEqual({ runtime: '/usr/bin/node', entry: bundle })
    expect(() => resolveAgentCliLaunch({
      daemonEntry, runtime: '/opt/bun/bin/bun', exists: () => false,
    })).toThrow('entry not found')
  })

  test('resolves the installed package through a Node command symlink', async () => {
    const root = tempRoot()
    const dist = join(root, 'lib', 'node_modules', '@leviyuan', 'lodestar', 'dist')
    const bin = join(root, 'bin')
    mkdirSync(dist, { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    const probe = join(root, 'probe.ts')
    writeFileSync(probe, [
      `import { resolveAgentCliLaunch } from ${JSON.stringify(join(import.meta.dir, 'managed-commands.ts'))}`,
      'process.stdout.write(JSON.stringify(resolveAgentCliLaunch()))',
    ].join('\n'))
    const build = await Bun.build({
      entrypoints: [probe], target: 'node', minify: true,
      outdir: dist, naming: 'lodestar.js',
    })
    expect(build.success, build.logs.join('\n')).toBe(true)
    const entry = join(dist, 'lodestar-agent.js')
    writeFileSync(entry, '')
    symlinkSync('../lib/node_modules/@leviyuan/lodestar/dist/lodestar.js', join(bin, 'daemon-link'))
    const command = join(bin, 'lodestar-daemon')
    symlinkSync('daemon-link', command)
    const proc = Bun.spawnSync(['node', command], { cwd: root })
    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    expect(JSON.parse(proc.stdout.toString()).entry).toBe(entry)

    // A similarly named file beside the command must never override the package.
    writeFileSync(join(bin, 'lodestar-agent.js'), '')
    const withDecoy = Bun.spawnSync(['node', command], { cwd: root })
    expect(withDecoy.exitCode, withDecoy.stderr.toString()).toBe(0)
    expect(JSON.parse(withDecoy.stdout.toString()).entry).toBe(entry)

    rmSync(entry)
    const missing = Bun.spawnSync(['node', command], { cwd: root })
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr.toString()).toContain(`entry not found beside daemon: ${entry}`)
  })

  test('surfaces a broken daemon symlink instead of selecting another command', () => {
    const root = tempRoot()
    const daemonEntry = join(root, 'lodestar-daemon')
    symlinkSync('missing-daemon.js', daemonEntry)
    writeFileSync(join(root, 'lodestar-agent.js'), '')
    expect(() => resolveAgentCliLaunch({ daemonEntry, runtime: '/usr/bin/node' })).toThrow('ENOENT')
  })

  test('atomically installs an executable wrapper and prepends its directory to PATH', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const target = ensureLodestarAgentCommand({
      platform: 'linux',
      targetDir,
      launch: { runtime: "/opt/bun's/bin/bun", entry: '/repo/src/agent-cli.ts' },
      env,
    })
    expect(readFileSync(target, 'utf8')).toContain(`exec '/opt/bun'"'"'s/bin/bun' '/repo/src/agent-cli.ts' "$@"`)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(env.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('removes only the obsolete daemon-owned consult wrapper', () => {
    const targetDir = join(tempRoot(), 'bin')
    const legacy = join(targetDir, 'lodestar-consult')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(legacy, "#!/bin/sh\nexec bun /repo/src/consult-cli.ts \"$@\"\n", { mode: 0o700 })
    ensureLodestarAgentCommand({
      platform: 'linux', targetDir,
      launch: { runtime: '/opt/bun/bin/bun', entry: '/repo/src/agent-cli.ts' },
      env: { PATH: '/usr/bin' },
    })
    expect(existsSync(legacy)).toBe(false)
  })

  test('writes a Windows command wrapper and updates Path case-insensitively', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const target = ensureLodestarAgentCommand({
      platform: 'win32',
      targetDir,
      launch: { runtime: 'C:\\Bun\\bun.exe', entry: 'C:\\Lodestar\\agent.js' },
      env,
    })
    expect(target.endsWith('lodestar-agent.cmd')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\agent.js" %*\r\n')
    expect(env.Path).toBe(`${targetDir};C:\\Windows`)
  })
})
