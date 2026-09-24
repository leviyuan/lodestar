import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface WorktreeEntry {
  slug: string
  chatName: string
  branch: string
  state: 'active' | 'merged' | 'stale'
  expectedPath: string
  worktreePath: string | null
  mounted: boolean
  dirtyCount: number | null
  statusLine: string | null
  error: string | null
}

export interface EnsureWorktreeResult {
  slug: string
  chatName: string
  branch: string
  worktreePath: string
  createdBranch: boolean
  createdWorktree: boolean
}

export interface RemoveWorktreeResult {
  slug: string
  chatName: string
  branch: string
  worktreePath: string
  removedWorktree: boolean
}

export interface WorktreeInstructionsFile {
  path: string
  content: string
  slug: string
}

const WORK_BRANCH_PREFIX = 'work/'
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const projectWorktreeTails = new Map<string, Promise<void>>()

/** Serialize every worktree registry transaction for one canonical repository.
 * Text-command creation/reactivation and card-action disbanding enter through
 * different dispatch paths, so the mutex belongs beside the Git primitives,
 * not in either UI handler. Distinct repositories remain concurrent. */
export async function withProjectWorktreeLock<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
  const real = realpathSync(projectDir)
  const key = process.platform === 'win32' ? real.toLowerCase() : real
  const previous = projectWorktreeTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const tail = previous.catch(() => {}).then(() => gate)
  projectWorktreeTails.set(key, tail)
  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
    if (projectWorktreeTails.get(key) === tail) projectWorktreeTails.delete(key)
  }
}

export function normalizeWorktreeSlug(raw: string): string | null {
  const slug = raw.trim()
  if (!SLUG_RE.test(slug)) return null
  return slug
}

export function projectNameFromSessionName(sessionName: string): string {
  const m = sessionName.match(/^(.+)\[[^\[\]]+\]$/)
  return m?.[1] ?? sessionName
}

export function worktreeChatName(projectName: string, slug: string): string {
  return `${projectName}[${slug}]`
}

export function worktreeBranch(slug: string): string {
  return `${WORK_BRANCH_PREFIX}${slug}`
}

export function expectedWorktreePath(projectDir: string, projectName: string, slug: string): string {
  return join(dirname(projectDir), worktreeChatName(projectName, slug))
}

export function readWorktreeInstructionsForManagedBranch(
  workDir: string,
  projectDir: string,
  projectName: string,
): WorktreeInstructionsFile | null {
  const context = managedWorktreeInstructionContext(workDir, projectDir, projectName)
  if (!context) return null
  const content = readFileSync(context.path, 'utf8').trim()
  if (!content) return null
  return { path: context.path, content, slug: context.slug }
}

export function listProjectWorktrees(projectDir: string, projectName: string): WorktreeEntry[] {
  assertGitRepo(projectDir)
  const branches = git(projectDir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${WORK_BRANCH_PREFIX}`])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(branch => branch.startsWith(WORK_BRANCH_PREFIX))

  const mountedByBranch = parseWorktreeList(projectDir)
  const out: WorktreeEntry[] = []
  for (const branch of branches) {
    const slug = branch.slice(WORK_BRANCH_PREFIX.length)
    if (!normalizeWorktreeSlug(slug)) continue
    const chatName = worktreeChatName(projectName, slug)
    const expectedPath = expectedWorktreePath(projectDir, projectName, slug)
    const mountedPath = mountedByBranch.get(branch) ?? null
    const mounted = !!mountedPath && existsSync(mountedPath)
    const state = branchState(projectDir, branch, mounted)
    const entry: WorktreeEntry = {
      slug,
      chatName,
      branch,
      state,
      expectedPath,
      worktreePath: mounted ? mountedPath : null,
      mounted,
      dirtyCount: null,
      statusLine: null,
      error: null,
    }
    if (mountedPath && existsSync(mountedPath)) {
      try {
        const status = git(mountedPath, ['status', '--porcelain=v1', '--branch'])
        const lines = status.split('\n').filter(Boolean)
        entry.statusLine = lines[0]?.startsWith('## ') ? lines[0].slice(3) : null
        entry.dirtyCount = lines.filter(line => !line.startsWith('## ')).length
      } catch (e) {
        entry.error = errorMessage(e)
      }
    }
    out.push(entry)
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

export function ensureProjectWorktree(projectDir: string, projectName: string, slug: string): EnsureWorktreeResult {
  const cleanSlug = normalizeWorktreeSlug(slug)
  if (!cleanSlug) throw new Error(`invalid worktree name "${slug}"`)
  assertGitRepo(projectDir)

  const branch = worktreeBranch(cleanSlug)
  const chatName = worktreeChatName(projectName, cleanSlug)
  const targetPath = expectedWorktreePath(projectDir, projectName, cleanSlug)
  const branchExists = hasBranch(projectDir, branch)
  const mountedPath = parseWorktreeList(projectDir).get(branch) ?? null
  const projectHead = branchExists && !mountedPath && branchState(projectDir, branch, false) === 'merged'
    ? git(projectDir, ['rev-parse', 'HEAD']).trim()
    : null

  if (mountedPath) {
    if (!sameWorktreePath(mountedPath, targetPath)) {
      throw new Error(`branch ${branch} is already mounted at ${mountedPath}`)
    }
    assertWorktreeBranch(targetPath, branch)
    return { slug: cleanSlug, chatName, branch, worktreePath: targetPath, createdBranch: false, createdWorktree: false }
  }

  if (existsSync(targetPath)) {
    if (!statSync(targetPath).isDirectory()) {
      throw new Error(`${targetPath} exists but is not a directory`)
    }
    if (!branchExists) {
      throw new Error(`${targetPath} already exists while branch ${branch} does not`)
    }
  }

  if (branchExists) {
    git(projectDir, ['worktree', 'add', targetPath, branch])
    if (projectHead) git(targetPath, ['rebase', projectHead])
    return { slug: cleanSlug, chatName, branch, worktreePath: targetPath, createdBranch: false, createdWorktree: true }
  }

  git(projectDir, ['worktree', 'add', '-b', branch, targetPath, 'HEAD'])
  return { slug: cleanSlug, chatName, branch, worktreePath: targetPath, createdBranch: true, createdWorktree: true }
}

export function removeProjectWorktreeIfClean(projectDir: string, projectName: string, slug: string): RemoveWorktreeResult {
  const target = assertProjectWorktreeClean(projectDir, projectName, slug)
  if (!existsSync(target.worktreePath)) return target
  git(projectDir, ['worktree', 'remove', target.worktreePath])
  return { ...target, removedWorktree: true }
}

export function assertProjectWorktreeClean(projectDir: string, projectName: string, slug: string): RemoveWorktreeResult {
  const cleanSlug = normalizeWorktreeSlug(slug)
  if (!cleanSlug) throw new Error(`invalid worktree name "${slug}"`)
  assertGitRepo(projectDir)
  const branch = worktreeBranch(cleanSlug)
  const chatName = worktreeChatName(projectName, cleanSlug)
  const targetPath = expectedWorktreePath(projectDir, projectName, cleanSlug)
  const mountedPath = parseWorktreeList(projectDir).get(branch) ?? null
  if (mountedPath && !sameWorktreePath(mountedPath, targetPath)) {
    throw new Error(`branch ${branch} is already mounted at ${mountedPath}, outside managed path ${targetPath}`)
  }
  const worktreePath = mountedPath ?? targetPath

  if (!existsSync(worktreePath)) {
    return { slug: cleanSlug, chatName, branch, worktreePath, removedWorktree: false }
  }
  if (!mountedPath) {
    throw new Error(`${worktreePath} is not a registered worktree of ${projectDir}`)
  }
  assertWorktreeBranch(worktreePath, branch)
  const dirty = git(worktreePath, ['status', '--porcelain=v1']).split('\n').filter(Boolean)
  if (dirty.length > 0) {
    const preview = dirty.slice(0, 8).join('\n')
    throw new Error(`worktree has uncommitted changes:\n${preview}`)
  }
  return { slug: cleanSlug, chatName, branch, worktreePath, removedWorktree: false }
}

function assertGitRepo(projectDir: string): void {
  if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`)
  const top = git(projectDir, ['rev-parse', '--show-toplevel']).trim()
  // realpath 两边再比:git 返回的是解掉符号链接的真实路径,而传入的
  // projectDir 可能带符号链接段(macOS /var → /private/var,tmpdir 下
  // 的测试仓库全踩这个),lexical resolve 会把同一目录判成两个。
  if (realpathSync(top) !== realpathSync(projectDir)) {
    throw new Error(`${projectDir} is not the git repository root (${top})`)
  }
}

function assertWorktreeBranch(worktreePath: string, branch: string): void {
  const actual = git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (actual !== branch) {
    throw new Error(`${worktreePath} is on ${actual}, expected ${branch}`)
  }
}

function managedWorktreeInstructionContext(
  workDir: string,
  projectDir: string,
  projectName: string,
): { path: string; slug: string } | null {
  const branch = currentGitBranchForOptionalInstructions(workDir)
  if (!branch?.startsWith(WORK_BRANCH_PREFIX)) return null
  const slug = branch.slice(WORK_BRANCH_PREFIX.length)
  if (!normalizeWorktreeSlug(slug)) {
    throw new Error(`invalid worktree branch "${branch}"`)
  }
  const expectedPath = expectedWorktreePath(projectDir, projectName, slug)
  if (!sameWorktreePath(workDir, expectedPath)) return null
  const instructionsPath = worktreeInstructionsPath(workDir, worktreeInstructionSlugKey(slug))
  return instructionsPath ? { path: instructionsPath, slug } : null
}

function currentGitBranchForOptionalInstructions(workDir: string): string | null {
  if (!existsSync(workDir)) return null
  try {
    return git(workDir, ['branch', '--show-current']).trim() || null
  } catch (e) {
    if (isNotGitRepositoryError(e)) return null
    throw e
  }
}

function worktreeInstructionSlugKey(slug: string): string {
  return slug.split('-', 1)[0] ?? slug
}

function worktreeInstructionsPath(workDir: string, slugKey: string): string | null {
  const expectedName = `agents.${slugKey}.md`.toLowerCase()
  const matches = readdirSync(workDir)
    .filter(name => name.toLowerCase() === expectedName)
    .sort()
  if (matches.length > 1) {
    throw new Error(`multiple worktree instruction files match ${expectedName}: ${matches.join(', ')}`)
  }
  return matches[0] ? join(workDir, matches[0]) : null
}

function hasBranch(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function branchState(projectDir: string, branch: string, mounted: boolean): WorktreeEntry['state'] {
  const head = git(projectDir, ['rev-parse', branch]).trim()
  const main = git(projectDir, ['rev-parse', 'HEAD']).trim()
  if (head === main) return mounted ? 'active' : 'merged'
  if (isAncestor(projectDir, branch, 'HEAD')) return 'merged'
  if (isAncestor(projectDir, 'HEAD', branch)) return 'active'
  return 'stale'
}

function isAncestor(projectDir: string, ancestor: string, descendant: string): boolean {
  try {
    git(projectDir, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

function parseWorktreeList(projectDir: string): Map<string, string> {
  const out = new Map<string, string>()
  const text = git(projectDir, ['worktree', 'list', '--porcelain', '-z'])
  let currentPath = ''
  for (const line of text.split('\0')) {
    if (!line) currentPath = ''
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length)
      continue
    }
    if (line.startsWith('branch refs/heads/') && currentPath) {
      out.set(line.slice('branch refs/heads/'.length), currentPath)
    }
  }
  return out
}

function sameWorktreePath(first: string, second: string): boolean {
  const canonical = (path: string): string => {
    const value = existsSync(path) ? realpathSync(path) : resolve(path)
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return canonical(first) === canonical(second)
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    throw new Error(errorMessage(e))
  }
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const any = e as { stderr?: Buffer | string; message?: string }
    const stderr = any.stderr ? String(any.stderr).trim() : ''
    if (stderr) return stderr
    if (any.message) return any.message
  }
  return String(e)
}

function isNotGitRepositoryError(e: unknown): boolean {
  return /not a git repository/i.test(errorMessage(e))
}
