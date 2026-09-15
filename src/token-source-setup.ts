/** model 面板的账号启用引导，以及 factory 声明的 <source>-setup 命令。 */

import * as feishu from './feishu'
import { getTokenSource, tokenSourceFactories } from './token-source'
import { addTokenSource } from './token-source-config'
import type { Session } from './session'
import { codexAccountCard } from './cards/codex-account'
import { config } from './config'
import { log } from './log'

/** 只控制 Lodestar 的订阅来源；本机 Claude 登录态保持不变。 */
export async function runClaudeSubscriptionCommand(s: Session, action: string): Promise<void> {
  const usage = 'claude-sub 查看状态 · claude-sub on 启用 · claude-sub off 禁用'
  if (action && action !== 'on' && action !== 'off') {
    await feishu.sendText(s.chatId, `用法：${usage}`)
    return
  }
  if (action) {
    try {
      await addTokenSource('claude-sub', { enabled: action === 'on' })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log(`claude-sub ${action} failed: ${reason}`)
      await feishu.sendText(s.chatId, `❌ Claude Code 订阅开关更新失败：${reason}`)
      return
    }
  }
  const source = getTokenSource('claude-sub')
  const enabled = config.token_sources['claude-sub']?.enabled !== false
  const state = source?.modelCatalogState
  const lines = [`Claude Code 订阅：${enabled ? '已启用' : '已禁用'}（Lodestar 全局）`]
  if (enabled && (!source?.enabled || state?.status !== 'ready')) {
    lines.push(`可用性 MISS：${state?.error ?? (state?.status === 'loading' || state?.status === 'idle' ? '模型目录尚未就绪，请发送 md 刷新' : '订阅来源不可用')}`)
  }
  lines.push('所有群共用；保留本机登录态。')
  if (!enabled) lines.push('禁止新任务，已在执行的任务继续完成。')
  lines.push(usage)
  await feishu.sendText(s.chatId, lines.join('\n'))
}

/** model 面板「启用」按钮回调:据 factory setup.hint 弹启用引导(codex/native 特例)。 */
export async function onTokenSourceEnable(s: Session, sourceId: string): Promise<void> {
  const ts = getTokenSource(sourceId)
  if (!ts) {
    await feishu.sendText(s.chatId, `❌ 未知 token source: ${sourceId}`)
    return
  }
  if (ts.enabled) {
    await feishu.sendText(s.chatId, `${ts.display} 已启用,发 \`model\` 选择。`)
    return
  }
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId || d.configSectionId === sourceId)
  if (def?.setup) {
    await feishu.sendText(s.chatId, def.setup.hint(ts.display))
  } else if (ts.kind === 'codex-subscription') {
    const sent = await feishu.sendCard(s.chatId, codexAccountCard({ phase: 'current', title: '添加账号',
      message: '通过设备码完成浏览器授权', hint: '默认：codex-login · 额外：codex-login 备注' }))
    if (!sent) throw new Error('Codex 登录引导卡片发送失败')
  } else if (ts.kind === 'claude-subscription') {
    await feishu.sendText(s.chatId, config.token_sources['claude-sub']?.enabled === false
      ? 'Claude Code 订阅已在 Lodestar 中禁用。发送 `claude-sub on` 启用，所有群共用，本机登录态保持不变。'
      : ts.modelCatalogState?.error ?? '请在运行 Lodestar 的本机执行 `claude auth login` 登录 Claude 订阅，完成后发送 `md` 刷新。')
  } else if (ts.kind === 'claude-native') {
    // native 凭本机 Claude 配置自动启用/禁用,无独立「启用」操作(它就是默认通路)。
    await feishu.sendText(s.chatId, `${ts.display} 直接使用本机 Claude Code 配置,无需单独启用。`)
  }
}

/** `<source>-setup <args>` generic:路由到 factory setup.parseArgs → 写 config + 全量刷新 models。
 *  commandSuffix 不匹配 / 无 setup → 报错(codex login / native 无此命令)。 */
export async function runTokenSourceSetup(s: Session, sourceId: string, args: string): Promise<void> {
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId)
  if (!def?.setup || !def.configSectionId) {
    await feishu.sendText(s.chatId, `❌ 未知或不可配置的 source: ${sourceId}`)
    return
  }
  const parsed = def.setup.parseArgs(args)
  if ('error' in parsed) {
    await feishu.sendText(s.chatId, parsed.error)
    return
  }
  try {
    await addTokenSource(def.configSectionId, parsed.config)
    const ts = getTokenSource(def.configSectionId)
    if (ts?.modelCatalogState?.status === 'failed') {
      await feishu.sendText(s.chatId, `❌ ${ts.display} 配置已保存，但模型目录未就绪：${ts.modelCatalogState.error ?? 'MISS'}`)
      return
    }
    await feishu.sendText(s.chatId, `✅ ${ts?.display ?? sourceId} 已启用。发 \`model\` 重新选择。`)
  } catch (e: any) {
    await feishu.sendText(s.chatId, `❌ 启用失败: ${e?.message ?? e}`)
  }
}
