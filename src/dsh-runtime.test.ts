import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshRuntime, profileProvidesAskUser } from './dsh-runtime'
import * as logModule from './log'

const roots: string[] = []
function runtimeRoot(patch?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-dsh-profile-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{"name":"runtime","private":true}')
  if (patch !== undefined) {
    const profile = join(root, 'node_modules', '@deepseek-ai', 'dsh-sdk-app')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{"name":"@deepseek-ai/dsh-sdk-app","version":"test"}')
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  }
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('DSH ask-user profile detection', () => {
  test('recognises a profile that already registers the ask-user tool', () => {
    const patch = [
      '    - id: tool-present',
      "      name: '@deepseek-ai/dsh-tool-present'",
      '    - id: tool-ask-user',
      '      name: "@deepseek-ai/dsh-tool-ask-user"',
      '',
    ].join('\n')
    expect(profileProvidesAskUser(runtimeRoot(patch))).toBe(true)
  })

  test('older profiles still need the explicit insert', () => {
    expect(profileProvidesAskUser(runtimeRoot("- id: tool-present\n  name: '@deepseek-ai/dsh-tool-present'\n"))).toBe(false)
    expect(profileProvidesAskUser(runtimeRoot(''))).toBe(false)
    // A commented-out or differently spelled entry is not a provided plugin.
    expect(profileProvidesAskUser(runtimeRoot("# name: '@deepseek-ai/dsh-tool-ask-user'\n"))).toBe(false)
    expect(profileProvidesAskUser(runtimeRoot("  name: '@deepseek-ai/dsh-tool-ask-user-v2'\n"))).toBe(false)
  })

  test('missing profile packages keep the explicit insert instead of failing', () => {
    expect(profileProvidesAskUser(runtimeRoot())).toBe(false)
    expect(profileProvidesAskUser(join(tmpdir(), 'lodestar-missing-runtime-root'))).toBe(false)
  })
})

describe('DSH launch directory', () => {
  test('a launch that fails after the directory was created removes it and keeps the original error', () => {
    const root = runtimeRoot()
    const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dsh, { recursive: true })
    writeFileSync(join(dsh, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"test","bin":{"dsh":"bin.js"}}')
    // The bridge directory cannot be created below a regular file.
    writeFileSync(join(root, '.lodestar-bridges'), '')
    const temp = join(root, 'tmp')
    mkdirSync(temp)
    const saved = { runtime: process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT, tmp: process.env.TMPDIR }
    process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = root
    process.env.TMPDIR = temp
    try {
      expect(() => new DshRuntime({ cwd: root, env: {}, home: join(root, 'home') })).toThrow(/ENOTDIR|EEXIST/)
      expect(readdirSync(temp)).toEqual([])
    } finally {
      for (const [key, value] of [['LODESTAR_TEST_AGENT_RUNTIME_ROOT', saved.runtime], ['TMPDIR', saved.tmp]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test.skipIf(process.platform === 'win32')('a launch directory that cannot be removed on child close is logged, not thrown from the listener', async () => {
    const root = runtimeRoot()
    const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dsh, { recursive: true })
    writeFileSync(join(dsh, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"test","bin":{"dsh":"bin.js"}}')
    const temp = join(root, 'tmp')
    mkdirSync(temp)
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    const spawn = spyOn(DshRuntime.prototype as any, 'spawnChild').mockImplementation(() => child)
    const logged = spyOn(logModule, 'logError').mockImplementation(() => {})
    const saved = { runtime: process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT, tmp: process.env.TMPDIR }
    process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = root
    process.env.TMPDIR = temp
    let launchDir = ''
    try {
      const runtime = new DshRuntime({ cwd: root, env: {}, home: join(root, 'home') })
      launchDir = (runtime as any).launchDir
      writeFileSync(join(launchDir, 'bridge.patch.yml'), '{}')
      chmodSync(launchDir, 0o500)
      expect(() => child.emit('close', 1, null)).not.toThrow()
      expect(logged).toHaveBeenCalledWith('dsh.launch_dir.cleanup_failed', expect.anything())
    } finally {
      if (launchDir) chmodSync(launchDir, 0o700)
      spawn.mockRestore()
      logged.mockRestore()
      for (const [key, value] of [['LODESTAR_TEST_AGENT_RUNTIME_ROOT', saved.runtime], ['TMPDIR', saved.tmp]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
