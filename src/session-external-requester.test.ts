import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { TurnAnchor } from './feishu'
import {
  branchBaseBySession,
  projectProfiles,
  resetFeishuMock,
  resolvedTempGroupOwners,
  sentCards,
  sentTexts,
  turnAnchorsBySession,
} from './feishu-test-mock'
import type { RequesterTenant } from './requester-tenant'

// feishu-test-mock 必须先注册，Session 才会拿到共享的 Feishu 替身。
const { Session } = await import('./session')
const worktree = await import('./worktree')

const EXTERNAL: RequesterTenant = { external: true, appTenantKey: 'tenant_app' }
const WORK_DIR = '/workspace/requester-project'

const sessions: Array<InstanceType<typeof Session>> = []
let createCalls: any[] = []

function realSession(): InstanceType<typeof Session> {
  projectProfiles.set('requester-project', { cwd: WORK_DIR })
  const session = new Session('requester-project', 'oc_requester_project', {
    onCreateTempSession: async input => {
      createCalls.push(input)
      return { ok: true }
    },
    onDisbandTempSession: async () => ({ ok: true }),
  })
  session.selectedProvider = 'codex'
  sessions.push(session)
  return session
}

function anchor(preview: string): TurnAnchor {
  return {
    checkpoint: {
      provider: 'codex',
      kind: 'turn',
      id: 'turn-1',
      source: { provider: 'codex', sessionId: 'root-thread', cwd: WORK_DIR },
    },
    preview,
    ts: Date.now(),
    writes: [],
  }
}

function pickerValue(card: any, preview: string): { panelId: string; choiceId: string } {
  for (const element of card?.body?.elements ?? []) {
    if (element?.tag !== 'column_set') continue
    if (!String(element.columns?.[0]?.elements?.[0]?.content ?? '').includes(preview)) continue
    const value = element.columns?.[1]?.elements?.[0]?.behaviors?.[0]?.value
    if (typeof value?.panel_id === 'string' && typeof value?.choice_id === 'string') {
      return { panelId: value.panel_id, choiceId: value.choice_id }
    }
  }
  throw new Error(`picker choice not found for preview: ${preview}`)
}

beforeEach(() => {
  resetFeishuMock()
  createCalls = []
})

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
})

describe('Session passes the requester tenant to the temp-group commands', () => {
  test('runCommand btw with an external requester reaches owner resolution', async () => {
    const session = realSession()

    expect(await session.runCommand('btw', 'ou_guest', 'om_btw', EXTERNAL)).toBe(true)

    expect(resolvedTempGroupOwners).toEqual([['oc_requester_project', 'ou_guest', 'tenant_app']])
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toMatchObject({
      chatName: 'requester-project*0000-0000',
      userOpenId: 'ou_guest',
      ownerOpenId: 'ou_group_owner',
      externalRequester: true,
    })
  })

  test('runCommand btw without a requester stays internal', async () => {
    const session = realSession()

    expect(await session.runCommand('btw', 'ou_member', 'om_btw')).toBe(true)

    expect(resolvedTempGroupOwners).toEqual([])
    expect(createCalls).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(createCalls[0], 'ownerOpenId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(createCalls[0], 'externalRequester')).toBe(false)
  })

  test('onForkSelect with an external requester reaches owner resolution', async () => {
    const session = realSession()
    turnAnchorsBySession.set('requester-project', [anchor('first-input')])
    branchBaseBySession.set('requester-project', { kind: 'fresh' })
    await session.showForkList('ou_guest')
    const value = pickerValue(sentCards[0], 'first-input')

    const result = await session.onForkSelect(value.panelId, value.choiceId, 'ou_guest', EXTERNAL)

    expect(result.ok).toBe(true)
    expect(resolvedTempGroupOwners).toEqual([['oc_requester_project', 'ou_guest', 'tenant_app']])
    expect(createCalls[0]).toMatchObject({ userOpenId: 'ou_guest', ownerOpenId: 'ou_group_owner', externalRequester: true })
  })

  test('wt <name> from an external requester is refused before any worktree or branch is created', async () => {
    const session = realSession()
    const ensure = spyOn(worktree, 'ensureProjectWorktree')
    const lock = spyOn(worktree, 'withProjectWorktreeLock')
    try {
      expect(await session.runCommand('wt feature-x', 'ou_guest', 'om_wt', EXTERNAL)).toBe(true)

      expect(ensure).not.toHaveBeenCalled()
      expect(lock).not.toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
      lock.mockRestore()
    }
    expect(sentTexts).toEqual(['❌ 外部联系人暂不支持 wt：飞书要求外部群由本企业成员当群主。请让本企业成员操作。'])
  })

  test('wt <name> from an internal requester still goes to the worktree flow', async () => {
    const session = realSession()
    const lock = spyOn(worktree, 'withProjectWorktreeLock').mockImplementation(async () => undefined as never)
    try {
      expect(await session.runCommand('wt feature-x', 'ou_member', 'om_wt')).toBe(true)
      expect(lock).toHaveBeenCalledTimes(1)
    } finally {
      lock.mockRestore()
    }
    expect(sentTexts.some(text => text.includes('外部联系人'))).toBe(false)
  })
})
