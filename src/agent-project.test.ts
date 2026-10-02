import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptsProjectCapability, createAgentProjectClient, readAgentProjectClient } from './agent-project-client'
import { resolveAgentProject } from './agent-project'

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
