import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  ensureProjectWorktree,
  listProjectWorktrees,
  readWorktreeInstructionsForManagedBranch,
  removeProjectWorktreeIfClean,
  withProjectWorktreeLock,
} from './worktree'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('project worktrees', () => {
  test('serializes create and remove for one canonical project root', async () => {
    const { repo } = initRepo()
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    let created!: () => void
    const createdReady = new Promise<void>(resolve => { created = resolve })
    const creating = withProjectWorktreeLock(repo, async () => {
      const result = ensureProjectWorktree(repo, 'feishu', 'serialized-work')
      created()
      await createGate
      return result
    })
    await createdReady

    let removeEntered = false
    const removing = withProjectWorktreeLock(join(repo, '.'), async () => {
      removeEntered = true
      return removeProjectWorktreeIfClean(repo, 'feishu', 'serialized-work')
    })
    await Promise.resolve()
    expect(removeEntered).toBe(false)

    releaseCreate()
    const [, removed] = await Promise.all([creating, removing])
    expect(removeEntered).toBe(true)
    expect(removed.removedWorktree).toBe(true)
  })

  test('keeps different projects concurrent and releases the lock after errors', async () => {
    const first = initRepo().repo
    const second = initRepo().repo
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const events: string[] = []
    const holding = withProjectWorktreeLock(first, async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    await Promise.resolve()
    await withProjectWorktreeLock(second, async () => { events.push('second') })
    expect(events).toEqual(['first:start', 'second'])
    releaseFirst()
    await holding

    await expect(withProjectWorktreeLock(first, async () => {
      throw new Error('expected lock probe')
    })).rejects.toThrow('expected lock probe')
    await expect(withProjectWorktreeLock(first, async () => 'recovered')).resolves.toBe('recovered')
  })

  test('creates sibling worktree and lists it from work branches', () => {
    const { root, repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'feature-worktree')

    expect(result.branch).toBe('work/feature-worktree')
    expect(result.chatName).toBe('feishu[feature-worktree]')
    expect(result.worktreePath).toBe(join(root, 'feishu[feature-worktree]'))

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      slug: 'feature-worktree',
      chatName: 'feishu[feature-worktree]',
      branch: 'work/feature-worktree',
      state: 'active',
      mounted: true,
      dirtyCount: 0,
    })
  })

  test('refuses to remove a dirty worktree', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'dirty-work')
    writeFileSync(join(result.worktreePath, 'scratch.txt'), 'dirty\n')

    expect(() => removeProjectWorktreeIfClean(repo, 'feishu', 'dirty-work')).toThrow(/uncommitted/)
  })

  test('refuses to remove work branches mounted outside the managed sibling path', () => {
    const { root, repo } = initRepo()
    const outside = join(root, 'manual-checkout')
    git(repo, ['worktree', 'add', '-b', 'work/manual', outside, 'HEAD'])

    expect(() => removeProjectWorktreeIfClean(repo, 'feishu', 'manual')).toThrow(/outside managed path/)
    expect(existsSync(outside)).toBe(true)
    expect(git(outside, ['branch', '--show-current']).trim()).toBe('work/manual')
  })

  test('rejects an unrelated repository at the managed path before remote disband can start', () => {
    const { root, repo } = initRepo()
    const unrelated = join(root, 'feishu[unrelated]')
    mkdirSync(unrelated)
    git(unrelated, ['init'])

    expect(() => removeProjectWorktreeIfClean(repo, 'feishu', 'unrelated')).toThrow(/not a registered worktree/)
    expect(existsSync(unrelated)).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('preserves quoted and newline-containing paths in the Git worktree registry', () => {
    const { root, repo } = initRepo()
    const projectName = '项目\n"quoted"'
    const first = ensureProjectWorktree(repo, projectName, 'path-test')

    expect(listProjectWorktrees(repo, projectName)[0]?.worktreePath).toBe(join(root, `${projectName}[path-test]`))
    expect(ensureProjectWorktree(repo, projectName, 'path-test').createdWorktree).toBe(false)
    expect(removeProjectWorktreeIfClean(repo, projectName, 'path-test').removedWorktree).toBe(true)
    expect(existsSync(first.worktreePath)).toBe(false)
  })

  test('recognizes managed worktrees and their instructions through a symlinked project root', () => {
    const { root, repo } = initRepo()
    const aliasRoot = `${root}-alias`
    symlinkSync(root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    roots.push(aliasRoot)
    const first = ensureProjectWorktree(repo, 'feishu', 'Prompt-work')
    writeFileSync(join(first.worktreePath, 'AGENTS.PROMPT.md'), '# shared instructions\n')

    const aliasRepo = join(aliasRoot, 'feishu')
    expect(ensureProjectWorktree(aliasRepo, 'feishu', 'Prompt-work').createdWorktree).toBe(false)
    expect(readWorktreeInstructionsForManagedBranch(first.worktreePath, aliasRepo, 'feishu')?.content)
      .toBe('# shared instructions')
    rmSync(join(first.worktreePath, 'AGENTS.PROMPT.md'))
    expect(removeProjectWorktreeIfClean(aliasRepo, 'feishu', 'Prompt-work').removedWorktree).toBe(true)
  })

  test('removes clean worktree directory but keeps branch discoverable', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'clean-work')

    const removed = removeProjectWorktreeIfClean(repo, 'feishu', 'clean-work')
    expect(removed.removedWorktree).toBe(true)

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.slug).toBe('clean-work')
    expect(entries[0]?.state).toBe('merged')
    expect(entries[0]?.mounted).toBe(false)
    expect(entries[0]?.worktreePath).toBeNull()
    expect(entries[0]?.expectedPath).toBe(result.worktreePath)
  })

  test('rebases archived branches to latest project head when reactivated', () => {
    const { repo } = initRepo()
    const first = ensureProjectWorktree(repo, 'feishu', 'archived-work')
    git(first.worktreePath, ['commit', '--allow-empty', '-m', 'feature'])
    git(repo, ['merge', '--no-ff', 'work/archived-work', '-m', 'merge feature'])
    removeProjectWorktreeIfClean(repo, 'feishu', 'archived-work')
    git(repo, ['commit', '--allow-empty', '-m', 'main moves after archive'])

    const latestProjectHead = git(repo, ['rev-parse', 'HEAD']).trim()
    const reactivated = ensureProjectWorktree(repo, 'feishu', 'archived-work')

    expect(reactivated.createdBranch).toBe(false)
    expect(reactivated.createdWorktree).toBe(true)
    expect(git(repo, ['rev-parse', 'work/archived-work']).trim()).toBe(latestProjectHead)
    expect(git(reactivated.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(latestProjectHead)
  })

  test('marks merged and stale work branches', () => {
    const { repo } = initRepo()
    ensureProjectWorktree(repo, 'feishu', 'merged-work')
    git(join(repo, '..', 'feishu[merged-work]'), ['commit', '--allow-empty', '-m', 'feature'])
    git(repo, ['merge', '--no-ff', 'work/merged-work', '-m', 'merge feature'])

    ensureProjectWorktree(repo, 'feishu', 'stale-work')
    git(repo, ['commit', '--allow-empty', '-m', 'main moves'])

    const entries = listProjectWorktrees(repo, 'feishu')
    expect(entries.find(e => e.slug === 'merged-work')?.state).toBe('merged')

    const stalePath = join(repo, '..', 'feishu[stale-work]')
    writeFileSync(join(stalePath, 'stale.txt'), 'branch work\n')
    git(stalePath, ['add', 'stale.txt'])
    git(stalePath, ['commit', '-m', 'branch work'])
    git(repo, ['commit', '--allow-empty', '-m', 'main moves again'])

    const updated = listProjectWorktrees(repo, 'feishu')
    expect(updated.find(e => e.slug === 'stale-work')?.state).toBe('stale')
  })

  test('finds first-segment agents file for managed worktree branches', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'avatar-art')
    writeFileSync(join(result.worktreePath, 'agents.avatar.md'), '# extra rules\n')

    expect(
      readWorktreeInstructionsForManagedBranch(result.worktreePath, repo, 'feishu')?.path,
    ).toBe(join(result.worktreePath, 'agents.avatar.md'))
  })

  test('skips full dashed slug agents files for managed worktree branches', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'avatar-art')
    writeFileSync(join(result.worktreePath, 'agents.avatar-art.md'), '# extra rules\n')

    expect(readWorktreeInstructionsForManagedBranch(result.worktreePath, repo, 'feishu')).toBeNull()
  })

  test('reads slug-specific AGENTS content for managed worktree branches', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'prompt-work')
    writeFileSync(join(result.worktreePath, 'agents.prompt.md'), '# extra rules\n- be loud\n')

    expect(
      readWorktreeInstructionsForManagedBranch(result.worktreePath, repo, 'feishu'),
    ).toEqual({
      path: join(result.worktreePath, 'agents.prompt.md'),
      content: '# extra rules\n- be loud',
      slug: 'prompt-work',
    })
  })

  test('skips mismatched slug-specific AGENTS files', () => {
    const { repo } = initRepo()
    const result = ensureProjectWorktree(repo, 'feishu', 'prompt-work')
    writeFileSync(join(result.worktreePath, 'agents.other.md'), '# extra rules\n')

    expect(readWorktreeInstructionsForManagedBranch(result.worktreePath, repo, 'feishu')).toBeNull()
  })

  test('skips slug-specific AGENTS files outside managed worktree branches', () => {
    const { repo } = initRepo()
    writeFileSync(join(repo, 'agents.main.md'), '# extra rules\n')

    expect(readWorktreeInstructionsForManagedBranch(repo, repo, 'feishu')).toBeNull()
  })

  test('skips managed-branch AGENTS lookup in non-git project directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-wt-nongit-'))
    roots.push(root)
    const projectDir = join(root, 'test1')
    mkdirSync(projectDir)
    writeFileSync(join(projectDir, 'agents.prompt.md'), '# extra rules\n')

    expect(readWorktreeInstructionsForManagedBranch(projectDir, projectDir, 'test1')).toBeNull()
  })

  test('skips managed-branch AGENTS lookup in unborn git repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-wt-unborn-'))
    roots.push(root)
    const projectDir = join(root, 'test1')
    mkdirSync(projectDir)
    git(projectDir, ['init'])
    writeFileSync(join(projectDir, 'agents.prompt.md'), '# extra rules\n')

    expect(readWorktreeInstructionsForManagedBranch(projectDir, projectDir, 'test1')).toBeNull()
  })
})

function initRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-wt-'))
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
