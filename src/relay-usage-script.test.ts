import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'lodestar-relay-usage-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function script(name: string, body: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Runs the real reader in its own process so an unhandled stream error is observable
 * as that process dying instead of as noise in the shared test runner. */
function read(balanceScript: string, apiKey: string | { length: number }): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([process.execPath, '--eval', `
    import { readRelayUsage } from ${JSON.stringify(fileURLToPath(new URL('./relay-usage-script.ts', import.meta.url)))}
    process.on('uncaughtException', error => { console.error('UNCAUGHT ' + (error?.code ?? error?.message)); process.exit(70) })
    const [balance_script, key] = JSON.parse(process.argv.at(-1))
    const api_key = typeof key === 'string' ? key : 'k'.repeat(key.length)
    const result = await readRelayUsage('site', { balance_script, api_key, base_url: 'https://relay.test' }, 'openai')
    // Let a late pipe error surface before reporting success.
    await new Promise(resolve => setTimeout(resolve, 100))
    process.stdout.write(JSON.stringify(result))
  `, JSON.stringify([balanceScript, apiKey])], { stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

test.skipIf(process.platform === 'win32')('a balance script receives the account on stdin and its snapshot is returned', () => {
  const path = script('echo.sh', `input=$(cat)
case "$input" in *'"api_key":"secret-key"'*) ;; *) exit 9 ;; esac
echo '{"state":"ok","kind":"balance","windows":[]}'`)
  const result = read(path, 'secret-key')
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ state: 'ok', kind: 'balance', windows: [] })
})

test.skipIf(process.platform === 'win32')('a script that exits without reading a large input cannot crash the caller', () => {
  // The input exceeds the pipe buffer, so the write fails once the script has gone.
  const path = script('no-read.sh', `exec 0<&-
echo '{"state":"ok","kind":"balance","windows":[]}'`)
  const result = read(path, { length: 2_000_000 })
  expect(result.stderr).not.toContain('UNCAUGHT')
  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).state).toBe('ok')
})

test.skipIf(process.platform === 'win32')('script failures are reported as an unavailable balance, never as success', () => {
  const failing = read(script('fail.sh', 'cat >/dev/null; exit 3'), 'key')
  expect(failing.exitCode, failing.stderr).toBe(0)
  expect(JSON.parse(failing.stdout)).toEqual({ state: 'network', windows: [], reason: '余额脚本退出码 3' })

  const malformed = read(script('malformed.sh', "cat >/dev/null; echo 'not json'"), 'key')
  expect(JSON.parse(malformed.stdout).state).toBe('network')
})
