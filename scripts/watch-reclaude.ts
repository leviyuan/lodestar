/** 持续检测 ReClaude；真实请求可能消耗额度，首次成功并通知后退出。 */
import { parseArgs } from 'node:util'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ReclaudeRecoveryWatch, reclaudeWatchStatePath, probeReclaudeModel, notifyReclaudeRecovery } from '../src/reclaude-watch'

const { values } = parseArgs({ options: {
  project: { type: 'string' }, model: { type: 'string' },
  'interval-seconds': { type: 'string' }, once: { type: 'boolean' },
}, strict: true })
const project = values.project?.trim()
const model = values.model?.trim()
const intervalSeconds = Number(values['interval-seconds'])
if (!project || !model || !Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
  throw new Error('用法：bun scripts/watch-reclaude.ts --project <群项目名> --model <模型> --interval-seconds <至少 60 秒> [--once]')
}

const controller = new AbortController()
const stop = () => controller.abort(new Error('ReClaude 恢复检测已停止'))
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
const file = reclaudeWatchStatePath(project, model)
const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`)
const watcher = new ReclaudeRecoveryWatch({ project, model, file, signal: controller.signal, log,
  probe: () => probeReclaudeModel(model, join(dirname(file), 'work'), controller.signal),
  notify: result => notifyReclaudeRecovery(project, model, result, controller.signal),
})

log(`监测 ${project} / ${model}，每 ${intervalSeconds} 秒检测一次；首次恢复并通知后退出。状态：${file}`)
try {
  while (!controller.signal.aborted) {
    const status = await watcher.step()
    if (status === 'done' || values.once) break
    await delay(status === 'notify_pending' ? 60_000 : intervalSeconds * 1000, undefined, { signal: controller.signal })
  }
} catch (error) {
  if (!controller.signal.aborted) throw error
  log('检测已取消')
} finally {
  process.off('SIGTERM', stop)
  process.off('SIGINT', stop)
}
