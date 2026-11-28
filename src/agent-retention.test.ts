import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, PRUNED_ARTIFACT_MANIFEST, PRUNED_RUN_TEXT, RUN_TEXT_RETENTION_MS, pruneExpiredRunArtifacts } from './agent-service'
import type { AgentRunSnapshot } from './agent-run-types'
import { AGENT_RUNS_DIR } from './paths'

function snapshot(runId: string, createdAt: string, status: AgentRunSnapshot['status'] = 'completed'): AgentRunSnapshot {
  return {
    runId, sessionName: 'group', chatId: 'oc_chat', workDir: '/repo', prompt: '', description: '任务',
    depth: 0, status, createdAt, finishedAt: createdAt,
    promptArtifact: `${runId}.prompt.txt`,
    workers: [{
      identityId: 'agent:a', identityName: 'A', tokenSourceId: 'src', provider: 'claude',
      model: 'm', effort: 'high', status, output: '', steps: [], sessionId: `${runId}-session`,
      outputArtifact: `${runId}.out.output.txt`,
    }],
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'lodestar-retention-'))
}

describe('Agent run text retention', () => {
  test('deletes old prompt/output bodies, marks the snapshot and keeps recent or active runs', () => {
    const dir = root()
    try {
      const now = Date.parse('2030-02-01T00:00:00Z')
      const old = new Date(now - RUN_TEXT_RETENTION_MS - 60_000).toISOString()
      const recent = new Date(now - 60_000).toISOString()
      for (const item of [snapshot('agent_old', old), snapshot('agent_recent', recent), snapshot('agent_active', old, 'running')]) {
        writeFileSync(join(dir, `${item.runId}.json`), JSON.stringify(item))
        for (const artifact of [item.promptArtifact!, ...item.workers.map(worker => worker.outputArtifact!)]) {
          writeFileSync(join(dir, artifact), 'body')
        }
      }
      expect(pruneExpiredRunArtifacts(dir, now)).toBe(2)
      expect(existsSync(join(dir, 'agent_old.prompt.txt'))).toBe(false)
      expect(existsSync(join(dir, 'agent_old.out.output.txt'))).toBe(false)
      // The lifecycle snapshot is kept as-is; status hydration turns missing
      // expired bodies into the "已清理" marker.
      expect(JSON.parse(readFileSync(join(dir, 'agent_old.json'), 'utf8')).runId).toBe('agent_old')
      expect(existsSync(join(dir, 'agent_recent.prompt.txt'))).toBe(true)
      expect(existsSync(join(dir, 'agent_active.prompt.txt'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('is idempotent and ignores corrupt or foreign files', () => {
    const dir = root()
    try {
      const now = Date.now()
      const old = new Date(now - RUN_TEXT_RETENTION_MS - 1).toISOString()
      const item = snapshot('agent_one', old)
      writeFileSync(join(dir, 'agent_one.json'), JSON.stringify(item))
      writeFileSync(join(dir, item.promptArtifact!), 'body')
      writeFileSync(join(dir, item.workers[0].outputArtifact!), 'body')
      writeFileSync(join(dir, 'broken.json'), '{')
      writeFileSync(join(dir, 'note.txt'), 'ignore')
      expect(pruneExpiredRunArtifacts(dir, now)).toBe(2)
      expect(pruneExpiredRunArtifacts(dir, now)).toBe(0)
      expect(existsSync(join(dir, 'pruned-artifacts.json'))).toBe(true)
      expect(PRUNED_RUN_TEXT).toContain('已清理')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('records a run in the manifest before deleting, so a failed delete still reads as cleaned and is retried', () => {
    const dir = root()
    try {
      const now = Date.now()
      const item = snapshot('agent_locked', new Date(now - RUN_TEXT_RETENTION_MS - 1).toISOString())
      writeFileSync(join(dir, 'agent_locked.json'), JSON.stringify(item))
      writeFileSync(join(dir, item.workers[0].outputArtifact!), 'body')
      // A directory under the body's name makes unlink fail with a non-ENOENT
      // error on every platform (EISDIR/EPERM), like a locked or immutable file.
      mkdirSync(join(dir, item.promptArtifact!))
      const failure = (() => { try { pruneExpiredRunArtifacts(dir, now) } catch (error) { return error } })()
      expect((failure as NodeJS.ErrnoException)?.code).toBeTruthy()
      expect((failure as NodeJS.ErrnoException).code).not.toBe('ENOENT')
      // The other body is still removed and the run is already recorded.
      expect(existsSync(join(dir, item.workers[0].outputArtifact!))).toBe(false)
      expect(JSON.parse(readFileSync(join(dir, PRUNED_ARTIFACT_MANIFEST), 'utf8')).runs).toEqual(['agent_locked'])
      // The next sweep retries a recorded body that is still there.
      rmSync(join(dir, item.promptArtifact!), { recursive: true })
      writeFileSync(join(dir, item.promptArtifact!), 'body')
      expect(pruneExpiredRunArtifacts(dir, now)).toBe(1)
      expect(existsSync(join(dir, item.promptArtifact!))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Agent run loading at daemon boot', () => {
  const session = {
    sessionName: 'group', chatId: 'oc_chat', workDir: '/repo',
    codexAccountId: () => 'default', delegatedAgentDeveloperInstructions: () => '',
  } as any

  function boot(): AgentService {
    const service = new AgentService()
    service.presentation.closeChat = async () => {}
    return service
  }

  function store(item: AgentRunSnapshot, bodies: Record<string, string | 'dir'> = {}): string[] {
    mkdirSync(AGENT_RUNS_DIR, { recursive: true })
    writeFileSync(join(AGENT_RUNS_DIR, `${item.runId}.json`), JSON.stringify(item))
    for (const [name, body] of Object.entries(bodies)) {
      if (body === 'dir') mkdirSync(join(AGENT_RUNS_DIR, name))
      else writeFileSync(join(AGENT_RUNS_DIR, name), body)
    }
    return [`${item.runId}.json`, ...Object.keys(bodies)]
  }

  function remove(files: string[]): void {
    for (const name of files) rmSync(join(AGENT_RUNS_DIR, name), { recursive: true, force: true })
  }

  test('an expired run whose bodies are gone without a manifest entry reads as cleaned instead of blocking boot', async () => {
    // Sweeps before the manifest-first order deleted bodies and wrote the
    // manifest last; being killed in between left exactly this state.
    const old = new Date(Date.now() - RUN_TEXT_RETENTION_MS - 60_000).toISOString()
    const files = store(snapshot('agent_boot_gone', old))
    const service = boot()
    try {
      const run = service.getRun(service.rootPrincipal(session), 'agent_boot_gone')
      expect(run.prompt).toBe(PRUNED_RUN_TEXT)
      expect(run.workers[0]!.output).toBe(PRUNED_RUN_TEXT)
    } finally { await service.shutdown('test cleanup'); remove(files) }
  })

  test('a recent run with a missing body still loads; status reports the read failure', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const missing = snapshot('agent_boot_missing', recent)
    const healthy = snapshot('agent_boot_healthy', recent)
    const files = [
      ...store(missing, { [missing.workers[0].outputArtifact!]: 'output' }),
      ...store(healthy, { [healthy.promptArtifact!]: 'prompt', [healthy.workers[0].outputArtifact!]: 'output' }),
    ]
    const service = boot()
    try {
      const principal = service.rootPrincipal(session)
      expect(() => service.getRun(principal, 'agent_boot_missing')).toThrow('prompt for agent_boot_missing is unreadable')
      expect(service.getRun(principal, 'agent_boot_healthy').prompt).toBe('prompt')
    } finally { await service.shutdown('test cleanup'); remove(files) }
  })

  test('a boot-time delete failure is logged, not thrown, and the run reads as cleaned', async () => {
    const old = new Date(Date.now() - RUN_TEXT_RETENTION_MS - 60_000).toISOString()
    const item = snapshot('agent_boot_locked', old)
    const files = store(item, { [item.promptArtifact!]: 'dir', [item.workers[0].outputArtifact!]: 'output' })
    const service = boot()
    try {
      const run = service.getRun(service.rootPrincipal(session), 'agent_boot_locked')
      expect(run.prompt).toBe(PRUNED_RUN_TEXT)
      expect(run.workers[0]!.output).toBe(PRUNED_RUN_TEXT)
      expect(JSON.parse(readFileSync(join(AGENT_RUNS_DIR, PRUNED_ARTIFACT_MANIFEST), 'utf8')).runs).toContain('agent_boot_locked')
    } finally { await service.shutdown('test cleanup'); remove(files) }
  })
})
