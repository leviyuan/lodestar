import { describe, expect, test } from 'bun:test'
import { AGENT_AUDIT_EXCEPTIONS, auditAgentRuntime, type AgentAuditDeps } from './agent-audit'

const PICOMATCH = {
  source: 1109876, name: 'picomatch', dependency: 'picomatch',
  title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', severity: 'high', cwe: ['CWE-1333'], range: '<=4.0.7',
}
const OTHER = {
  source: 1100001, name: 'undici', dependency: 'undici', title: 'undici leaks headers',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'moderate', range: '<8.12.3',
}

/** npm 10 `npm audit --json` 报告的形状：根因公告是对象，受牵连的包只列名字。 */
function report(...advisories: object[]): string {
  const vulnerabilities: Record<string, unknown> = {}
  for (const advisory of advisories as Array<typeof PICOMATCH>) {
    vulnerabilities[advisory.name] = { name: advisory.name, severity: advisory.severity, isDirect: false,
      via: [advisory], effects: ['@deepseek-ai/dsh-hmr'], range: '*', nodes: [`node_modules/${advisory.name}`],
      fixAvailable: { name: '@deepseek-ai/dsh', version: undefined, isSemVerMajor: true } }
  }
  if (advisories.length) {
    vulnerabilities['@deepseek-ai/dsh-hmr'] = { name: '@deepseek-ai/dsh-hmr', severity: 'high', isDirect: false,
      via: advisories.map(advisory => (advisory as typeof PICOMATCH).name), effects: [], range: '*', nodes: [] }
  }
  const total = Object.keys(vulnerabilities).length
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: total, critical: 0, total } } })
}

function deps(output: string, overrides: AgentAuditDeps = {}): AgentAuditDeps & { latestCalls: string[] } {
  const latestCalls: string[] = []
  return {
    runAudit: () => output,
    latestVersion: name => { latestCalls.push(name); return '4.0.7' },
    today: () => '2026-11-18',
    latestCalls,
    ...overrides,
  }
}

function failure(run: () => unknown): string {
  try { run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  throw new Error('expected the audit to fail')
}

describe('Agent runtime audit exceptions', () => {
  test('a clean runtime passes without asking the registry', () => {
    const d = deps(report())
    expect(auditAgentRuntime('codex', '/runtime', d)).toEqual([])
    expect(d.latestCalls).toEqual([])
  })

  test('the listed advisory passes only while the latest release is still affected, with a visible warning', () => {
    const d = deps(report(PICOMATCH))
    const exempted = auditAgentRuntime('dsh', '/runtime', d)
    expect(exempted).toHaveLength(1)
    expect(exempted[0]).toStartWith('⚠️ dsh: 暂时豁免 GHSA-fc5q-39xc-vjpf（picomatch high，受影响范围 <=4.0.7，latest 4.0.7 仍受影响，2026-12-31 到期）')
    expect(d.latestCalls).toEqual(['picomatch'])
    // The expiry day itself is still covered.
    expect(auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH), { today: () => '2026-12-31' }))).toHaveLength(1)
  })

  test('a published fix ends the exception and says how to fix the runtime', () => {
    const message = failure(() => auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH), { latestVersion: () => '4.0.8' })))
    expect(message).toContain('picomatch@4.0.8 已不在受影响范围 <=4.0.7')
    expect(message).toContain('agentRuntimeOverrides.dsh')
  })

  test('an expired exception, an unknown latest version or another agent blocks the release', () => {
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH), { today: () => '2027-01-01' }))))
      .toContain('豁免已于 2026-12-31 到期')
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH), {
      latestVersion: () => { throw new Error('registry ETIMEDOUT') },
    })))).toContain('无法确认上游是否已有修复版本：registry ETIMEDOUT')
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH), { latestVersion: () => 'not-a-version' }))))
      .toContain('版本号无法识别')
    expect(failure(() => auditAgentRuntime('codex', '/runtime', deps(report(PICOMATCH)))))
      .toContain('codex 运行目录 npm audit 未通过')
  })

  test('any other advisory still blocks, even next to an exempted one', () => {
    const message = failure(() => auditAgentRuntime('dsh', '/runtime', deps(report(PICOMATCH, OTHER))))
    expect(message).toBe('dsh 运行目录 npm audit 未通过：\nundici <8.12.3 moderate GHSA-aaaa-bbbb-cccc undici leaks headers')
  })

  test('each affected range of the same advisory is judged on its own', () => {
    // npm 把同一公告的不同受影响区间报成多条 via：2.x 已有修复时不能因 4.x 段仍受影响而放行。
    const fixedLine = { ...PICOMATCH, source: 1109875, range: '<2.3.2' }
    const openLine = { ...PICOMATCH, source: 1109876, range: '>=3.0.0 <=4.0.7' }
    const output = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {
      picomatch: { name: 'picomatch', severity: 'high', via: [fixedLine, openLine], effects: [], range: '*', nodes: [] },
    }, metadata: { vulnerabilities: { total: 1 } } })
    const message = failure(() => auditAgentRuntime('dsh', '/runtime', deps(output)))
    expect(message).toBe('dsh 运行目录 npm audit 未通过：\npicomatch <2.3.2 high GHSA-fc5q-39xc-vjpf '
      + 'picomatch vulnerable to ReDoS through single-branch repeated extglobs'
      + '（picomatch@4.0.7 已不在受影响范围 <2.3.2：请在 agentRuntimeOverrides.dsh 覆盖到修复版本并删除豁免）')
    // Exact duplicates of one entry are still merged and exempted once.
    const twice = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {
      picomatch: { name: 'picomatch', severity: 'high', via: [openLine, openLine], effects: [], range: '*', nodes: [] },
    }, metadata: { vulnerabilities: { total: 1 } } })
    expect(auditAgentRuntime('dsh', '/runtime', deps(twice))).toHaveLength(1)
  })

  test('unreadable or failed audits fail closed', () => {
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps('npm ERR! network'))))
      .toContain('npm audit 输出不是 JSON')
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps(JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'no audit' } })))))
      .toContain('npm audit 没有给出可识别的报告')
    expect(failure(() => auditAgentRuntime('dsh', '/runtime', deps(JSON.stringify({ auditReportVersion: 2,
      vulnerabilities: { picomatch: { name: 'picomatch', via: ['dependency-only'] } },
      metadata: { vulnerabilities: { total: 1 } } })))))
      .toContain('没有公告明细')
  })

  test('every exception names one agent, one GHSA advisory, one package, a reason and a valid date', () => {
    for (const exception of AGENT_AUDIT_EXCEPTIONS) {
      expect(['codex', 'claude', 'dsh']).toContain(exception.agent)
      expect(exception.advisory).toMatch(/^GHSA(?:-[0-9a-z]{4}){3}$/)
      expect(exception.package).toMatch(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)
      expect(exception.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${exception.expires}T00:00:00Z`).toISOString().slice(0, 10)).toBe(exception.expires)
      expect(exception.reason.length).toBeGreaterThan(10)
    }
  })
})
