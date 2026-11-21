import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLodestarCommand, resolveLodestarLaunch } from './managed-commands'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar command-')))
  roots.push(root)
  return root
}

describe('managed lodestar command', () => {
  test('resolves Bun source and Node release layouts without substituting a missing entry', () => {
    const root = tempRoot()
    const daemonEntry = join(root, 'daemon.ts')
    const source = join(root, 'cli.ts')
    const bundle = join(root, 'dist', 'lodestar.js')
    mkdirSync(join(root, 'dist'))
    writeFileSync(daemonEntry, '')
    writeFileSync(source, '')
    writeFileSync(bundle, '')
    expect(resolveLodestarLaunch({ daemonEntry, runtime: '/opt/bun/bin/bun' }))
      .toEqual({ runtime: '/opt/bun/bin/bun', entry: source })
    expect(resolveLodestarLaunch({ daemonEntry: bundle, runtime: '/usr/bin/node' }))
      .toEqual({ runtime: '/usr/bin/node', entry: bundle })
    expect(() => resolveLodestarLaunch({ daemonEntry, runtime: '/opt/bun/bin/bun', exists: () => false }))
      .toThrow('entry not found')
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
      `import { resolveLodestarLaunch } from ${JSON.stringify(join(import.meta.dir, 'managed-commands.ts'))}`,
      'process.stdout.write(JSON.stringify(resolveLodestarLaunch()))',
    ].join('\n'))
    const build = await Bun.build({
      entrypoints: [probe], target: 'node', minify: true,
      outdir: dist, naming: 'lodestar.js',
    })
    expect(build.success, build.logs.join('\n')).toBe(true)
    const entry = join(dist, 'lodestar.js')
    const command = join(bin, 'lodestar')
    symlinkSync('../lib/node_modules/@leviyuan/lodestar/dist/lodestar.js', command)
    const proc = Bun.spawnSync(['node', command], { cwd: root })
    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    expect(JSON.parse(proc.stdout.toString()).entry).toBe(entry)

    // A similarly named file beside the command must never override the package.
    writeFileSync(join(bin, 'lodestar.js'), '')
    const withDecoy = Bun.spawnSync(['node', command], { cwd: root })
    expect(withDecoy.exitCode, withDecoy.stderr.toString()).toBe(0)
    expect(JSON.parse(withDecoy.stdout.toString()).entry).toBe(entry)

  })

  test('surfaces a broken daemon symlink instead of selecting another command', () => {
    const root = tempRoot()
    const daemonEntry = join(root, 'lodestar')
    symlinkSync('missing-daemon.js', daemonEntry)
    expect(() => resolveLodestarLaunch({ daemonEntry, runtime: '/usr/bin/node' })).toThrow('ENOENT')
  })

  test('atomically installs the executable wrapper and prepends its directory to PATH', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const target = ensureLodestarCommand({
      platform: 'linux',
      targetDir,
      launch: { runtime: "/opt/bun's/bin/bun", entry: '/repo/cli.ts' },
      env,
    })
    expect(target.endsWith('lodestar')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(`#!/bin/sh\nexec '/opt/bun'"'"'s/bin/bun' '/repo/cli.ts' "$@"\n`)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(env.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('removes obsolete daemon-owned wrappers but preserves unclear files', () => {
    const targetDir = join(tempRoot(), 'bin')
    mkdirSync(targetDir, { recursive: true })
    const consult = join(targetDir, 'lodestar-consult')
    const agent = join(targetDir, 'lodestar-agent')
    const foreign = join(targetDir, 'lodestar-old')
    writeFileSync(consult, "#!/bin/sh\nexec bun /repo/src/consult-cli.ts \"$@\"\n", { mode: 0o700 })
    writeFileSync(agent, "#!/bin/sh\nexec bun /repo/src/agent-cli.ts \"$@\"\n", { mode: 0o700 })
    writeFileSync(foreign, "#!/bin/sh\nexec /usr/bin/other \"$@\"\n", { mode: 0o700 })
    ensureLodestarCommand({
      platform: 'linux', targetDir,
      launch: { runtime: '/opt/bun/bin/bun', entry: '/repo/cli.ts' },
      env: { PATH: '/usr/bin' },
    })
    expect(existsSync(consult)).toBe(false)
    expect(existsSync(agent)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
  })

  test('writes a Windows command wrapper and updates Path case-insensitively', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const target = ensureLodestarCommand({
      platform: 'win32',
      targetDir,
      launch: { runtime: 'C:\\Bun\\bun.exe', entry: 'C:\\Lodestar\\dist\\lodestar.js' },
      env,
    })
    expect(target.endsWith('lodestar.cmd')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\dist\\lodestar.js" %*\r\n')
    expect(env.Path).toBe(`${targetDir};C:\\Windows`)
  })
})
