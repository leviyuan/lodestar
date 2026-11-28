import { describe, expect, test } from 'bun:test'
import { parsePromptArgs } from './agent-main'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 统一入口；Agent 调用与用户终端共用 `lodestar agent`。 */
const CLI = join(import.meta.dir, '..', 'cli.ts')

describe('lodestar agent subcommand', () => {
  test('prints help and reports a malformed managed context without daemon config', () => {
    const help = Bun.spawnSync([process.execPath, CLI, 'agent', '--help'], { cwd: join(import.meta.dir, '..') })
    expect(help.exitCode, help.stderr.toString()).toBe(0)
    expect(help.stdout.toString()).toContain('lodestar agent run --identity')
    const invalid = Bun.spawnSync([process.execPath, CLI, 'agent', 'identities'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: '{}' },
    })
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr.toString()).toContain('invalid DSH Lodestar delegation context')
  })

  test('uses the DSH root context for its authenticated request', async () => {
    const authorizations: Array<string | null> = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      authorizations.push(request.headers.get('authorization'))
      return Response.json({ identities: [], sourceFailures: [] })
    } })
    try {
      // Inside a DSH shell the launch removed LODESTAR_AGENT_*; a lone capability is not a context.
      const proc = Bun.spawn([process.execPath, CLI, 'agent', 'identities', '--json'], {
        env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, capability: 'dsh-test-capability' }),
          LODESTAR_AGENT_CAPABILITY: 'incomplete-without-url' }, stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout).identities).toEqual([])
      expect(authorizations).toEqual(['Bearer dsh-test-capability'])
    } finally { await server.stop(true) }
  })

  test('the context injected for this process wins over a DSH context left in the host environment', async () => {
    const seen: Array<{ server: string; authorization: string | null }> = []
    const serve = (name: string) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      seen.push({ server: name, authorization: request.headers.get('authorization') })
      return Response.json({ identities: [], sourceFailures: [] })
    } })
    const current = serve('current')
    const stale = serve('stale')
    try {
      // e.g. a daemon started from a managed DSH shell still carries the earlier task's context.
      for (const dsh of [JSON.stringify({ baseUrl: `http://127.0.0.1:${stale.port}`, capability: 'earlier-task' }), '{}', 'not json']) {
        const proc = Bun.spawn([process.execPath, CLI, 'agent', 'identities', '--json'], {
          env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: dsh,
            LODESTAR_AGENT_URL: `http://127.0.0.1:${current.port}/`, LODESTAR_AGENT_CAPABILITY: 'this-task' }, stdout: 'pipe', stderr: 'pipe',
        })
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
        expect(code, stderr).toBe(0)
      }
      expect(seen).toEqual(Array(3).fill({ server: 'current', authorization: 'Bearer this-task' }))
    } finally { await current.stop(true); await stale.stop(true) }
  })

  test('rejects a malformed or non-local DSH context when it is the only context', () => {
    for (const dsh of ['{}', 'not json', JSON.stringify({ baseUrl: 'http://example.com:9876', capability: 'x' }),
      JSON.stringify({ baseUrl: 'file:///tmp/x', capability: 'x' }), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', capability: '' })]) {
      const proc = Bun.spawnSync([process.execPath, CLI, 'agent', 'identities'], {
        env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: dsh },
      })
      expect(proc.exitCode).toBe(1)
      expect(proc.stderr.toString()).toContain('invalid DSH Lodestar delegation context')
    }
  })

  test('parses a parallel full-Agent run', () => {
    expect(parsePromptArgs([
      '--description', '任务说明', '--identity', 'a', '--identity', 'b', '--identity', 'a', '--effort', 'max', '--stdin', '--no-wait',
    ], true)).toEqual({
      description: '任务说明', identityIds: ['a', 'b'], identityId: '', sessionId: '', workDir: '', effort: 'max', prompt: '', noWait: true, readStdin: true, json: false, card: false,
    })
  })

  test('parses a single-session follow-up', () => {
    expect(parsePromptArgs(['--description', '任务说明', '--identity', 'a', 'continue here'], false)).toEqual({
      description: '任务说明', identityIds: [], identityId: 'a', sessionId: '', workDir: '', effort: '', prompt: 'continue here', noWait: false, readStdin: false, json: false, card: false,
    })
  })

  test('requires an identity for a new run', () => {
    expect(() => parsePromptArgs(['task'], true)).toThrow('--identity')
  })

  test('parses the explicit card flag for runs and follow-ups', () => {
    expect(parsePromptArgs(['--description', '任务说明', '--identity', 'a', '--card', '--prompt', 'work'], true))
      .toMatchObject({ card: true })
    expect(parsePromptArgs(['--description', '任务说明', '--card', '--prompt', 'work'], false))
      .toMatchObject({ card: true })
    expect(parsePromptArgs(['--description', '任务说明', '--identity', 'a', '--prompt', 'work'], true))
      .toMatchObject({ card: false })
  })

  test('accepts session continuation without a new identity and rejects ambiguous session options', () => {
    expect(parsePromptArgs(['--description', '任务说明', '--session', 'sid', '--prompt', 'next turn', '--json'], true)).toEqual({
      description: '任务说明', identityIds: [], identityId: '', sessionId: 'sid', workDir: '', effort: '', prompt: 'next turn', noWait: false, readStdin: false, json: true, card: false,
    })
    expect(() => parsePromptArgs(['--session', 'sid', '--identity', 'a', '--identity', 'b'], true)).toThrow('at most one')
    expect(() => parsePromptArgs(['--session', 'sid', '--session', 'other'], true)).toThrow('only be specified once')
    expect(() => parsePromptArgs(['--session', 'sid'], false)).toThrow('only supported by run')
    expect(() => parsePromptArgs(['--session'], true)).toThrow('requires a value')
  })

  test('accepts a work directory and rejects missing or repeated directory options', () => {
    expect(parsePromptArgs(['--identity', 'a', '--description', '指定目录', '--workdir', 'packages/app with spaces ', '--prompt', 'work'], true))
      .toMatchObject({ workDir: 'packages/app with spaces ' })
    expect(parsePromptArgs(['--description', '原目录续跑', '--workdir', '/repo/packages/app', '--prompt', 'work'], false))
      .toMatchObject({ workDir: '/repo/packages/app' })
    expect(() => parsePromptArgs(['--workdir'], true)).toThrow('--workdir requires a value')
    expect(() => parsePromptArgs(['--workdir', ' '], true)).toThrow('--workdir requires a value')
    expect(() => parsePromptArgs(['--workdir', 'a', '--workdir', 'b'], true)).toThrow('only be specified once')
  })

  test('round-trips native session ids and content through CLI JSON and prints a continuation command', async () => {
    const requests: any[] = []
    let current: any
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (request.method === 'POST') {
        const body = await request.json() as any
        requests.push(body)
        if (body.session_id === 'missing') return Response.json({ error: 'agent session not found' }, { status: 409 })
        current = {
          run_id: `agent_${requests.length}`, status: 'completed',
          work_dir: body.work_dir ?? current?.work_dir ?? '/repo',
          workers: [{ identity_id: 'agent:a', identity_name: 'Agent A', status: 'completed', session_id: 'native-sid', output: body.prompt }],
        }
        return Response.json(current, { status: 202 })
      }
      return Response.json(current)
    } })
    const invoke = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, CLI, 'agent', ...args], {
        env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: JSON.stringify({
          baseUrl: `http://127.0.0.1:${server.port}`, capability: 'cli-test-capability',
        }) }, stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return { code, stdout, stderr }
    }
    try {
      const first = await invoke('run', '--description', '任务说明', '--identity', 'agent:a', '--workdir', 'packages/app', '--prompt', 'first', '--json')
      expect(first.code, first.stderr).toBe(0)
      const firstRun = JSON.parse(first.stdout)
      expect(firstRun.workers[0].output).toBe('first')
      expect(firstRun.work_dir).toBe('packages/app')
      const second = await invoke('run', '--description', '任务说明', '--session', firstRun.workers[0].session_id, '--prompt', '  第二轮\n', '--json')
      expect(second.code, second.stderr).toBe(0)
      const secondRun = JSON.parse(second.stdout)
      expect(secondRun.run_id).not.toBe(firstRun.run_id)
      expect(secondRun.workers[0]).toMatchObject({ session_id: 'native-sid', output: '  第二轮\n' })
      const status = await invoke('status', secondRun.run_id, '--json')
      expect(status.code, status.stderr).toBe(0)
      expect(JSON.parse(status.stdout)).toEqual(secondRun)
      const third = await invoke('run', '--description', '任务说明', '--session', 'native-sid', '--prompt', 'third')
      expect(third.code, third.stderr).toBe(0)
      expect(third.stdout).toContain('Session: native-sid')
      expect(third.stdout).toContain('Work directory: packages/app')
      expect(third.stdout).toContain("lodestar agent run --session 'native-sid' --identity 'agent:a' --description '<brief next step>' --stdin")
      expect(requests).toEqual([
        { description: '任务说明', identity_ids: ['agent:a'], work_dir: 'packages/app', prompt: 'first' },
        { description: '任务说明', identity_ids: [], session_id: 'native-sid', prompt: '  第二轮\n' },
        { description: '任务说明', identity_ids: [], session_id: 'native-sid', prompt: 'third' },
      ])
      const failed = await invoke('run', '--description', '任务说明', '--session', 'missing', '--prompt', 'next', '--json')
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('agent session not found')
      expect(requests).toHaveLength(4)
      const follow = await invoke('follow-up', firstRun.run_id, '--description', '指定原目录', '--workdir', 'packages/app', '--prompt', 'follow', '--no-wait')
      expect(follow.code, follow.stderr).toBe(0)
      expect(requests.at(-1)).toEqual({ description: '指定原目录', work_dir: 'packages/app', prompt: 'follow' })
    } finally { await server.stop(true) }
  })
})

test('explicit project CLI uses the private daemon endpoint and preserves project scope in continuation commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lodestar-project-cli-'))
  const requests: { url: string; token: string | null; body: any }[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ url: request.url, token: request.headers.get('authorization'), body: request.method === 'POST' ? await request.json() : null })
    return Response.json({ run_id: 'agent_cli_project', binding: 'project', project: 'repo', status: 'completed', workers: [{
      identity_id: 'agent:a', identity_name: 'A', session_id: 'native', status: 'completed', output: 'done',
    }] })
  } })
  const env = { ...process.env, LODESTAR_DATA_DIR: dir, LODESTAR_AGENT_ROLE: undefined, DSH_LODESTAR_AGENT_CONTEXT: undefined,
    LODESTAR_AGENT_URL: undefined, LODESTAR_AGENT_CAPABILITY: undefined }
  const exec = async (args: string[], extra = {}) => {
    const proc = Bun.spawn([process.execPath, CLI, 'agent', ...args], {
      env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, out, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, out, error }
  }
  try {
    writeFileSync(join(dir, 'agent-project-client.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, capability: 'test-project-key' }))
    const result = await exec(['run', '--project', 'repo', '--identity', 'agent:a', '--description', '任务', '--prompt', '--project', '--request-id', 'job-1'])
    expect(result.code, result.error).toBe(0)
    expect(result.out).toContain("lodestar agent --project 'repo' run --session 'native'")
    expect(requests[0]).toMatchObject({ token: 'Bearer test-project-key', body: { prompt: '--project', request_id: 'job-1' } })
    expect(new URL(requests[0].url).searchParams.get('project')).toBe('repo')
    // External project calls carry no display field unless --card is passed (daemon default: silent).
    expect(requests[0].body.display).toBeUndefined()
    const carded = await exec(['run', '--project', 'repo', '--identity', 'agent:a', '--description', '任务', '--prompt', 'card', '--request-id', 'job-2', '--card'])
    expect(carded.code, carded.error).toBe(0)
    const posts = requests.filter(item => item.body)
    expect(posts[1]).toMatchObject({ body: { prompt: 'card', request_id: 'job-2', display: 'card' } })
    const answer = await exec(['--project', 'repo', 'answer', 'agent_cli_project', '--request', 'q', '--stdin'])
    expect(answer.code).toBe(1)
    expect(answer.error).toContain('non-interactive')
    const noContext = await exec(['identities'])
    expect(noContext.code).toBe(1)
    expect(noContext.error).toContain('missing capability')
    const worker = await exec(['--project', 'repo', 'identities'], { LODESTAR_AGENT_ROLE: 'worker' })
    expect(worker.code).toBe(1)
    expect(worker.error).toContain('must remain session-bound')
    for (const context of [
      { LODESTAR_AGENT_ROLE: 'main' }, { LODESTAR_AGENT_CAPABILITY: 'stale' },
      { LODESTAR_AGENT_URL: 'http://127.0.0.1:1' }, { DSH_LODESTAR_AGENT_CONTEXT: '{}' },
    ]) {
      const agent = await exec(['--project', 'repo', 'identities'], context)
      expect(agent.code).toBe(1)
      expect(agent.error).toContain('must remain session-bound')
    }
    expect(requests.filter(item => item.body)).toHaveLength(2)
    const duplicate = await exec(['--project', 'repo', 'identities', '--project', 'repo'])
    expect(duplicate.code).toBe(2)
    expect(duplicate.error).toContain('only be specified once')
  } finally {
    await server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
