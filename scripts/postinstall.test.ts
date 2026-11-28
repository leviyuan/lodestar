import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Loading the script only exports its text; the migration side effects run when npm executes it.
const { installMessage, LEGACY_COMMANDS } = require('./postinstall.cjs') as {
  installMessage(): string
  LEGACY_COMMANDS: Array<[string, string]>
}

test('postinstall tells users upgrading from 0.24 or earlier how to finish the Agent update and fix their service', () => {
  const text = installMessage()
  // The old lodestar-update re-executes its removed entry, so the Agent step must be rerun.
  expect(text).toContain('从 0.24 及更早版本升级')
  expect(text).toContain('请再运行一次 lodestar update --agents-only')
  expect(text).toContain('lodestar-daemon 改为 lodestar start')
  for (const [legacy, current] of LEGACY_COMMANDS) expect(text).toContain(`${legacy} → ${current}`)
  expect(LEGACY_COMMANDS.map(([legacy]) => legacy)).toEqual([
    'lodestar-daemon', 'lodestar-setup', 'lodestar-stop', 'lodestar-update', 'lodestar-version', 'lodestar-agent', 'lodestar-claude',
  ])
})
