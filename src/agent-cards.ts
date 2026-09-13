import * as cards from './cards'
import { isCardCapacityFailure, type CardWriteResult } from './cardkit'
import type { AgentRunSnapshot } from './agent-run-types'
import { withChatMessageOrder } from './chat-message-order'

// Each row has one panel and one Markdown body. Leave room below the
// component ceiling, and also honor actual byte-capacity errors from Card Kit.
const CARD_ROW_SOFT_LIMIT = 50

export interface AgentCardsDeps {
  sendCard(chatId: string, card: object): Promise<string | null>
  getChatTailMessageId(chatId: string): Promise<string | null>
  convertMessageToCard(messageId: string): Promise<string>
  recordCardCreated(cardId: string, elementCount: number, onFailure?: (code?: number) => void): void
  getElementCount(cardId: string): number
  addElementResult(cardId: string, element: object): Promise<CardWriteResult>
  replaceElementResult(cardId: string, elementId: string, element: object): Promise<CardWriteResult>
  deleteElementChecked(cardId: string, elementId: string): Promise<boolean>
  cancelSummary(cardId: string): void
  patchSettingsChecked(cardId: string, settings: object): Promise<boolean>
  dispose(cardId: string): Promise<void>
}

interface CardGroup {
  cardId: string
  messageId: string
  chatId: string
  runs: Map<string, AgentRunSnapshot>
  settled: Set<string>
  sealed: boolean
  settingsJson?: string
}

/** A run owns a row; a group owns Card Kit streaming and disposal. */
export class AgentCards {
  private readonly tails = new Map<string, CardGroup>()
  private readonly byRun = new Map<string, CardGroup>()

  constructor(private readonly deps: AgentCardsDeps) {}

  add(run: AgentRunSnapshot): Promise<void> {
    return withChatMessageOrder(run.chatId, async () => {
      const group = this.tails.get(run.chatId)
      if (group) {
        const atTail = await this.deps.getChatTailMessageId(run.chatId) === group.messageId
        if (atTail && this.deps.getElementCount(group.cardId) < CARD_ROW_SOFT_LIMIT) {
          const result = await this.deps.addElementResult(group.cardId, cards.agentRunElement(run))
          if (result.landed) {
            this.attach(group, run)
            // Appending to a completed card reopens the group for this run.
            await this.settings(group)
            return
          }
          if (!isCapacity(result)) throw writeError('agent card append', result)
        }
        await this.seal(group)
      }
      await this.create(run)
    })
  }

  update(run: AgentRunSnapshot, terminal = false): Promise<void> {
    return withChatMessageOrder(run.chatId, async () => {
      let group = this.byRun.get(run.runId)
      if (!group) return // Durable history / a disposed, settled card.
      if (group.settled.has(run.runId)) {
        // A progress callback admitted before finalization must not reopen a
        // completed card; failed terminal settings may still be retried.
        if (terminal) await this.settings(group)
        return
      }
      const errors: string[] = []
      const result = await this.deps.replaceElementResult(group.cardId, cards.agentRunElementId(run.runId), cards.agentRunElement(run))
      if (!result.landed) {
        if (!isCapacity(result) || group.runs.size === 1) throw writeError('agent task row update', result)
        // A later result can exhaust the shared card's byte capacity. Move only
        // this row, keeping every other running task attached to its own card.
        const old = group
        await this.seal(old)
        const tail = this.tails.get(run.chatId)
        if (tail) await this.seal(tail)
        group = await this.create(run)
        // Ownership transfers as soon as the new row exists. Even a failed
        // deletion must not leave a ghost task holding the old card open.
        old.runs.delete(run.runId)
        old.settled.delete(run.runId)
        try {
          if (!await this.deps.deleteElementChecked(old.cardId, cards.agentRunElementId(run.runId))) {
            throw new Error('agent moved task row deletion MISS; the previous card may still show its earlier state')
          }
        } catch (error) { errors.push(String(error)) }
        try { await this.settings(old) }
        catch (error) { errors.push(String(error)) }
      }
      if (terminal) group.settled.add(run.runId)
      try { await this.settings(group) }
      catch (error) { errors.push(String(error)) }
      if (errors.length) throw new Error(errors.join('; '))
    })
  }

  closeChat(chatId: string): Promise<void> {
    return withChatMessageOrder(chatId, async () => {
      const group = this.tails.get(chatId)
      if (group) await this.seal(group)
    })
  }

  private attach(group: CardGroup, run: AgentRunSnapshot): void {
    group.runs.set(run.runId, run)
    this.byRun.set(run.runId, group)
    run.cardMessageId = group.messageId
  }

  private async create(run: AgentRunSnapshot): Promise<CardGroup> {
    const messageId = await this.deps.sendCard(run.chatId, cards.agentRunCard(run))
    if (!messageId) throw new Error('agent card creation failed')
    const cardId = await this.deps.convertMessageToCard(messageId)
    this.deps.recordCardCreated(cardId, 1)
    const group: CardGroup = {
      cardId, messageId, chatId: run.chatId, runs: new Map(), settled: new Set(), sealed: false,
    }
    this.attach(group, run)
    this.tails.set(run.chatId, group)
    return group
  }

  private async seal(group: CardGroup): Promise<void> {
    group.sealed = true
    if (this.tails.get(group.chatId) === group) this.tails.delete(group.chatId)
    await this.settings(group)
  }

  private async settings(group: CardGroup): Promise<void> {
    this.deps.cancelSummary(group.cardId)
    const complete = group.settled.size === group.runs.size
    const settings = {
      config: {
        streaming_mode: !complete,
        summary: { content: cards.agentCardSummary([...group.runs.values()]) },
      },
    }
    const settingsJson = JSON.stringify(settings)
    if (settingsJson !== group.settingsJson) {
      if (!await this.deps.patchSettingsChecked(group.cardId, settings)) throw new Error('agent card settings update MISS')
      group.settingsJson = settingsJson
    }
    if (complete && group.sealed) {
      await this.deps.dispose(group.cardId)
      for (const runId of group.runs.keys()) {
        if (this.byRun.get(runId) === group) this.byRun.delete(runId)
      }
    }
  }
}

function isCapacity(result: CardWriteResult): boolean {
  return isCardCapacityFailure(result.failure?.code, result.failure)
}

function writeError(action: string, result: CardWriteResult): Error {
  return new Error(`${action} MISS${result.failure ? `: ${result.failure.message} (code=${result.failure.code ?? 'MISS'})` : ''}`)
}
