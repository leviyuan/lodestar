import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import permissions from '../docs/feishu-permissions.json'

test('the importable permission list carries the 1:1 message scope and the setup guide names every scope', () => {
  const tenant: string[] = permissions.scopes.tenant
  expect(tenant).toContain('im:message.p2p_msg:readonly')
  // 群解散事件 im.chat.disbanded_v1 要求 im:chat（或 im:chat:readonly）其一，清单已含 im:chat。
  expect(tenant).toContain('im:chat')
  expect(new Set(tenant).size).toBe(tenant.length)
  expect(permissions.scopes.user).toEqual([])
  // The wizard prints the JSON and then a readable copy; the two must not drift apart.
  const setup = readFileSync(fileURLToPath(new URL('./setup.ts', import.meta.url)), 'utf8')
  for (const scope of tenant) expect(setup).toContain('${C.bold}' + scope + '${C.reset}')
})
