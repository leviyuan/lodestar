#!/usr/bin/env bun
/**
 * 向运行中的 daemon 注入消息。daemon 需以 `LODESTAR_DEBUG_SOCKET=1` 在 Bun 下启动；
 * 先在目标群发送 `[DEBUG]hi` 保存目标群；发送者只保留在 daemon 内存中。
 * 每次注入会向该群发送成员可见的测试消息，再交给正常消息处理流程。
 *
 * bun scripts/test-inject.ts [--delay <ms>] <text>...
 */
import { injectDebugMessage } from './debug-client'

function parseArgs(argv: string[]): { delay: number; texts: string[] } {
  let delay = 200
  const texts: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--delay') {
      const value = argv[++i]
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--delay must be a non-negative integer in milliseconds')
      }
      delay = Number(value)
    } else {
      texts.push(arg)
    }
  }
  if (!texts.length) throw new Error('usage: bun scripts/test-inject.ts [--delay <ms>] <text>...')
  return { delay, texts }
}

try {
  const { delay, texts } = parseArgs(process.argv.slice(2))
  for (const [i, text] of texts.entries()) {
    const body = await injectDebugMessage(text)
    console.log(`[${i + 1}/${texts.length}] text=${JSON.stringify(text)} ${body}`)
    if (delay > 0 && i < texts.length - 1) await Bun.sleep(delay)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
