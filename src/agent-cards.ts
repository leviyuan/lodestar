import * as cards from './cards'
import { isCardCapacityFailure, type CardWriteFailure, type CardWriteResult } from './cardkit'
import { formatFeishuError } from './feishu-errors'
import type { AgentRunSnapshot } from './agent-run-types'
import type { BgTaskEntry } from './cards/background'
import type { AgentCardTaskKind } from './cards/task-kind'
import { withChatMessageOrder } from './chat-message-order'

// Each row has one panel and one Markdown body. Leave room below the
// component ceiling, and also honor actual byte-capacity errors from Card Kit.
const CARD_ROW_SOFT_LIMIT = 50

export interface AgentCardsDeps {
  sendCard(chatId: string, card: object, onFailure?: (error: unknown) => void): Promise<string | null>
  getChatTailMessageId(chatId: string): Promise<string | null>
  convertMessageToCard(messageId: string): Promise<string>
  recordCardCreated(cardId: string, elementCount: number, onFailure?: (code?: number) => void): void
  getElementCount(cardId: string): number
  addElementResult(cardId: string, element: object): Promise<CardWriteResult>
  replaceElementResult(cardId: string, elementId: string, element: object): Promise<CardWriteResult>
  deleteElementChecked(cardId: string, elementId: string, onFailure?: (failure: CardWriteFailure) => void): Promise<boolean>
  cancelSummary(cardId: string): void
  patchSettingsChecked(cardId: string, settings: object, onFailure?: (failure: CardWriteFailure) => void): Promise<boolean>
  dispose(cardId: string): Promise<void>
}

interface CardGroup {
  cardId: string
  messageId: string
  chatId: string
  rows: Map<string, TaskRow>
  settled: Set<string>
  sealed: boolean
  settingsJson?: string
}

interface TaskRow {
  key: string
  chatId: string
  elementId: string
  element: object
  summary: string
  kind: AgentCardTaskKind
  status: string
  terminal: boolean
  attach?: (messageId: string) => void
}

/** All carded work shares placement, capacity and streaming ownership. */
export class AgentCards {
  private readonly tails = new Map<string, CardGroup>()
  private readonly byTask = new Map<string, CardGroup>()
  private readonly background = new Map<string, Map<string, { task: BgTaskEntry; version: number; pendingSettings?: boolean }>>()

  constructor(private readonly deps: AgentCardsDeps) {}

  add(run: AgentRunSnapshot): Promise<void> {
    return this.addRow(runRow(run))
  }

  update(run: AgentRunSnapshot, terminal = false): Promise<void> {
    return this.updateRow(runRow(run), terminal)
  }

  /** Snapshots are immutable. Unchanged entries do not produce Card Kit writes.
   * Native follow-ups get a fresh row; late terminal corrections update the old row. */
  syncBackground(chatId: string, owner: string, tasks: BgTaskEntry[]): Promise<void> {
    return withChatMessageOrder(chatId, async () => {
      let entries = this.background.get(owner)
      if (!entries) this.background.set(owner, entries = new Map())
      const errors: unknown[] = []
      for (const task of tasks) {
        const id = task.displayId ?? task.toolUseId ?? task.id
        const previous = entries.get(id)
        if (previous?.task === task && !previous.pendingSettings) continue
        const restarted = previous && cards.isBgTerminal(previous.task) && !cards.isBgTerminal(task)
        const version = (previous?.version ?? 0) + (restarted ? 1 : 0)
        const key = `background:${owner}:${id}:${version}`
        const row: TaskRow = {
          key, chatId, elementId: cards.BG_ELEMENTS.panel(key),
          element: cards.backgroundTaskPanel({ ...task, id: key }),
          summary: cards.backgroundTaskSummary(task), kind: cards.backgroundTaskKind(task),
          status: task.status, terminal: cards.isBgTerminal(task),
        }
        try {
          if (!previous || restarted) await this.addRow(row)
          else await this.updateRow(row, row.terminal, true)
          entries.set(id, { task, version })
        } catch (error) {
          // The row may have landed even when settings failed. Preserve that
          // terminal boundary so a native follow-up gets its own row, while
          // keeping the failed settings eligible for retry.
          if (this.byTask.get(key)?.rows.get(key) === row) {
            entries.set(id, { task, version, pendingSettings: true })
          }
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
    })
  }

  releaseBackground(owner: string): void {
    this.background.delete(owner)
  }

  private addRow(row: TaskRow): Promise<void> {
    return withChatMessageOrder(row.chatId, async () => {
      // A successful append followed by a settings failure still owns its row.
      const existing = this.byTask.get(row.key)
      if (existing) {
        await this.updateRow(row, row.terminal, true)
        return
      }
      const group = this.tails.get(row.chatId)
      if (group) {
        const atTail = await this.deps.getChatTailMessageId(row.chatId) === group.messageId
        if (atTail && this.deps.getElementCount(group.cardId) < CARD_ROW_SOFT_LIMIT) {
          const result = await this.deps.addElementResult(group.cardId, row.element)
          if (result.landed) {
            this.attach(group, row)
            // Appending to a completed card reopens the group for this run.
            await this.settings(group)
            return
          }
          if (!isCapacity(result)) throw writeError('agent card append', result)
        }
        await this.seal(group)
      }
      await this.create(row)
    })
  }

  private updateRow(row: TaskRow, terminal = false, allowTerminalCorrection = false): Promise<void> {
    return withChatMessageOrder(row.chatId, async () => {
      let group = this.byTask.get(row.key)
      if (!group) return // Durable history / a disposed, settled card.
      if (group.settled.has(row.key) && !allowTerminalCorrection) {
        // A progress callback admitted before finalization must not reopen a
        // completed card; failed terminal settings may still be retried.
        if (terminal) await this.settings(group)
        return
      }
      // 完成后的正文更新可能由 Card Kit 自动重开 streaming。旧的设置缓存
      // 此时不能证明远端仍已关闭，即便补充结果没有改变标题和摘要。
      if (group.settled.size === group.rows.size) group.settingsJson = undefined
      const errors: string[] = []
      const result = await this.deps.replaceElementResult(group.cardId, row.elementId, row.element)
      if (!result.landed) {
        if (!isCapacity(result) || group.rows.size === 1) throw writeError('agent task row update', result)
        // A later result can exhaust the shared card's byte capacity. Move only
        // this row, keeping every other running task attached to its own card.
        const old = group
        await this.seal(old, true)
        const tail = this.tails.get(row.chatId)
        if (tail) await this.seal(tail)
        group = await this.create(row)
        // Ownership transfers as soon as the new row exists. Even a failed
        // deletion must not leave a ghost task holding the old card open.
        old.rows.delete(row.key)
        old.settled.delete(row.key)
        try {
          let failure: CardWriteFailure | undefined
          if (!await this.deps.deleteElementChecked(old.cardId, row.elementId, detail => { failure = detail })) {
            const error = writeError('agent moved task row deletion', { landed: false, failure })
            throw new Error(`${error.message}; the previous card may still show its earlier state`)
          }
        } catch (error) { errors.push(String(error)) }
        try { await this.settings(old) }
        catch (error) { errors.push(String(error)) }
      }
      group.rows.set(row.key, row)
      if (terminal) group.settled.add(row.key)
      else group.settled.delete(row.key)
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

  private attach(group: CardGroup, row: TaskRow): void {
    group.rows.set(row.key, row)
    this.byTask.set(row.key, group)
    if (row.terminal) group.settled.add(row.key)
    row.attach?.(group.messageId)
  }

  private async create(row: TaskRow): Promise<CardGroup> {
    let sendFailure: unknown
    const messageId = await this.deps.sendCard(row.chatId, {
      schema: '2.0',
      config: { update_multi: true, streaming_mode: !row.terminal, summary: { content: row.summary } },
      body: { elements: [row.element] },
    }, error => { sendFailure = error })
    if (!messageId) throw new Error(`agent card creation failed: ${formatFeishuError(sendFailure)}`)
    const cardId = await this.deps.convertMessageToCard(messageId)
    this.deps.recordCardCreated(cardId, 1)
    const group: CardGroup = {
      cardId, messageId, chatId: row.chatId, rows: new Map(), settled: new Set(), sealed: false,
    }
    this.attach(group, row)
    this.tails.set(row.chatId, group)
    return group
  }

  private async seal(group: CardGroup, movingRow = false): Promise<void> {
    group.sealed = true
    if (this.tails.get(group.chatId) === group) this.tails.delete(group.chatId)
    await this.settings(group, !movingRow)
  }

  private async settings(group: CardGroup, allowDisposal = true): Promise<void> {
    this.deps.cancelSummary(group.cardId)
    const complete = group.settled.size === group.rows.size
    const settings = {
      config: {
        streaming_mode: !complete,
        summary: { content: cards.delegationCardSummary([...group.rows.values()]) },
      },
    }
    const settingsJson = JSON.stringify(settings)
    if (settingsJson !== group.settingsJson) {
      let failure: CardWriteFailure | undefined
      if (!await this.deps.patchSettingsChecked(group.cardId, settings, detail => { failure = detail })) {
        throw writeError('agent card settings update', { landed: false, failure })
      }
      group.settingsJson = settingsJson
    }
    if (complete && group.sealed && allowDisposal) {
      await this.deps.dispose(group.cardId)
      for (const key of group.rows.keys()) {
        if (this.byTask.get(key) === group) this.byTask.delete(key)
      }
    }
  }
}

function runRow(run: AgentRunSnapshot): TaskRow {
  return {
    key: `run:${run.runId}`, chatId: run.chatId, elementId: cards.agentRunElementId(run.runId),
    element: cards.agentRunElement(run), summary: cards.agentRunSummary(run), kind: 'delegated', status: run.status,
    terminal: run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled',
    attach: messageId => { run.cardMessageId = messageId },
  }
}

function isCapacity(result: CardWriteResult): boolean {
  return isCardCapacityFailure(result.failure?.code, result.failure)
}

function writeError(action: string, result: CardWriteResult): Error {
  return new Error(`${action} MISS: ${formatFeishuError(result.failure)}`)
}
