#!/usr/bin/env bun
/** 指定群作为 debug 注入目标；发送者身份只保留在 daemon 内存中。 */
import { writeJsonStateAtomic } from '../src/state-store'
import { DEBUG_CTX_FILE } from '../src/paths'

const chatId = process.argv[2]
if (!chatId || !chatId.startsWith('oc_')) {
  console.error('usage: bun scripts/seed-debug-ctx.ts <chat_id>')
  process.exit(1)
}

writeJsonStateAtomic(DEBUG_CTX_FILE, {
  chat_id: chatId,
  seeded_at: new Date().toISOString(),
  seeded_by: 'seed-debug-ctx.ts',
})
console.log(`wrote debug context to ${DEBUG_CTX_FILE}`)
