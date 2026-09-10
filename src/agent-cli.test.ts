import { describe, expect, test } from 'bun:test'
import { parsePromptArgs } from './agent-cli'
import { join } from 'node:path'

describe('lodestar-agent CLI args', () => {
  test('uses the DSH root context for its authenticated request', async () => {
    const authorizations: Array<string | null> = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      authorizations.push(request.headers.get('authorization'))
      return Response.json({ identities: [], sourceFailures: [] })
    } })
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'agent-cli.ts'), 'identities', '--json'], {
        env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, capability: 'dsh-test-capability' }),
          LODESTAR_AGENT_CAPABILITY: 'must-not-use-legacy' }, stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout).identities).toEqual([])
      expect(authorizations).toEqual(['Bearer dsh-test-capability'])
    } finally { await server.stop(true) }
  })

  test('rejects malformed DSH context without using legacy credentials', () => {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, 'agent-cli.ts'), 'identities'], {
      env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: '{}', LODESTAR_AGENT_URL: 'http://127.0.0.1:1', LODESTAR_AGENT_CAPABILITY: 'legacy' },
    })
    expect(proc.exitCode).not.toBe(0)
    expect(proc.stderr.toString()).toContain('invalid DSH Lodestar delegation context')
  })

  test('parses a parallel full-Agent run', () => {
    expect(parsePromptArgs([
      '--identity', 'a', '--identity', 'b', '--identity', 'a', '--effort', 'max', '--stdin', '--no-wait',
    ], true)).toEqual({
      identityIds: ['a', 'b'], identityId: '', effort: 'max', prompt: '', noWait: true, readStdin: true,
    })
  })

  test('parses a single-session follow-up', () => {
    expect(parsePromptArgs(['--identity', 'a', 'continue here'], false)).toEqual({
      identityIds: [], identityId: 'a', effort: '', prompt: 'continue here', noWait: false, readStdin: false,
    })
  })

  test('requires an identity for a new run', () => {
    expect(() => parsePromptArgs(['task'], true)).toThrow('--identity')
  })
})
