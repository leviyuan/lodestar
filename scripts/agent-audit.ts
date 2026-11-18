/**
 * 发布验收对自动安装的 latest Agent 运行目录做 `npm audit --omit=dev`，默认任何公告都拦截。
 * `AGENT_AUDIT_EXCEPTIONS` 只临时放行上游还没有修复版本的个别公告，必须同时满足：Agent、
 * 公告编号和包名一致；未过到期日（含当天，UTC）；该包在 npm 上的 latest 版本仍落在公告的
 * 受影响范围内。上游发布修复版本后豁免自动失效，届时在 package.json 的
 * `agentRuntimeOverrides` 把该包覆盖到修复版本并删除豁免。
 */
import { execFileSync } from 'node:child_process'

export type AuditedAgent = 'codex' | 'claude' | 'dsh'

export interface AgentAuditException {
  agent: AuditedAgent
  /** GitHub 公告编号（GHSA-…）。 */
  advisory: string
  package: string
  /** YYYY-MM-DD，含当天（UTC）；过期后照常拦截。 */
  expires: string
  reason: string
}

export const AGENT_AUDIT_EXCEPTIONS: readonly AgentAuditException[] = [{
  agent: 'dsh',
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  expires: '2026-12-31',
  reason: 'picomatch 单分支重复 extglob 的 ReDoS（CVE-2026-112366）：<=4.0.7 全部受影响，最新版就是 4.0.7，上游还没有修复版本；经 @deepseek-ai/dsh-hmr 进入 DSH 运行目录。',
}]

export interface AgentAuditDeps {
  /** 返回 `npm audit --json` 的 stdout。 */
  runAudit?: (directory: string) => string
  /** 返回 npm 上该包 latest 标签的版本号。 */
  latestVersion?: (packageName: string) => string
  /** 返回 UTC 日期 YYYY-MM-DD。 */
  today?: () => string
  exceptions?: readonly AgentAuditException[]
}

interface NpmAdvisory {
  name: string
  url: string
  severity: string
  title: string
  range: string
}

function npmAuditJson(directory: string): string {
  try {
    return execFileSync('npm', ['audit', '--prefix', directory, '--omit=dev', '--json'],
      { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 })
  } catch (error) {
    // npm audit 发现公告时退出码为 1，报告仍在 stdout；其余失败原样抛出。
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.trim()) return stdout
    throw error
  }
}

function npmLatestVersion(packageName: string): string {
  return execFileSync('npm', ['view', packageName, 'version'], { stdio: 'pipe', encoding: 'utf8', timeout: 60_000 }).trim()
}

function advisoriesOf(report: any): NpmAdvisory[] {
  if (!report || typeof report !== 'object' || report.error || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`npm audit 没有给出可识别的报告：${JSON.stringify(report?.error ?? report).slice(0, 500)}`)
  }
  const found = new Map<string, NpmAdvisory>()
  for (const entry of Object.values<any>(report.vulnerabilities)) {
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (!via || typeof via !== 'object') continue
      // 同一个公告可能按受影响区间拆成多条（source、range 不同），每一段都要单独判定，
      // 只合并完全相同的重复项。
      found.set(`${via.source ?? ''}\n${via.url}\n${via.name}\n${via.range}`, {
        name: String(via.name), url: String(via.url), severity: String(via.severity),
        title: String(via.title), range: String(via.range),
      })
    }
  }
  const total = report.metadata?.vulnerabilities?.total
  if (Object.keys(report.vulnerabilities).length > 0 && found.size === 0 || typeof total === 'number' && total > 0 && found.size === 0) {
    throw new Error('npm audit 报告有受影响的包，但没有公告明细')
  }
  return [...found.values()]
}

function ghsaOf(url: string): string | null {
  return /\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})(?:$|[/?#])/i.exec(url)?.[1] ?? null
}

/** 审计一个 Agent 运行目录：返回本次放行的公告说明，其余公告或任何无法确认的情况都抛错。 */
export function auditAgentRuntime(agent: AuditedAgent, directory: string, deps: AgentAuditDeps = {}): string[] {
  const output = (deps.runAudit ?? npmAuditJson)(directory)
  let report: unknown
  try { report = JSON.parse(output) }
  catch { throw new Error(`npm audit 输出不是 JSON：${output.slice(0, 500)}`) }
  const advisories = advisoriesOf(report)
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))()
  const exceptions = deps.exceptions ?? AGENT_AUDIT_EXCEPTIONS
  const blocked: string[] = []
  const exempted: string[] = []
  for (const advisory of advisories) {
    const ghsa = ghsaOf(advisory.url)
    const label = `${advisory.name} ${advisory.range} ${advisory.severity} ${ghsa ?? advisory.url} ${advisory.title}`
    const exception = ghsa ? exceptions.find(item => item.agent === agent
      && item.advisory.toLowerCase() === ghsa.toLowerCase() && item.package === advisory.name) : undefined
    if (!exception) {
      blocked.push(label)
      continue
    }
    if (today > exception.expires) {
      blocked.push(`${label}（豁免已于 ${exception.expires} 到期）`)
      continue
    }
    let latest: string
    try {
      latest = (deps.latestVersion ?? npmLatestVersion)(advisory.name)
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest)) throw new Error(`版本号无法识别：${latest.slice(0, 100)}`)
    } catch (error) {
      blocked.push(`${label}（无法确认上游是否已有修复版本：${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    if (!Bun.semver.satisfies(latest, advisory.range)) {
      blocked.push(`${label}（${advisory.name}@${latest} 已不在受影响范围 ${advisory.range}：请在 agentRuntimeOverrides.${agent} 覆盖到修复版本并删除豁免）`)
      continue
    }
    exempted.push(`⚠️ ${agent}: 暂时豁免 ${ghsa}（${advisory.name} ${advisory.severity}，受影响范围 ${advisory.range}，latest ${latest} 仍受影响，${exception.expires} 到期）：${exception.reason}`)
  }
  if (blocked.length) throw new Error(`${agent} 运行目录 npm audit 未通过：\n${blocked.join('\n')}`)
  return exempted
}
