import { describe, expect, test } from 'bun:test'
import { ChatMessageOrder } from './chat-message-order'

describe('chat message ordering', () => {
  test('keeps same-chat work FIFO, allows nested sends and leaves other chats independent', async () => {
    const queue = new ChatMessageOrder()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.run('a', async () => {
      events.push('start')
      await gate
      await queue.run('a', async () => { events.push('nested-send') })
      events.push('end')
    })
    const next = queue.run('a', async () => { events.push('next') })
    await queue.run('b', async () => { events.push('other-chat') })
    expect(events).toEqual(['start', 'other-chat'])
    release()
    await Promise.all([first, next])
    expect(events).toEqual(['start', 'other-chat', 'nested-send', 'end', 'next'])
  })

  test('propagates a failed send and releases subsequent work', async () => {
    const queue = new ChatMessageOrder()
    const failed = queue.run('chat', async () => { throw new Error('send failed') })
    const next = queue.run('chat', async () => 'sent')
    await expect(failed).rejects.toThrow('send failed')
    expect(await next).toBe('sent')
  })

  test('detached callbacks cannot reuse an expired transaction', async () => {
    const queue = new ChatMessageOrder()
    const events: string[] = []
    let wake!: () => void
    const gate = new Promise<void>(resolve => { wake = resolve })
    let detached!: Promise<void>
    await queue.run('chat', async () => {
      detached = gate.then(() => queue.run('chat', async () => { events.push('detached') }))
    })
    let release!: () => void
    const currentGate = new Promise<void>(resolve => { release = resolve })
    const current = queue.run('chat', async () => { events.push('current'); await currentGate })
    wake()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['current'])
    release()
    await Promise.all([current, detached])
    expect(events).toEqual(['current', 'detached'])
  })
})
