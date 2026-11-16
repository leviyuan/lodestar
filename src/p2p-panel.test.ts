import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  chatMemberChecks, preferredChatForSession, resetFeishuMock, sentCards, sentRawTexts,
  setChatMemberCheckError, setChatMembers, setChatOwners, setChatOwnersError,
} from './feishu-test-mock'
import type { AccountUsage } from './account-usage'
import type { ChatOwner } from './feishu'
import { FeishuRequestError } from './feishu-retry'
import { sanitizeSessionName } from './session-name'
import type { SysInfo } from './sysinfo'

const feishu = await import('./feishu')
const {
  P2P_LOOKUP_FAILED_NOTE, P2P_MEMBERSHIP_CONCURRENCY,
  anchoredOwnedGroups, buildP2pPanelCard, isDerivedSessionName, isP2pMessage, p2pSessionVisible, p2pViewerRestricted, replyP2pPanel,
} = await import('./p2p-panel')
type P2pPanelDeps = import('./p2p-panel').P2pPanelDeps
type P2pPanelSession = import('./p2p-panel').P2pPanelSession

/** The `restricted` argument: an internal member, or an external / unknown-tenant viewer. */
const INTERNAL = false
const RESTRICTED = true
// Real open_id shape: ou_ + 32 lowercase hex characters.
const REQUESTER = `ou_${'1a2b3c4d'.repeat(4)}`
const SOMEONE_ELSE = `ou_${'9f8e7d6c'.repeat(4)}`

const sysinfo: SysInfo = {
  cpu: { cores: 4, load1: 1.5, load5: 1, load15: 0.5 },
  mem: { totalBytes: 8 * 1024 ** 3, availBytes: 4 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, percent: 50 },
  disks: [],
  services: [],
  servicesError: null,
}
const usage: AccountUsage[] = [
  { id: 'glm', label: 'GLM Coding Plan', usage: { state: 'ok', kind: 'balance', balance: { remaining: 3, currency: 'CNY' }, windows: [] } },
]

/** A running session that records every property the panel touches beyond the four it may read. */
function fakeSession(name: string, chatId: string, account?: string, unexpected: string[] = []): P2pPanelSession {
  const target: Record<string, unknown> = {
    sessionName: name,
    chatId,
    peerSnapshot: () => ({
      name, status: 'idle' as const, uptimeMs: 120_000,
      ...(account ? { codexAccountName: account } : {}),
    }),
    workload: async () => ({ background: 0, subagents: 0 }),
  }
  return new Proxy(target, {
    get(object, key) {
      if (typeof key === 'string' && !(key in object) && key !== 'then') unexpected.push(key)
      return object[key as string]
    },
  }) as unknown as P2pPanelSession
}

interface Harness {
  deps: P2pPanelDeps
  calls: string[]
  memberChecks: Array<[string, string]>
  cards: any[]
}

function harness(opts: {
  sessions: P2pPanelSession[]
  owners?: ChatOwner[] | Error
  /** Session name -> its persisted chat binding (`boundChatIdForSession`). */
  bindings?: Record<string, string>
  members?: Record<string, string[]>
  memberErrors?: Record<string, unknown>
  sendCard?: P2pPanelDeps['sendCard']
  deadlineMs?: number
  /** A lookup is recorded when it is issued, then waits here before answering (a stalled request). */
  ownersGate?: Promise<unknown>
  memberGate?: Promise<unknown>
}): Harness {
  const calls: string[] = []
  const memberChecks: Array<[string, string]> = []
  const cards: any[] = []
  const deps: P2pPanelDeps = {
    runningSessions: () => { calls.push('runningSessions'); return opts.sessions },
    listChatOwners: async () => {
      calls.push('listChatOwners')
      await opts.ownersGate
      if (opts.owners instanceof Error) throw opts.owners
      return opts.owners ?? []
    },
    isChatMember: async (chatId, openId) => {
      calls.push('isChatMember')
      memberChecks.push([chatId, openId])
      await opts.memberGate
      const error = opts.memberErrors?.[chatId]
      if (error) throw error
      return (opts.members?.[chatId] ?? []).includes(openId)
    },
    boundChatIdForSession: name => { calls.push('boundChatIdForSession'); return opts.bindings?.[name] ?? null },
    readAllAccountUsage: async () => { calls.push('readAllAccountUsage'); return usage },
    readSysInfo: async () => { calls.push('readSysInfo'); return sysinfo },
    sendCard: opts.sendCard ?? (async (_chatId, card) => { calls.push('sendCard'); cards.push(card); return 'om_card' }),
    sendTextRaw: async (_chatId, text) => { calls.push(`sendTextRaw:${text}`); return 'om_text' },
    ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
  }
  return { deps, calls, memberChecks, cards }
}

function rows(card: any): string[] {
  const projects = card.body.elements.find((element: any) => element.element_id === 'console_projects')
  const content: string = projects.elements[0].content
  return content === '_无_' ? [] : content.split('\n')
}

function names(card: any): string[] {
  return rows(card).map(row => row.match(/`([^`]+)`/)![1])
}

function elementIds(card: any): unknown[] {
  return card.body.elements.map((element: any) => element.element_id)
}

/** How the SDK transport rethrows an HTTP 400 business rejection. */
function sdkRejection(code: number, msg: string): Error {
  return Object.assign(new Error(`code=${code} message=${msg} log_id=log-x`), {
    response: { status: 400, data: { code, msg } },
  })
}

describe('1:1 visibility rule', () => {
  test('an anchored owned group covers its own chat, its temp groups and its worktree groups only', () => {
    const groups = anchoredOwnedGroups([{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }], REQUESTER,
      name => name === 'foo' ? 'oc_foo' : null)
    expect(groups).toEqual([{ chatId: 'oc_foo', sessionName: 'foo' }])
    const visible = (sessionName: string, chatId: string) => p2pSessionVisible({ sessionName, chatId }, groups, false)
    expect(visible('foo', 'oc_foo')).toBe(true)
    // Same name in another chat: not this group's session.
    expect(visible('foo', 'oc_other_foo')).toBe(false)
    expect(visible('foo*x', 'oc_foo_x')).toBe(true)
    expect(visible('foo[b]', 'oc_foo_b')).toBe(true)
    expect(visible('foo[b]*x', 'oc_foo_b_x')).toBe(true)
    expect(visible('foo-bar', 'oc_foo_bar')).toBe(false)
    expect(visible('foobar', 'oc_foobar')).toBe(false)
    expect(isDerivedSessionName('foo*x', '')).toBe(false)
  })

  test('a group only counts when its project name is bound to that very chat', () => {
    // Real group-name to project-name mapping: these all collide with existing projects.
    const long = 'p'.repeat(64)
    expect(sanitizeSessionName('foo bar')).toBe('foo_bar')
    expect(sanitizeSessionName('foo.bar')).toBe('foo_bar')
    expect(sanitizeSessionName('アイウ')).toBe('___')
    expect(sanitizeSessionName('テスト')).toBe('___')
    expect(sanitizeSessionName(`${long}-tail`)).toBe(long)
    const bindings: Record<string, string> = {
      foo: 'oc_real_foo', foo_bar: 'oc_real_foo_bar', ___: 'oc_real_kana', [long]: 'oc_real_long', my_proj: 'oc_my_proj',
    }
    const owners: ChatOwner[] = [
      { chatId: 'oc_my_dup', name: 'foo', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_space', name: 'foo bar', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_dot', name: 'foo.bar', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_kana', name: 'アイウ', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_long', name: `${long}-tail`, ownerOpenId: REQUESTER },
      { chatId: 'oc_unbound', name: 'nobody-bound-me', ownerOpenId: REQUESTER },
      { chatId: 'oc_real_foo', name: 'foo', ownerOpenId: SOMEONE_ELSE },
      { chatId: 'oc_bot', name: 'bot-owned', ownerOpenId: null },
      // A legitimately owned group whose name needs sanitising still anchors.
      { chatId: 'oc_my_proj', name: 'my proj', ownerOpenId: REQUESTER },
    ]
    expect(anchoredOwnedGroups(owners, REQUESTER, name => bindings[name] ?? null))
      .toEqual([{ chatId: 'oc_my_proj', sessionName: 'my_proj' }])
    expect(anchoredOwnedGroups(owners, '', name => bindings[name] ?? null)).toEqual([])
  })

  test('owning a temp group shows that group but not its parent project', () => {
    const groups = anchoredOwnedGroups([{ chatId: 'oc_foo_x', name: 'foo*x', ownerOpenId: REQUESTER }], REQUESTER,
      name => name === 'foo*x' ? 'oc_foo_x' : null)
    expect(p2pSessionVisible({ sessionName: 'foo*x', chatId: 'oc_foo_x' }, groups, false)).toBe(true)
    expect(p2pSessionVisible({ sessionName: 'foo', chatId: 'oc_foo' }, groups, false)).toBe(false)
    expect(p2pSessionVisible({ sessionName: 'foo*y', chatId: 'oc_foo_y' }, groups, false)).toBe(false)
  })

  test('membership alone is enough, and nothing else is', () => {
    expect(p2pSessionVisible({ sessionName: 'bar', chatId: 'oc_bar' }, [], true)).toBe(true)
    expect(p2pSessionVisible({ sessionName: 'bar', chatId: 'oc_bar' }, [], false)).toBe(false)
  })

  test('only 1:1 chat events are routed to the panel', () => {
    expect(isP2pMessage({ chat_type: 'p2p', chat_id: 'oc_p2p' })).toBe(true)
    expect(isP2pMessage({ chat_type: 'group' })).toBe(false)
    expect(isP2pMessage({ chat_id: 'oc_group' })).toBe(false)
    expect(isP2pMessage(null)).toBe(false)
    expect(isP2pMessage(undefined)).toBe(false)
  })

  test('the 1:1 panel shows internal details only to a confirmed same-tenant sender', () => {
    expect(p2pViewerRestricted({ sender: { tenant_key: 't1' }, tenant_key: 't1' })).toBe(false)
    expect(p2pViewerRestricted({ event: { sender: { tenant_key: 't1' } }, header: { tenant_key: 't1' } })).toBe(false)
    expect(p2pViewerRestricted({ sender: { tenant_key: 't2' }, tenant_key: 't1' })).toBe(true)
    // Unknown on either side fails closed.
    expect(p2pViewerRestricted({ sender: {}, tenant_key: 't1' })).toBe(true)
    expect(p2pViewerRestricted({ sender: { tenant_key: 't1' } })).toBe(true)
    expect(p2pViewerRestricted({ sender: { tenant_key: ' ' }, tenant_key: ' ' })).toBe(true)
    expect(p2pViewerRestricted(undefined)).toBe(true)
  })
})

describe('1:1 panel builder', () => {
  test('an internal owner sees the anchored project and its associated groups, with accounts, host and quota', async () => {
    const sessions = [
      fakeSession('foo', 'oc_foo', '工作订阅'),
      fakeSession('foo*x', 'oc_foo_x'),
      fakeSession('foo[b]', 'oc_foo_b'),
      fakeSession('foo[b]*x', 'oc_foo_b_x'),
      fakeSession('foo-bar', 'oc_foo_bar'),
      fakeSession('my_proj', 'oc_my_proj'),
      fakeSession('elsewhere', 'oc_elsewhere'),
      fakeSession('member-only', 'oc_member_only', '备用'),
    ]
    const h = harness({
      sessions,
      owners: [
        { chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER },
        { chatId: 'oc_my_proj', name: 'my proj', ownerOpenId: REQUESTER },
        { chatId: 'oc_foo_bar', name: 'foo-bar', ownerOpenId: SOMEONE_ELSE },
        { chatId: 'oc_bot', name: 'elsewhere', ownerOpenId: null },
      ],
      bindings: { foo: 'oc_foo', my_proj: 'oc_my_proj', 'foo-bar': 'oc_foo_bar' },
      members: { oc_member_only: [REQUESTER] },
    })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any

    expect(names(card)).toEqual(['foo', 'foo*x', 'foo[b]', 'foo[b]*x', 'my_proj', 'member-only'])
    expect(rows(card)[0]).toBe('　· 🟢 `foo` · 闲 · 2m · Codex：`工作订阅`')
    expect(rows(card)[5]).toContain('Codex：`备用`')
    // Membership is only asked for the sessions ownership did not already cover.
    expect(h.memberChecks).toEqual([
      ['oc_foo_bar', REQUESTER], ['oc_elsewhere', REQUESTER], ['oc_member_only', REQUESTER],
    ])
    expect(h.calls.filter(call => call === 'listChatOwners')).toHaveLength(1)
    expect(elementIds(card)).toEqual(['console_projects', 'console_host', 'console_usage', undefined])
    expect(JSON.stringify(card)).toContain('GLM Coding Plan')
    expect(JSON.stringify(card)).not.toContain(P2P_LOOKUP_FAILED_NOTE)
  })

  test('owning a same-named or colliding group reveals nothing (name-spoof regression)', async () => {
    const running = [
      fakeSession('foo', 'oc_real_foo', 'acct-foo'),
      fakeSession('foo*fix', 'oc_real_foo_tmp'),
      fakeSession('foo[b]', 'oc_real_foo_wt'),
      fakeSession('foo_bar', 'oc_real_foo_dot_bar'),
      fakeSession('___', 'oc_real_kana'),
    ]
    const owners: ChatOwner[] = [
      { chatId: 'oc_my_dup', name: 'foo', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_space', name: 'foo bar', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_kana', name: 'ペン', ownerOpenId: SOMEONE_ELSE },
      { chatId: 'oc_my_kana2', name: 'ねこ犬', ownerOpenId: REQUESTER },
      { chatId: 'oc_my_kana3', name: 'アイウ', ownerOpenId: REQUESTER },
    ]
    // The projects stay bound to their real groups; with no binding at all nothing anchors either.
    const bindingSets: Array<Record<string, string>> = [{ foo: 'oc_real_foo', foo_bar: 'oc_real_foo_dot_bar', ___: 'oc_real_kana' }, {}]
    for (const bindings of bindingSets) {
      for (const restricted of [INTERNAL, RESTRICTED]) {
        const h = harness({ sessions: running, owners, bindings })
        const card = await buildP2pPanelCard(REQUESTER, restricted, h.deps) as any
        expect(rows(card)).toEqual([])
        expect(JSON.stringify(card)).not.toContain(P2P_LOOKUP_FAILED_NOTE)
        expect(h.memberChecks.map(([chatId]) => chatId)).toEqual(running.map(session => session.chatId))
      }
    }
  })

  test('a duplicate group of an owned project does not show the other chat\'s session', async () => {
    const h = harness({
      sessions: [fakeSession('foo', 'oc_foo'), fakeSession('foo', 'oc_other_foo'), fakeSession('foo*x', 'oc_foo_x')],
      owners: [{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }],
      bindings: { foo: 'oc_foo' },
    })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any
    expect(names(card)).toEqual(['foo', 'foo*x'])
    expect(h.memberChecks).toEqual([['oc_other_foo', REQUESTER]])
  })

  test('an external requester gets no account names, quota or host data', async () => {
    const unexpected: string[] = []
    const h = harness({
      sessions: [fakeSession('foo', 'oc_foo', '工作订阅', unexpected), fakeSession('bar', 'oc_bar', '备用', unexpected)],
      owners: [{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }],
      bindings: { foo: 'oc_foo' },
      members: { oc_bar: [REQUESTER] },
    })
    const card = await buildP2pPanelCard(REQUESTER, RESTRICTED, h.deps) as any

    expect(rows(card)).toEqual(['　· 🟢 `foo` · 闲 · 2m', '　· 🟢 `bar` · 闲 · 2m'])
    expect(elementIds(card)).toEqual(['console_projects', undefined])
    expect(h.calls).not.toContain('readAllAccountUsage')
    expect(h.calls).not.toContain('readSysInfo')
    const body = JSON.stringify(card)
    for (const hidden of ['工作订阅', '备用', 'Codex：', '主机', '全部账号额度', 'GLM']) expect(body).not.toContain(hidden)
    expect(unexpected).toEqual([])
  })

  test('a failed membership lookup hides only that row and says so', async () => {
    const h = harness({
      sessions: [fakeSession('alpha', 'oc_alpha'), fakeSession('beta', 'oc_beta'), fakeSession('gamma', 'oc_gamma')],
      members: { oc_alpha: [REQUESTER], oc_beta: [REQUESTER], oc_gamma: [REQUESTER] },
      memberErrors: { oc_beta: sdkRejection(99991400, 'request trigger frequency limit chat oc_beta') },
    })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any

    expect(names(card)).toEqual(['alpha', 'gamma'])
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: P2P_LOOKUP_FAILED_NOTE })
    // The note never carries the failing group's identity.
    expect(JSON.stringify(card)).not.toContain('oc_beta')
    expect(JSON.stringify(card)).not.toContain('beta')
  })

  test('a gone chat or a bot no longer in it counts as not a member, without the note', async () => {
    const sessions = [
      fakeSession('alpha', 'oc_alpha'), fakeSession('invalid', 'oc_invalid'),
      fakeSession('dissolved', 'oc_dissolved'), fakeSession('bot-left', 'oc_bot_left'),
    ]
    const gone = {
      oc_invalid: sdkRejection(232006, 'Your request specifies a chat_id which is invalid.'),
      oc_dissolved: new FeishuRequestError('feishu chatMembers.get failed code=232009', 400, 232009),
      oc_bot_left: sdkRejection(232011, 'Operator can NOT be out of the chat.'),
    }
    const quiet = harness({ sessions, members: { oc_alpha: [REQUESTER] }, memberErrors: gone })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, quiet.deps) as any
    expect(names(card)).toEqual(['alpha'])
    expect(JSON.stringify(card)).not.toContain(P2P_LOOKUP_FAILED_NOTE)

    // Any other rejection, e.g. another tenant's chat, still hides the row with the note.
    const noisy = harness({
      sessions: [...sessions, fakeSession('foreign', 'oc_foreign')],
      members: { oc_alpha: [REQUESTER] },
      memberErrors: { ...gone, oc_foreign: sdkRejection(232010, 'Operator and chat can NOT be in different tenants.') },
    })
    const noted = await buildP2pPanelCard(REQUESTER, INTERNAL, noisy.deps) as any
    expect(names(noted)).toEqual(['alpha'])
    expect(noted.body.elements[0].content).toBe(P2P_LOOKUP_FAILED_NOTE)
  })

  test('a failed owner list still checks membership and adds the note', async () => {
    const h = harness({
      sessions: [fakeSession('foo', 'oc_foo'), fakeSession('foo*x', 'oc_foo_x')],
      owners: new Error('chat.list failed'),
      bindings: { foo: 'oc_foo' },
      members: { oc_foo: [REQUESTER] },
    })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any

    expect(names(card)).toEqual(['foo'])
    expect(h.memberChecks.map(([chatId]) => chatId)).toEqual(['oc_foo', 'oc_foo_x'])
    expect(card.body.elements[0].content).toBe(P2P_LOOKUP_FAILED_NOTE)
  })

  test('an empty list renders without any lookup', async () => {
    const h = harness({ sessions: [] })
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any

    expect(rows(card)).toEqual([])
    expect(card.body.elements[0].header.title.content).toBe('🗂 活跃项目 (0)')
    expect(card.body.elements[0].elements[0].content).toBe('_无_')
    expect(h.calls).not.toContain('listChatOwners')
    expect(h.calls).not.toContain('isChatMember')
  })

  test('an unknown sender sees no project and the note', async () => {
    const h = harness({ sessions: [fakeSession('foo', 'oc_foo')], members: { oc_foo: [''] } })
    const card = await buildP2pPanelCard('', INTERNAL, h.deps) as any

    expect(rows(card)).toEqual([])
    expect(card.body.elements[0].content).toBe(P2P_LOOKUP_FAILED_NOTE)
    expect(h.calls).not.toContain('listChatOwners')
    expect(h.calls).not.toContain('isChatMember')
  })

  test('membership lookups run with bounded concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const sessions = Array.from({ length: 10 }, (_, index) => fakeSession(`p${index}`, `oc_p${index}`))
    const h = harness({ sessions })
    h.deps.isChatMember = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight--
      return true
    }
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any

    expect(names(card)).toEqual(sessions.map(session => session.sessionName))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(P2P_MEMBERSHIP_CONCURRENCY)
  })

  test('host and quota failures stay visible as MISS for an internal requester', async () => {
    const h = harness({ sessions: [] })
    h.deps.readAllAccountUsage = async () => { throw new Error('usage cache unavailable') }
    h.deps.readSysInfo = async () => { throw new Error('ps failed') }
    const card = await buildP2pPanelCard(REQUESTER, INTERNAL, h.deps) as any
    const body = JSON.stringify(card)
    expect(body).toContain('**负载**　MISS')
    expect(body).toContain('usage cache unavailable')
  })
})

describe('1:1 reply', () => {
  test('replies with exactly one card and touches nothing but reads', async () => {
    const unexpected: string[] = []
    const h = harness({
      sessions: [fakeSession('foo', 'oc_foo', undefined, unexpected)],
      owners: [{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }],
      bindings: { foo: 'oc_foo' },
    })
    await replyP2pPanel('oc_p2p', REQUESTER, INTERNAL, h.deps)

    expect(h.calls).toEqual(['runningSessions', 'listChatOwners', 'boundChatIdForSession', 'readAllAccountUsage', 'readSysInfo', 'sendCard'])
    // The session objects are only read: no start, stop, command or binding call reaches them.
    expect(unexpected).toEqual([])
  })

  test('an event without both tenant keys gets the restricted panel', async () => {
    const h = harness({
      sessions: [fakeSession('foo', 'oc_foo', '工作订阅')],
      members: { oc_foo: [REQUESTER] },
    })
    await replyP2pPanel('oc_p2p', REQUESTER, p2pViewerRestricted({ sender: { sender_id: { open_id: REQUESTER } }, tenant_key: 'tenant_app' }), h.deps)

    expect(h.cards).toHaveLength(1)
    expect(elementIds(h.cards[0])).toEqual(['console_projects', undefined])
    expect(rows(h.cards[0])).toEqual(['　· 🟢 `foo` · 闲 · 2m'])
    expect(h.calls).not.toContain('readAllAccountUsage')
    expect(h.calls).not.toContain('readSysInfo')
  })

  test('a stalled lookup is cut off at the deadline with a fail-closed reply and no further reads', async () => {
    for (const stall of ['owners', 'membership'] as const) {
      for (const restricted of [INTERNAL, RESTRICTED]) {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const h = harness({
          sessions: [fakeSession('foo', 'oc_foo', '工作订阅'), fakeSession('bar', 'oc_bar'), fakeSession('baz', 'oc_baz')],
          owners: [{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }],
          bindings: { foo: 'oc_foo' },
          members: { oc_bar: [REQUESTER], oc_baz: [REQUESTER] },
          deadlineMs: 20,
          ...(stall === 'owners' ? { ownersGate: gate } : { memberGate: gate }),
        })

        const started = Date.now()
        await replyP2pPanel('oc_p2p', REQUESTER, restricted, h.deps)
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(h.cards).toHaveLength(1)
        const card = h.cards[0]
        expect(rows(card)).toEqual([])
        expect(card.body.elements[0].content).toBe(restricted ? P2P_LOOKUP_FAILED_NOTE : `${P2P_LOOKUP_FAILED_NOTE}：读取超时`)
        expect(elementIds(card)).toEqual([undefined, 'console_projects', undefined])
        expect(JSON.stringify(card)).not.toContain('工作订阅')

        // Once the stalled request answers, the abandoned build issues nothing more:
        // no further owner or membership lookup, no quota or host read, no second message.
        const issuedAtReply = [...h.calls]
        release()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(h.calls).toEqual(issuedAtReply)
        expect(h.cards).toHaveLength(1)
      }
    }
  })

  test('after a stall the next message shares the lookup cap with the abandoned build', async () => {
    let inFlight = 0
    let peak = 0
    // 0: first message pending, 1: first replied, 2: second replied.
    let phase = 0
    const issued: Array<{ chatId: string; phase: number }> = []
    const groups = (prefix: string) => Array.from({ length: 24 }, (_, index) => fakeSession(`${prefix}${index}`, `oc_${prefix}${index}`))
    const first = groups('p')
    const second = groups('q')
    // Both messages use the daemon's single dependency set, as in production.
    const h = harness({ sessions: [], deadlineMs: 30 })
    let message = 0
    h.deps.runningSessions = () => (message++ === 0 ? first : second)
    h.deps.isChatMember = async chatId => {
      issued.push({ chatId, phase })
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 40))
      inFlight--
      return false
    }

    await replyP2pPanel('oc_p2p', REQUESTER, INTERNAL, h.deps)
    phase = 1
    await replyP2pPanel('oc_p2p', REQUESTER, INTERNAL, h.deps)
    phase = 2
    // Let every request that was already in flight finish.
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(issued.filter(call => call.chatId.startsWith('oc_p') && call.phase > 0)).toEqual([])
    expect(issued.filter(call => call.phase > 1)).toEqual([])
    expect(issued.filter(call => call.chatId.startsWith('oc_p')).length).toBeLessThanOrEqual(P2P_MEMBERSHIP_CONCURRENCY)
    expect(peak).toBeLessThanOrEqual(P2P_MEMBERSHIP_CONCURRENCY)
    expect(h.cards).toHaveLength(2)
    for (const card of h.cards) expect(rows(card)).toEqual([])
  })

  test('a card send failure falls back to text with the diagnostics but no member ids', async () => {
    const hidden = `ou_${'0a1b2c3d'.repeat(4)}`
    const h = harness({
      sessions: [],
      sendCard: async (_chatId, _card, onFailure) => {
        onFailure?.({ code: 230013, msg: `bot is invisible to user ids: [${hidden}]`, error: { log_id: 'log-p2p' } })
        return null
      },
    })
    await replyP2pPanel('oc_p2p', REQUESTER, INTERNAL, h.deps)

    const text = h.calls.find(call => call.startsWith('sendTextRaw:'))!
    expect(text).toContain('❌ 面板发送失败')
    expect(text).toContain('code=230013')
    expect(text).toContain('log_id=log-p2p')
    expect(text).not.toContain(hidden)
  })

  test('a build failure tells an internal requester why and a restricted one only that it failed', async () => {
    // Redaction recognises the real open_id shape: ou_ + 32 lowercase hex characters.
    const leaked = `ou_${'5e6f7a8b'.repeat(4)}`
    for (const [restricted, expected] of [
      [INTERNAL, '❌ 面板生成失败：snapshot broke for …'],
      [RESTRICTED, '❌ 面板生成失败'],
    ] as const) {
      const broken = fakeSession('foo', 'oc_foo')
      ;(broken as any).peerSnapshot = () => { throw new Error(`snapshot broke for ${leaked}`) }
      const h = harness({ sessions: [broken], members: { oc_foo: [REQUESTER] } })
      await replyP2pPanel('oc_p2p', REQUESTER, restricted, h.deps)
      expect(h.calls.filter(call => call.startsWith('sendTextRaw:'))).toEqual([`sendTextRaw:${expected}`])
      expect(h.calls).not.toContain('sendCard')
    }
  })
})

describe('1:1 panel with the Feishu helpers', () => {
  beforeEach(() => { resetFeishuMock() })

  function feishuDeps(sessions: P2pPanelSession[]): P2pPanelDeps {
    return {
      runningSessions: () => sessions,
      listChatOwners: feishu.listChatOwners,
      isChatMember: feishu.isChatMember,
      boundChatIdForSession: feishu.boundChatIdForSession,
      readAllAccountUsage: async () => usage,
      readSysInfo: async () => sysinfo,
      sendCard: feishu.sendCard,
      sendTextRaw: feishu.sendTextRaw,
    }
  }

  test('owner list and live membership come from the helpers, and the card goes out once', async () => {
    setChatOwners([{ chatId: 'oc_foo', name: 'foo', ownerOpenId: REQUESTER }])
    preferredChatForSession.set('foo', 'oc_foo')
    setChatMembers('oc_bar', [REQUESTER])
    setChatMembers('oc_baz', [SOMEONE_ELSE])
    setChatMemberCheckError('oc_qux', new Error('chatMembers.get failed'))
    const sessions = [fakeSession('foo[b]', 'oc_foo_b'), fakeSession('bar', 'oc_bar'), fakeSession('baz', 'oc_baz'), fakeSession('qux', 'oc_qux')]
    await replyP2pPanel('oc_p2p', REQUESTER, RESTRICTED, feishuDeps(sessions))

    expect(chatMemberChecks).toEqual([['oc_bar', REQUESTER], ['oc_baz', REQUESTER], ['oc_qux', REQUESTER]])
    expect(sentCards).toHaveLength(1)
    expect(names(sentCards[0])).toEqual(['foo[b]', 'bar'])
    expect((sentCards[0] as any).body.elements[0].content).toBe(P2P_LOOKUP_FAILED_NOTE)
    expect(sentRawTexts).toEqual([])
  })

  test('a failing owner list is reported as hidden rows, not as an error', async () => {
    setChatOwnersError(new Error('chat.list failed'))
    setChatMembers('oc_bar', [REQUESTER])
    await replyP2pPanel('oc_p2p', REQUESTER, INTERNAL, feishuDeps([fakeSession('bar', 'oc_bar')]))

    expect(names(sentCards[0])).toEqual(['bar'])
    expect((sentCards[0] as any).body.elements[0].content).toBe(P2P_LOOKUP_FAILED_NOTE)
    expect(sentRawTexts).toEqual([])
  })
})

describe('1:1 panel modules', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))

  // Only types and pure helpers may be imported, so the panel cannot reach sessions, Feishu or state.
  test.each([
    ['src/p2p-panel.ts', ['./cards/p2p', './feishu-errors', './log', './session-name']],
    ['src/cards/p2p.ts', ['./console']],
  ])('%s imports nothing stateful', (file, allowed) => {
    const text = readFileSync(join(root, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const valueImports: string[] = []
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        const bindings = clause?.namedBindings
        const typeOnly = clause?.isTypeOnly === true || (!!clause && !clause.name && !!bindings
          && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly))
        if (!typeOnly) valueImports.push((statement.moduleSpecifier as ts.StringLiteral).text)
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        valueImports.push((statement.moduleSpecifier as ts.StringLiteral).text)
      }
    }
    expect([...new Set(valueImports)].sort()).toEqual([...allowed].sort())
    expect(text).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })
})

describe('daemon routing for 1:1 chats', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const source = ts.createSourceFile('daemon.ts', readFileSync(join(root, 'daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true)

  // daemon.ts boots the service on import, so its routing is checked structurally:
  // the 1:1 branch must answer and return before anything creates, binds or records state.
  test('answers before any session, chat binding, debug context or activity write', () => {
    const handler = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'handleMessage')
    const statements = [...handler!.body!.statements]
    const route = statements.findIndex(statement => ts.isIfStatement(statement)
      && statement.expression.getText(source) === 'isP2pMessage(message)')
    expect(route).toBeGreaterThan(-1)
    const branch = (statements[route] as ts.IfStatement).thenStatement as ts.Block
    expect(branch.statements.map(statement => statement.getText(source))).toEqual([
      'await replyP2pPanel(chatId, userOpenId, p2pViewerRestricted(data), p2pPanelDeps)',
      'return',
    ])
    const first = (pattern: RegExp) => statements.findIndex(statement => pattern.test(statement.getText(source)))
    expect(first(/seenMessageIds\.has\(/)).toBeLessThan(route)
    expect(first(/isStaleAtReceipt\(/)).toBeLessThan(route)
    for (const pattern of [
      /\[DEBUG\]/, /writeJsonStateAtomic\(/, /refreshChatList\(/, /fetchChatName\(/, /bindSessionToChat\(/,
      /sessionFor\(/, /recordUserMessage\(/, /runCommand\(/, /downloadAttachment\(/,
    ]) {
      expect(first(pattern)).toBeGreaterThan(route)
    }
  })

  test('the panel is wired only to read-only helpers and senders', () => {
    const declaration = source.statements
      .flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
      .find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === 'p2pPanelDeps')
    const initializer = declaration?.initializer
    expect(initializer && ts.isObjectLiteralExpression(initializer)).toBe(true)
    const wiring = Object.fromEntries((initializer as ts.ObjectLiteralExpression).properties.map(property => [
      property.name!.getText(source),
      ts.isPropertyAssignment(property) ? property.initializer.getText(source) : property.getText(source),
    ]))
    expect(wiring).toEqual({
      runningSessions: '() => [...Session.all].filter(session => session.isRunning())',
      listChatOwners: 'feishu.listChatOwners',
      isChatMember: 'feishu.isChatMember',
      boundChatIdForSession: 'feishu.boundChatIdForSession',
      readAllAccountUsage: 'readAllAccountUsage',
      readSysInfo: 'readSysInfo',
      sendCard: 'feishu.sendCard',
      sendTextRaw: 'feishu.sendTextRaw',
    })
  })
})
