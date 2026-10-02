import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import * as feishu from './feishu'
import { workspaceName } from './workspace'
import type { AgentExecutionContext } from './agent-context'
import type { AgentProvider } from './agent-process'
import type { AgentRunSnapshot } from './agent-run-types'
import type { FileDeliveryMode } from './file-delivery-types'
import { createFileDelivery, groupFileDelivery } from './file-delivery-runtime'
import { channelInstructions } from './instructions'
import { extractSendMarkerPaths, normalizeOutboundPath } from './outbound-markers'

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

export function projectAgentInstructions(provider: AgentProvider, mode: FileDeliveryMode): string {
  return channelInstructions(provider, mode, 'project')
}

export interface AgentProjectRuntime {
  mode(chatId: string, workDir: string): FileDeliveryMode
  deliver(run: AgentRunSnapshot, output: string, signal: AbortSignal, seen: Set<string>): Promise<void>
}

export function createAgentProjectRuntime(deps: {
  mode: AgentProjectRuntime['mode']
  uploadAndSend: typeof feishu.uploadAndSend
  createFileDelivery: typeof createFileDelivery
}): AgentProjectRuntime {
  return {
    mode: deps.mode,
    async deliver(run, output, signal, seen) {
      const paths = extractSendMarkerPaths(output).map(path => normalizeOutboundPath(path)).filter(path => {
        if (seen.has(path)) return false
        seen.add(path)
        if (!isAbsolute(path)) throw new Error(`文件交付路径必须是绝对路径: ${path}`)
        return true
      })
      if (!paths.length) return
      signal.throwIfAborted()
      if (run.deliveryMode === 'chat') {
        for (const path of paths) {
          signal.throwIfAborted()
          if (!await deps.uploadAndSend(run.chatId, path)) throw new Error(`项目任务文件交付失败: ${path}`)
        }
        return
      }
      if (run.deliveryMode !== 'drive') throw new Error('项目任务文件交付方式 MISS')
      if (!run.requesterOpenId) throw new Error('云空间交付需要调用方通过 --requester 提供发起人的 open_id')
      const delivery = deps.createFileDelivery({
        chatId: run.chatId, managerOpenId: run.requesterOpenId,
        projectName: run.owner!.name, createdAt: Date.parse(run.createdAt),
      })
      const cancel = () => delivery.cancel(String(signal.reason))
      signal.addEventListener('abort', cancel, { once: true })
      try {
        let addFailure: unknown
        try { for (const path of paths) delivery.add(path) }
        catch (error) { addFailure = error; delivery.cancel(String(error)) }
        let delivered: string[]
        try { delivered = await delivery.finish() }
        catch (error) {
          if (addFailure) throw new AggregateError([addFailure, error], `${String(addFailure)}; ${String(error)}`)
          throw error
        }
        if (addFailure) throw addFailure
        signal.throwIfAborted()
        const missing = paths.filter(path => !delivered.includes(path))
        if (missing.length) throw new Error(`项目任务文件交付未完成: ${missing.join(', ')}`)
      } finally { signal.removeEventListener('abort', cancel) }
    },
  }
}

export const agentProjectRuntime = createAgentProjectRuntime({
  mode: (chatId, workDir) => groupFileDelivery.mode(chatId, workDir),
  uploadAndSend: feishu.uploadAndSend,
  createFileDelivery,
})
