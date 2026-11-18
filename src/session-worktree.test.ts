import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  botLeftChats,
  chatIdsByName,
  disbandedChats,
  ensuredWorktreeChats,
  externalChatChecks,
  normalChatLookups,
  projectProfiles,
  resetFeishuMock,
  resolvedTempGroupOwners,
  sentTexts,
  setExternalChat,
  setExternalChatError,
} from './feishu-test-mock'
import type { RequesterTenant } from './requester-tenant'

// feishu-test-mock 必须先注册，session-worktree 才会拿到共享的 Feishu 替身。
const { onWorktreeDisband, runWorktreeCommand } = await import('./session-worktree')
const worktree = await import('./worktree')
const EXTERNAL: RequesterTenant = { external: true, appTenantKey: 'tenant_app' }

let roots: string[] = []

beforeEach(() => {
  resetFeishuMock()
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-wt-disband-')))
  roots.push(root)
  const repo = join(root, 'feishu')
  mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'init'])
  git(repo, ['branch', '-M', 'main'])
  return { root, repo }
}

interface Harness {
  session: any
  tempCalls: Array<[string, string]>
  running: Set<string>
}

function harness(repo: string, options: { failTemp?: string; leftTemp?: string } = {}): Harness {
  // session-worktree 通过 feishu.resolveProjectDir 找项目目录，替身这里指向真实仓库。
  projectProfiles.set('feishu', { cwd: repo })
  const tempCalls: Array<[string, string]> = []
  const running = new Set<string>()
  const session: any = {
    sessionName: 'feishu',
    chatId: 'oc_main',
    workDir: repo,
    backendLabel: () => 'Codex',
    hasRunningPeerSession: (name: string) => running.has(name),
    opts: {
      onDisbandTempSession: async (chatName: string, chatId: string) => {
        if (options.failTemp === chatName) return { ok: false, error: 'lease 校验失败' }
        tempCalls.push([chatName, chatId])
        chatIdsByName.delete(chatName)
        // 外部临时群：机器人只能退群，群本身留给群主。
        return options.leftTemp === chatName ? { ok: true, left: true } : { ok: true }
      },
    },
  }
  return { session, tempCalls, running }
}

describe('worktree disband cascades to its temp groups', () => {
  test('disbands every temp group of that worktree before removing the directory', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    chatIdsByName.set(`${chatName}*修复登录`, ['oc_temp_a'])
    chatIdsByName.set(`${chatName}*0821-1337`, ['oc_temp_b'])
    chatIdsByName.set('feishu*修复登录', ['oc_main_temp'])
    const h = harness(repo)

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(true)
    expect(h.tempCalls).toEqual([
      [`${chatName}*0821-1337`, 'oc_temp_b'],
      [`${chatName}*修复登录`, 'oc_temp_a'],
    ])
    expect(disbandedChats).toEqual([chatName])
    expect(result.message).toContain('临时群 2 个已解散')
    expect(result.message).toContain('dir removed')
    // 主项目下的临时群不受影响，也不会被解散。
    expect(h.tempCalls.some(([name]) => name === 'feishu*修复登录')).toBe(false)
  })

  test('an external temp group the bot could only leave is reported separately, not as disbanded', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    chatIdsByName.set(`${chatName}*修复登录`, ['oc_temp_a'])
    chatIdsByName.set(`${chatName}*0821-1337`, ['oc_temp_b'])
    const h = harness(repo, { leftTemp: `${chatName}*修复登录` })

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(true)
    expect(h.tempCalls).toHaveLength(2)
    expect(result.message).toContain('临时群 1 个已解散')
    expect(result.message).toContain('外部临时群 1 个机器人已退出，请群主手动解散')
    expect(result.message).not.toContain('无临时群')
  })

  test('refuses while a temp group session is still running and keeps everything', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    chatIdsByName.set(`${chatName}*修复登录`, ['oc_temp_a'])
    const h = harness(repo)
    h.running.add(`${chatName}*修复登录`)

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('临时群还在运行')
    expect(h.tempCalls).toEqual([])
    expect(disbandedChats).toEqual([])
  })

  test('stops at the first temp group that cannot be disbanded and reports it', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    chatIdsByName.set(`${chatName}*0821-1337`, ['oc_temp_a'])
    chatIdsByName.set(`${chatName}*修复登录`, ['oc_temp_b'])
    const h = harness(repo, { failTemp: `${chatName}*0821-1337` })

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('临时群')
    expect(result.message).toContain('lease 校验失败')
    // 没有删除 worktree 群，也没有删除目录。
    expect(disbandedChats).toEqual([])
    expect(worktree.listProjectWorktrees(repo, 'feishu').some(entry => entry.slug === 'feature' && entry.mounted)).toBe(true)
  })

  test('refuses ambiguous duplicate temp group names instead of guessing', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    chatIdsByName.set(`${chatName}*修复登录`, ['oc_temp_a', 'oc_temp_b'])
    const h = harness(repo)

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('临时群重名')
    expect(h.tempCalls).toEqual([])
    expect(disbandedChats).toEqual([])
  })

  test('removes a worktree without temp groups exactly as before', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    const h = harness(repo)

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(true)
    expect(h.tempCalls).toEqual([])
    expect(result.message).toContain('无临时群')
    expect(disbandedChats).toEqual([chatName])
  })

  test('an external WT group is left by the bot for its owner; the directory is still removed', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    setExternalChat('oc_wt')
    const h = harness(repo)

    const result = await onWorktreeDisband(h.session, 'feature')

    expect(result.ok).toBe(true)
    expect(disbandedChats).toEqual([])
    expect(botLeftChats).toEqual(['oc_wt'])
    expect(result.message).toContain('机器人已退出 WT 群，请群主手动解散')
    expect(result.message).toContain('dir removed')
    expect(worktree.listProjectWorktrees(repo, 'feishu').some(entry => entry.slug === 'feature' && entry.mounted)).toBe(false)
  })
})

describe('wt groups follow the temp group rule for internal and external groups', () => {
  const mounted = (repo: string) => worktree.listProjectWorktrees(repo, 'feishu').some(entry => entry.slug === 'feature' && entry.mounted)

  test('in an internal group a member gets the bot-owned internal WT group as before', async () => {
    const { repo } = initRepo()
    const h = harness(repo)

    await runWorktreeCommand(h.session, 'feature', 'ou_member')

    expect(externalChatChecks).toEqual(['oc_main'])
    expect(ensuredWorktreeChats).toEqual([{ sessionName: worktree.worktreeChatName('feishu', 'feature'), userOpenId: 'ou_member' }])
    expect(mounted(repo)).toBe(true)
  })

  test('in an external group a member owns a new external WT group, so external members can join later', async () => {
    const { repo } = initRepo()
    setExternalChat('oc_main')
    const h = harness(repo)

    await runWorktreeCommand(h.session, 'feature', 'ou_member')

    expect(resolvedTempGroupOwners).toEqual([])
    expect(ensuredWorktreeChats).toEqual([
      { sessionName: worktree.worktreeChatName('feishu', 'feature'), userOpenId: 'ou_member', ownerOpenId: 'ou_member' },
    ])
    expect(mounted(repo)).toBe(true)
  })

  test('an external contact creates a WT group owned by the source group owner', async () => {
    const { repo } = initRepo()
    setExternalChat('oc_main')
    const h = harness(repo)

    await runWorktreeCommand(h.session, 'feature', 'ou_guest', EXTERNAL)

    const chatName = worktree.worktreeChatName('feishu', 'feature')
    expect(normalChatLookups).toEqual([chatName])
    expect(resolvedTempGroupOwners).toEqual([['oc_main', 'ou_guest', 'tenant_app']])
    expect(ensuredWorktreeChats).toEqual([
      { sessionName: chatName, userOpenId: 'ou_guest', ownerOpenId: 'ou_group_owner', externalRequester: true },
    ])
    expect(mounted(repo)).toBe(true)
  })

  test('an external contact joining an existing WT group needs no owner', async () => {
    const { repo } = initRepo()
    const chatName = worktree.worktreeChatName('feishu', 'feature')
    worktree.ensureProjectWorktree(repo, 'feishu', 'feature')
    chatIdsByName.set(chatName, ['oc_wt'])
    const h = harness(repo)

    await runWorktreeCommand(h.session, 'feature', 'ou_guest', EXTERNAL)

    expect(resolvedTempGroupOwners).toEqual([])
    expect(ensuredWorktreeChats).toEqual([{ sessionName: chatName, userOpenId: 'ou_guest', externalRequester: true }])
  })

  test('an unreadable group type fails before any worktree or branch is created', async () => {
    const { repo } = initRepo()
    setExternalChatError(new Error('feishu chat.get failed code=232010 message=no permission log_id=wt-type-log'))
    const h = harness(repo)

    await runWorktreeCommand(h.session, 'feature', 'ou_member')

    expect(ensuredWorktreeChats).toEqual([])
    expect(mounted(repo)).toBe(false)
    expect(sentTexts).toHaveLength(1)
    expect(sentTexts[0]).toContain('❌ wt 失败: 读取当前群类型失败')
    expect(sentTexts[0]).toContain('log_id=wt-type-log')
  })
})
