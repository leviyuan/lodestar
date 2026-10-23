import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { fileLoggingEnabled, formatLogDiagnostic, formatLogError, localDayKey, log, logFileForDate, parseLogFileDate, pruneOldLogs } from './log'

describe('log day key', () => {
  test('localDayKey formats local date as YYYY-MM-DD', () => {
    // 月份参数 0-based:5 = 六月
    expect(localDayKey(new Date(2026, 5, 25))).toBe('2026-06-25')
    expect(localDayKey(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(localDayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  test('logFileForDate builds daemon-YYYY-MM-DD.log in the given dir', () => {
    const dir = '/tmp/fake-lodestar'
    expect(logFileForDate(new Date(2026, 5, 25), dir)).toBe(join(dir, 'daemon-2026-06-25.log'))
  })
})

describe('parseLogFileDate', () => {
  test('parses daemon-YYYY-MM-DD.log', () => {
    const d = parseLogFileDate('daemon-2026-06-25.log')
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2026)
    expect(d!.getMonth()).toBe(5) // 六月
    expect(d!.getDate()).toBe(25)
  })

  test('rejects non-log / malformed names', () => {
    expect(parseLogFileDate('daemon.log')).toBeNull()
    expect(parseLogFileDate('daemon-2026-6-5.log')).toBeNull() // 未补零
    expect(parseLogFileDate('daemon-2026-06-25.txt')).toBeNull()
    expect(parseLogFileDate('session-chat-map.json')).toBeNull()
    expect(parseLogFileDate('')).toBeNull()
  })
})

describe('pruneOldLogs', () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), 'lodestar-log-test-'))
  }
  function touch(dir: string, name: string): void {
    writeFileSync(join(dir, name), 'x')
  }

  test('removes logs >= 7 days old; keeps recent + non-logs (retains 7 calendar days incl. today)', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25) // 2026-06-25
    touch(dir, 'daemon-2026-06-17.log') // 8 天前 → 删
    touch(dir, 'daemon-2026-06-18.log') // 7 天前 → 删(ageDays=7)
    touch(dir, 'daemon-2026-06-19.log') // 6 天前 → 留
    touch(dir, 'daemon-2026-06-25.log') // 今天 → 留
    touch(dir, 'daemon.pid')            // 非日志 → 不动
    touch(dir, 'session-chat-map.json') // 非日志 → 不动

    const removed = pruneOldLogs(dir, now, 7)

    expect(removed).toBe(2)
    expect(readdirSync(dir).sort()).toEqual([
      'daemon-2026-06-19.log',
      'daemon-2026-06-25.log',
      'daemon.pid',
      'session-chat-map.json',
    ])
  })

  test('future-dated files are preserved (clock skew safe)', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25)
    touch(dir, 'daemon-2026-06-27.log') // 未来
    touch(dir, 'daemon-2026-06-25.log') // 今天
    expect(pruneOldLogs(dir, now, 7)).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['daemon-2026-06-25.log', 'daemon-2026-06-27.log'])
  })

  test('missing dir returns 0 without throwing', () => {
    expect(pruneOldLogs(join(tmpdir(), 'lodestar-no-such-dir-xyz'), new Date(2026, 5, 25))).toBe(0)
  })

  test('default retention is 7 days', () => {
    const dir = makeDir()
    const now = new Date(2026, 5, 25)
    touch(dir, 'daemon-2026-06-17.log') // 8 天前
    touch(dir, 'daemon-2026-06-18.log') // 7 天前
    expect(pruneOldLogs(dir, now)).toBe(2)
  })
})

describe('test-env file logging guard', () => {
  // 跑测试会把 log() 输出写进生产 daemon-*.log(07-02 的 session "probe"
  // "Claude auth failed" 全是历史测试污染)。bun test 固定设 NODE_ENV=test,
  // 以此为闸:测试进程只打 stderr,不落盘、不迁移、不清理。
  test('fileLoggingEnabled gates on NODE_ENV=test', () => {
    expect(fileLoggingEnabled('test')).toBe(false)
    expect(fileLoggingEnabled('production')).toBe(true)
    expect(fileLoggingEnabled('development')).toBe(true)
    // 显式 undefined 走默认参数(取本进程 env),等价于无参调用;
    // 本进程就是 bun test,必须已处于禁用态
    expect(fileLoggingEnabled(undefined)).toBe(false)
    expect(fileLoggingEnabled()).toBe(false)
  })

  test('log() under bun test writes stderr only — marker never lands in the real day file', () => {
    const marker = `log-test-marker-${process.pid}-${Date.now()}`
    log(marker)
    const todayFile = logFileForDate(new Date())
    const content = existsSync(todayFile) ? readFileSync(todayFile, 'utf8') : ''
    expect(content).not.toContain(marker)
  })
})

describe('operational log privacy', () => {
  test('keeps useful machine diagnostics without serializing upstream errors', () => {
    const error = Object.assign(new Error('private-user@example.test /private/customer/report.txt'), {
      code: 'ECONNRESET',
      request: { headers: { authorization: 'Bearer private-key' }, data: { user: 'private-person' } },
      response: { status: 503, data: { code: 99991400, message: 'oc_private-chat' } },
    })
    expect(formatLogError('transport failed', error)).toBe('transport failed reason=ECONNRESET status=503 code=99991400')
    expect(formatLogError('request failed', new Error('unauthorized for ou_private-person')))
      .toBe('request failed reason=authentication')
    expect(formatLogError('request failed', { get message() { throw new Error('private-person') } }))
      .toBe('request failed reason=unknown')
    expect(formatLogError('request failed', new AggregateError([
      { code: '300308', httpStatus: 500, msg: 'Server Internal Error private-owner' },
    ], 'private-owner'))).toBe('request failed code=300308 status=500 reason=server_error')
  })

  test('does not accept identity fields or arbitrary strings disguised as enums', () => {
    expect(formatLogDiagnostic('request failed', {
      chatId: 'oc_private-chat', sessionId: 'private-session', user: 'private-person',
      count: 17, groups: 3, path: '/private/customer', payload: '{"owner":"private-person"}',
      reason: 'private-person', method: 'GET/oc_private-chat', provider: 'private-provider',
      status: 503, attempt: 2,
    })).toBe('request failed status=503 attempt=2')
  })

  test('both output sinks omit identities and repeated failures do not enumerate users', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lodestar-log-privacy-'))
    const script = `
      import { logError, logDiagnostic } from ${JSON.stringify(new URL('./log.ts', import.meta.url).href)};
      for (const owner of ['private-user-one', 'private-user-two']) {
        const error = Object.assign(new Error('unauthorized ' + owner + ' /private/' + owner), {
          response: { status: 401, data: { user: owner, chat_id: 'oc_' + owner } },
          stack: 'private stack ' + owner,
        });
        logError('transport failed', error);
      }
      logDiagnostic('protocol invalid', { sessionId: 'private-session', count: 2, payload: 'private-body' });
    `
    try {
      const child = Bun.spawnSync([process.execPath, '--eval', script], {
        env: { ...process.env, NODE_ENV: 'production', LODESTAR_DATA_DIR: directory },
        stdout: 'pipe', stderr: 'pipe',
      })
      const stderr = child.stderr.toString()
      expect(child.exitCode).toBe(0)
      expect(child.stdout.toString()).toBe('')
      expect(stderr).not.toMatch(/private-|oc_|\/private\/|count=|suppressed|stack/)
      expect(stderr.trim().split('\n')).toHaveLength(2)
      expect(stderr).toContain('transport failed status=401 reason=authentication')
      const file = readdirSync(directory).find(name => /^daemon-.*\.log$/.test(name))!
      expect(readFileSync(join(directory, file), 'utf8')).toBe(stderr)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
