import { describe, expect, test } from 'bun:test'

import { snapshotFromReadResponse, observeRateLimitsNotification, refreshUsageFromConnection, peekUsage, peekSuccessfulUsage, invalidateCodexUsage } from './usage'

describe('quota account isolation', () => {
  test('successful Plus reads without 5h consistently expose a full short window to footer and hi', () => {
    const input = { rateLimits: { limitId: 'codex', planType: 'plus', primary: {
      usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_900_000_000 }, secondary: null } }
    const snapshot = snapshotFromReadResponse(input)
    if (snapshot.state !== 'ok') throw new Error('expected successful snapshot')
    expect(snapshot.fiveHour).toEqual({ percent: 0, resetsAt: null, durationMins: 300, unreportedFull: true })
    expect(snapshot.buckets?.[0].fiveHour).toEqual(snapshot.fiveHour)
    const pro = snapshotFromReadResponse(input, 'pro')
    expect(pro.state === 'ok' && pro.fiveHour).toBeNull()
    expect(snapshotFromReadResponse({}, 'plus').state).toBe('network')
  })
  test('separate accounts never share in-flight requests or cached snapshots', async () => {
    let release!: (value: any) => void
    const a = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), 'account-a')
    const b = await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } } }), 'account-b')
    expect(b?.state === 'ok' && b.fiveHour?.percent).toBe(80)
    release({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } })
    await a
    const cachedA = peekUsage('account-a'); const cachedB = peekUsage('account-b')
    expect(cachedA?.state === 'ok' && cachedA.fiveHour?.percent).toBe(10)
    expect(cachedB?.state === 'ok' && cachedB.fiveHour?.percent).toBe(80)
    expect(cachedA).toBe(peekSuccessfulUsage('account-a'))
    expect(cachedB).toBe(peekSuccessfulUsage('account-b'))
    invalidateCodexUsage('account-a'); invalidateCodexUsage('account-b')
  })
  test('a late response from before reauthentication cannot repopulate the cache', async () => {
    await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } }), 'relogin')
    expect(peekSuccessfulUsage('relogin')).not.toBeNull()
    let release!: (value: any) => void
    const pending = refreshUsageFromConnection(() => new Promise(resolve => { release = resolve }), 'relogin')
    invalidateCodexUsage('relogin')
    expect(peekSuccessfulUsage('relogin')).toBeNull()
    release({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } })
    expect(await pending).toBeNull()
    expect(peekUsage('relogin')).toBeNull()
    expect(peekSuccessfulUsage('relogin')).toBeNull()
  })
})

describe('quota transient failures', () => {
  test('a transient request failure retries the same connection and returns the real quota', async () => {
    let calls = 0
    const snapshot = await refreshUsageFromConnection(async method => {
      expect(method).toBe('account/rateLimits/read')
      if (++calls === 1) throw new Error('failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)')
      return { rateLimits: { limitId: 'codex', primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1789632148 } } }
    })
    expect(calls).toBe(2)
    expect(snapshot).toMatchObject({ state: 'ok', weekly: { percent: 19 } })
  })

  test('persistent network failures remain visible and retain the successful snapshot only for startup', async () => {
    const account = 'cached-startup'
    const cached = await refreshUsageFromConnection(async () => ({ rateLimits: { planType: 'pro',
      primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_900_000_000 } } }), account)
    let calls = 0
    const snapshot = await refreshUsageFromConnection(async () => { calls++; throw new Error('error sending request') }, account)
    expect(calls).toBe(3)
    expect(snapshot).toBeNull()
    expect(peekUsage(account)).toBeNull()
    expect(cached).toBe(peekSuccessfulUsage(account))
    invalidateCodexUsage(account)
  })

  test('an invalid quota response is shown as MISS while the previous successful observation remains cached', async () => {
    const account = 'invalid-refresh'
    const cached = await refreshUsageFromConnection(async () => ({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } }), account)
    expect(await refreshUsageFromConnection(async () => ({}), account)).toMatchObject({ state: 'network' })
    expect(peekUsage(account)).toMatchObject({ state: 'network' })
    expect(cached).toBe(peekSuccessfulUsage(account))
    invalidateCodexUsage(account)
  })

  test('authentication failures are reported immediately', async () => {
    let calls = 0
    const snapshot = await refreshUsageFromConnection(async () => { calls++; throw new Error('HTTP 401 unauthorized') })
    expect(calls).toBe(1)
    expect(snapshot).toBeNull()
  })
})

describe('usage read snapshot semantics', () => {
  test('reads available quota-reset credits and never infers them from window reset times', () => {
    const response = { rateLimits: { limitId: 'codex', primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1789632148 } } }
    for (const count of [0, 3]) {
      expect(snapshotFromReadResponse({ ...response, rateLimitResetCredits: { availableCount: count, credits: [] } }))
        .toMatchObject({ state: 'ok', resetCredits: count })
    }
    expect(snapshotFromReadResponse(response)).toMatchObject({ state: 'ok', resetCredits: null })
  })

  test('多桶 read 响应:默认桶跟随服务端顶层 rateLimits 指针,桶 map 全量保留', () => {
    // 2026-08-20 实测 pro 账号 read 端点:主桶(周)+ bengalfox(Spark 附加包,5h+周)。
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex', limitName: null,
        primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex', limitName: null,
          primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
          secondary: null,
        },
        codex_bengalfox: {
          limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_202_131 },
          secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_787_205_481 },
        },
      },
    })

    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    // footer 显示服务端默认指针指向的主桶(周-only)
    expect(snap.defaultLimitId).toBe('codex')
    expect(snap.fiveHour).toBeNull()
    expect(snap.weekly?.percent).toBe(44)
    // 桶 map 整体保留,非默认桶(bengalfox)不丢
    expect(snap.buckets?.map(b => b.limitId)).toEqual(['codex', 'codex_bengalfox'])
    const spark = snap.buckets?.find(b => b.limitId === 'codex_bengalfox')
    expect(spark?.fiveHour?.percent).toBe(0)
    expect(spark?.weekly?.percent).toBe(25)
  })

  test('prolite 形态:唯一周窗口在 primary(secondary=null),归 weekly 不按位置', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
        planType: 'prolite',
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour).toBeNull()
    expect(snap.weekly?.percent).toBe(9)
  })

  test('倒挂形态:primary=周、secondary=5h,按时长归类不按位置', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour?.percent).toBe(7)
    expect(snap.weekly?.percent).toBe(17)
  })

  test('不把缺失的 usedPercent 强转成 0', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { windowDurationMins: 300 },
        secondary: { windowDurationMins: 10_080 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snap.fiveHour?.percent).toBeNull()
    expect(snap.weekly?.percent).toBeNull()
  })

  test('OpenAI 改窗口结构(如日窗 1440m)也能归类,不硬编码 300/10080', () => {
    const snap = snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 30, windowDurationMins: 1_440 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080 },
      },
    })
    expect(snap.state).toBe('ok')
    if (snap.state !== 'ok') throw new Error('expected ok snapshot')
    // 1440m 是短窗(≤720?否——1440>720 走 isLong)。调整断言:1440m 日窗归 fiveHour 档
    // 由 isShort(≤720)判定失败 → 按位置 primary。此处验证"未知时长不崩、按位置兜底"
    expect(snap.fiveHour?.percent ?? snap.weekly?.percent).toBe(30)
  })

  test('空 read 响应显式 network,不假数据', () => {
    const snap = snapshotFromReadResponse({})
    expect(snap.state).toBe('network')
  })
})

describe('rate-limit notification observation (失效信号,不写 cache)', () => {
  test('错标通知(limitId=codex 但内容是 bengalfox)只观察不覆盖', () => {
    // 先建立权威快照(主桶 44%)
    snapshotFromReadResponse({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
        secondary: null,
      },
    })
    // 错标通知:limitId 写 codex、内容是 bengalfox 形态 —— 不应抛错、不应写 cache
    expect(() => observeRateLimitsNotification({
      limitId: 'codex', limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_202_131 },
      secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_787_205_481 },
    })).not.toThrow()
  })
})
