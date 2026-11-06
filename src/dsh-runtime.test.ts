import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileProvidesAskUser } from './dsh-runtime'

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
