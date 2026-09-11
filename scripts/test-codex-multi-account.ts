/** Native Codex acceptance in private temp homes with a localhost Responses stub. No real auth or IM messages. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexAccounts } from '../src/codex-accounts'
import { AppServerOnce } from '../src/usage'

// Native Codex refuses to create its helper aliases beneath the OS /tmp directory.
const scratchParent = join(homedir(), '.cache', 'lodestar-acceptance')
mkdirSync(scratchParent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(scratchParent, 'codex-native-'))
const liveClients = new Set<AppServerOnce>()
const calls: unknown[] = []
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
  calls.push(JSON.parse(Buffer.concat(chunks).toString()))
  const id = calls.length
  const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: `shared-history-${id}`, annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: `response_${id}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `response_${id}`, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const osEnv: Record<string, string | undefined> = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'TMPDIR', 'SystemRoot', 'ComSpec', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, process.env[key]]))

try {
  for (const mode of ['default', 'relative-sqlite', 'custom-env-sqlite'] as const) {
    const dir = join(root, mode); const home = join(dir, 'native'); const cwd = join(dir, 'project')
    mkdirSync(home, { recursive: true }); mkdirSync(cwd)
    const store = new CodexAccounts(home, join(dir, 'accounts'), join(dir, 'accounts.json'))
    const named = store.ensure('isolated-account')
    const config = [
      'model = "gpt-5.5"', 'model_provider = "local_test"', 'cli_auth_credentials_store = "file"', 'sandbox_mode = "danger-full-access"',
      ...(mode === 'relative-sqlite' ? ['sqlite_home = "state"'] : []),
      '[model_providers.local_test]', 'name = "Local acceptance"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', '',
    ].join('\n')
    writeFileSync(join(home, 'config.toml'), config)
    let threadId: string | undefined
    const initialCalls = calls.length
    for (const accountId of ['default', named.id, 'default']) {
      const env = store.env(accountId, { ...osEnv, CODEX_SQLITE_HOME: mode === 'custom-env-sqlite' ? join(dir, 'database') : home,
        HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' })
      const app = new AppServerOnce({ accountId, env, args: store.cliArgs(accountId), cwd })
      liveClients.add(app)
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<any>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('native turn timed out')), 30_000)
        app.on('notification', (method: string, params: any) => {
          if (method === 'turn/completed') resolve(params.turn)
        })
        app.on('closed', reject)
      })
      void done.catch(() => {})
      try {
        await app.initialize('lodestar-multi-account-acceptance')
        const response = await app.request(threadId ? 'thread/resume' : 'thread/start', {
          ...(threadId ? { threadId } : {}), cwd, model: 'gpt-5.5', approvalPolicy: 'never', sandbox: 'danger-full-access',
        }, 30_000)
        if (threadId) assert.equal(response.thread.id, threadId)
        threadId = response.thread.id
        await app.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the next local acceptance marker.' }] })
        assert.equal((await done).status, 'completed')
        const history = await app.request('thread/read', { threadId, includeTurns: true })
        assert.ok(JSON.stringify(history).includes(`shared-history-${initialCalls + 1}`), 'original history lost after account restart')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        await app.close()
        liveClients.delete(app)
      }
    }
    assert.equal(calls.length - initialCalls, 3)
    assert.ok(JSON.stringify(calls.at(-1)).includes(`shared-history-${initialCalls + 1}`), 'resumed model request lost the initial conversation')
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config)
    console.log(JSON.stringify({ mode, sequence: 'default → named → default', threadPreserved: true, modelHistoryPreserved: true }))
  }
  console.log(JSON.stringify({ result: 'passed', realCredentialsUsed: false, modelRequests: calls.length, endpoint: 'localhost' }))
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if ([...liveClients].some(client => client.isAlive())) throw new Error(`验收进程退出未确认，保留目录：${root}`)
  rmSync(root, { recursive: true, force: true })
}
