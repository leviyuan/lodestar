import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { agentRuntimeRoot } from './agent-updates'

test('native SDK wire requests exclude project question/approval tools and refresh policies on resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-input-boundary-test-'))
  const runtime = agentRuntimeRoot('claude')
  const runtimes = join(root, 'runtimes')
  mkdirSync(join(runtimes, 'claude'), { recursive: true })
  writeFileSync(join(runtimes, 'claude', 'current.json'), JSON.stringify({
    directory: runtime, checkedAt: Date.now(), versions: {
      '@anthropic-ai/claude-agent-sdk': JSON.parse(readFileSync(join(runtime, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version,
    },
  }))
  const output = join(root, 'capture')
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/test-agent-input-boundary.ts'),
      '--agent-runtimes', runtimes, '--output-dir', output], {
      cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
    expect(report.errors).toEqual([])
    expect(report.projectNeedsInputSnapshots).toBe(0)
    expect(report.completed.map((item: any) => [item.name, item.needsInput])).toEqual([
      ['project_fresh', 0], ['project_resume', 0], ['session_control', 1], ['session_to_project', 0], ['project_to_session', 1],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

for (const codeMode of [false, true]) test(`native Codex preserves delegation and execution across input policies (codeMode=${codeMode})`, async () => {
  const parent = join(homedir(), '.cache', 'lodestar-acceptance')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'codex-input-boundary-test-'))
  const runtime = agentRuntimeRoot('codex')
  const runtimes = join(root, 'runtimes')
  mkdirSync(join(runtimes, 'codex'), { recursive: true })
  writeFileSync(join(runtimes, 'codex', 'current.json'), JSON.stringify({
    directory: runtime, checkedAt: Date.now(), versions: {
      '@openai/codex': JSON.parse(readFileSync(join(runtime, 'node_modules/@openai/codex/package.json'), 'utf8')).version,
    },
  }))
  const output = join(root, 'capture')
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/test-codex-input-boundary.ts'),
      '--agent-runtimes', runtimes, '--output-dir', output,
      ...(codeMode ? ['--model', 'gpt-6-astra', '--effort', 'xhigh', '--code-mode', '--fresh-only'] : []),
    ], {
      cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
    expect(report.validationStatus).toBe('passed')
    expect(report.errors).toEqual([])
    expect(report.projectNeedsInputSnapshots).toBe(0)
    expect(report.completed.filter((item: any) => !item.seed).map((item: any) => [item.name, item.needsInput])).toEqual(codeMode
      ? [['project_fresh', 0], ['session_control', 0]]
      : [['project_fresh', 0], ['session_control', 1], ['project_resume', 0], ['session_to_project', 0],
        ['project_to_session', 1], ['plan_to_session', 1], ['plan_to_project', 0]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
