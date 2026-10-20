import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireClaudeSessionLease, canonicalClaudeHistoryRoot } from './claude-session-lease'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-lease-'))
  const shared = join(root, 'shared')
  mkdirSync(shared)
  for (const name of ['A', 'B']) {
    mkdirSync(join(root, name))
    symlinkSync(shared, join(root, name, 'projects'), 'junction')
  }
  return { root, shared, a: join(root, 'A/projects'), b: join(root, 'B/projects'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('Claude shared-history writer leases', () => {
  test('aliases and account directories use one lease while different session IDs remain independent', () => {
    const f = fixture()
    const a = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'same-session' })
    const other = acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'other-session' })
    try {
      expect(a.historyRoot).toBe(canonicalClaudeHistoryRoot(f.shared))
      expect(() => acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'same-session' })).toThrow('会话正在使用')
      a.release()
      const next = acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'same-session' })
      a.release() // An old owner must never release a newer owner's lease.
      expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'same-session' })).toThrow('会话正在使用')
      next.release()
    } finally { a.release(); other.release(); f.cleanup() }
  })

  test('separate history roots may use the same native session ID', () => {
    const f = fixture()
    const a = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'session' })
    const b = acquireClaudeSessionLease({ historyRoot: join(f.root, 'separate/projects'), sessionId: 'session' })
    try { expect(a.historyRoot).not.toBe(b.historyRoot) } finally { a.release(); b.release(); f.cleanup() }
  })

  test('fork refuses an active writer and protects its source until the snapshot is loaded', () => {
    const f = fixture()
    const writer = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'source' })
    try {
      expect(() => acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'fork', sourceSessionId: 'source' })).toThrow('暂时不能分叉')
      writer.release()
      const fork = acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'fork', sourceSessionId: 'source' })
      const second = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'fork-2', sourceSessionId: 'source' })
      try {
        expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'source' })).toThrow('会话正在使用')
        fork.releaseSource()
        expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'source' })).toThrow('会话正在使用')
        second.releaseSource()
        const restored = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'source' })
        restored.release()
        expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'fork' })).toThrow('会话正在使用')
      } finally { fork.release(); second.release() }
    } finally { writer.release(); f.cleanup() }
  })

  test('canonicalizes absent descendants without creating a directory', () => {
    const f = fixture()
    try {
      expect(canonicalClaudeHistoryRoot(join(f.a, 'new/deep'))).toBe(join(canonicalClaudeHistoryRoot(f.shared), 'new/deep'))
    } finally { f.cleanup() }
  })

  test('idle live writers can be forked, while a checkpoint permits snapshotting a later active turn', () => {
    const f = fixture()
    let active = false
    const parent = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'parent', isActive: () => active })
    const idleFork = acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'idle-fork', sourceSessionId: 'parent' })
    let checkpointFork: ReturnType<typeof acquireClaudeSessionLease> | undefined
    try {
      expect(() => acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'parent' })).toThrow('会话正在使用')
      active = true
      expect(() => acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'busy-full-fork', sourceSessionId: 'parent' })).toThrow('暂时不能分叉')
      checkpointFork = acquireClaudeSessionLease({ historyRoot: f.b, sessionId: 'checkpoint-fork', sourceSessionId: 'parent', sourceCheckpointId: 'completed-turn' })
      parent.release()
      // The source cannot get a new writer until both in-flight snapshots have loaded.
      expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'parent' })).toThrow('会话正在使用')
      idleFork.releaseSource()
      expect(() => acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'parent' })).toThrow('会话正在使用')
      checkpointFork.releaseSource()
      const next = acquireClaudeSessionLease({ historyRoot: f.a, sessionId: 'parent' })
      next.release()
    } finally { parent.release(); idleFork.release(); checkpointFork?.release(); f.cleanup() }
  })
})
