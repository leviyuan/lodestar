import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chatIdsByName, disbandedChats, projectProfiles, resetFeishuMock } from './feishu-test-mock'

// feishu-test-mock 必须先注册，session-worktree 才会拿到共享的 Feishu 替身。
const { onWorktreeDisband } = await import('./session-worktree')
const worktree = await import('./worktree')

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

function harness(repo: string, options: { failTemp?: string } = {}): Harness {
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
        return { ok: true }
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
})
