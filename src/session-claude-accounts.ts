import type { Session } from './session'
import * as feishu from './feishu'
import { messageOf } from './session-util'

/** Login stays in the native CLI. This command only discovers and starts a named account. */
export async function runClaudeNamedHi(session: Session, name: string): Promise<void> {
  const card = await session.openStatusCard('Claude 订阅账号', `🔎 检查「${name}」`)
  let status = ''
  let finished = false
  const finish = async (value: string): Promise<void> => {
    const useCard = card && !finished
    finished = true
    if (useCard) await session.closeStatusCard(card!, value)
    else await feishu.sendTextRaw(session.chatId, value)
  }
  try {
    const ok = await session.startWithClaudeAccount(name, {
      announce: false,
      onStatus: value => { status = value; session.setStatusCard(card, value) },
    })
    if (!ok) throw new Error(status || '指定账号启动失败')
    status = `✅ Claude 订阅「${name}」已就绪 · 本次指定`
    await finish(status)
    await session.showConsole()
  } catch (error) {
    status = `❌ ${messageOf(error)}`
    await finish(status)
  }
}
