import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ConversationLaunch, ConversationRouting, ConversationSummary } from './conversation'
import type { TurnAnchor } from './feishu'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetAgentSessionRegistryForTest } from './agent-session-registry'
import {
  clearedTurnAnchorSessions,
  branchBaseBySession,
  resetFeishuMock,
  seededTurnAnchors,
  sentCards,
  sentRawTexts,
  sentTexts,
  turnAnchorsBySession,
} from './feishu-test-mock'
import * as feishu from './feishu'

// feishu-test-mock 必须先注册，session-temp 才会拿到共享的 Feishu 替身。
const {
  onBackSelect,
  onForkSelect,
  onResumeSelect,
  runBtwCommand,
  showBackList,
  showForkList,
  showResumeList,
  listClaudeSessions,
} = await import('./session-temp')

interface TempHarnessState {
  routing: ConversationRouting
  running: boolean
  rollbackResult: boolean
  history: ConversationSummary[]
}

interface TempHarness {
  session: any
  state: TempHarnessState
  createCalls: any[]
  rollbackCalls: ConversationLaunch[]
  rollbackStates: any[]
}

function makeHarness(sessionName = 'project'): TempHarness {
  const state: TempHarnessState = {
    routing: {
      provider: 'codex',
      tokenSourceId: 'codex-subscription',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
    running: false,
    rollbackResult: true,
    history: [],
  }
  const createCalls: any[] = []
  const rollbackCalls: ConversationLaunch[] = []
  const rollbackStates: any[] = []
  const session: any = {
    sessionName,
    chatId: `oc_${sessionName}`,
    selectedProvider: 'codex',
    lastSessionId: 'current-thread',
    workDir: '/workspace/project',
    opts: {
      onCreateTempSession: async (input: any) => {
        createCalls.push(input)
        return { ok: true }
      },
    },
    backendLabel: () => 'Codex',
    conversationRouting: () => ({ ...state.routing }),
    isRunning: () => state.running,
    listCodexConversations: async () => state.history.slice(),
    rollbackTo: async (launch: ConversationLaunch, branchState?: { anchors: TurnAnchor[]; base: any }) => {
      rollbackCalls.push(launch)
      rollbackStates.push(branchState)
      if (state.rollbackResult) {
        session.lastSessionId = 'fork-result-thread'
        if (branchState) {
          clearedTurnAnchorSessions.push(session.sessionName)
          seededTurnAnchors.push([session.sessionName, branchState.anchors.slice()])
          turnAnchorsBySession.set(session.sessionName, branchState.anchors.slice())
          branchBaseBySession.set(session.sessionName, branchState.base)
        }
      }
      return state.rollbackResult
    },
  }
  return { session, state, createCalls, rollbackCalls, rollbackStates }
}

function codexAnchor(
  preview: string,
  sourceSessionId: string,
  turnId: string,
  writes: TurnAnchor['writes'] = [],
  ts = Date.now(),
): TurnAnchor {
  return {
    checkpoint: {
      provider: 'codex',
      kind: 'turn',
      id: turnId,
      source: { provider: 'codex', sessionId: sourceSessionId, cwd: '/workspace/project' },
    },
    preview,
    ts,
    writes,
  }
}

function pickerValue(card: any, preview: string): {
  panelId: string
  choiceId: string
} {
  for (const element of card?.body?.elements ?? []) {
    if (element?.tag !== 'column_set') continue
    const markdown = element.columns?.[0]?.elements?.[0]?.content
    if (!String(markdown ?? '').includes(preview)) continue
    const value = element.columns?.[1]?.elements?.[0]?.behaviors?.[0]?.value
    if (typeof value?.panel_id === 'string' && typeof value?.choice_id === 'string') {
      return { panelId: value.panel_id, choiceId: value.choice_id }
    }
  }
  throw new Error(`picker choice not found for preview: ${preview}`)
}

beforeEach(() => {
  resetFeishuMock()
})

describe('session-temp Codex btw/fork', () => {
  test('failed fork, back and resume pickers expose diagnostics and discard their choices', async () => {
    const h = makeHarness('send-diagnostics')
    turnAnchorsBySession.set(h.session.sessionName, [codexAnchor('first-input', 'root-thread', 'turn-1')])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })
    h.state.history = [{ provider: 'codex', sessionId: 'old-thread', cwd: h.session.workDir, preview: 'old-input', ts: Date.now() }]
    const cards: any[] = []
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (_chatId, card, onFailure) => {
      cards.push(card)
      onFailure?.({ code: 230001, msg: 'invalid card content', log_id: 'temp-send-log' })
      return null
    })
    try {
      await showForkList(h.session, 'ou_owner')
      await showBackList(h.session, 'ou_owner')
      await showResumeList(h.session, 'ou_owner')
      expect(sentRawTexts).toHaveLength(3)
      expect(sentRawTexts.every(text => text.includes('code=230001 message=invalid card content log_id=temp-send-log'))).toBe(true)
      const value = pickerValue(cards[0], 'first-input')
      expect((await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')).ok).toBe(false)
      expect(h.createCalls).toHaveLength(0)
      expect(h.rollbackCalls).toHaveLength(0)
    } finally { send.mockRestore() }
  })

  test('a rejected write-log card reports diagnostics while preserving the requested rollback', async () => {
    const h = makeHarness('back-send-diagnostics')
    turnAnchorsBySession.set(h.session.sessionName, [
      codexAnchor('first-input', 'root-thread', 'turn-1'),
      codexAnchor('second-input', 'current-thread', 'turn-2'),
    ])
    await showBackList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'second-input')
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (_chatId, _card, onFailure) => {
      onFailure?.({ code: 230001, msg: 'invalid card content', log_id: 'write-log-send' })
      return null
    })
    try {
      const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
      expect(result.ok).toBe(true)
      expect(result.message).toContain('code=230001 message=invalid card content log_id=write-log-send')
      expect(h.rollbackCalls).toHaveLength(1)
    } finally { send.mockRestore() }
  })

  test('btw 以 Codex routing 和原 workDir 创建 fresh 会话', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_owner')

    expect(h.createCalls).toEqual([{
      chatName: 'project*0000-0000',
      userOpenId: 'ou_owner',
      workDir: '/workspace/project',
      routing: h.state.routing,
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
    }])
    expect(sentTexts.some(text => text.includes('Codex'))).toBe(true)
    expect(sentTexts.at(-1)).toContain('已创建')
  })

  test('并发创建会同步预留临时群名，避免同分钟同名', async () => {
    const first = makeHarness()
    const second = makeHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    first.session.opts.onCreateTempSession = async (input: any) => {
      first.createCalls.push(input)
      entered()
      await gate
      return { ok: true }
    }

    const firstRun = runBtwCommand(first.session, 'ou_first')
    await started
    await runBtwCommand(second.session, 'ou_second')
    release()
    await firstRun

    expect(first.createCalls[0].chatName).toBe('project*0000-0000')
    expect(second.createCalls[0].chatName).toBe('project*0000-0000-2')
  })

  test('fork 第 0 条输入从 fresh 启动且不 seed 历史', async () => {
    const h = makeHarness()
    const first = codexAnchor('first-input', 'original-thread', 'turn-1')
    turnAnchorsBySession.set(h.session.sessionName, [first])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'first-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual({ kind: 'fresh' })
    expect(h.createCalls[0].seedAnchors).toEqual([])
  })

  test('fork 后续输入使用前一 checkpoint 自带 source 并 seed 分叉前锚点', async () => {
    const h = makeHarness()
    const first = codexAnchor('first-input', 'root-thread', 'turn-root')
    const second = codexAnchor('second-input', 'nested-thread', 'turn-nested')
    const third = codexAnchor('third-input', 'current-thread', 'turn-current')
    turnAnchorsBySession.set(h.session.sessionName, [first, second, third])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'third-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual({
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'nested-thread', cwd: '/workspace/project' },
      through: second.checkpoint,
    })
    expect(h.createCalls[0].launch.source.sessionId).not.toBe(h.session.lastSessionId)
    expect(h.createCalls[0].seedAnchors).toEqual([first, second])
  })

  test('full-fork 历史后的第一条新输入沿用 branch base，不误退化成 fresh', async () => {
    const h = makeHarness('history-branch')
    const base: Extract<ConversationLaunch, { kind: 'fork' }> = {
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'historical-root', cwd: '/workspace/project' },
    }
    const firstNew = codexAnchor('first-new-input', 'fork-result-thread', 'new-turn-1')
    turnAnchorsBySession.set(h.session.sessionName, [firstNew])
    branchBaseBySession.set(h.session.sessionName, base)

    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'first-new-input')
    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.createCalls[0].launch).toEqual(base)
    expect(h.createCalls[0].branchBase).toEqual(base)
  })

  test('legacy unknown branch base does not expose the oldest prompt as a false fresh origin', async () => {
    const h = makeHarness('legacy-unknown')
    turnAnchorsBySession.set(h.session.sessionName, [
      codexAnchor('unknown-origin-input', 'old-thread', 'old-turn'),
    ])
    branchBaseBySession.set(h.session.sessionName, null)

    await showForkList(h.session, 'ou_owner')

    expect(() => pickerValue(sentCards[0], 'unknown-origin-input')).toThrow('picker choice not found')
  })

  test('fork picker 拒绝非 owner、变化后的 provider/source session/token source', async () => {
    const h = makeHarness()
    turnAnchorsBySession.set(h.session.sessionName, [
      codexAnchor('guarded-input', 'current-thread', 'turn-guarded'),
    ])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })
    await showForkList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'guarded-input')

    const wrongOwner = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_other')
    expect(wrongOwner).toMatchObject({ ok: false, replaceCard: false })
    expect(wrongOwner.message).toContain('只有打开这张选择卡的用户')

    h.session.selectedProvider = 'claude'
    const staleProvider = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleProvider).toMatchObject({ ok: false })
    expect(staleProvider.message).toContain('已经变化')
    h.session.selectedProvider = 'codex'

    h.session.lastSessionId = 'replacement-thread'
    const staleSession = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleSession).toMatchObject({ ok: false })
    expect(staleSession.message).toContain('已经变化')
    h.session.lastSessionId = 'current-thread'

    h.state.routing.tokenSourceId = 'another-codex-account'
    const staleSource = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(staleSource).toMatchObject({ ok: false })
    expect(staleSource.message).toContain('已经变化')
    expect(h.createCalls).toHaveLength(0)
  })
})

describe('session-temp Codex back', () => {
  test('展示 bk 列表不触发 stop/rollback，点击成功后才替换 anchors', async () => {
    const h = makeHarness()
    const first = codexAnchor('keep-input', 'root-thread', 'turn-keep')
    const second = codexAnchor('rollback-input', 'current-thread', 'turn-rollback', [
      { tool: 'FileChange', path: '/workspace/project/a.ts', body: '+changed' },
    ])
    turnAnchorsBySession.set(h.session.sessionName, [first, second])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showBackList(h.session, 'ou_owner')

    expect(h.rollbackCalls).toHaveLength(0)
    expect(turnAnchorsBySession.get('project')).toEqual([first, second])
    const value = pickerValue(sentCards[0], 'rollback-input')

    const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.rollbackCalls).toEqual([{
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'root-thread', cwd: '/workspace/project' },
      through: first.checkpoint,
    }])
    expect(clearedTurnAnchorSessions).toEqual(['project'])
    expect(seededTurnAnchors).toEqual([['project', [first]]])
    expect(turnAnchorsBySession.get('project')).toEqual([first])
  })

  test('rollback 失败时保留原 anchors，不执行 clear/seed', async () => {
    const h = makeHarness('failed-back')
    h.state.rollbackResult = false
    const first = codexAnchor('first-input', 'root-thread', 'turn-1')
    const second = codexAnchor('second-input', 'current-thread', 'turn-2')
    turnAnchorsBySession.set(h.session.sessionName, [first, second])
    branchBaseBySession.set(h.session.sessionName, { kind: 'fresh' })

    await showBackList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'second-input')
    const result = await onBackSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('原会话绑定未改')
    expect(h.rollbackCalls).toHaveLength(1)
    expect(clearedTurnAnchorSessions).toHaveLength(0)
    expect(seededTurnAnchors).toHaveLength(0)
    expect(turnAnchorsBySession.get('failed-back')).toEqual([first, second])
  })
})

describe('session-temp Codex stopped-session history', () => {
  test('Claude history excludes delegated Agent native sessions', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'lodestar-claude-agent-history-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const workDir = '/workspace/project'
    const transcriptDir = join(configDir, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(transcriptDir, { recursive: true })
    const line = (content: string) => `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })}\n`
    writeFileSync(join(transcriptDir, 'delegated.jsonl'), line('child work'))
    writeFileSync(join(transcriptDir, 'main.jsonl'), line('main work'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetAgentSessionRegistryForTest(['claude:delegated'])
    try {
      expect(listClaudeSessions(workDir).map(item => item.sessionId)).toEqual(['main'])
    } finally {
      resetAgentSessionRegistryForTest()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('rs 对所选历史 thread 创建不带 checkpoint 的 full fork', async () => {
    const h = makeHarness()
    const selectedTs = 1_787_350_000_000
    h.state.history = [{
      provider: 'codex',
      sessionId: 'historical-thread',
      cwd: '/workspace/project',
      preview: 'historical-input',
      ts: selectedTs,
      status: 'idle',
    }]
    turnAnchorsBySession.set(h.session.sessionName, [
      codexAnchor('old-local-input', 'current-thread', 'turn-old'),
    ])

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'historical-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(true)
    expect(h.rollbackCalls).toEqual([{
      kind: 'fork',
      source: { provider: 'codex', sessionId: 'historical-thread', cwd: '/workspace/project' },
    }])
    expect(Object.prototype.hasOwnProperty.call(h.rollbackCalls[0], 'through')).toBe(false)
    expect(clearedTurnAnchorSessions).toEqual(['project'])
    expect(turnAnchorsBySession.get('project')).toEqual([])
    expect(branchBaseBySession.get('project')).toEqual(h.rollbackCalls[0])
    expect(h.rollbackStates[0].pendingLaunch).toBeNull()
    expect(result.resumePresentation).toEqual({
      projectName: 'project',
      provider: 'codex',
      selectedPreview: 'historical-input',
      selectedTs,
      sourceSessionId: 'historical-thread',
      sourceStatus: 'idle',
      previousSessionId: 'current-thread',
      newSessionId: 'fork-result-thread',
      bindingState: 'changed',
    })
    expect(sentTexts.some(text => text.includes('正在从历史会话'))).toBe(false)
  })

  test('rs 点击时本群已 running 则拒绝且不 rollback', async () => {
    const h = makeHarness('running-project')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'historical-thread',
      cwd: '/workspace/project',
      preview: 'running-guard-input',
      ts: Date.now(),
      status: 'idle',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'running-guard-input')
    h.state.running = true
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('当前群已经启动了新进程')
    expect(result.replaceCard).not.toBe(false)
    expect(result.resumePresentation).toMatchObject({
      provider: 'codex',
      selectedPreview: 'running-guard-input',
      sourceSessionId: 'historical-thread',
      previousSessionId: 'current-thread',
      newSessionId: null,
      bindingState: 'unchanged',
    })
    expect(h.rollbackCalls).toHaveLength(0)
    expect(clearedTurnAnchorSessions).toHaveLength(0)
  })

  test('rs 非 owner 只 toast 且不消费 panel，owner 随后仍可成功', async () => {
    const h = makeHarness('resume-owner-guard')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'owner-source-thread',
      cwd: '/workspace/project',
      preview: 'owner-guard-input',
      ts: Date.now(),
      status: 'idle',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'owner-guard-input')
    const rejected = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_other')
    expect(rejected).toMatchObject({ ok: false, replaceCard: false })
    expect(rejected.resumePresentation).toBeUndefined()
    expect(h.rollbackCalls).toHaveLength(0)

    const accepted = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')
    expect(accepted.ok).toBe(true)
    expect(accepted.resumePresentation?.sourceSessionId).toBe('owner-source-thread')
    expect(h.rollbackCalls).toHaveLength(1)
  })

  test('rs rollback 失败仍返回带所选快照的红色终态信息', async () => {
    const h = makeHarness('resume-failure')
    h.state.rollbackResult = false
    h.state.history = [{
      provider: 'codex',
      sessionId: 'failed-source-thread',
      cwd: '/workspace/project',
      preview: 'failed-history-input',
      ts: 1_787_351_000_000,
      status: 'systemError',
    }]

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'failed-history-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result).toMatchObject({ ok: false })
    expect(result.replaceCard).not.toBe(false)
    expect(result.resumePresentation).toEqual({
      projectName: 'resume-failure',
      provider: 'codex',
      selectedPreview: 'failed-history-input',
      selectedTs: 1_787_351_000_000,
      sourceSessionId: 'failed-source-thread',
      sourceStatus: 'systemError',
      previousSessionId: 'current-thread',
      newSessionId: null,
      bindingState: 'unchanged',
    })
    expect(result.message).toContain('原会话绑定未改')
  })

  test('Claude rs 成功也返回同一终态展示契约', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'lodestar-claude-rs-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const h = makeHarness('claude-project')
    h.session.selectedProvider = 'claude'
    h.session.lastSessionId = 'current-claude-session'
    h.state.routing = {
      provider: 'claude',
      tokenSourceId: 'claude-native',
      model: 'claude-opus-4-6',
      effort: 'high',
    }
    h.session.rollbackTo = async (launch: ConversationLaunch, branchState: any) => {
      h.rollbackCalls.push(launch)
      h.rollbackStates.push(branchState)
      // Claude SDK only materializes the forked session id on first user input.
      return true
    }
    const transcriptDir = join(
      configDir,
      'projects',
      h.session.workDir.replace(/[^a-zA-Z0-9]/g, '-'),
    )
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, 'historical-claude-session.jsonl'), `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'claude-history-input',
    })}\n`)
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      await showResumeList(h.session, 'ou_owner')
      const value = pickerValue(sentCards[0], 'claude-history-input')
      const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

      expect(result.ok).toBe(true)
      expect(h.rollbackCalls).toEqual([{
        kind: 'fork',
        source: {
          provider: 'claude',
          sessionId: 'historical-claude-session',
          cwd: '/workspace/project',
        },
      }])
      expect(result.resumePresentation).toMatchObject({
        projectName: 'claude-project',
        provider: 'claude',
        selectedPreview: 'claude-history-input',
        sourceSessionId: 'historical-claude-session',
        previousSessionId: 'current-claude-session',
        newSessionId: null,
        bindingState: 'prepared',
      })
      expect(h.rollbackStates[0].pendingLaunch).toEqual({
        launch: h.rollbackCalls[0],
        previousSessionId: 'current-claude-session',
      })
      expect(result.message).toContain('首条消息时生成并接入')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('rs 后端声称成功但缺少独立新 id 时显式失败', async () => {
    const h = makeHarness('resume-missing-id')
    h.state.history = [{
      provider: 'codex',
      sessionId: 'missing-id-source',
      cwd: '/workspace/project',
      preview: 'missing-id-input',
      ts: Date.now(),
      status: 'idle',
    }]
    h.session.rollbackTo = async (launch: ConversationLaunch) => {
      h.rollbackCalls.push(launch)
      h.session.lastSessionId = null
      return true
    }

    await showResumeList(h.session, 'ou_owner')
    const value = pickerValue(sentCards[0], 'missing-id-input')
    const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有返回新会话 id')
    expect(result.resumePresentation?.newSessionId).toBeNull()
    expect(result.resumePresentation?.previousSessionId).toBe('current-thread')
    expect(result.resumePresentation?.bindingState).toBe('unknown')
  })
})
