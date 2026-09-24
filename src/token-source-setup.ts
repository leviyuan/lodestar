/** model 面板的账号启用引导，以及 factory 声明的 <source>-setup 命令。 */

import * as feishu from './feishu'
import { getTokenSource, tokenSourceFactories } from './token-source'
import { addTokenSource, configureTokenSource, TokenSourceSetupError } from './token-source-config'
import type { Session } from './session'
import { codexAccountCard } from './cards/codex-account'
import { config } from './config'
import { log } from './log'
import { tokenSourceErrorMessage } from './token-source-errors'
import { sharedAccountSourceIds } from './token-source-accounts'
import { agentProviderLabel } from './agent-process'

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
    lines.push(`可用性 MISS：${state?.error ?? (state?.status === 'loading' || state?.status === 'idle' ? '模型目录缓存尚未就绪，后台刷新中' : '订阅来源不可用')}`)
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
  if (ts.enabled && ts.modelCatalogState?.status !== 'failed') {
    await feishu.sendText(s.chatId, `${ts.display} 已启用,发 \`model\` 选择。`)
    return
  }
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId || d.configSectionId === sourceId)
  if (def?.setup) {
    const failure = ts.modelCatalogState?.status === 'failed'
      ? `${ts.display} 当前不可用：${tokenSourceErrorMessage(ts.modelCatalogState.error ?? 'MISS')}\n` : ''
    await feishu.sendText(s.chatId, failure + def.setup.hint(ts.display))
  } else if (ts.kind === 'codex-subscription') {
    const sent = await feishu.sendCard(s.chatId, codexAccountCard({ phase: 'current', title: '添加账号',
      message: '通过设备码完成浏览器授权', hint: '默认：codex-login · 额外：codex-login 备注' }))
    if (!sent) throw new Error('Codex 登录引导卡片发送失败')
  } else if (ts.kind === 'claude-subscription') {
    await feishu.sendText(s.chatId, config.token_sources['claude-sub']?.enabled === false
      ? 'Claude Code 订阅已在 Lodestar 中禁用。发送 `claude-sub on` 启用，所有群共用，本机登录态保持不变。'
      : ts.modelCatalogState?.error ?? '请在运行 Lodestar 的本机执行 `claude auth login` 登录 Claude 订阅，完成后等待后台刷新，发送 `md` 查看状态。')
  } else if (ts.kind === 'claude-native') {
    // native 凭本机 Claude 配置自动启用/禁用,无独立「启用」操作(它就是默认通路)。
    await feishu.sendText(s.chatId, `${ts.display} 直接使用本机 Claude Code 配置,无需单独启用。`)
  }
}

/** `<source>-setup <args>` generic:解析 → 校验候选凭据 → 写 config + 全量刷新 models。
 *  commandSuffix 不匹配 / 无 setup → 报错(codex login / native 无此命令)。 */
export async function runTokenSourceSetup(s: Session, sourceId: string, args: string): Promise<void> {
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId || d.usageSetup?.commandSuffix === sourceId)
  const usageOnly = def?.usageSetup?.commandSuffix === sourceId
  const setup = usageOnly ? def?.usageSetup : def?.setup
  if (!def || !setup || !def.configSectionId) {
    await feishu.sendText(s.chatId, `❌ 未知或不可配置的 source: ${sourceId}`)
    return
  }
  const parsed = setup.parseArgs(args)
  if ('error' in parsed) {
    await feishu.sendText(s.chatId, parsed.error)
    return
  }
  await feishu.sendText(s.chatId, '正在后台校验账号配置，完成后会返回结果；其他操作可继续使用。')
  let saved = false
  try {
    await configureTokenSource(def, parsed.config, setup)
    saved = true
    const ts = getTokenSource(def.configSectionId)
    const related = sharedAccountSourceIds(def.configSectionId).map(id => getTokenSource(id))
    const failed = related.find(source => (!usageOnly || source?.enabled) && source?.modelCatalogState?.status !== 'ready')
    if (usageOnly) {
      const diagnostic = failed ? `\n模型目录仍为 MISS：${tokenSourceErrorMessage(failed.modelCatalogState?.error ?? '尚未就绪', [parsed.config.management_token])}` : ''
      await feishu.sendText(s.chatId, `✅ ${ts?.display ?? sourceId} 真实余额校验通过，配置已保存。发送 hi 查看；回复页脚使用同一账户余额。${diagnostic}`)
      return
    }
    if (failed?.modelCatalogState?.status === 'failed' || related.some(source => !source)) {
      const reason = tokenSourceErrorMessage(failed?.modelCatalogState?.error ?? '模型目录尚未就绪', [parsed.config.api_key, parsed.config.auth_token])
      await feishu.sendText(s.chatId, `❌ ${ts?.display ?? sourceId} 凭据校验通过、配置已保存，但暂不可用：${reason}\n处理后等待后台刷新，发送 md 查看状态。`)
      return
    }
    const agents = [...new Set(related.filter((source): source is NonNullable<typeof source> => !!source).map(source => agentProviderLabel(source.agent)))]
    await feishu.sendText(s.chatId, `✅ ${ts!.display} 校验通过，配置已保存。${agents.length > 1 ? `${agents.join(' 和 ')} 共用该账号。` : ''}目录与额度在后台刷新；发送 md 查看模型。`)
  } catch (e: any) {
    const state = saved || e instanceof TokenSourceSetupError && e.saved ? '配置已保存，但后续处理失败' : '配置失败，未保存，原配置保持不变'
    const reason = tokenSourceErrorMessage(e, [parsed.config.api_key, parsed.config.auth_token, parsed.config.management_token])
    await feishu.sendText(s.chatId, `❌ ${state}：${reason}`)
  }
}
