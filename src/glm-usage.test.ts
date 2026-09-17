import { describe, expect, test } from 'bun:test'

import { fetchGlmUsage } from './glm-usage'

const FIVE_HOUR = { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1786900000000 }
const WEEKLY = { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 17, nextResetTime: 1787500000000 }
const MONTHLY = { type: 'TIME_LIMIT', percentage: 10, currentValue: 412, usage: 4000, nextResetTime: 1787000000000 }

describe('glm quota/limit 窗口解析(TOKENS_LIMIT 双条按 unit/number 区分)', () => {
  test.each(['object', 'array'])('CREDIT_LIMIT 的 %s 响应保留五小时和周窗口', async shape => {
    const origFetch = globalThis.fetch
    const limits = [
      { ...FIVE_HOUR, type: 'CREDIT_LIMIT', percentage: 3 },
      { ...WEEKLY, type: 'CREDIT_LIMIT', percentage: 12 },
    ]
    globalThis.fetch = (async () => Response.json({ code: 200, success: true,
      data: shape === 'object' ? { level: 'standard', limits } : limits })) as unknown as typeof fetch
    try {
      const snapshot = await fetchGlmUsage('https://open.bigmodel.cn/api/anthropic', `credit-window-${shape}`)
      expect(snapshot).toMatchObject({ state: 'ok', fiveHour: { percent: 3 }, weekly: { percent: 12 }, monthly: null })
      if (snapshot.state !== 'ok') throw new Error('expected ok')
      expect(snapshot.fiveHour?.resetsAt?.getTime()).toBe(FIVE_HOUR.nextResetTime)
      expect(snapshot.weekly?.resetsAt?.getTime()).toBe(WEEKLY.nextResetTime)
    } finally { globalThis.fetch = origFetch }
  })

  test('mixed token and credit windows remain independent and missing percentages stay MISS', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ success: true, data: { limits: [
      { ...FIVE_HOUR, type: 'CREDIT_LIMIT', percentage: undefined }, WEEKLY, MONTHLY,
    ] } })) as unknown as typeof fetch
    try {
      expect(await fetchGlmUsage('https://open.bigmodel.cn/api/anthropic', 'mixed-credit-windows'))
        .toMatchObject({ state: 'ok', fiveHour: { percent: null }, weekly: { percent: 17 }, monthly: { percent: 10 } })
    } finally { globalThis.fetch = origFetch }
  })

  test.each([
    [{ code: 500, success: false, msg: 'Internal service error' }, 'code 500: Internal service error'],
    [{ error: { code: '401', message: 'token invalid' } }, 'code 401: token invalid'],
    [{ code: '429', success: false, message: 'too many requests' }, 'code 429: too many requests'],
    [{ success: true, data: {} }, '缺少 limits 数组'],
    [{ success: true, data: { limits: [{ type: 'UNKNOWN_LIMIT', percentage: 1 }] } }, '没有可识别的额度窗口'],
  ] as const)('upstream error or unrecognized response stays a failure: %j', async (body, reason) => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch
    try {
      const snapshot = await fetchGlmUsage('https://open.bigmodel.cn/api/anthropic', `invalid-quota-${reason}`)
      expect(snapshot.state).toBe('code' in body && body.code === '429' ? 'rate_limited' : 'network')
      expect('reason' in snapshot && snapshot.reason).toContain(reason)
    } finally { globalThis.fetch = origFetch }
  })

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
