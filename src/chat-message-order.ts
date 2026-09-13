import { AsyncLocalStorage } from 'node:async_hooks'
import { PerKeyActor } from './card-action-runtime'

/** Serialize new messages with delegation placement in the same chat. Nested
 * sends reuse the current transaction; detached work cannot keep its lease. */
export class ChatMessageOrder {
  private readonly actor = new PerKeyActor()
  private readonly context = new AsyncLocalStorage<{ chatId: string; active: boolean }>()

  run<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const current = this.context.getStore()
    if (current?.active && current.chatId === chatId) return work()
    return this.actor.enqueue(chatId, async () => {
      const lease = { chatId, active: true }
      try { return await this.context.run(lease, work) }
      finally { lease.active = false }
    })
  }
}

const order = new ChatMessageOrder()
export function withChatMessageOrder<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  return order.run(chatId, work)
}
