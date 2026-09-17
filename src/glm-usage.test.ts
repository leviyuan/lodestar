import { describe, expect, test } from 'bun:test'

import { fetchGlmUsage } from './glm-usage'

const FIVE_HOUR = { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1786900000000 }
const WEEKLY = { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 17, nextResetTime: 1787500000000 }
const MONTHLY = { type: 'TIME_LIMIT', percentage: 10, currentValue: 412, usage: 4000, nextResetTime: 1787000000000 }

describe('glm quota/limit 窗口解析(TOKENS_LIMIT 双条按 unit/number 区分)', () => {
  test('无周限额账号:只有一条 TOKENS_LIMIT(unit=3),weekly 落 null', async () => {
    // fetchGlmUsage 走真实 HTTP;parse 逻辑用统一入口间接验证成本高,这里
    // 直接构造响应形状走 parseQuotaLimit 同款分支 —— 通过 fetch mock。
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: {
        level: 'max',
        limits: [FIVE_HOUR, MONTHLY],
      },
    }), { status: 200 })) as any
    try {
      const snap = await fetchGlmUsage('https://open.bigmodel.cn/api/anthropic', 'quota-no-week-account')
      expect(snap.state).toBe('ok')
      if (snap.state !== 'ok') throw new Error('expected ok')
      expect(snap.fiveHour?.percent).toBe(1)
      expect(snap.weekly).toBeNull()
      expect(snap.monthly?.used).toBe(412)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('有周限额账号:两条 TOKENS_LIMIT 并存,旧的 find-第一条 会丢周窗口,现在都解析', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: {
        level: 'max',
        limits: [FIVE_HOUR, WEEKLY, MONTHLY],
      },
    }), { status: 200 })) as any
    try {
      const snap = await fetchGlmUsage('https://open.bigmodel.cn/api/anthropic', 'quota-week-account')
      expect(snap.state).toBe('ok')
      if (snap.state !== 'ok') throw new Error('expected ok')
      expect(snap.fiveHour?.percent).toBe(1)
      expect(snap.weekly?.percent).toBe(17)
      expect(snap.monthly?.percent).toBe(10)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
