import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface CliContext {
  baseUrl: string
  capability: string
}

interface PromptArgs {
  identityIds: string[]
  identityId: string
  effort: string
  prompt: string
  noWait: boolean
  readStdin: boolean
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv.shift() ?? ''
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const context = cliContext()
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
      process.stdout.write(formatRun(data))
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
    prompt,
    ...(parsed.effort ? { effort: parsed.effort } : {}),
  }
  const started = await requestJson(context, 'POST', '/agents/runs', body)
  await presentStartedRun(context, started, parsed.noWait)
}

async function followUpCommand(context: CliContext, argv: string[]): Promise<void> {
  const runId = requiredArg(argv.shift(), 'follow-up requires run_id')
  const parsed = parsePromptArgs(argv, false)
  const prompt = await resolvePrompt(parsed)
  const body = {
    prompt,
    ...(parsed.identityId ? { identity_id: parsed.identityId } : {}),
    ...(parsed.effort ? { effort: parsed.effort } : {}),
  }
  const started = await requestJson(context, 'POST', `/agents/runs/${encodeURIComponent(runId)}/follow-up`, body)
  await presentStartedRun(context, started, parsed.noWait)
}

async function answerCommand(context: CliContext, argv: string[]): Promise<void> {
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
    identityIds: [], identityId: '', effort: '', prompt: '', noWait: false, readStdin: false,
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
      case '--prompt': out.prompt = next(); break
      case '--stdin': out.readStdin = true; break
      case '--no-wait': out.noWait = true; break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
        positional.push(arg)
    }
  }
  out.identityIds = [...new Set(out.identityIds)]
  if (identitiesRequired && out.identityIds.length === 0) throw new Error('run requires at least one --identity')
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

async function presentStartedRun(context: CliContext, started: any, noWait: boolean): Promise<void> {
  const runId = String(started.run_id ?? '')
  if (!runId) throw new Error('agent API returned no run_id')
  if (noWait) {
    process.stdout.write(`${JSON.stringify(started, null, 2)}\n`)
    return
  }
  await waitAndPrintRun(context, runId)
}

async function waitAndPrintRun(context: CliContext, runId: string): Promise<void> {
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
        process.stdout.write(formatRun(run))
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

function cliContext(): CliContext {
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
  const response = await fetch(`${context.baseUrl}${path}`, {
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

function formatRun(run: any): string {
  const lines = [
    `# Lodestar agent ${run.run_id ?? 'MISS'}`,
    '',
    `- Status: ${run.status ?? 'MISS'}`,
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
      lines.push('', 'Answer with:', `lodestar-agent answer ${run.run_id} --identity '${worker.identity_id}' --request '${worker.pending_input.request_id}' --stdin`)
    }
    if (worker.output) lines.push('', worker.output)
  }
  if (run.presentation_errors?.length) {
    lines.push('', 'Presentation errors:', ...run.presentation_errors.map((error: string) => `- ${error}`))
  }
  return `${lines.join('\n')}\n`
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
    '  lodestar-agent identities [--json]',
    '  lodestar-agent run --identity <id> [--identity <id>...] [--effort <level>] --stdin',
    '  lodestar-agent follow-up <run_id> [--identity <id>] [--effort <level>] --stdin',
    '  lodestar-agent answer <run_id> [--identity <id>] --request <id> (--answer key=value | --stdin)',
    '  lodestar-agent status <run_id>',
    '  lodestar-agent cancel <run_id>',
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
