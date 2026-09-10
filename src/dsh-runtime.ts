import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import spawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import type { ProjectProfile } from './config'
import { DSH_HOME_DIR } from './paths'
import { DSH_PROTOCOL_VERSION, DSH_VERSION, type DshNotification } from './dsh-protocol'
import { log } from './log'

export interface DshRuntimeOptions {
  cwd: string
  env: Record<string, string | undefined>
  home?: string
  profile?: ProjectProfile
  managedSkillDir?: string
  /** Explicit overlays used by isolated runtime integration tests as well as deployments. */
  patches?: string[]
}

function projectMcpRows(cwd: string, profile?: ProjectProfile): object[] {
  if (profile?.loadProjectMcp === false) return []
  let raw: string
  try { raw = readFileSync(join(cwd, '.mcp.json'), 'utf8') }
  catch (error: any) { if (error?.code === 'ENOENT') return []; throw error }
  const parsed = JSON.parse(raw)
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    throw new Error('DSH project .mcp.json must contain an mcpServers object')
  }
  return Object.entries(parsed.mcpServers).map(([serverName, value]) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName) || !value || typeof value !== 'object') throw new Error(`invalid DSH MCP server: ${serverName}`)
    const server = value as any
    const config = server.type === 'http'
      ? { transport: 'streamable-http', serverName, url: server.url, headers: server.headers ?? {} }
      : server.type === undefined || server.type === 'stdio'
        ? { transport: 'stdio', serverName, command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd }
        : null
    if (!config) throw new Error(`DSH does not support MCP transport ${server.type} for ${serverName}`)
    return { id: `lodestar-mcp-${serverName}`, name: '@deepseek-ai/dsh-mcp-client', config: { ...config, failOnStartupError: true } }
  })
}

/** Child ownership and stdio transport, shared by session and catalog callers. */
export class DshRuntime extends EventEmitter {
  private child: ChildProcess
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private exited = false
  private closing = false
  private stderr = ''
  private initialized = false
  private initTask?: Promise<void>
  private closeTask?: Promise<void>
  private readonly exitTask: Promise<void>
  private readonly launchDir: string

  constructor(opts: DshRuntimeOptions) {
    super()
    if (!isAbsolute(opts.cwd)) throw new Error('DSH requires an absolute workspace')
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.version !== DSH_VERSION) throw new Error(`DSH runtime version mismatch: expected ${DSH_VERSION}, got ${manifest.version}`)
    const home = opts.home ?? DSH_HOME_DIR
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const mcp = projectMcpRows(opts.cwd, opts.profile)
    this.launchDir = mkdtempSync(join(tmpdir(), 'lodestar-dsh-'))
    const bridge = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './dsh-bridge.ts' : './dsh-bridge.js', import.meta.url))
    const patch = [
      ...['sdk-jsonrpc-server', 'session-title-llm', 'session-telemetry-otel', 'settings', 'credentials', 'llm-pi-ai'].map(id => ({ id, disabled: true })),
      { id: 'approval', config: { policy: 'ask' } },
      { id: 'permission', config: { defaultPreset: 'lodestar', presets: { lodestar: { sandbox: 'danger-full-access', approval: 'ask' } } } },
      { id: 'system-prompt', config: { personaPrefix: 'You are a coding agent powered by {{model}}.', personaSuffix: 'Your working directory is {{cwd}}.' } },
      { id: 'skill-filesystem', config: { includeDefaultRoots: true, ...(opts.managedSkillDir ? { customSkillDirs: [opts.managedSkillDir] } : {}) } },
      { insert: [{ id: 'lodestar-bridge', name: bridge },
        { id: 'lodestar-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }, ...mcp] },
    ]
    const patchPath = join(this.launchDir, 'bridge.patch.yml')
    writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 })
    const node = opts.env.LODESTAR_DSH_NODE || 'node'
    const args = [join(dirname(manifestPath), manifest.bin.dsh), '--profile', 'sdk', '--patch', patchPath,
      ...(opts.patches ?? []).flatMap(path => ['--patch', path])]
    const childEnv = { ...opts.env }
    // DSH rebuilds its own namespace for each shell execution. This context is
    // available only through our root-agent ShellEnv contributor below.
    if (childEnv.LODESTAR_AGENT_CAPABILITY && childEnv.LODESTAR_AGENT_URL) {
      childEnv.DSH_LODESTAR_AGENT_CONTEXT = JSON.stringify({
        baseUrl: childEnv.LODESTAR_AGENT_URL, capability: childEnv.LODESTAR_AGENT_CAPABILITY,
      })
    }
    for (const key of Object.keys(childEnv)) if (key.startsWith('LODESTAR_AGENT_')) delete childEnv[key]
    try {
      this.child = spawn(node, args, {
        cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        env: { ...childEnv, DSH_HOME: home, DSH_PERMISSION_MODE: 'danger-full-access' },
      })
    } catch (error) { rmSync(this.launchDir, { recursive: true, force: true }); throw error }
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_384)
      log(`dsh stderr: ${chunk.trimEnd()}`)
    })
    this.child.stdin!.on('error', error => this.transportFailure(error))
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    lines.on('line', line => this.receive(line))
    this.exitTask = new Promise(resolve => {
      this.child.once('error', error => this.transportFailure(error))
      this.child.once('close', (code, signal) => {
        this.exited = true
        lines.close()
        const error = new Error(`DSH exited code=${code} signal=${signal}\n${this.stderr}`)
        this.rejectPending(error)
        rmSync(this.launchDir, { recursive: true, force: true })
        resolve()
        this.emit('exit', { code, signal, expected: this.closing })
      })
    })
  }

  get pid(): number | undefined { return this.child.pid }
  isAlive(): boolean { return !this.exited }
  initialize(): Promise<void> {
    return this.initTask ??= this.request('initialize', {}, 30_000).then(result => {
      if (result.protocolVersion !== DSH_PROTOCOL_VERSION || result.runtimeVersion !== DSH_VERSION) {
        throw new Error(`DSH handshake version mismatch: ${JSON.stringify(result)}`)
      }
      this.initialized = true
    })
  }
  request(method: string, params: unknown = {}, timeoutMs: number | null = 30_000): Promise<any> {
    if (this.exited || (this.closing && method !== 'shutdown')) return Promise.reject(new Error('DSH transport is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DSH ${method} timed out after ${timeoutMs}ms\n${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) this.transportFailure(error)
      })
    })
  }
  private receive(line: string): void {
    try {
      const frame = JSON.parse(line)
      if (frame.jsonrpc !== '2.0') throw new Error('invalid DSH JSON-RPC envelope')
      if (typeof frame.id === 'number') {
        const pending = this.pending.get(frame.id)
        if (!pending) { log(`dsh: unexpected response id=${frame.id}`); return }
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.error) pending.reject(new Error(`DSH RPC error: ${frame.error.message}`))
        else if ('result' in frame) pending.resolve(frame.result)
        else pending.reject(new Error('DSH response has neither result nor error'))
      } else if (typeof frame.method === 'string' && frame.params && typeof frame.params === 'object') {
        this.emit('notification', { method: frame.method, params: frame.params } satisfies DshNotification)
      } else throw new Error('invalid DSH notification')
    } catch (error) { this.transportFailure(error instanceof Error ? error : new Error(String(error))) }
  }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
  }
  private transportFailure(error: Error): void {
    this.rejectPending(error)
    this.emit('failure', error)
  }
  close(timeoutMs = 3000): Promise<void> {
    return this.closeTask ??= this.dispose(timeoutMs).catch(error => { this.closeTask = undefined; throw error })
  }
  private async dispose(timeoutMs: number): Promise<void> {
    if (this.exited) return
    this.closing = true
    if (this.initialized) {
      try { await this.request('shutdown', {}, timeoutMs) }
      catch (error) { log(`dsh shutdown: ${error}`) }
    }
    this.child.stdin!.end()
    const waitExit = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.exitTask, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
      clearTimeout(timer)
      return this.exited
    }
    if (await waitExit(timeoutMs)) return
    log(`dsh: terminate owned child pid=${this.pid}`)
    this.child.kill('SIGTERM')
    if (await waitExit(timeoutMs)) return
    log(`dsh: kill unresponsive owned child pid=${this.pid}`)
    this.child.kill('SIGKILL')
    if (!await waitExit(timeoutMs)) throw new Error(`DSH child exit not confirmed: pid=${this.pid}`)
  }
}

/** Read-only native catalog operations always reap their own process. */
export async function queryDshRuntime(opts: DshRuntimeOptions, method: 'model/list' | 'session/list', params = {}): Promise<any> {
  const runtime = new DshRuntime(opts)
  runtime.on('failure', error => log(`dsh catalog: ${error}`))
  let failure: unknown
  let result: unknown
  try { await runtime.initialize(); result = await runtime.request(method, params) }
  catch (error) { failure = error }
  try { await runtime.close() }
  catch (error) {
    if (failure) throw new AggregateError([failure, error], 'DSH query and cleanup both failed')
    throw error
  }
  if (failure) throw failure
  return result
}
