import { test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = process.platform === 'win32' ? null : Bun.which('python3')

test.skipIf(!python)('Codex reset monitor: isolated Python state and delivery regressions (Unix, Python 3.9+)', () => {
  const result = spawnSync(python!, ['-B', fileURLToPath(new URL('./test_monitor.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Codex reset monitor regressions failed: ${result.error?.message ?? `exit ${result.status}`}\n${result.stdout}\n${result.stderr}`)
  }
})
