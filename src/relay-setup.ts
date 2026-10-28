import * as feishu from './feishu'
import type { Session } from './session'
import { configureRelay, configureRelayBalance } from './relay-config'
import { tokenSourceErrorMessage } from './token-source-errors'
import { logError } from './log'

/** Configure one generic relay endpoint:
 * relay-setup <site_id> <anthropic|openai> <base_url> <api_key> */
export async function runRelaySetup(s: Session, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 4) {
    await feishu.sendText(s.chatId, '用法：relay-setup <站点标识> <anthropic|openai> <base_url> <api_key>')
    return
  }
  const [siteId, protocol, baseUrl, apiKey] = parts
  await feishu.sendText(s.chatId, '正在校验中转站地址和模型目录，完成后返回结果。')
  try {
    await configureRelay(siteId!, { display: siteId, protocol, base_url: baseUrl, api_key: apiKey })
    await feishu.sendText(s.chatId, `✅ 中转站「${siteId}」配置已保存（${protocol}）。模型目录将在后台刷新；发送 model 查看。`)
  } catch (error) {
    logError('relay setup failed', error)
    await feishu.sendText(s.chatId, `❌ 中转站配置失败，原配置保持不变：${tokenSourceErrorMessage(error, [apiKey])}`)
  }
}

export async function runRelayBalanceSetup(s: Session, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 2) {
    await feishu.sendText(s.chatId, '用法：relay-balance-setup <站点标识> <脚本路径>')
    return
  }
  try {
    configureRelayBalance(parts[0]!, parts[1]!)
    await feishu.sendText(s.chatId, `✅ 中转站「${parts[0]}」余额脚本已保存。`)
  } catch (error) {
    logError('relay balance setup failed', error)
    await feishu.sendText(s.chatId, `❌ 余额脚本配置失败：${tokenSourceErrorMessage(error)}`)
  }
}
