import { localFetch } from './network'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { requireAgentDescription, PROJECT_AGENT_INPUT_ERROR } from './agent-run-types'
import { readAgentProjectClient } from './agent-project-client'

interface CliContext {
  baseUrl: string
  capability: string
  project?: string
}

interface PromptArgs {
  requestId?: string
  requesterOpenId?: string
  identityIds: string[]
  identityId: string
  sessionId: string
  workDir: string
  effort: string
  description: string
  prompt: string
  noWait: boolean
  readStdin: boolean
  json: boolean
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const selected = extractProjectOption(argv)
  argv = selected.argv
  const command = argv.shift() ?? ''
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const context = cliContext(selected.project)
  switch (command) {
    case 'identities': {
      const data = await requestJson(context, 'GET', '/agents/identities')
      process.stdout.write(argv.includes('--json') ? `${JSON.stringify(data, null, 2)}\n` : formatIdentities(data))
      return
    }
    case 'run':
      await runCommand(context, argv)
      return
    case 'follow-up':
    case 'followup':
      await followUpCommand(context, argv)
      return
    case 'answer':
      await answerCommand(context, argv)
      return
    case 'status': {
      const runId = requiredArg(argv[0], 'status requires run_id')
      const data = await requestJson(context, 'GET', `/agents/runs/${encodeURIComponent(runId)}`)
      printRun(data, argv.includes('--json'))
      if (data.status === 'failed' || data.status === 'cancelled') process.exitCode = 1
      return
    }
    case 'cancel': {
      const runId = requiredArg(argv[0], 'cancel requires run_id')
      const data = await requestJson(context, 'DELETE', `/agents/runs/${encodeURIComponent(runId)}`)
      process.stdout.write(`${JSON.stringify(data)}\n`)
      return
    }
    default:
      throw new Error(usage())
  }
}

async function runCommand(context: CliContext, argv: string[]): Promise<void> {
  const parsed = parsePromptArgs(argv, true)
  const prompt = await resolvePrompt(parsed)
  const body = {
    identity_ids: parsed.identityIds,
    description: parsed.description,
    prompt,
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.sessionId ? { session_id: parsed.sessionId } : {}),
    ...(parsed.workDir ? { work_dir: parsed.workDir } : {}),
    ...(parsed.requestId ? { request_id: parsed.requestId } : {}),
    ...(parsed.requesterOpenId ? { requester_open_id: parsed.requesterOpenId } : {}),
  }
  const started = await requestJson(context, 'POST', '/agents/runs', body)
  await presentStartedRun(context, started, parsed.noWait, parsed.json)
}

async function followUpCommand(context: CliContext, argv: string[]): Promise<void> {
  const runId = requiredArg(argv.shift(), 'follow-up requires run_id')
  const parsed = parsePromptArgs(argv, false)
  const prompt = await resolvePrompt(parsed)
  const body = {
    description: parsed.description,
    prompt,
    ...(parsed.identityId ? { identity_id: parsed.identityId } : {}),
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.workDir ? { work_dir: parsed.workDir } : {}),
    ...(parsed.requestId ? { request_id: parsed.requestId } : {}),
    ...(parsed.requesterOpenId ? { requester_open_id: parsed.requesterOpenId } : {}),
  }
  const started = await requestJson(context, 'POST', `/agents/runs/${encodeURIComponent(runId)}/follow-up`, body)
  await presentStartedRun(context, started, parsed.noWait, parsed.json)
}

async function answerCommand(context: CliContext, argv: string[]): Promise<void> {
  if (context.project) throw new Error(PROJECT_AGENT_INPUT_ERROR)
  const runId = requiredArg(argv.shift(), 'answer requires run_id')
  let identityId = ''
  let requestId = ''
  let readStdinFlag = false
  const answers: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => requiredArg(argv[++i], `${arg} requires a value`)
    switch (arg) {
      case '--identity': case '-i': identityId = next(); break
      case '--request': requestId = next(); break
      case '--answer': {
        const pair = next()
        const split = pair.indexOf('=')
        if (split <= 0) throw new Error('--answer must be question-or-id=value')
        answers[pair.slice(0, split)] = pair.slice(split + 1)
        break
      }
      case '--stdin': readStdinFlag = true; break
      default: throw new Error(`unknown answer option: ${arg}`)
    }
  }
  if (readStdinFlag) {
    const raw = (await readStdin()).trim()
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { throw new Error('answer stdin must be a JSON object') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('answer stdin must be a JSON object')
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) answers[key] = String(value)
  }
  if (!requestId) throw new Error('answer requires --request')
  if (Object.keys(answers).length === 0) throw new Error('answer requires --answer or --stdin')
  const run = await requestJson(context, 'POST', `/agents/runs/${encodeURIComponent(runId)}/answer`, {
    request_id: requestId,
    answers,
    ...(identityId ? { identity_id: identityId } : {}),
  })
  await waitAndPrintRun(context, String(run.run_id ?? runId))
}

export function parsePromptArgs(argv: string[], identitiesRequired: boolean): PromptArgs {
  const out: PromptArgs = {
    identityIds: [], identityId: '', sessionId: '', workDir: '', effort: '', description: '', prompt: '', noWait: false, readStdin: false, json: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => requiredArg(argv[++i], `${arg} requires a value`)
    switch (arg) {
      case '--identity': case '-i':
        if (identitiesRequired) out.identityIds.push(next())
        else out.identityId = next()
        break
      case '--effort': out.effort = next(); break
      case '--request-id':
        if (out.requestId) throw new Error('--request-id may only be specified once')
        out.requestId = next(); break
      case '--requester':
        if (out.requesterOpenId) throw new Error('--requester may only be specified once')
        out.requesterOpenId = next(); break
      case '--description': out.description = next(); break
      case '--workdir':
        if (out.workDir) throw new Error('--workdir may only be specified once')
        next(); out.workDir = argv[i]!; break
      case '--session':
        if (!identitiesRequired) throw new Error('--session is only supported by run; follow-up accepts a run_id')
        if (out.sessionId) throw new Error('--session may only be specified once')
        out.sessionId = next()
        break
      case '--prompt': next(); out.prompt = argv[i]!; break
      case '--stdin': out.readStdin = true; break
      case '--no-wait': out.noWait = true; break
      case '--json': out.json = true; break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
        positional.push(arg)
    }
  }
  out.identityIds = [...new Set(out.identityIds)]
  if (out.sessionId && out.identityIds.length > 1) throw new Error('--session accepts at most one --identity')
  if (identitiesRequired && !out.sessionId && out.identityIds.length === 0) throw new Error('run requires at least one --identity')
  out.description = requireAgentDescription(out.description)
  if (!out.prompt && positional.length) out.prompt = positional.join(' ')
  if (!out.prompt) out.readStdin = true
  return out
}

async function resolvePrompt(parsed: PromptArgs): Promise<string> {
  const stdin = parsed.readStdin ? await readStdin() : ''
  const prompt = parsed.prompt || stdin
  if (!prompt.trim()) throw new Error('agent prompt is empty')
  return prompt
}

async function presentStartedRun(context: CliContext, started: any, noWait: boolean, json: boolean): Promise<void> {
  const runId = String(started.run_id ?? '')
  if (!runId) throw new Error('agent API returned no run_id')
  if (noWait) {
    process.stdout.write(`${JSON.stringify(started, null, 2)}\n`)
    if (started.status === 'failed' || started.status === 'cancelled') process.exitCode = 1
    return
  }
  await waitAndPrintRun(context, runId, json)
}

async function waitAndPrintRun(context: CliContext, runId: string, json = false): Promise<void> {
  let cancelling = false
  const cancel = () => {
    if (cancelling) return
    cancelling = true
    void requestJson(context, 'DELETE', `/agents/runs/${encodeURIComponent(runId)}`)
      .then(() => process.exit(130), error => {
        process.stderr.write(`lodestar-agent: cancellation failed: ${messageOf(error)}\n`)
        process.exit(1)
      })
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    while (true) {
      const run = await requestJson(context, 'GET', `/agents/runs/${encodeURIComponent(runId)}`)
      if (run.status === 'needs_input' || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        printRun(run, json)
        if (run.status === 'failed' || run.status === 'cancelled') process.exitCode = 1
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

export function extractProjectOption(argv: string[]): { project?: string; argv: string[] } {
  let project: string | undefined
  const remaining: string[] = []
  const paired = new Set(['--identity', '-i', '--effort', '--description', '--workdir', '--session', '--prompt',
    '--request', '--answer', '--request-id', '--requester'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project') {
      if (project !== undefined) throw new Error('--project may only be specified once')
      project = requiredArg(argv[++i], '--project requires a project name')
    } else {
      remaining.push(arg)
      if (paired.has(arg) && i + 1 < argv.length) remaining.push(argv[++i])
    }
  }
  return { ...(project !== undefined ? { project } : {}), argv: remaining }
}

function cliContext(project?: string): CliContext {
  if (project !== undefined) {
    if (process.env.LODESTAR_AGENT_ROLE === 'worker') throw new Error('Delegated Agents cannot start project calls')
    if (['LODESTAR_AGENT_ROLE', 'LODESTAR_AGENT_URL', 'LODESTAR_AGENT_CAPABILITY', 'LODESTAR_AGENT_SESSION', 'DSH_LODESTAR_AGENT_CONTEXT']
      .some(key => process.env[key] !== undefined)) {
      throw new Error('Agent task calls must remain session-bound; --project is only for independent services and applications')
    }
    return { ...readAgentProjectClient(), project }
  }
  if (process.env.DSH_LODESTAR_AGENT_CONTEXT !== undefined) {
    const context = JSON.parse(process.env.DSH_LODESTAR_AGENT_CONTEXT)
    if (typeof context.baseUrl !== 'string' || !context.baseUrl || typeof context.capability !== 'string' || !context.capability) {
      throw new Error('invalid DSH Lodestar delegation context')
    }
    return { baseUrl: context.baseUrl.replace(/\/+$/, ''), capability: context.capability }
  }
  const baseUrl = String(process.env.LODESTAR_AGENT_URL ?? '').replace(/\/+$/, '')
  const capability = String(process.env.LODESTAR_AGENT_CAPABILITY ?? '')
  if (!baseUrl || !capability) {
    throw new Error('lodestar-agent must run inside a Lodestar-managed Agent session (missing capability)')
  }
  return { baseUrl, capability }
}

async function requestJson(context: CliContext, method: string, path: string, body?: object): Promise<any> {
  const url = new URL(`${context.baseUrl}${path}`)
  if (context.project) url.searchParams.set('project', context.project)
  const response = await localFetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${context.capability}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let value: any
  try { value = JSON.parse(text) }
  catch { throw new Error(`agent API ${method} ${path} returned HTTP ${response.status}: ${text || '(empty)'}`) }
  if (!response.ok) throw new Error(value?.error ?? `agent API HTTP ${response.status}`)
  return value
}

function formatIdentities(value: any): string {
  const lines = [`catalog ${value.catalog_generation ?? 'MISS'}`]
  for (const identity of value.identities ?? []) {
    lines.push([
      identity.status === 'ready' ? '✅' : 'MISS',
      identity.id,
      identity.display_name,
      identity.model,
      `default-effort=${identity.default_effort}`,
      identity.source_default ? 'source-default' : '',
      identity.reason ?? '',
    ].filter(Boolean).join(' · '))
  }
  for (const failure of value.source_failures ?? []) lines.push(`MISS · ${failure.display} · ${failure.reason}`)
  return `${lines.join('\n')}\n`
}

function printRun(run: any, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(run, null, 2)}\n` : formatRun(run))
}

function formatRun(run: any): string {
  const command = `lodestar-agent${run.binding === 'project' ? ` --project ${shellQuote(String(run.project))}` : ''}`
  const lines = [
    `# Lodestar agent ${run.run_id ?? 'MISS'}`,
    '',
    `- Status: ${run.status ?? 'MISS'}`,
    ...(run.binding === 'project' ? [`- Project: ${run.project}`] : []),
    `- Description: ${run.description ?? 'MISS'}`,
    `- Work directory: ${run.work_dir ?? 'MISS'}`,
    ...(run.parent_run_id ? [`- Parent: ${run.parent_run_id} (${run.parent_kind ?? 'delegate'})`] : []),
  ]
  if (run.error) lines.push(`- Error: ${run.error}`)
  for (const worker of run.workers ?? []) {
    lines.push('', `## ${worker.identity_name ?? worker.identity_id}`, '', `Status: ${worker.status}`)
    if (worker.session_id) lines.push(`Session: ${worker.session_id}`)
    if (worker.error) lines.push('', `Error: ${worker.error}`)
    if (worker.pending_input) {
      lines.push('', `Input request: ${worker.pending_input.request_id}`)
      for (const question of worker.pending_input.questions ?? []) {
        lines.push(`- [${question.id}] ${question.question}`)
        if (question.options?.length) lines.push(`  Options: ${question.options.map((option: any) => option.label).join(' / ')}`)
      }
      lines.push('', 'Answer with:', `${command} answer ${shellQuote(run.run_id)} --identity ${shellQuote(worker.identity_id)} --request ${shellQuote(worker.pending_input.request_id)} --stdin`)
    }
    if (worker.output) lines.push('', worker.output)
    if (worker.session_id && worker.identity_id
      && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      lines.push('', 'Continue with:',
        `${command} run --session ${shellQuote(worker.session_id)} --identity ${shellQuote(worker.identity_id)} --description '<brief next step>' --stdin`)
    }
  }
  if (run.presentation_errors?.length) {
    lines.push('', 'Presentation errors:', ...run.presentation_errors.map((error: string) => `- ${error}`))
  }
  return `${lines.join('\n')}\n`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function requiredArg(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message)
  return value.trim()
}

function usage(): string {
  return [
    'Usage:',
    '  lodestar-agent --project <project-or-worktree> <command> [options]',
    '  lodestar-agent identities [--json]',
    '  lodestar-agent run --identity <id> [--identity <id>...] --description <summary> [--workdir <path>] [--effort <level>] [--json] --stdin',
    '  lodestar-agent run --session <session_id> [--identity <id>] --description <summary> [--workdir <path>] [--effort <level>] [--json] --stdin',
    '  lodestar-agent follow-up <run_id> [--identity <id>] --description <summary> [--workdir <path>] [--effort <level>] [--json] --stdin',
    '  lodestar-agent answer <run_id> [--identity <id>] --request <id> (--answer key=value | --stdin)',
    '  lodestar-agent status <run_id> [--json]',
    '  lodestar-agent cancel <run_id>',
    '',
    'Use --prompt <text> instead of --stdin for inline input. --no-wait returns the started run as JSON.',
    'Agent task calls must use the managed-session context. --project is only for independent services and applications.',
    'Without --project, the existing managed-session context is required; invalid contexts never switch modes.',
    'Project run/follow-up: --request-id <unique-key> deduplicates retries; --requester <open_id> records the requester only.',
    'Project calls are non-interactive and never wait for answers. The answer command is only for session-bound delegation.',
    'Agent results and local artifact paths return to the caller. File-delivery markers are not executed.',
    '--session resumes the unique native conversation id only within its registered project and group.',
    'Unknown ownership and cross-project/group resumes are rejected, even with an explicit identity.',
    '--identity may change the model/source within the original backend; effort and project-local workdir may be overridden.',
    'The new run belongs to the current caller; the previous run keeps its original owner and cancellation scope.',
    '--workdir defaults to the managed-session or explicit-project directory; relative paths are resolved from it.',
    'New conversations and resumes stay within that project root. Resumes otherwise reuse the recorded directory.',
    'session_id is the stable conversation identity; run_id identifies only one invocation, not a second session.',
    '--description is required for every run/follow-up: one short line, at most 60 characters, shown on the collapsed card.',
    'Each turn has a new run_id; workers[].session_id identifies the native conversation.',
  ].join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// npm preserves the command symlink in argv[1]; compare the actual files.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`lodestar-agent: ${messageOf(error)}\n`)
    process.exitCode = 1
  })
}
