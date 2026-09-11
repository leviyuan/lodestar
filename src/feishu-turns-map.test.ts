import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateConversationLaunch } from './conversation'

interface FreshResult { exitCode: number; stdout: string; stderr: string }

function runFreshState(
  work: string,
  initialFiles: Record<string, unknown> = {},
): FreshResult {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-turns-map-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  for (const [name, value] of Object.entries(initialFiles)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2) + '\n')
  }
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "t"\napp_secret = "t"\n')
  const feishuModule = pathToFileURL(join(import.meta.dir, 'feishu.ts')).href
  const script = `
    import {
      appendTurnAnchorChecked,
      bindSessionResumeChecked,
      clearSessionConversationState,
      clearSessionResumeChecked,
      getSessionBranchBase,
      getSessionModelSelection,
      getSessionResumeRef,
      getPendingConversationLaunch,
      getTurnAnchors,
      loadSessionModelMap,
      loadSessionResumeMap,
      loadSessionTurnsMap,
      replaceTurnAnchors,
      readAliveMarker,
      writeAliveMarker,
      setPendingConversationLaunchChecked,
    } from ${JSON.stringify(feishuModule)}
    import { mkdirSync, readFileSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    const __dataDir = ${JSON.stringify(dataDir)}
    const __read = name => JSON.parse(readFileSync(join(__dataDir, name), 'utf8'))
    const __out = value => process.stdout.write('@@@' + JSON.stringify(value) + '@@@')
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function extract(result: FreshResult): any {
  const marker = result.stdout.match(/@@@([\s\S]*?)@@@/)
  if (!marker) {
    throw new Error(
      `no @@@ marker (exitCode=${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
  return JSON.parse(marker[1])
}

describe('session turn checkpoint persistence', () => {
  test('the alive marker survives repeated reads and atomic writes across boots', () => {
    const result = runFreshState(`
      const first = readAliveMarker()
      const second = readAliveMarker()
      writeAliveMarker(['b'])
      __out({ first, second, saved: __read('alive-on-shutdown.json'), nextBoot: readAliveMarker() })
    `, { 'alive-on-shutdown.json': ['a', 'b'] })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({ first: ['a', 'b'], second: ['a', 'b'], saved: ['b'], nextBoot: ['b'] })
  })

  test('an invalid alive marker fails visibly instead of being treated as an empty recovery list', () => {
    for (const marker of [{ a: true }, ['a', 7], ['']]) {
      const result = runFreshState(`
        let error = null
        try { readAliveMarker() } catch (cause) { error = cause.message }
        __out({ error, saved: __read('alive-on-shutdown.json') })
      `, { 'alive-on-shutdown.json': marker })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(extract(result)).toEqual({
        error: 'invalid alive session marker: expected non-empty session names', saved: marker,
      })
    }
  })

  test('alive marker IO errors reach callers during both boot and shutdown', () => {
    const result = runFreshState(`
      mkdirSync(join(__dataDir, 'alive-on-shutdown.json'))
      const errors = []
      try { readAliveMarker() } catch (error) { errors.push(error.code) }
      try { writeAliveMarker(['a']) } catch (error) { errors.push(error.code) }
      __out(errors)
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toHaveLength(2)
    expect(extract(result).every((code: unknown) => typeof code === 'string')).toBe(true)
  })

  test('preserves DSH resume, off effort and native event checkpoints across reload', () => {
    const result = runFreshState(`
      loadSessionResumeMap()
      loadSessionModelMap()
      bindSessionResumeChecked('project', { provider: 'dsh', sessionId: 'dsh-second', cwd: '/tmp/project' })
      appendTurnAnchorChecked('project', {
        checkpoint: { provider: 'dsh', kind: 'event', id: '42', source: { provider: 'dsh', sessionId: 'dsh-second', cwd: '/tmp/project' } },
        preview: 'native input', ts: 100, writes: [],
      })
      loadSessionResumeMap()
      loadSessionTurnsMap()
      __out({ resume: getSessionResumeRef('project', 'dsh'), claude: getSessionResumeRef('project', 'claude'),
        model: getSessionModelSelection('project'), anchors: getTurnAnchors('project'), saved: __read('session-resume-map.json') })
    `, {
      'session-resume-map.json': { project: {
        dsh: { provider: 'dsh', sessionId: 'dsh-first', cwd: '/tmp/project' },
        claude: { provider: 'claude', sessionId: 'claude-original', cwd: '/tmp/project' },
      } },
      'session-model-map.json': { project: { provider: 'dsh', model: 'deepseek-v4-flash', effort: 'off', tokenSourceId: 'deepseek-harness' } },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    const data = extract(result)
    expect(data.resume.sessionId).toBe('dsh-second')
    expect(data.claude.sessionId).toBe('claude-original')
    expect(data.model).toMatchObject({ provider: 'dsh', effort: 'off', tokenSourceId: 'deepseek-harness' })
    expect(data.anchors[0].checkpoint).toMatchObject({ provider: 'dsh', kind: 'event', id: '42' })
    expect(data.saved.project.dsh.sessionId).toBe('dsh-second')
  })

  test('rejects invalid DSH fork anchors before touching a backend', () => {
    const source = { provider: 'dsh' as const, sessionId: 'native', cwd: '/tmp/project' }
    expect(() => validateConversationLaunch({ kind: 'fork', source,
      through: { provider: 'dsh', kind: 'event', id: '-1', source } }, 'dsh', '/tmp/project')).toThrow('non-negative')
  })

  test('loads V2 checkpoints with an unknown base and null legacy cwd', () => {
    const result = runFreshState(`
      loadSessionTurnsMap()
      __out({ base: getSessionBranchBase('project'), anchors: getTurnAnchors('project') })
    `, {
      'session-turns-map.json': {
        project: [
          {
            checkpoint: {
              provider: 'claude',
              kind: 'assistant-message',
              id: 'assistant-1',
              source: { provider: 'claude', sessionId: 'claude-session' },
            },
            preview: 'claude input',
            ts: 100,
            writes: [{ tool: 'Edit', path: '/tmp/a.ts', body: 'after' }],
          },
          {
            checkpoint: {
              provider: 'codex',
              kind: 'turn',
              id: 'turn-2',
              source: { provider: 'codex', sessionId: 'codex-thread' },
            },
            preview: 'codex input',
            ts: 200,
            writes: [],
          },
        ],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      base: null,
      anchors: [
        {
          checkpoint: {
            provider: 'claude',
            kind: 'assistant-message',
            id: 'assistant-1',
            source: { provider: 'claude', sessionId: 'claude-session', cwd: null },
          },
          preview: 'claude input',
          ts: 100,
          writes: [{ tool: 'Edit', path: '/tmp/a.ts', body: 'after' }],
        },
        {
          checkpoint: {
            provider: 'codex',
            kind: 'turn',
            id: 'turn-2',
            source: { provider: 'codex', sessionId: 'codex-thread', cwd: null },
          },
          preview: 'codex input',
          ts: 200,
          writes: [],
        },
      ],
    })
  })

  test('migrates a whole legacy chain only for an unambiguous Claude-only resume key', () => {
    const result = runFreshState(`
      loadSessionResumeMap()
      loadSessionTurnsMap()
      __out({
        claude: getTurnAnchors('legacy-claude'),
        codex: getTurnAnchors('legacy-codex'),
        ambiguous: getTurnAnchors('legacy-ambiguous'),
      })
    `, {
      'session-resume-map.json': {
        'legacy-claude': { claude: 'different-current-session' },
        'legacy-codex': { codex: 'codex-current' },
        'legacy-ambiguous': { claude: 'shared-current', codex: 'shared-current' },
      },
      'session-turns-map.json': {
        'legacy-claude': [
          {
            uuid: 'assistant-old',
            sid: 'claude-ancestor',
            preview: 'old input',
            ts: 300,
            writes: [{ path: '/tmp/old.ts' }],
          },
          { uuid: 'assistant-older', sid: 'claude-other-ancestor', preview: 'older', ts: 301 },
          { uuid: 'missing-source', sid: '', preview: 'unsafe', ts: 301 },
          {
            checkpoint: {
              provider: 'codex',
              kind: 'assistant-message',
              id: 'not-a-turn',
              source: { provider: 'codex', sessionId: 'thread' },
            },
            uuid: 'must-not-fallback',
            sid: 'claude-session',
            ts: 302,
          },
        ],
        'legacy-codex': [{ uuid: 'agent-message-item', sid: 'codex-current', preview: 'unsafe', ts: 400 }],
        'legacy-ambiguous': [{ uuid: 'unknown-item', sid: 'shared-current', preview: 'unsafe', ts: 500 }],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      claude: [
      {
        checkpoint: {
          provider: 'claude',
          kind: 'assistant-message',
          id: 'assistant-old',
          source: { provider: 'claude', sessionId: 'claude-ancestor', cwd: null },
        },
        preview: 'old input',
        ts: 300,
        writes: [{ tool: 'Write', path: '/tmp/old.ts', body: '' }],
      },
      {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-older',
          source: { provider: 'claude', sessionId: 'claude-other-ancestor', cwd: null },
        },
        preview: 'older', ts: 301, writes: [],
      }],
      codex: [],
      ambiguous: [],
    })
  })

  test('round-trips explicit fresh and full-fork bases with absolute cwd', () => {
    const result = runFreshState(`
      const cwd = '/srv/lodestar/project'
      const first = {
        checkpoint: {
          provider: 'codex', kind: 'turn', id: 'turn-1',
          source: { provider: 'codex', sessionId: 'forked-thread', cwd },
        },
        preview: 'first', ts: 1, writes: [],
      }
      replaceTurnAnchors('fresh', [], { kind: 'fresh' })
      replaceTurnAnchors('forked', [first], {
        kind: 'fork',
        source: { provider: 'codex', sessionId: 'source-thread', cwd },
      })
      replaceTurnAnchors('cleared', [first], { kind: 'fresh' })
      replaceTurnAnchors('cleared', [], null, null)
      loadSessionTurnsMap()
      __out({
        fresh: getSessionBranchBase('fresh'),
        fullFork: getSessionBranchBase('forked'),
        anchors: getTurnAnchors('forked'),
        cleared: {
          base: getSessionBranchBase('cleared'),
          anchors: getTurnAnchors('cleared'),
        },
        persisted: __read('session-turns-map.json'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.fresh).toEqual({ kind: 'fresh' })
    expect(output.fullFork).toEqual({
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'source-thread', cwd: '/srv/lodestar/project' },
    })
    expect(output.anchors[0].checkpoint.source.cwd).toBe('/srv/lodestar/project')
    expect(output.cleared).toEqual({ base: null, anchors: [] })
    expect(output.persisted).toEqual({
      fresh: { base: { kind: 'fresh' }, anchors: [] },
      forked: { base: output.fullFork, anchors: output.anchors },
    })
  })

  test('advances the branch base through the discarded checkpoint at 201 anchors', () => {
    const result = runFreshState(`
      const cwd = '/srv/lodestar/project'
      replaceTurnAnchors('project', [], { kind: 'fresh' })
      for (let i = 1; i <= 201; i++) {
        appendTurnAnchorChecked('project', {
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'turn-' + i,
            source: { provider: 'codex', sessionId: 'thread-1', cwd },
          },
          preview: 'input-' + i,
          ts: i,
          writes: [],
        })
      }
      __out({
        base: getSessionBranchBase('project'),
        anchors: getTurnAnchors('project'),
        persisted: __read('session-turns-map.json').project,
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.anchors).toHaveLength(200)
    expect(output.anchors[0].checkpoint.id).toBe('turn-2')
    expect(output.anchors[199].checkpoint.id).toBe('turn-201')
    expect(output.base).toEqual({
      kind: 'fork',
      source: {
        provider: 'codex', sessionId: 'thread-1', cwd: '/srv/lodestar/project',
      },
      through: {
        provider: 'codex', kind: 'turn', id: 'turn-1',
        source: {
          provider: 'codex', sessionId: 'thread-1', cwd: '/srv/lodestar/project',
        },
      },
    })
    expect(output.persisted).toEqual({ base: output.base, anchors: output.anchors })
  })

  test('round-trips and clears a durable pending Claude fork without losing branch state', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      replaceTurnAnchors('project', [], launch, pending)
      loadSessionTurnsMap()
      const loaded = getPendingConversationLaunch('project')
      setPendingConversationLaunchChecked('project', null)
      __out({
        loaded,
        base: getSessionBranchBase('project'),
        anchors: getTurnAnchors('project'),
        persisted: __read('session-turns-map.json').project,
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      loaded: {
        launch: {
          kind: 'fork',
          source: {
            provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
          },
        },
        previousSessionId: 'previous-session',
      },
      base: {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      },
      anchors: [],
      persisted: {
        base: {
          kind: 'fork',
          source: {
            provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
          },
        },
        anchors: [],
      },
    })
  })

  test('rejects a persisted pending fork without an authoritative cwd', () => {
    const result = runFreshState(`
      loadSessionTurnsMap()
      __out({ pending: getPendingConversationLaunch('unsafe'), anchors: getTurnAnchors('unsafe') })
    `, {
      'session-turns-map.json': {
        unsafe: {
          base: null,
          anchors: [],
          pendingLaunch: {
            launch: {
              kind: 'fork',
              source: { provider: 'claude', sessionId: 'source-session', cwd: null },
            },
            previousSessionId: null,
          },
        },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({ pending: null, anchors: [] })
    expect(result.stderr).toContain('rejected 1 malformed turn anchors')
  })

  test('append and ordinary replace preserve pending; explicit null consumes it', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      replaceTurnAnchors('project', [], launch, pending)
      appendTurnAnchorChecked('project', {
        checkpoint: {
          provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
          source: {
            provider: 'claude', sessionId: 'materialized-session', cwd: '/srv/lodestar/project',
          },
        },
        preview: 'first input', ts: 1, writes: [],
      })
      const afterAppend = getPendingConversationLaunch('project')
      replaceTurnAnchors('project', getTurnAnchors('project'), launch)
      const afterReplace = getPendingConversationLaunch('project')
      replaceTurnAnchors('project', getTurnAnchors('project'), launch, null)
      __out({
        afterAppend,
        afterReplace,
        afterExplicitClear: getPendingConversationLaunch('project'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.afterAppend).toEqual(output.afterReplace)
    expect(output.afterAppend.previousSessionId).toBe('previous-session')
    expect(output.afterExplicitClear).toBeNull()
  })

  test('checked pending write failure restores the prior in-memory marker', () => {
    const result = runFreshState(`
      const launch = {
        kind: 'fork',
        source: {
          provider: 'claude', sessionId: 'source-session', cwd: '/srv/lodestar/project',
        },
      }
      const pending = { launch, previousSessionId: 'previous-session' }
      setPendingConversationLaunchChecked('project', pending)
      const statePath = join(__dataDir, 'session-turns-map.json')
      rmSync(statePath)
      mkdirSync(statePath)
      let error = ''
      try { setPendingConversationLaunchChecked('project', null) }
      catch (cause) { error = String(cause?.message ?? cause) }
      __out({ error, pending: getPendingConversationLaunch('project') })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.error).not.toBe('')
    expect(output.pending.previousSessionId).toBe('previous-session')
    expect(output.pending.launch.source.sessionId).toBe('source-session')
  })
})

describe('conversation cwd validation', () => {
  test('fails closed for missing or mismatched source cwd when a target cwd is expected', () => {
    const legacy = {
      kind: 'resume' as const,
      source: { provider: 'codex' as const, sessionId: 'thread', cwd: null },
    }
    expect(() => validateConversationLaunch(legacy, 'codex', '/srv/project')).toThrow('source cwd is missing')

    const mismatched = {
      kind: 'resume' as const,
      source: { provider: 'codex' as const, sessionId: 'thread', cwd: '/srv/other' },
    }
    expect(() => validateConversationLaunch(mismatched, 'codex', '/srv/project')).toThrow('cwd mismatch')

    expect(() => validateConversationLaunch({
      kind: 'resume',
      source: { provider: 'codex', sessionId: 'thread', cwd: '/srv/project' },
    }, 'codex', '/srv/project')).not.toThrow()
  })
})

describe('session conversation state cleanup', () => {
  test('round-trips provider conversation refs with their absolute cwd', () => {
    const result = runFreshState(`
      bindSessionResumeChecked('project', {
        provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
      })
      bindSessionResumeChecked('project', 'claude-session', 'claude', '/srv/claude-project')
      loadSessionResumeMap()
      __out({
        codexId: (getSessionResumeRef('project', 'codex')?.sessionId ?? null),
        claudeId: (getSessionResumeRef('project', 'claude')?.sessionId ?? null),
        codexRef: getSessionResumeRef('project', 'codex'),
        claudeRef: getSessionResumeRef('project', 'claude'),
        persisted: __read('session-resume-map.json'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      codexId: 'codex-thread',
      claudeId: 'claude-session',
      codexRef: {
        provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
      },
      claudeRef: {
        provider: 'claude', sessionId: 'claude-session', cwd: '/srv/claude-project',
      },
      persisted: {
        project: {
          codex: {
            provider: 'codex', sessionId: 'codex-thread', cwd: '/srv/codex-project',
          },
          claude: {
            provider: 'claude', sessionId: 'claude-session', cwd: '/srv/claude-project',
          },
        },
      },
    })
  })

  test('rejects new resume bindings without an absolute cwd', () => {
    const result = runFreshState(`
      const errors = []
      for (const bind of [
        () => bindSessionResumeChecked('missing', {
          provider: 'codex', sessionId: 'thread', cwd: null,
        }),
        () => bindSessionResumeChecked('relative', 'session', 'claude', 'relative/project'),
      ]) {
        try { bind() } catch (error) { errors.push(String(error?.message ?? error)) }
      }
      __out({
        errors,
        missing: getSessionResumeRef('missing', 'codex'),
        relative: getSessionResumeRef('relative', 'claude'),
      })
    `)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      errors: [
        'cannot bind a conversation without an absolute cwd: null',
        'cannot bind a conversation without an absolute cwd: relative/project',
      ],
      missing: null,
      relative: null,
    })
  })

  test('keeps legacy resume compatibility and clears only the requested provider', () => {
    const result = runFreshState(`
      loadSessionResumeMap()
      const legacyCodex = (getSessionResumeRef('legacy')?.sessionId ?? null)
      const legacyClaude = (getSessionResumeRef('legacy-claude', 'claude')?.sessionId ?? null)
      const legacyRef = getSessionResumeRef('legacy-ref', 'codex')
      clearSessionResumeChecked('target', 'codex')
      __out({
        legacyCodex,
        legacyClaude,
        legacyRef,
        legacyCodexRef: getSessionResumeRef('legacy'),
        legacyClaudeRef: getSessionResumeRef('legacy-claude', 'claude'),
        targetCodex: (getSessionResumeRef('target', 'codex')?.sessionId ?? null),
        targetClaude: (getSessionResumeRef('target', 'claude')?.sessionId ?? null),
        targetClaudeRef: getSessionResumeRef('target', 'claude'),
        persisted: __read('session-resume-map.json'),
      })
    `, {
      'session-resume-map.json': {
        legacy: 'old-codex-thread',
        'legacy-claude': { provider: 'claude', session_id: 'old-claude-session' },
        'legacy-ref': { provider: 'codex', sessionId: 'old-ref-thread' },
        target: { codex: 'target-thread', claude: 'target-session' },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(extract(result)).toEqual({
      legacyCodex: 'old-codex-thread',
      legacyClaude: 'old-claude-session',
      legacyCodexRef: {
        provider: 'codex', sessionId: 'old-codex-thread', cwd: null,
      },
      legacyClaudeRef: {
        provider: 'claude', sessionId: 'old-claude-session', cwd: null,
      },
      legacyRef: {
        provider: 'codex', sessionId: 'old-ref-thread', cwd: null,
      },
      targetCodex: null,
      targetClaude: 'target-session',
      targetClaudeRef: {
        provider: 'claude', sessionId: 'target-session', cwd: null,
      },
      persisted: {
        legacy: {
          codex: { provider: 'codex', sessionId: 'old-codex-thread', cwd: null },
        },
        'legacy-claude': {
          claude: { provider: 'claude', sessionId: 'old-claude-session', cwd: null },
        },
        'legacy-ref': {
          codex: { provider: 'codex', sessionId: 'old-ref-thread', cwd: null },
        },
        target: {
          claude: { provider: 'claude', sessionId: 'target-session', cwd: null },
        },
      },
    })
  })

  test('checked resume cleanup restores the full ref when persistence fails', () => {
    const result = runFreshState(`
      loadSessionResumeMap()
      const resumeFile = join(__dataDir, 'session-resume-map.json')
      rmSync(resumeFile)
      mkdirSync(resumeFile)
      let error = null
      try { clearSessionResumeChecked('target', 'codex') }
      catch (caught) { error = String(caught?.message ?? caught) }
      __out({ error, restored: getSessionResumeRef('target', 'codex') })
    `, {
      'session-resume-map.json': {
        target: {
          codex: {
            provider: 'codex', sessionId: 'target-thread', cwd: '/srv/target',
          },
        },
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.error).toBeString()
    expect(output.error.length).toBeGreaterThan(0)
    expect(output.restored).toEqual({
      provider: 'codex', sessionId: 'target-thread', cwd: '/srv/target',
    })
  })

  test('permanent cleanup removes exact session resume, model and turns only', () => {
    const result = runFreshState(`
      loadSessionResumeMap()
      loadSessionModelMap()
      loadSessionTurnsMap()
      clearSessionConversationState('target')
      __out({
        target: {
          codex: (getSessionResumeRef('target', 'codex')?.sessionId ?? null),
          claude: (getSessionResumeRef('target', 'claude')?.sessionId ?? null),
          model: getSessionModelSelection('target'),
          turns: getTurnAnchors('target'),
        },
        keep: {
          resume: (getSessionResumeRef('keep', 'codex')?.sessionId ?? null),
          model: getSessionModelSelection('keep'),
          turns: getTurnAnchors('keep'),
        },
        persisted: {
          resume: __read('session-resume-map.json'),
          model: __read('session-model-map.json'),
          turns: __read('session-turns-map.json'),
        },
      })
    `, {
      'session-resume-map.json': {
        target: { codex: 'target-thread', claude: 'target-session' },
        keep: { codex: 'keep-thread' },
      },
      'session-model-map.json': {
        target: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        keep: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
      'session-turns-map.json': {
        target: [{
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'target-turn',
            source: { provider: 'codex', sessionId: 'target-thread' },
          },
          preview: 'target', ts: 1, writes: [],
        }],
        keep: [{
          checkpoint: {
            provider: 'codex', kind: 'turn', id: 'keep-turn',
            source: { provider: 'codex', sessionId: 'keep-thread' },
          },
          preview: 'keep', ts: 2, writes: [],
        }],
      },
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const output = extract(result)
    expect(output.target).toEqual({ codex: null, claude: null, model: null, turns: [] })
    expect(output.keep.resume).toBe('keep-thread')
    expect(output.keep.model).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'medium' })
    expect(output.keep.turns).toHaveLength(1)
    expect(output.persisted.resume).toEqual({
      keep: {
        codex: { provider: 'codex', sessionId: 'keep-thread', cwd: null },
      },
    })
    expect(output.persisted.model).toEqual({
      keep: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
    })
    expect(output.persisted.turns).toEqual({
      keep: { base: null, anchors: output.keep.turns },
    })
  })
})
