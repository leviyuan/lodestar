import { describe, expect, test } from 'bun:test'
import { codexAccountCard, codexAccountPanel, CODEX_ACCOUNTS_PAGE_SIZE, type CodexAccountCardView } from './codex-account'
import { aggregateCodexUsage, type CodexAccountUsage } from '../codex-account-usage'
import { rankCodexQuota } from '../codex-quota'

const waiting: CodexAccountCardView = { phase: 'waiting', name: '工作',
  verification: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' }, hint: '取消：codex-login-cancel 工作' }
function entry(index: number): CodexAccountUsage {
  return { account: { id: String(index), name: `账号 ${index}` }, fingerprint: String(index), usage: {
    state: 'ok', fiveHour: { percent: index * 10, resetsAt: null }, weekly: { percent: 25, resetsAt: null },
    subscriptionType: 'plus', resetCredits: 0, fetchedAt: 1,
  } }
}
describe('compact Codex account cards', () => {
  test('shows descending shares/hour in both modes and explains Ultra exclusions', () => {
    const rows = [entry(0), entry(1), entry(2)]
    for (const [i, row] of rows.entries()) {
      if (row.usage.state !== 'ok') throw new Error('fixture')
      row.usage.subscriptionType = i === 0 ? 'pro' : i === 1 ? 'prolite' : 'plus'
      row.usage.weekly!.resetsAt = new Date(Date.now() + 24 * 3600_000)
      if (i === 2) row.usage.weekly!.percent = 100
    }
    const total = aggregateCodexUsage(rows)
    const candidates = rows.map(row => ({ ...row, identity: row.fingerprint!, ...rankCodexQuota(row.usage, 'model') }))
    const normal = JSON.stringify(codexAccountCard({ phase: 'accounts', total, scheduling: { candidates, ultra: false } }))
    expect(normal).not.toContain('最高分优先')
    expect(normal).not.toContain('个记录')
    expect(normal).toContain('#1·账号 0「0.789/h」')
    expect(normal).not.toContain('Pro 20×'); expect(normal).not.toContain('Pro 5×')
    expect(normal).toContain('耗尽 · 暂不参与')
    const ultraCandidates = rows.map(row => ({ ...row, identity: row.fingerprint!, ...rankCodexQuota(row.usage, 'model', Date.now(), 'ultra') }))
    const ultra = JSON.stringify(codexAccountCard({ phase: 'accounts', total, scheduling: { candidates: ultraCandidates, ultra: true } }))
    expect(ultra).not.toContain('Ultra · Pro ≥ 0.5 份'); expect(ultra).toContain('#1·账号 0「0.789/h」')
    expect(ultra).toContain('Ultra 自动排除 Plus')
  })
  test('renders the scheduling order before pagination, compact quota lines and an unchanged folded command panel', () => {
    const now = Date.now()
    const rows = [entry(0), entry(1), entry(2), entry(3), entry(4)]
    for (const [index, row] of rows.entries()) {
      row.email = `account-${index}@example.test`
      if (row.usage.state !== 'ok') throw new Error('fixture')
      row.usage = { ...row.usage, subscriptionType: 'pro', fetchedAt: now, fiveHour: null,
        weekly: { percent: index === 1 ? 0 : 50,
          resetsAt: new Date(index === 1 ? Math.floor(now / 1000) * 1000 + 168 * 3600_000
            : now + [100, 168, 4, 50, 24][index] * 3600_000), durationMins: 10080 } }
    }
    const firstUsage = rows[1].usage
    if (firstUsage.state !== 'ok') throw new Error('fixture')
    firstUsage.fiveHour = { percent: 0, resetsAt: new Date(now + 2 * 3600_000), durationMins: 300 }
    const total = aggregateCodexUsage(rows)
    const candidates = rows.map(row => ({ ...row, identity: row.fingerprint!, ...rankCodexQuota(row.usage, 'model', now) }))
    const view: CodexAccountCardView = { phase: 'accounts', total, scheduling: { candidates, ultra: false } }
    const panel = codexAccountPanel(view) as any
    const displayed = panel.elements.slice(0, 4)
    expect(displayed.map((row: any) => row.header.title.content.split('「')[0])).toEqual([
      '#1·账号 1', '#2·账号 2', '#3·账号 4', '#4·账号 3',
    ])
    expect(displayed[1].header.title.content).toBe('#2·账号 2「临期优先」')
    expect(displayed[0].elements).toHaveLength(3)
    expect(displayed[0].elements[0].content).toBe("<font color='grey'>邮箱：account-1@example.test</font>")
    expect(displayed[0].elements[1].content).toBe("周　<font color='green'>▱▱▱▱▱▱</font>　0% <font color='grey'>「7.0d」</font>")
    expect(displayed[0].elements[2].content).toBe("5h　<font color='green'>▱▱▱▱▱▱</font>　0% <font color='grey'>「2.0h」</font>")
    expect(displayed[1].elements).toHaveLength(2)
    expect(displayed[1].elements[1].content).toContain('「4.0h」') // Display the real reset time, not the scoring horizon.
    expect(displayed.every((row: any) => row.expanded && row.vertical_spacing === '2px')).toBe(true)
    const next = codexAccountPanel({ ...view, page: 2 }) as any
    expect(next.elements[0].header.title.content).toStartWith('#5·账号 0「')
    expect(next.elements.at(-1)).toEqual(panel.elements.at(-1))
    expect(panel.elements.at(-1).expanded).toBe(false)
    expect(panel.elements.at(-1).header.title.content).toBe('⌨️ Codex 命令')
    expect(total.entries.map(row => row.account.id)).toEqual(['0', '1', '2', '3', '4'])
  })
  test('authorization is prominent and terminal cards remove the code and link', () => {
    const initial = JSON.stringify(codexAccountCard(waiting, true))
    expect(initial).toContain('ABCD-1234')
    expect(initial).toContain('打开授权页')
    expect(initial).toContain('blue-50')
    for (const phase of ['success', 'deleted', 'cancelled', 'expired', 'error'] as const) {
      const final = JSON.stringify(codexAccountCard({ ...waiting, phase, message: phase === 'error' ? '连接失败' : undefined }))
      expect(final).not.toContain('ABCD-1234')
      expect(final).not.toContain('https://auth.openai.com')
      expect(JSON.parse(final).config.streaming_mode).toBe(false)
    }
  })
  test('long diagnostics are collapsed and untrusted names cannot inject mentions or Markdown images', () => {
    const panel = codexAccountPanel({ phase: 'error', name: '<at id=all>![x](bad)', message: '登录失败', details: 'HTTP 503\nservice unavailable' }) as any
    const detail = panel.elements.find((e: any) => e.tag === 'collapsible_panel')
    expect(detail.expanded).toBe(false)
    expect(JSON.stringify(detail)).toContain('HTTP 503')
    expect(panel.header.title.tag).toBe('plain_text')
    const selected = JSON.stringify(codexAccountCard({ phase: 'selected', current: '<at id=all>', selected: '![x](bad)' }))
    expect(selected).not.toContain('<at id=all>')
    expect(selected).not.toContain('![x](bad)')
  })
  test('accounts retain zero and MISS distinctly and use bounded pages', () => {
    const entries = Array.from({ length: CODEX_ACCOUNTS_PAGE_SIZE + 1 }, (_, i) => entry(i))
    entries[1].usage = { state: 'network', reason: 'upstream offline' }
    const total = aggregateCodexUsage(entries)
    const first = JSON.stringify(codexAccountCard({ phase: 'accounts', total, currentId: '0', selectedId: '1' }))
    expect(first).not.toContain('实际邮箱')
    expect(first).toContain('邮箱：MISS')
    expect(first).toContain("5h　<font color='green'>▱▱▱▱▱▱</font>　0%")
    expect(first).toContain('额度 MISS')
    expect(first).toContain('upstream offline')
    expect(first).toContain('codex-accounts 2')
    expect(first).toContain('codex-reset [备注]')
    expect(first).not.toContain(`账号 ${CODEX_ACCOUNTS_PAGE_SIZE}`)
    expect(first).not.toContain('份额')
    const second = JSON.stringify(codexAccountCard({ phase: 'accounts', total, page: 2 }))
    expect(second).toContain(`账号 ${CODEX_ACCOUNTS_PAGE_SIZE}`)
    expect(second).not.toContain('账号 0')
    expect(() => codexAccountCard({ phase: 'accounts', total, page: 3 })).toThrow('页码')
  })
  test('rejects malformed authorization fields before creating unsafe card links', () => {
    expect(() => codexAccountCard({ ...waiting, verification: { url: 'javascript:alert(1)', code: 'CODE' } })).toThrow()
    expect(() => codexAccountCard({ ...waiting, verification: { url: 'https://auth.openai.com', code: '`<at id=all>' } })).toThrow()
  })
  test('reset receipts show authoritative windows, zero cards, and explicit missing data', () => {
    const view: CodexAccountCardView = { phase: 'success', title: '额度已重置', message: '已使用 1 次重置卡。',
      resetUsage: { state: 'ok', fiveHour: { percent: 4, resetsAt: null }, weekly: { percent: 7, resetsAt: null }, resetCredits: 0, fetchedAt: 1 } }
    const card = JSON.stringify(codexAccountCard(view))
    expect(card).toContain('0 次可用'); expect(card).toContain('5h · 4%'); expect(card).toContain('周 · 7%')
    expect(card).not.toContain('登录成功')
    const failed = JSON.stringify(codexAccountCard({ ...view, phase: 'warning', resetUsage: { state: 'network', reason: 'offline' }, details: 'offline' }))
    expect(failed).toContain('额度已重置'); expect(failed).toContain('额度 MISS'); expect(failed).toContain('offline')
    expect(failed).not.toContain('0 次可用')
  })
})
