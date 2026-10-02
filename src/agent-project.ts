import { realpathSync, statSync } from 'node:fs'
import * as feishu from './feishu'
import { workspaceName } from './workspace'
import type { AgentExecutionContext } from './agent-context'

export function resolveAgentProject(name: string, deps: Pick<typeof feishu,
  'sanitizeSessionName' | 'chatIdForSession' | 'resolveProjectDir'> = feishu): AgentExecutionContext {
  const project = name.trim()
  if (!project || deps.sanitizeSessionName(project) !== project || workspaceName(project) !== project) {
    throw new Error('请指定项目或 worktree 名称，不能指定 BTW/FK 临时会话')
  }
  const chatId = deps.chatIdForSession(project)
  if (!chatId) throw new Error(`项目 ${project} 没有明确的群绑定`)
  const workDir = realpathSync(deps.resolveProjectDir(project))
  if (!statSync(workDir).isDirectory()) throw new Error(`项目工作目录不是文件夹: ${workDir}`)
  return { owner: { kind: 'project', name: project, chatId, workDir } }
}
