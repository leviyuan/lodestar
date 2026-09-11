import * as feishu from './feishu'
import * as cardkit from './cardkit'
import { ELEMENTS } from './cards/elements'
import { codexAccountCard, codexAccountPanel, codexAccountSummary, type CodexAccountCardView } from './cards/codex-account'

export interface CodexAccountCardDeps {
  sendCard: typeof feishu.sendCard
  convertMessageToCard: typeof cardkit.convertMessageToCard
  recordCardCreated: typeof cardkit.recordCardCreated
  replaceElementChecked: typeof cardkit.replaceElementChecked
  patchSettingsChecked: typeof cardkit.patchSettingsChecked
  dispose: typeof cardkit.dispose
}
const defaults: CodexAccountCardDeps = { sendCard: feishu.sendCard, convertMessageToCard: cardkit.convertMessageToCard,
  recordCardCreated: cardkit.recordCardCreated, replaceElementChecked: cardkit.replaceElementChecked,
  patchSettingsChecked: cardkit.patchSettingsChecked, dispose: cardkit.dispose }

/** One command receipt, updated through Card Kit until a checked terminal write. */
export class CodexAccountCard {
  private tail: Promise<void> = Promise.resolve()
  private terminal: Promise<void> | null = null
  private constructor(readonly cardId: string, private deps: CodexAccountCardDeps) {}
  static async open(chatId: string, view: CodexAccountCardView, deps = defaults): Promise<CodexAccountCard> {
    const messageId = await deps.sendCard(chatId, codexAccountCard(view, true))
    if (!messageId) throw new Error('Codex 账号卡片发送失败')
    const cardId = await deps.convertMessageToCard(messageId)
    deps.recordCardCreated(cardId, 1)
    return new CodexAccountCard(cardId, deps)
  }
  update(view: CodexAccountCardView): Promise<void> {
    if (this.terminal) return Promise.reject(new Error('Codex 账号卡片已结束'))
    const panel = codexAccountPanel(view)
    return this.enqueue(() => this.write(view, panel, false))
  }
  finish(view: CodexAccountCardView): Promise<void> {
    if (this.terminal) return this.terminal
    const panel = codexAccountPanel(view)
    this.terminal = this.enqueue(() => this.write(view, panel, true))
    return this.terminal
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work)
    // Release only the queue. The original promise reports every failed mutation to its caller.
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private async write(view: CodexAccountCardView, panel: object, terminal: boolean): Promise<void> {
    const replaced = await this.deps.replaceElementChecked(this.cardId, ELEMENTS.codexAccountPanel, panel, { notifyCardFailure: false })
    const configured = await this.deps.patchSettingsChecked(this.cardId, { config: {
      streaming_mode: !terminal, summary: { content: codexAccountSummary(view) },
    } })
    if (!replaced || !configured) throw new Error(`Codex 账号卡片更新失败：内容 ${replaced ? 'OK' : 'MISS'}，状态 ${configured ? 'OK' : 'MISS'}`)
    if (terminal) await this.deps.dispose(this.cardId)
  }
}
