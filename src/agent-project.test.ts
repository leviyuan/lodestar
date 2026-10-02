import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptsProjectCapability, createAgentProjectClient, readAgentProjectClient } from './agent-project-client'
import { createAgentProjectRuntime, projectAgentInstructions, resolveAgentProject } from './agent-project'
import type { AgentRunSnapshot } from './agent-run-types'

// Each local service credential is private and replaced on daemon startup.
describe('project Agent client', () => {
  test('rotates credentials, validates loopback addresses, and reports missing or corrupt state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-project-client-'))
    const path = join(dir, 'client.json')
    try {
      expect(() => readAgentProjectClient(path)).toThrow('无法读取')
      const first = createAgentProjectClient('http://127.0.0.1:9876', path)
      expect(readAgentProjectClient(path)).toEqual(first)
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
      const second = createAgentProjectClient('http://[::1]:9876', path)
      expect(acceptsProjectCapability(second, first.capability)).toBe(false)
      expect(acceptsProjectCapability(second, second.capability)).toBe(true)
      for (const baseUrl of ['http://example.com:9876', 'https://127.0.0.1', 'http://127.0.0.1/other', 'http://user:pass@127.0.0.1']) {
        writeFileSync(path, JSON.stringify({ baseUrl, capability: second.capability }))
        expect(() => readAgentProjectClient(path)).toThrow('loopback')
      }
      writeFileSync(path, 'not json')
      expect(() => readAgentProjectClient(path)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('resolves registered project and worktree bindings without starting or reading a Session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-project-owner-'))
    mkdirSync(join(dir, 'main'))
    mkdirSync(join(dir, 'wt'))
    symlinkSync(join(dir, 'main'), join(dir, 'alias'))
    const deps = {
      sanitizeSessionName: (name: string) => name.replaceAll('/', '_'),
      chatIdForSession: (name: string) => ({ repo: 'main-chat', 'repo[feature]': 'wt-chat', alias: 'alias-chat' }[name] ?? null),
      resolveProjectDir: (name: string) => join(dir, name === 'repo' ? 'main' : name === 'alias' ? 'alias' : 'wt'),
    }
    try {
      const main = resolveAgentProject('repo', deps)
      expect(main).toEqual({ owner: { kind: 'project', name: 'repo', chatId: 'main-chat', workDir: join(dir, 'main') } })
      expect(resolveAgentProject('repo[feature]', deps).owner.workDir).toBe(join(dir, 'wt'))
      expect(resolveAgentProject('alias', deps).owner.workDir).toBe(main.owner.workDir)
      expect(() => resolveAgentProject('unknown', deps)).toThrow('群绑定')
      expect(() => resolveAgentProject('repo*0101-1200', deps)).toThrow('临时会话')
      expect(() => resolveAgentProject('../repo', deps)).toThrow('项目或 worktree')
      rmSync(join(dir, 'wt'), { recursive: true })
      expect(() => resolveAgentProject('repo[feature]', deps)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('project output delivery', () => {
  const run = (mode: 'chat' | 'drive'): AgentRunSnapshot => ({
    runId: 'agent_project', sessionName: 'repo', chatId: 'chat', workDir: '/repo',
    owner: { kind: 'project', name: 'repo', chatId: 'chat', workDir: '/repo' },
    deliveryMode: mode, status: 'running', prompt: '', depth: 0, workers: [], createdAt: new Date().toISOString(),
  })
  test('uploads explicit paths once per run and surfaces attachment failures without changing transport', async () => {
    const paths: string[] = []
    let ok = true
    const runtime = createAgentProjectRuntime({
      mode: () => 'chat', uploadAndSend: async (_chat, path) => { paths.push(path); return ok },
      createFileDelivery: () => { throw new Error('must not switch transport') },
    })
    const seen = new Set<string>()
    const signal = new AbortController().signal
    await runtime.deliver(run('chat'), '[[send: /tmp/a]]\n[[send: /tmp/a]]', signal, seen)
    await runtime.deliver(run('chat'), '[[send: /tmp/a]]', signal, seen)
    expect(paths).toEqual(['/tmp/a'])
    ok = false
    await expect(runtime.deliver(run('chat'), '[[send: /tmp/b]]', signal, seen)).rejects.toThrow('交付失败')
    await expect(runtime.deliver(run('chat'), '[[send: relative]]', signal, seen)).rejects.toThrow('绝对路径')
  })

  test('cloud output requires an explicit requester and does not report partially delivered batches as success', async () => {
    const contexts: unknown[] = []
    const runtime = createAgentProjectRuntime({ mode: () => 'drive',
      uploadAndSend: async () => { throw new Error('must not switch transport') },
      createFileDelivery: context => {
        contexts.push(context)
        return { add: () => {}, cancel: () => true, finish: async () => ['/tmp/a'] }
      },
    })
    const signal = new AbortController().signal
    await expect(runtime.deliver(run('drive'), '[[send: /tmp/a]]', signal, new Set())).rejects.toThrow('--requester')
    const owned = { ...run('drive'), requesterOpenId: 'requester' }
    await runtime.deliver(owned, '[[send: /tmp/a]]', signal, new Set())
    expect(contexts[0]).toMatchObject({ chatId: 'chat', managerOpenId: 'requester', projectName: 'repo' })
    await expect(runtime.deliver(owned, '[[send: /tmp/a]]\n[[send: /tmp/b]]', signal, new Set())).rejects.toThrow('/tmp/b')
  })

  test('a synchronous cloud enqueue failure cancels and drains already admitted delivery work', async () => {
    let drained = false
    let cancelled = false
    const runtime = createAgentProjectRuntime({ mode: () => 'drive', uploadAndSend: async () => true,
      createFileDelivery: () => ({
        add: () => { throw new Error('persistence unavailable') },
        cancel: () => { cancelled = true; return true },
        finish: async () => { drained = true; return [] },
      }),
    })
    await expect(runtime.deliver({ ...run('drive'), requesterOpenId: 'requester' }, '[[send: /tmp/a]]', new AbortController().signal, new Set()))
      .rejects.toThrow('persistence unavailable')
    expect(cancelled).toBe(true)
    expect(drained).toBe(true)
  })

  test('independent instructions retain provider questions and never direct handoff to a missing main Agent', () => {
    for (const provider of ['codex', 'claude', 'dsh'] as const) {
      const text = projectAgentInstructions(provider, 'chat')
      expect(text).toContain('没有主 Agent')
      expect(text).toContain('[[send: /abs/path]]')
      expect(text).toContain('30 MB')
      expect(text).not.toContain('由主 Agent 提交')
    }
    expect(projectAgentInstructions('codex', 'drive')).not.toContain('30 MB')
  })
})
