import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ConversationRouting } from './conversation'
import type { TurnAnchor } from './feishu'
import {
  branchBaseBySession,
  chatIdsByName,
  externalChatChecks,
  leftChats,
  normalChatLookups,
  preferredChatForSession,
  projectProfiles,
  resetFeishuMock,
  resolvedTempGroupOwners,
  sentCards,
  sentRawTexts,
  sentTexts,
  setChatMembers,
  setExternalChat,
  setExternalChatError,
  setNormalChatLookupError,
  setTempGroupOwner,
  turnAnchorsBySession,
  updatedCards,
} from './feishu-test-mock'
import * as feishu from './feishu'
import * as logModule from './log'
import type { RequesterTenant } from './requester-tenant'

// feishu-test-mock 必须先注册，session-temp 才会拿到共享的 Feishu 替身。
const { onForkSelect, runBtwCommand, runByeCommand, showForkList } = await import('./session-temp')
const { runCommand } = await import('./session-commands')
const { createTempSessionRuntime } = await import('./temp-session-runtime')

const EXTERNAL: RequesterTenant = { external: true, appTenantKey: 'tenant_app' }
const WORK_DIR = '/workspace/project'
const ROUTING: ConversationRouting = {
  provider: 'codex',
  tokenSourceId: 'codex-subscription',
  model: 'gpt-5.6-sol',
  effort: 'high',
}
/** Real open_id shape (ou_ + 32 lowercase hex), so redaction applies to it. */
const SECRET_ID = `ou_${'a1b2c3d4'.repeat(4)}`

interface DisbandCall {
  chatName: string
  chatId: string
  /** 调用 onDisbandTempSession 时群里已经看到的提示卡（发送与原地更新）。 */
  shownBefore: string[]
}

function shownCards(): string[] {
  return [...sentCards, ...updatedCards.map(([, card]) => card)].map(card => JSON.stringify(card))
}

function makeHarness(sessionName = 'project') {
  projectProfiles.set('project', { cwd: WORK_DIR })
  const createCalls: any[] = []
  const disbandCalls: DisbandCall[] = []
  const harness = {
    createCalls,
    disbandCalls,
    createResult: { ok: true } as { ok: boolean; error?: string; join?: 'added' | 'present' },
    disbandResult: { ok: true } as { ok: boolean; error?: string; left?: boolean },
    session: null as any,
  }
  const session: any = {
    sessionName,
    chatId: `oc_${sessionName}`,
    selectedProvider: 'codex',
    lastSessionId: 'current-thread',
    workDir: WORK_DIR,
    opts: {
      onCreateTempSession: async (input: any) => {
        createCalls.push(input)
        return harness.createResult
      },
      onDisbandTempSession: async (chatName: string, chatId: string) => {
        disbandCalls.push({ chatName, chatId, shownBefore: shownCards() })
        return harness.disbandResult
      },
    },
    backendLabel: () => 'Codex',
    conversationRouting: () => ({ ...ROUTING }),
    isRunning: () => false,
    runBtwCommand: (userOpenId: string, role: string, requester?: RequesterTenant) =>
      runBtwCommand(session, userOpenId, role, requester),
  }
  harness.session = session
  return harness
}

function codexAnchor(preview: string, sourceSessionId: string, turnId: string): TurnAnchor {
  return {
    checkpoint: {
      provider: 'codex',
      kind: 'turn',
      id: turnId,
      source: { provider: 'codex', sessionId: sourceSessionId, cwd: WORK_DIR },
    },
    preview,
    ts: Date.now(),
    writes: [],
  }
}

function pickerValue(card: any, preview: string): { panelId: string; choiceId: string } {
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

/** btw/bye 的终态回执：发出后被原位更新的卡片优先，否则取最后发送的卡片。 */
function finalCard(): any {
  return updatedCards.length ? updatedCards.at(-1)![1] : sentCards.at(-1)
}

/** Fixed literal event names passed to logError (the error argument is reduced to category/code by log.ts). */
let loggedEvents: string[] = []
let logSpy: { mockRestore(): void } | null = null

beforeEach(() => {
  resetFeishuMock()
  loggedEvents = []
  logSpy = spyOn(logModule, 'logError').mockImplementation((event: string) => { loggedEvents.push(event) })
})

afterEach(() => {
  logSpy?.mockRestore()
  logSpy = null
})

describe('external contact btw', () => {
  test('the new temp group is owned by the source group owner and includes the requester', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_guest', '', EXTERNAL)

    expect(resolvedTempGroupOwners).toEqual([['oc_project', 'ou_guest', 'tenant_app']])
    expect(normalChatLookups).toEqual([])
    expect(h.createCalls).toEqual([{
      chatName: 'project*0000-0000',
      userOpenId: 'ou_guest',
      workDir: WORK_DIR,
      routing: ROUTING,
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
      ownerOpenId: 'ou_group_owner',
      externalRequester: true,
    }])
    expect(sentCards).toHaveLength(1)
    expect(JSON.stringify(finalCard())).toContain('临时群已就绪')
  })

  test('btw 备注 creating a new group resolves the owner first, through runCommand', async () => {
    const h = makeHarness()

    expect(await runCommand(h.session, 'btw 修复登录', 'ou_guest', undefined, EXTERNAL)).toBe(true)

    expect(normalChatLookups).toEqual(['project*修复登录'])
    expect(resolvedTempGroupOwners).toEqual([['oc_project', 'ou_guest', 'tenant_app']])
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0]).toMatchObject({
      chatName: 'project*修复登录',
      groupMode: 'reuse',
      userOpenId: 'ou_guest',
      ownerOpenId: 'ou_group_owner',
      externalRequester: true,
    })
  })

  test('btw 备注 joining an existing same-name group needs no owner', async () => {
    const h = makeHarness()
    chatIdsByName.set('project*修复登录', ['oc_existing'])
    // 当前群的群主不合格也不影响加入：根本不查群主。
    setTempGroupOwner(new Error('当前群的群主不属于机器人所在企业'))
    h.createResult = { ok: true, join: 'added' }

    await runBtwCommand(h.session, 'ou_guest', '修复登录', EXTERNAL)

    expect(normalChatLookups).toEqual(['project*修复登录'])
    expect(resolvedTempGroupOwners).toEqual([])
    expect(h.createCalls).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(h.createCalls[0], 'ownerOpenId')).toBe(false)
    expect(h.createCalls[0]).toMatchObject({ chatName: 'project*修复登录', groupMode: 'reuse', externalRequester: true })
    expect(JSON.stringify(finalCard())).toContain('**已加入**')
  })

  test('a failed same-name group lookup is shown and logged, and nothing is created', async () => {
    const h = makeHarness()
    setNormalChatLookupError(new Error('feishu chat.list failed code=99991400 message=rate limited log_id=list-log'))

    await runBtwCommand(h.session, 'ou_guest', '修复登录', EXTERNAL)

    expect(h.createCalls).toHaveLength(0)
    expect(resolvedTempGroupOwners).toEqual([])
    const last = finalCard()
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain('查找同名临时群失败')
    expect(JSON.stringify(last)).toContain('log_id=list-log')
    expect(loggedEvents).toEqual(['session-temp: same-name temp group lookup failed'])
  })

  test('an unusable owner fails with a clear notice, is logged, and creates nothing', async () => {
    const h = makeHarness()
    setTempGroupOwner(new Error('外部联系人发起的临时群须由本企业成员当群主，但当前群的群主不是用户（可能是机器人）'))

    await runBtwCommand(h.session, 'ou_guest', '', EXTERNAL)

    expect(h.createCalls).toHaveLength(0)
    // 「创建中」和失败共用一张卡。
    expect(sentCards).toHaveLength(1)
    const last = finalCard()
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain('建临时会话失败')
    expect(JSON.stringify(last)).toContain('本企业成员当群主')
    expect(loggedEvents).toEqual(['session-temp: temp group owner lookup failed'])

    // 失败时释放了预留的时间后缀群名，下一次 btw 不会变成 -2。
    setTempGroupOwner('ou_group_owner')
    await runBtwCommand(h.session, 'ou_guest', '', EXTERNAL)
    expect(h.createCalls[0].chatName).toBe('project*0000-0000')
  })

  test('internal requesters in an internal group are unchanged: no owner and no external keys', async () => {
    const h = makeHarness()

    await runBtwCommand(h.session, 'ou_member')
    await runBtwCommand(h.session, 'ou_member', '', { external: false })
    expect(await runCommand(h.session, 'btw 评审', 'ou_member')).toBe(true)

    // Only the source group's type is read; no owner or same-name lookups.
    expect(externalChatChecks).toEqual(['oc_project', 'oc_project', 'oc_project'])
    expect(resolvedTempGroupOwners).toEqual([])
    expect(normalChatLookups).toEqual([])
    expect(h.createCalls).toHaveLength(3)
    for (const call of h.createCalls) {
      expect(Object.prototype.hasOwnProperty.call(call, 'ownerOpenId')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(call, 'externalRequester')).toBe(false)
    }
    expect(h.createCalls[0]).toEqual({
      chatName: 'project*0000-0000',
      userOpenId: 'ou_member',
      workDir: WORK_DIR,
      routing: ROUTING,
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
    })
    expect(loggedEvents).toEqual([])
  })

  test('an internal member in an external group creates an external group they own, so external members can join later', async () => {
    const h = makeHarness()
    setExternalChat('oc_project')

    await runBtwCommand(h.session, 'ou_member')
    expect(await runCommand(h.session, 'btw 评审', 'ou_member')).toBe(true)

    expect(externalChatChecks).toEqual(['oc_project', 'oc_project'])
    // The requester owns the group: no source-owner lookup, and no same-name pre-check (joining ignores the owner).
    expect(resolvedTempGroupOwners).toEqual([])
    expect(normalChatLookups).toEqual([])
    expect(h.createCalls).toHaveLength(2)
    expect(h.createCalls[0]).toEqual({
      chatName: 'project*0000-0000',
      userOpenId: 'ou_member',
      workDir: WORK_DIR,
      routing: ROUTING,
      launch: { kind: 'fresh' },
      branchBase: { kind: 'fresh' },
      seedAnchors: [],
      ownerOpenId: 'ou_member',
      externalRequester: false,
    })
    expect(h.createCalls[1]).toMatchObject({
      chatName: 'project*评审', groupMode: 'reuse', userOpenId: 'ou_member', ownerOpenId: 'ou_member', externalRequester: false,
    })
    expect(loggedEvents).toEqual([])
  })

  test('an unreadable source group type is shown and logged, and nothing is created', async () => {
    const h = makeHarness()
    setExternalChatError(new Error('feishu chat.get failed code=232010 message=no permission log_id=type-log'))

    await runBtwCommand(h.session, 'ou_member')

    expect(h.createCalls).toHaveLength(0)
    const last = finalCard()
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain('读取当前群类型失败')
    expect(JSON.stringify(last)).toContain('log_id=type-log')
    expect(loggedEvents).toEqual(['session-temp: source group type lookup failed'])

    // The reserved time-suffix name was released: the retry does not become -2.
    setExternalChatError(null)
    await runBtwCommand(h.session, 'ou_member')
    expect(h.createCalls[0].chatName).toBe('project*0000-0000')
  })

  test('member IDs echoed by a Feishu rejection never reach the chat; code, log_id and hint stay', async () => {
    const h = makeHarness()
    h.createResult = {
      ok: false,
      error: `feishu chat.create failed code=232043 message=Your request contains unavailable ids, ext=bot is invisible to user ids: [${SECRET_ID}] log_id=log-232043；外部联系人须先点开机器人发起单聊并确认`,
    }

    await runBtwCommand(h.session, 'ou_guest', '', EXTERNAL)

    const shown = [...shownCards(), ...sentRawTexts].join('\n')
    expect(shown).not.toContain(SECRET_ID)
    const last = JSON.stringify(finalCard())
    expect(last).toContain('code=232043')
    expect(last).toContain('log_id=log-232043')
    expect(last).toContain('外部联系人须先点开机器人发起单聊并确认')
  })
})

describe('external contact fork', () => {
  async function openForkPicker(h: ReturnType<typeof makeHarness>, userOpenId: string) {
    turnAnchorsBySession.set('project', [codexAnchor('first-input', 'root-thread', 'turn-1')])
    branchBaseBySession.set('project', { kind: 'fresh' })
    await showForkList(h.session, userOpenId)
    return pickerValue(sentCards[0], 'first-input')
  }

  test('an external fork selection passes the source group owner', async () => {
    const h = makeHarness()
    const value = await openForkPicker(h, 'ou_guest')

    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_guest', EXTERNAL)

    expect(result.ok).toBe(true)
    expect(resolvedTempGroupOwners).toEqual([['oc_project', 'ou_guest', 'tenant_app']])
    expect(normalChatLookups).toEqual([])
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0]).toMatchObject({
      userOpenId: 'ou_guest', ownerOpenId: 'ou_group_owner', externalRequester: true, launch: { kind: 'fresh' },
    })
  })

  test('an internal fork selection adds no owner', async () => {
    const h = makeHarness()
    const value = await openForkPicker(h, 'ou_member')

    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_member')

    expect(result.ok).toBe(true)
    expect(resolvedTempGroupOwners).toEqual([])
    expect(Object.prototype.hasOwnProperty.call(h.createCalls[0], 'ownerOpenId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(h.createCalls[0], 'externalRequester')).toBe(false)
  })

  test('an internal fork from an external group creates an external group owned by the requester', async () => {
    const h = makeHarness()
    setExternalChat('oc_project')
    const value = await openForkPicker(h, 'ou_member')

    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_member')

    expect(result.ok).toBe(true)
    expect(resolvedTempGroupOwners).toEqual([])
    expect(h.createCalls[0]).toMatchObject({ userOpenId: 'ou_member', ownerOpenId: 'ou_member', externalRequester: false })
  })

  test('an unreadable source group type fails the fork before any group work and is logged', async () => {
    const h = makeHarness()
    const value = await openForkPicker(h, 'ou_member')
    setExternalChatError(new Error('feishu chat.get failed code=232010 message=no permission log_id=fork-type-log'))

    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_member')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('分叉失败')
    expect(result.message).toContain('读取当前群类型失败')
    expect(h.createCalls).toHaveLength(0)
    expect(sentTexts.some(text => text.includes('正在分叉'))).toBe(false)
    expect(loggedEvents).toEqual(['session-temp: source group type lookup failed'])
  })

  test('an unusable owner fails the fork before any group work, is logged and redacts member IDs', async () => {
    const h = makeHarness()
    const value = await openForkPicker(h, 'ou_guest')
    setTempGroupOwner(new Error(`当前群的群主不属于机器人所在企业 (${SECRET_ID})`))

    const result = await onForkSelect(h.session, value.panelId, value.choiceId, 'ou_guest', EXTERNAL)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('分叉失败')
    expect(result.message).toContain('不属于机器人所在企业')
    expect(result.message).not.toContain(SECRET_ID)
    expect(h.createCalls).toHaveLength(0)
    expect(sentTexts.some(text => text.includes('正在分叉'))).toBe(false)
    expect(loggedEvents).toEqual(['session-temp: temp group owner lookup failed'])
  })
})

describe('bye in an external temp group', () => {
  test('stops the session and lets the bot leave after posting the owner notice; no member is removed', async () => {
    const h = makeHarness('project*修复登录')
    h.disbandResult = { ok: true, left: true }
    setExternalChat(h.session.chatId)
    setChatMembers(h.session.chatId, ['ou_guest', 'ou_member'])
    const members = spyOn(feishu, 'chatMemberOpenIds')
    const leave = spyOn(feishu, 'leaveChatForMember')
    try {
      await runByeCommand(h.session, 'ou_guest')

      expect(leave).not.toHaveBeenCalled()
      expect(members).not.toHaveBeenCalled()
    } finally {
      members.mockRestore()
      leave.mockRestore()
    }

    expect(externalChatChecks).toEqual(['oc_project*修复登录'])
    expect(leftChats).toEqual([])
    expect(h.disbandCalls.map(call => [call.chatName, call.chatId])).toEqual([['project*修复登录', 'oc_project*修复登录']])
    // 退群前已经发出「请群主在群设置里解散」的提示，退群后不再更新卡片。
    const before = h.disbandCalls[0]!.shownBefore
    expect(before).toHaveLength(1)
    expect(before[0]).toContain('正在停止会话')
    expect(before[0]).toContain('请群主在群设置里解散')
    expect(sentCards).toHaveLength(1)
    expect(updatedCards).toHaveLength(0)
  })

  test('a failed stop or leave patches the same notice with the reason', async () => {
    const h = makeHarness('project*修复登录')
    h.disbandResult = { ok: false, error: 'process still alive；无法确认 Session 已停止，未执行删群' }
    setExternalChat(h.session.chatId)

    await runByeCommand(h.session, 'ou_guest')

    expect(sentCards).toHaveLength(1)
    expect(updatedCards).toHaveLength(1)
    const last = finalCard()
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain('停止会话或退群失败')
    expect(JSON.stringify(last)).toContain('process still alive')
  })

  test('when the group type cannot be read, an error is shown and logged and nothing else happens', async () => {
    const h = makeHarness('project*修复登录')
    setExternalChatError(new Error('feishu chat.get failed code=232010 message=no permission log_id=chat-get-log'))
    setChatMembers(h.session.chatId, ['ou_guest'])
    const members = spyOn(feishu, 'chatMemberOpenIds')
    try {
      await runByeCommand(h.session, 'ou_guest')
      expect(members).not.toHaveBeenCalled()
    } finally {
      members.mockRestore()
    }

    expect(h.disbandCalls).toHaveLength(0)
    expect(leftChats).toHaveLength(0)
    expect(sentCards).toHaveLength(1)
    const last = sentCards[0] as any
    expect(last.header.template).toBe('red')
    expect(JSON.stringify(last)).toContain('读取群信息失败')
    expect(JSON.stringify(last)).toContain('232010')
    expect(JSON.stringify(last)).toContain('未执行退出或解散')
    expect(loggedEvents).toEqual(['session-temp: temp group type lookup failed'])
  })

  test('an internal temp group keeps the leave / last-member-disbands flow', async () => {
    const leaving = makeHarness('project*修复登录')
    setChatMembers(leaving.session.chatId, ['ou_guest', 'ou_member'])

    await runByeCommand(leaving.session, 'ou_guest')

    expect(externalChatChecks).toEqual(['oc_project*修复登录'])
    expect(leftChats).toEqual([['oc_project*修复登录', 'ou_guest']])
    expect(leaving.disbandCalls).toHaveLength(0)
    expect(JSON.stringify(finalCard())).toContain('**正在退出**')

    resetFeishuMock()
    const last = makeHarness('project*修复登录')
    setChatMembers(last.session.chatId, ['ou_guest'])

    await runByeCommand(last.session, 'ou_guest')

    expect(leftChats).toEqual([])
    expect(last.disbandCalls.map(call => [call.chatName, call.chatId])).toEqual([['project*修复登录', 'oc_project*修复登录']])
    expect(JSON.stringify(finalCard())).toContain('**正在解散**')
  })
})

describe('bye in an external temp group through the real runtime transaction', () => {
  /** Wires the real createTempSessionRuntime as the bye hook; the Feishu dep reports that the bot left. */
  function withRealRuntime(h: ReturnType<typeof makeHarness>, options: { cleanupFails?: boolean } = {}) {
    const events: string[] = []
    const registry = new Map<string, any>()
    const tempSession = {
      sessionName: h.session.sessionName,
      workDir: WORK_DIR,
      isRunning: () => false,
      applyConversationRouting: () => {},
      start: async () => true,
      startForked: async () => true,
      backendLabel: () => 'Codex',
      stop: async () => { events.push('stop') },
      dispose: () => { events.push('dispose') },
    }
    registry.set(h.session.chatId, tempSession)
    const runtime = createTempSessionRuntime<typeof tempSession>({
      registry,
      createSession: () => tempSession,
      ensureChatForSession: async () => { throw new Error('bye never creates a group') },
      disbandChatForSessionExact: async (_sessionName, chatId) => {
        events.push(`leave after ${shownCards().length} notice(s)`)
        return { chatId, disbanded: false, left: true }
      },
      chatIdForSession: () => h.session.chatId,
      clearSessionConversationState: () => {
        events.push('state:clear')
        if (options.cleanupFails) throw new Error('state file locked')
      },
      registerTempSessionLease: () => {},
      hasTempSessionLease: () => true,
      replaceTurnAnchors: () => {},
      log: () => {},
    })
    h.session.opts.onDisbandTempSession = runtime.disbandTempSession
    return { events, registry }
  }

  test('the session stops, the bot leaves after the notice, and local state is cleared', async () => {
    const h = makeHarness('project*修复登录')
    setExternalChat(h.session.chatId)
    const { events, registry } = withRealRuntime(h)

    await runByeCommand(h.session, 'ou_guest')

    expect(events).toEqual(['stop', 'leave after 1 notice(s)', 'dispose', 'state:clear'])
    expect(registry.has(h.session.chatId)).toBe(false)
    expect(sentCards).toHaveLength(1)
    expect(JSON.stringify(sentCards[0])).toContain('正在停止会话')
    expect(updatedCards).toHaveLength(0)
    expect(sentRawTexts).toEqual([])
    expect(loggedEvents).toEqual([])
  })

  test('a cleanup failure after the bot left is reported to the parent group and logged, not to the left group', async () => {
    const h = makeHarness('project*修复登录')
    setExternalChat(h.session.chatId)
    preferredChatForSession.set('project', 'oc_parent')
    withRealRuntime(h, { cleanupFails: true })
    const sent: Array<[string, any]> = []
    const send = spyOn(feishu, 'sendCard').mockImplementation(async (chatId: string, card: object) => {
      sent.push([chatId, card])
      return `om_${sent.length}`
    })
    try {
      await runByeCommand(h.session, 'ou_guest')
    } finally {
      send.mockRestore()
    }

    expect(sent.map(([chatId]) => chatId)).toEqual(['oc_project*修复登录', 'oc_parent'])
    expect(JSON.stringify(sent[0]![1])).toContain('正在停止会话')
    const report = sent[1]![1]
    expect(report.header.template).toBe('red')
    expect(report.header.title.content).toContain('project*修复登录')
    expect(JSON.stringify(report)).toContain('机器人已退出外部临时群，但本地状态清理失败: state file locked')
    // 不再尝试更新已退出群里的提示卡。
    expect(updatedCards).toHaveLength(0)
    expect(sentRawTexts).toEqual([])
    expect(loggedEvents).toEqual(['session-temp: external temp group cleanup failed after the bot left'])
  })

  test('without a resolvable parent group the failure only goes to the log', async () => {
    const h = makeHarness('project*修复登录')
    setExternalChat(h.session.chatId)
    withRealRuntime(h, { cleanupFails: true })

    await runByeCommand(h.session, 'ou_guest')

    expect(sentCards).toHaveLength(1)
    expect(updatedCards).toHaveLength(0)
    expect(sentRawTexts).toEqual([])
    expect(loggedEvents).toEqual(['session-temp: external temp group cleanup failed after the bot left'])
  })
})
