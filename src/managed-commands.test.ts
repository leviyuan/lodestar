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
    })!
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
    })!
    expect(target.endsWith('lodestar.cmd')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\dist\\lodestar.js" %*\r\n')
    expect(env.Path).toBe(`${targetDir};C:\\Windows`)
  })

  test('updates an existing Lodestar wrapper of the same shape, including the source-checkout form', () => {
    const targetDir = join(tempRoot(), 'bin')
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, 'lodestar')
    // Same shape as a wrapper generated for a source checkout with an older Bun.
    writeFileSync(target, `#!/bin/sh\nexec '/home/u/.local/share/lodestar-dev-tools/bun-1.3.10/bun' '/home/u/project/feishu/cli.ts' "$@"\n`, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(ensureLodestarCommand({
      platform: 'linux', targetDir, env,
      launch: { runtime: '/home/u/.local/share/lodestar-dev-tools/bun-1.3.11/bun', entry: '/home/u/project/feishu/cli.ts' },
    })).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(`#!/bin/sh\nexec '/home/u/.local/share/lodestar-dev-tools/bun-1.3.11/bun' '/home/u/project/feishu/cli.ts' "$@"\n`)
    // A release-bundle wrapper with quoted characters is recognized as well.
    writeFileSync(target, `#!/bin/sh\nexec '/opt/node'"'"'s/node' '/usr/lib/node_modules/@leviyuan/lodestar/dist/lodestar.js' "$@"\n`)
    ensureLodestarCommand({ platform: 'linux', targetDir, env, launch: { runtime: '/usr/bin/node', entry: '/srv/lodestar/dist/lodestar.js' } })
    expect(readFileSync(target, 'utf8')).toBe(`#!/bin/sh\nexec '/usr/bin/node' '/srv/lodestar/dist/lodestar.js' "$@"\n`)
    expect(env.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('never replaces a user script, a foreign symlink or the npm command link', () => {
    const root = tempRoot()
    const targetDir = join(root, 'bin')
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, 'lodestar')
    const launch = { runtime: '/usr/bin/node', entry: join(root, 'dist', 'lodestar.js') }
    mkdirSync(join(root, 'dist'))
    writeFileSync(launch.entry, '// bundle')

    const script = `#!/bin/sh\n# my own lodestar helper\nexec /usr/local/bin/other "$@"\n`
    writeFileSync(target, script, { mode: 0o755 })
    const userEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(ensureLodestarCommand({ platform: 'linux', targetDir, env: userEnv, launch })).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe(script)
    expect(userEnv.PATH).toBe('/usr/bin')

    rmSync(target)
    writeFileSync(join(root, 'other.js'), '// other')
    symlinkSync(join(root, 'other.js'), target)
    expect(ensureLodestarCommand({ platform: 'linux', targetDir, env: { PATH: '/usr/bin' }, launch })).toBeNull()
    expect(realpathSync(target)).toBe(join(root, 'other.js'))

    // npm's global bin link to the running entry already works; keep the link.
    rmSync(target)
    symlinkSync('../dist/lodestar.js', target)
    const npmEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(ensureLodestarCommand({ platform: 'linux', targetDir, env: npmEnv, launch })).toBeNull()
    expect(realpathSync(target)).toBe(launch.entry)
    expect(npmEnv.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('Windows wrappers follow the same ownership rule', () => {
    const targetDir = join(tempRoot(), 'bin')
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, 'lodestar.cmd')
    const launch = { runtime: 'C:\\Bun\\bun.exe', entry: 'C:\\Lodestar\\dist\\lodestar.js' }
    writeFileSync(target, '@"C:\\Old\\node.exe" "C:\\Old\\dist\\lodestar.js" %*\r\n')
    expect(ensureLodestarCommand({ platform: 'win32', targetDir, env: { Path: 'C:\\Windows' }, launch })).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\dist\\lodestar.js" %*\r\n')
    writeFileSync(target, '@echo off\r\nC:\\Tools\\lodestar.exe %*\r\n')
    expect(ensureLodestarCommand({ platform: 'win32', targetDir, env: { Path: 'C:\\Windows' }, launch })).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('@echo off\r\nC:\\Tools\\lodestar.exe %*\r\n')
  })
})
