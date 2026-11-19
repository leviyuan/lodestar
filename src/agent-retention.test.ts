import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRUNED_RUN_TEXT, RUN_TEXT_RETENTION_MS, pruneExpiredRunArtifacts } from './agent-service'
import type { AgentRunSnapshot } from './agent-run-types'

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
})
