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
  leftChats,
  projectProfiles,
  resetFeishuMock,
  seededTurnAnchors,
  sentCards,
  sentRawTexts,
  sentTexts,
  setChatMembers,
  setChatMembersError,
  setLeaveChatError,
  turnAnchorsBySession,
} from './feishu-test-mock'
import * as feishu from './feishu'

// feishu-test-mock 必须先注册，session-temp 才会拿到共享的 Feishu 替身。
const {
  onBackSelect,
  onForkSelect,
  onResumeSelect,
  runBtwCommand,
  runByeCommand,
  showBackList,
  showForkList,
  showResumeList,
  listClaudeSessions,
} = await import('./session-temp')
const { runCommand } = await import('./session-commands')

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
  disbandCalls: Array<[string, string]>
}

function makeHarness(sessionName = 'project'): TempHarness {
  // 临时群目录按群名解析(主项目目录),与 session.workDir 保持一致,
  // 让备注 btw 的同目录校验不会误拒。
  projectProfiles.set('project', { cwd: '/workspace/project' })
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
  const disbandCalls: Array<[string, string]> = []
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
      onDisbandTempSession: async (chatName: string, chatId: string) => {
        disbandCalls.push([chatName, chatId])
        return { ok: true }
      },
    },
    backendLabel: () => 'Codex',
    conversationRouting: () => ({ ...state.routing }),
    isRunning: () => state.running,
    listCodexConversations: async () => state.history.slice(),
    claudeHistoryOptions: () => ({ configDir: process.env.CLAUDE_CONFIG_DIR }),
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
  return { session, state, createCalls, rollbackCalls, rollbackStates, disbandCalls }
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

/** 卡片正文断言用：模板是纯 JSON，直接查序列化文本。 */
function cardJson(card: unknown): string {
  return JSON.stringify(card ?? {})
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
    // 创建过程先给「正在创建」卡，成功后换成「已就绪」卡，都是 Codex 会话。
    expect(cardJson(sentCards[0])).toContain('正在创建或加入')
    expect(cardJson(sentCards.at(-1))).toContain('临时群已就绪')
    expect(cardJson(sentCards.at(-1))).toContain('Codex')
  })

  test('btw 备注代替时间后缀', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_owner', '修复 登录')

    expect(h.createCalls[0].chatName).toBe('project*修复_登录')
    expect(h.createCalls[0].groupMode).toBe('reuse')
    expect(cardJson(sentCards[0])).toContain('project*修复_登录')
    expect(cardJson(sentCards.at(-1))).toContain('project*修复_登录')
  })

  test('同备注的第二个成员复用同一个群名，不再追加 -2', async () => {
    const first = makeHarness()
    const second = makeHarness()

    await runBtwCommand(first.session, 'ou_first', '修复登录')
    await runBtwCommand(second.session, 'ou_second', '修复登录')

    expect(first.createCalls[0].chatName).toBe('project*修复登录')
    expect(second.createCalls[0].chatName).toBe('project*修复登录')
    expect(second.createCalls[0].userOpenId).toBe('ou_second')
    expect(second.createCalls[0].groupMode).toBe('reuse')
  })

  test('加入既有临时群时只回执已加入，不声称创建或重启会话', async () => {
    const h = makeHarness()
    h.session.opts.onCreateTempSession = async (input: any) => {
      h.createCalls.push(input)
      return { ok: true, chatId: 'oc_project*修复登录', join: 'added' }
    }

    await runBtwCommand(h.session, 'ou_guest', '修复登录')

    const last = sentCards.at(-1) as any
    expect(last.header.template).toBe('turquoise')
    expect(cardJson(last)).toContain('已加入这个临时群')
    expect(cardJson(last)).toContain('没有新建或重启会话')
    expect(sentCards.some(card => cardJson(card).includes('临时群已就绪'))).toBe(false)
  })

  test('本来就在群里时回执「已在群内」，不谎报刚被拉进来', async () => {
    const h = makeHarness()
    h.session.opts.onCreateTempSession = async (input: any) => {
      h.createCalls.push(input)
      return { ok: true, chatId: 'oc_project*修复登录', join: 'present' }
    }

    await runBtwCommand(h.session, 'ou_owner', '修复登录')

    const last = sentCards.at(-1) as any
    expect(last.header.template).toBe('blue')
    expect(cardJson(last)).toContain('你已经在这个临时群里')
    expect(cardJson(last)).not.toContain('已加入这个临时群')
  })

  test('WT 里发 btw 备注落在该 worktree，群名带分支', async () => {
    const h = makeHarness('project[feature]')
    h.session.workDir = '/workspace/project[feature]'

    await runBtwCommand(h.session, 'ou_owner', '评审')

    expect(h.createCalls[0].chatName).toBe('project[feature]*评审')
    expect(h.createCalls[0].groupMode).toBe('reuse')
    expect(h.createCalls[0].workDir).toBe('/workspace/project[feature]')
  })

  test('基名很长导致备注放不下时明确拒绝，不创建会被截断的同名群', async () => {
    const h = makeHarness('p'.repeat(40))
    const longRole = '备'.repeat(40)

    await runBtwCommand(h.session, 'ou_owner', longRole)

    expect(h.createCalls).toHaveLength(0)
    const last = sentCards.at(-1) as any
    expect(last.header.template).toBe('red')
    expect(cardJson(last)).toContain('备注太长')
    expect(cardJson(last)).toContain('最多 23 个字符')
  })

  test('群里有别人时 bye 只是自己退出，不停会话也不解散群', async () => {
    const h = makeHarness('project*修复登录')
    setChatMembers(h.session.chatId, ['ou_guest', 'ou_owner'])

    await runByeCommand(h.session, 'ou_guest')

    expect(h.disbandCalls).toHaveLength(0)
    expect(leftChats).toEqual([['oc_project*修复登录', 'ou_guest']])
    expect(cardJson(sentCards.at(-1))).toContain('正在退出这个临时群')
    expect(cardJson(sentCards.at(-1))).toContain('仍由创建者管理')
  })

  test('最后一个人 bye 时停止会话并解散，不看是谁创建的', async () => {
    const h = makeHarness('project*修复登录')
    setChatMembers(h.session.chatId, ['ou_guest'])

    await runByeCommand(h.session, 'ou_guest')

    expect(leftChats).toHaveLength(0)
    expect(h.disbandCalls).toEqual([['project*修复登录', 'oc_project*修复登录']])
    expect(cardJson(sentCards.at(-1))).toContain('正在停止会话并解散')
  })

  test('并发退群：退出后复查发现已空，最后一个走的负责解散', async () => {
    const h = makeHarness('project*修复登录')
    const members = spyOn(feishu, 'chatMemberOpenIds')
      .mockResolvedValueOnce(['ou_guest', 'ou_other'])
      .mockResolvedValueOnce([])
    try {
      await runByeCommand(h.session, 'ou_guest')
    } finally { members.mockRestore() }

    expect(leftChats).toEqual([['oc_project*修复登录', 'ou_guest']])
    expect(h.disbandCalls).toEqual([['project*修复登录', 'oc_project*修复登录']])
  })

  test('读取群成员失败时既不退出也不解散', async () => {
    const h = makeHarness('project*修复登录')
    setChatMembersError(new Error('chatMembers.get failed: code=230002'))

    await runByeCommand(h.session, 'ou_guest')

    expect(leftChats).toHaveLength(0)
    expect(h.disbandCalls).toHaveLength(0)
    const last = sentCards.at(-1) as any
    expect(last.header.template).toBe('red')
    expect(cardJson(last)).toContain('读取群成员失败')
    expect(cardJson(last)).toContain('230002')
  })

  test('自助退群失败时保留飞书原因并提示手动退出', async () => {
    const h = makeHarness('project*修复登录')
    setChatMembers(h.session.chatId, ['ou_guest', 'ou_owner'])
    setLeaveChatError(new Error('chatMembers.delete failed: code=232008 no permission'))

    await runByeCommand(h.session, 'ou_guest')

    expect(h.disbandCalls).toHaveLength(0)
    const last = sentCards.at(-1) as any
    expect(last.header.template).toBe('red')
    expect(cardJson(last)).toContain('退出失败')
    expect(cardJson(last)).toContain('232008')
    expect(cardJson(last)).toContain('手动退出')
  })

  test('群成员为空时按最后一人处理，解散而不是留空群', async () => {
    const h = makeHarness('project*0821-1337')

    await runByeCommand(h.session, 'ou_anyone')

    expect(h.disbandCalls).toHaveLength(1)
    expect(leftChats).toHaveLength(0)
  })

  test('btw 备注没有可用字符时不创建临时群', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_owner', '🚀')

    expect(h.createCalls).toHaveLength(0)
    expect(cardJson(sentCards.at(-1))).toContain('备注至少需要')
  })

  test('卡片发送失败时回退原文并保留飞书诊断', async () => {
    const h = makeHarness()
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (_chatId, _card, onFailure) => {
      onFailure?.({ code: 230001, msg: 'invalid card content', log_id: 'btw-send-log' })
      return null as unknown as string
    })
    try {
      await runBtwCommand(h.session, 'ou_owner', '修复登录')
    } finally { send.mockRestore() }

    expect(sentRawTexts.length).toBeGreaterThan(0)
    expect(sentRawTexts.every(text => text.includes('code=230001 message=invalid card content log_id=btw-send-log'))).toBe(true)
  })

  test('WT 中创建 BTW 使用该 worktree 基名', async () => {
    const h = makeHarness('project[feature]')

    await runBtwCommand(h.session, 'ou_owner')

    expect(h.createCalls[0].chatName).toBe('project[feature]*0000-0000')

    await runBtwCommand(h.session, 'ou_owner', 'review')

    expect(h.createCalls[1].chatName).toBe('project[feature]*review')
  })

  test('btw 命令把备注原样传给临时群创建', async () => {
    const calls: Array<[string, string]> = []
    const fakeSession = {
      runBtwCommand: async (userOpenId: string, role: string) => { calls.push([userOpenId, role]) },
    }

    expect(await runCommand(fakeSession as any, 'btw 修复 登录', 'ou_owner')).toBe(true)
    expect(await runCommand(fakeSession as any, ' BTW ', 'ou_owner')).toBe(true)
    expect(await runCommand(fakeSession as any, 'btw\nextra', 'ou_owner')).toBe(false)

    expect(calls).toEqual([['ou_owner', '修复 登录'], ['ou_owner', '']])
  })

  test('时间后缀的并发创建仍同步预留群名，避免同分钟同名', async () => {
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
      tokenSourceId: 'claude-sub',
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

describe('session-temp rs Claude account', () => {
  test('rs 历史展示已记录的 Claude 账号，选择后把它留给耗尽回退', async () => {
    const { claudeTranscriptDir } = await import('./claude-agent-process')
    const { recordClaudeSessionAccount } = await import('./claude-session-accounts')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-rs-account-'))
    const workDir = join(root, 'project')
    const configDir = join(root, 'claude')
    const sessionId = '01a03100-0000-7000-8000-00000000beef'
    mkdirSync(workDir, { recursive: true })
    const transcriptDir = claudeTranscriptDir(workDir, { configDir })
    mkdirSync(transcriptDir, { recursive: true })
    const line = (value: unknown) => `${JSON.stringify(value)}\n`
    writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), [
      line({ type: 'queue-operation', operation: 'enqueue', content: '第一句：排查导出失败' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '## 结论\n已定位到超时逻辑。' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '顺便把重试日志也加上' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '已修复导出超时，回归测试全部通过。' }] } }),
    ].join(''))
    recordClaudeSessionAccount(sessionId, 'default')
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    const h = makeHarness('claude-account-rs')
    h.session.selectedProvider = 'claude'
    h.session.workDir = workDir
    h.state.routing = { provider: 'claude', tokenSourceId: 'claude-sub', model: 'opus', effort: 'high' }
    try {
      await showResumeList(h.session, 'ou_owner')
      const card = sentCards[sentCards.length - 1]
      const row = JSON.stringify(card)
      expect(row).toContain('🚩 `第一句：排查导出失败`')
      // 末只取用户消息：最后一条用户输入，而不是它的回复。
      expect(row).toContain('🏁 `顺便把重试日志也加上`')
      expect(row).not.toContain('🏁 `已修复导出超时，回归测试全部通过。`')
      const value = pickerValue(card, '第一句：排查导出失败')
      const result = await onResumeSelect(h.session, value.panelId, value.choiceId, 'ou_owner')

      expect(result.ok).toBe(true)
      expect(result.resumePresentation).toMatchObject({
        provider: 'claude',
        sourceSessionId: sessionId,
        selectedLastPreview: '顺便把重试日志也加上',
        bindingState: 'prepared',
      })
      // 账号不再展示，但仍会留给“全部额度耗尽”时的原账号回退。
      expect(h.session.claudeResumeAccountId).toBe('default')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(root, { recursive: true, force: true })
    }
  })
})
