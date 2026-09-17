import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileForWorkspace, resolveWorkspaceDir, workspaceKey, workspaceName } from './workspace'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-workspace-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('directory configuration boundaries', () => {
  test('BTW and fork share cwd; WT and its temporary conversations use their own sibling directory', () => {
    const projects = { main: { cwd: join(root, 'custom') } }
    expect(resolveWorkspaceDir('main', root, projects)).toBe(join(root, 'custom'))
    expect(resolveWorkspaceDir('main*0917-1234-2', root, projects)).toBe(join(root, 'custom'))
    expect(resolveWorkspaceDir('main[feature]*0917-1234', root, projects)).toBe(join(root, 'main[feature]'))
    expect(workspaceName('main[feature]*0917-1234')).toBe('main[feature]')
  })

  test('normalizes directory aliases, symlinks, trailing separators and paths not yet created', () => {
    mkdirSync(join(root, 'actual'))
    symlinkSync(join(root, 'actual'), join(root, 'alias'), 'junction')
    expect(workspaceKey(join(root, 'alias') + '/')).toBe(workspaceKey(join(root, 'actual')))
    expect(workspaceKey(join(root, 'alias', 'future'))).toBe(workspaceKey(join(root, 'actual', 'future')))
    mkdirSync(join(root, 'actual', 'future'))
    expect(workspaceKey(join(root, 'alias', 'future'))).toBe(workspaceKey(join(root, 'actual', 'future')))
  })

  test('preserves the configured cwd spelling used by existing native resume records', () => {
    const cwd = join(root, 'resume-repo') + '/'
    const projects = { main: { cwd } }
    expect(resolveWorkspaceDir('main', root, projects)).toBe(cwd)
    expect(resolveWorkspaceDir('main*0917-1234', root, projects)).toBe(cwd)
    expect(workspaceKey(cwd)).toBe(workspaceKey(join(root, 'resume-repo')))
  })

  test('rejects files, relative paths and broken symlinks as configuration directories', () => {
    writeFileSync(join(root, 'file'), 'file')
    symlinkSync(join(root, 'missing'), join(root, 'broken'), 'junction')
    expect(() => workspaceKey('relative')).toThrow('绝对路径')
    expect(() => workspaceKey(join(root, 'file'))).toThrow('不是文件夹')
    expect(() => workspaceKey(join(root, 'broken'))).toThrow()
    expect(() => workspaceKey(join(root, 'broken', 'child'))).toThrow()
  })

  test('project tools and MCP policy follow the actual directory without leaking into WT', () => {
    const main = join(root, 'repo')
    const wt = join(root, 'main[feature]')
    const projects = {
      main: { cwd: main, tools: 'Read', strictMcp: true, loadProjectMcp: false },
      alias: { cwd: main, settingSources: 'project' },
    }
    expect(profileForWorkspace(main, root, projects)).toEqual({
      cwd: main, tools: 'Read', strictMcp: true, loadProjectMcp: false, settingSources: 'project',
    })
    expect(profileForWorkspace(resolveWorkspaceDir('alias*0917-1234', root, projects), root, projects)?.tools).toBe('Read')
    expect(profileForWorkspace(wt, root, projects)).toBeUndefined()
    expect(profileForWorkspace(wt, root, { ...projects, feature: { cwd: wt, tools: 'Read,Edit' } })?.tools).toBe('Read,Edit')
    expect(profileForWorkspace(join(main, 'subdir'), root, projects)).toBeUndefined()
  })

  test('conflicting policies for the same directory fail visibly', () => {
    expect(() => profileForWorkspace(root, root, {
      a: { cwd: root, loadProjectMcp: true }, b: { cwd: root + '/', loadProjectMcp: false },
    })).toThrow('项目配置冲突')
  })
})
