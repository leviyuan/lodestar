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
    expect(normal).toContain('最高分优先')
    expect(normal).toContain('#1 · 0.625 份/h')
    expect(normal).toContain('Pro 20×'); expect(normal).toContain('Pro 5×')
    expect(normal).toContain('耗尽 · 暂不参与')
    const ultraCandidates = rows.map(row => ({ ...row, identity: row.fingerprint!, ...rankCodexQuota(row.usage, 'model', Date.now(), 'ultra') }))
    const ultra = JSON.stringify(codexAccountCard({ phase: 'accounts', total, scheduling: { candidates: ultraCandidates, ultra: true } }))
    expect(ultra).toContain('Ultra · Pro ≥ 0.5 份'); expect(ultra).toContain('#1 · 0.625 份/h')
    expect(ultra).toContain('Ultra 自动排除 Plus')
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
    expect(first).toContain('使用中')
    expect(first).toContain('下次启动')
    expect(first).toContain('5h · 0%')
    expect(first).toContain('额度 MISS')
    expect(first).toContain('upstream offline')
    expect(first).toContain('codex-accounts 2')
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
})
