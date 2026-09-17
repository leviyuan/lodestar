import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProjectProfile } from './config'
import { expectedWorktreePath, projectNameFromSessionName } from './worktree'

/** BTW/fork changes the conversation, never the workspace. WT keeps its suffix. */
export function workspaceName(sessionName: string): string {
  return sessionName.replace(/\*[0-9]{4}-[0-9]{4}(?:-[0-9]+)?$/, '')
}

export function resolveWorkspaceDir(sessionName: string, projectsRoot: string, projects: Record<string, ProjectProfile>): string {
  const name = workspaceName(sessionName)
  const project = projectNameFromSessionName(name)
  const root = projects[project]?.cwd?.trim() || join(projectsRoot, project)
  // Native resume records contain this exact spelling. Normalize only config
  // keys, not the cwd passed to an existing conversation.
  if (name === project) return root
  return expectedWorktreePath(root, project, name.slice(project.length + 1, -1))
}

/** Resolve aliases including symlinks. Uncreated workspaces use their existing
 * ancestor's real path, so configuring a directory before `hi` is stable. */
export function workspaceKey(workDir: string): string {
  if (!isAbsolute(workDir)) throw new Error(`工作目录必须是绝对路径: ${workDir}`)
  const canonical = realDirectoryPath(resolve(workDir))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function realDirectoryPath(path: string): string {
  try {
    const real = realpathSync(path)
    if (!statSync(real).isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`)
    return real
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT' || dirname(path) === path) throw error
    // A dangling symlink is an invalid directory, not an uncreated workspace.
    try { if (lstatSync(path).isSymbolicLink()) throw error }
    catch (entryError: any) { if (entryError === error || entryError?.code !== 'ENOENT') throw entryError }
    return join(realDirectoryPath(dirname(path)), basename(path))
  }
}

/** Project names locate directories; launch policy belongs to that directory.
 * Multiple names for one directory may contribute settings, but cannot disagree. */
export function profileForWorkspace(
  workDir: string, projectsRoot: string, projects: Record<string, ProjectProfile>,
): ProjectProfile | undefined {
  const key = workspaceKey(workDir)
  let result: ProjectProfile | undefined
  const owners = new Map<string, string>()
  for (const [name, profile] of Object.entries(projects)) {
    if (workspaceKey(resolveWorkspaceDir(name, projectsRoot, projects)) !== key) continue
    result ??= { cwd: workDir }
    for (const field of ['settingSources', 'strictMcp', 'tools', 'loadProjectMcp'] as const) {
      const value = profile[field]
      if (value === undefined) continue
      if (result[field] !== undefined && result[field] !== value) {
        throw new Error(`同一工作目录的项目配置冲突: ${owners.get(field)} / ${name}, ${field} (${workDir})`)
      }
      Object.assign(result, { [field]: value })
      owners.set(field, name)
    }
  }
  return result
}
