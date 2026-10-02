import { describe, expect, test } from 'bun:test'
import { parsePromptArgs } from './agent-cli'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('lodestar-agent CLI args', () => {
  test('executes the release CLI through npm symlinks and remains inert when imported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar agent-cli-'))
    try {
      const dist = join(root, 'dist')
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(root, 'package.json'), '{"type":"module"}')
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'agent-cli.ts')], target: 'node', minify: true,
        banner: '#!/usr/bin/env node', outdir: dist, naming: 'lodestar-agent.js',
      })
      expect(build.success, build.logs.join('\n')).toBe(true)
      const entry = join(dist, 'lodestar-agent.js')
      const command = join(bin, 'lodestar-agent')
      symlinkSync('../dist/lodestar-agent.js', command)
      for (const path of [entry, command]) {
        const help = Bun.spawnSync(['node', path, '--help'], { cwd: root })
        expect(help.exitCode, help.stderr.toString()).toBe(0)
        expect(help.stdout.toString()).toContain('lodestar-agent run --identity')
      }
      const invalid = Bun.spawnSync(['node', command, 'identities'], {
        cwd: root, env: { ...process.env, DSH_LODESTAR_AGENT_CONTEXT: '{}' },
      })
      expect(invalid.exitCode).toBe(1)
      expect(invalid.stderr.toString()).toContain('invalid DSH Lodestar delegation context')
      const imported = Bun.spawnSync(['node', '--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
      ], { cwd: root })
      expect(imported.exitCode, imported.stderr.toString()).toBe(0)
      expect(imported.stdout.toString()).toBe('')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

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
      '--description', '任务说明', '--identity', 'a', '--identity', 'b', '--identity', 'a', '--effort', 'max', '--stdin', '--no-wait',
    ], true)).toEqual({
      description: '任务说明', identityIds: ['a', 'b'], identityId: '', sessionId: '', workDir: '', effort: 'max', prompt: '', noWait: true, readStdin: true, json: false,
    })
  })

  test('parses a single-session follow-up', () => {
    expect(parsePromptArgs(['--description', '任务说明', '--identity', 'a', 'continue here'], false)).toEqual({
      description: '任务说明', identityIds: [], identityId: 'a', sessionId: '', workDir: '', effort: '', prompt: 'continue here', noWait: false, readStdin: false, json: false,
    })
  })

  test('requires an identity for a new run', () => {
    expect(() => parsePromptArgs(['task'], true)).toThrow('--identity')
  })

  test('accepts session continuation without a new identity and rejects ambiguous session options', () => {
    expect(parsePromptArgs(['--description', '任务说明', '--session', 'sid', '--prompt', 'next turn', '--json'], true)).toEqual({
      description: '任务说明', identityIds: [], identityId: '', sessionId: 'sid', workDir: '', effort: '', prompt: 'next turn', noWait: false, readStdin: false, json: true,
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
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'agent-cli.ts'), ...args], {
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
      expect(third.stdout).toContain("lodestar-agent run --session 'native-sid' --identity 'agent:a' --description '<brief next step>' --stdin")
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
  const env = { ...process.env, LODESTAR_DATA_DIR: dir, LODESTAR_AGENT_ROLE: '', DSH_LODESTAR_AGENT_CONTEXT: undefined,
    LODESTAR_AGENT_URL: undefined, LODESTAR_AGENT_CAPABILITY: undefined }
  const exec = async (args: string[], extra = {}) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'agent-cli.ts'), ...args], {
      env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, out, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, out, error }
  }
  try {
    writeFileSync(join(dir, 'agent-project-client.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, capability: 'test-project-key' }))
    const result = await exec(['run', '--project', 'repo', '--identity', 'agent:a', '--description', '任务', '--prompt', '--project', '--request-id', 'job-1'])
    expect(result.code, result.error).toBe(0)
    expect(result.out).toContain("lodestar-agent --project 'repo' run --session 'native'")
    expect(requests[0]).toMatchObject({ token: 'Bearer test-project-key', body: { prompt: '--project', request_id: 'job-1' } })
    expect(new URL(requests[0].url).searchParams.get('project')).toBe('repo')
    const noContext = await exec(['identities'])
    expect(noContext.code).toBe(1)
    expect(noContext.error).toContain('missing capability')
    const worker = await exec(['--project', 'repo', 'identities'], { LODESTAR_AGENT_ROLE: 'worker' })
    expect(worker.code).toBe(1)
    expect(worker.error).toContain('cannot start project')
    const duplicate = await exec(['--project', 'repo', 'identities', '--project', 'repo'])
    expect(duplicate.code).toBe(1)
    expect(duplicate.error).toContain('only be specified once')
  } finally {
    await server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
