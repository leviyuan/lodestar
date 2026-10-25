import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureClaudeSyncWarmup, waitForClaudeSyncWarmup, type ClaudeSyncWarmupOptions } from './claude-sync-warmup'

const ORG = '11111111-1111-1111-1111-111111111111'
const ACCOUNT = '22222222-2222-2222-2222-222222222222'
const TOKEN = '33333333-3333-3333-3333-333333333333'
const BUCKET = `${ORG}_${ACCOUNT}`
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lodestar-sync-warmup-'))
  roots.push(root)
  const configDir = join(root, 'account'), sharedConfigDir = join(root, 'shared')
  await Promise.all([mkdir(configDir), mkdir(sharedConfigDir)])
  const write = async (path: string, value: unknown) => { await writeFile(path, JSON.stringify(value)) }
  const identity = (account = ACCOUNT, email = 'test@example.invalid') => write(join(configDir, '.claude.json'), {
    oauthAccount: { accountUuid: account, organizationUuid: ORG, emailAddress: email },
  })
  await identity()
  const path = (kind: 'skills' | 'plugins', name = '', bucket = BUCKET) => join(sharedConfigDir, kind, 'synced', bucket, name)
  const marker = async (kind: 'skills' | 'plugins', token = TOKEN) => {
    await mkdir(path(kind), { recursive: true }); await writeFile(path(kind, '.last-complete-round'), `${token} `)
  }
  const manifest = async (kind: 'skills' | 'plugins', names: string[], extra: Record<string, unknown> = {}) => {
    await mkdir(path(kind), { recursive: true })
    await write(path(kind, 'manifest.json'), { lastUpdated: Date.now(), [kind]: names.map(name => ({ name })), ...extra })
  }
  const artifact = async (kind: 'skills' | 'plugins', name: string) => {
    await mkdir(path(kind, name), { recursive: true })
    await writeFile(path(kind, `${name}/${kind === 'skills' ? 'SKILL.md' : 'README.md'}`), 'complete')
  }
  let elapsed = 0, polls = 0
  const options: ClaudeSyncWarmupOptions = { configDir, sharedConfigDir, startedAt: 0,
    accountInfo: { email: 'test@example.invalid', organization: 'test organization' },
    isAlive: () => true, now: () => elapsed, timeoutMs: 20_000, intervalMs: 5_000,
    sleep: async ms => { elapsed += ms; polls++ },
  }
  return { root, configDir, sharedConfigDir, options, marker, manifest, artifact, path, write, identity,
    polls: () => polls, elapsed: () => elapsed, advance: (ms: number) => { elapsed += ms; polls++ } }
}

describe('Claude first cloud sync warmup', () => {
  test('waits for download claims, complete round and files before two stable checks', async () => {
    const f = await fixture()
    await f.manifest('skills', ['alpha'], { pendingClaims: ['123:/alpha'] })
    await f.marker('plugins')
    f.options.sleep = async ms => {
      f.advance(ms)
      if (f.polls() === 1) {
        await f.artifact('skills', 'alpha')
        await f.manifest('skills', ['alpha'])
        await f.marker('skills')
      }
    }
    const result = await waitForClaudeSyncWarmup(f.options)
    expect(result.skills.count).toBe(1)
    expect(f.elapsed()).toBe(10_000)
  })

  test('native successful empty collections need no fabricated nonempty manifest', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    const result = await waitForClaudeSyncWarmup(f.options)
    expect(result.skills.state).toBe('complete')
    expect(result.plugins.count).toBe(0)
    expect(f.polls()).toBe(1)
  })

  test('checks plugin packages and native generation suffixes', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await f.manifest('plugins', [], { plugins: [{ name: 'plugin', generation: 2 }] })
    f.options.sleep = async ms => { f.advance(ms); if (f.polls() === 1) await f.artifact('plugins', 'plugin~g2') }
    const result = await waitForClaudeSyncWarmup(f.options)
    expect(result.plugins.count).toBe(1)
    expect(f.elapsed()).toBe(10_000)
  })

  test('native sanitized skill names map to the actual directory', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await f.manifest('skills', ['design/art. '])
    await f.artifact('skills', 'design_art')
    expect((await waitForClaudeSyncWarmup(f.options)).skills.count).toBe(1)
  })

  test.each(['pendingClaims', 'staleDirs'])('refuses an incomplete manifest with %s', async field => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await f.manifest('skills', ['alpha'], { [field]: ['unfinished'] })
    await f.artifact('skills', 'alpha')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow(field)
  })

  test('does not accept an incomplete manifest just because every listed file exists', async () => {
    const f = await fixture()
    await f.manifest('skills', ['alpha']); await f.artifact('skills', 'alpha'); await f.marker('plugins')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('completion_missing')
  })

  test('waits for staging cleanup and trash to remain unchanged for a full interval', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await mkdir(f.path('skills', '.staging/123'), { recursive: true })
    f.options.sleep = async ms => {
      f.advance(ms)
      if (f.polls() === 1) await rm(f.path('skills', '.staging/123'), { recursive: true })
      if (f.polls() === 2) await mkdir(join(f.sharedConfigDir, 'skills', '.trash', 'new-entry'), { recursive: true })
    }
    await waitForClaudeSyncWarmup(f.options)
    expect(f.elapsed()).toBe(15_000)
  })

  test('an incomplete second account cannot borrow a completed first account bucket', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await f.identity('44444444-4444-4444-4444-444444444444')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('bucket_missing')
  })

  test('detects identity change and mismatched authenticated email', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    f.options.sleep = async ms => { f.advance(ms); await f.identity('44444444-4444-4444-4444-444444444444') }
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('身份发生变化')
    await f.identity(ACCOUNT, 'different@example.invalid')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('一致的原生账号')
  })

  test('explicitly disabled lanes require no cloud buckets, absent settings do not imply disabled', async () => {
    const f = await fixture()
    await f.write(join(f.sharedConfigDir, 'settings.json'), { syncClaudeAiSkills: false })
    f.options.settings = { syncClaudeAiPlugins: false }
    const result = await waitForClaudeSyncWarmup(f.options)
    expect(result.skills.state).toBe('disabled')
    expect(result.plugins.state).toBe('disabled')
    await f.write(join(f.sharedConfigDir, 'settings.json'), {})
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('bucket_missing')
  })

  test('explicit launch enable overrides user disable and still requires native completion', async () => {
    const f = await fixture()
    await f.write(join(f.sharedConfigDir, 'settings.json'), { syncClaudeAiSkills: false, syncClaudeAiPlugins: false })
    f.options.settings = { syncClaudeAiSkills: true }
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('bucket_missing')
    await f.marker('skills')
    expect((await waitForClaudeSyncWarmup(f.options)).skills.state).toBe('complete')
  })

  test('process exit and cancellation stop waiting with explicit failures', async () => {
    const f = await fixture()
    f.options.isAlive = () => f.polls() === 0
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('进程已退出')
    const abort = new AbortController(); abort.abort(new Error('cancelled warmup'))
    await expect(waitForClaudeSyncWarmup({ ...f.options, signal: abort.signal })).rejects.toThrow('cancelled warmup')
  })

  test('shared settings may be symlinked, and disabled lanes still wait for staging', async () => {
    const f = await fixture()
    const settingsFile = join(f.root, 'settings.json')
    await f.write(settingsFile, { syncClaudeAiSkills: false, syncClaudeAiPlugins: false })
    await symlink(settingsFile, join(f.sharedConfigDir, 'settings.json'))
    await mkdir(f.path('plugins', '.staging/123'), { recursive: true })
    f.options.sleep = async ms => { f.advance(ms); if (f.polls() === 1) await rm(f.path('plugins', '.staging/123'), { recursive: true }) }
    expect((await waitForClaudeSyncWarmup(f.options)).plugins.state).toBe('disabled')
    expect(f.elapsed()).toBe(10_000)
  })

  test('stale marker alone is insufficient, unchanged validated prestart snapshot supports native reuse', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    const old = new Date(Date.now() - 60_000)
    await Promise.all(['skills', 'plugins'].map(kind => utimes(f.path(kind as 'skills' | 'plugins', '.last-complete-round'), old, old)))
    f.options.startedAt = Date.now()
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('completion_missing')
    f.options.baseline = await captureClaudeSyncWarmup(f.options)
    expect((await waitForClaudeSyncWarmup(f.options)).skills.state).toBe('complete')
  })

  test('modified baseline proof cannot bless an old completion marker', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    f.options.baseline = await captureClaudeSyncWarmup(f.options)
    const old = new Date(Date.now() - 60_000)
    await Promise.all(['skills', 'plugins'].map(kind => utimes(f.path(kind as 'skills' | 'plugins', '.last-complete-round'), old, old)))
    f.options.startedAt = Date.now()
    await f.manifest('skills', ['alpha']); await f.artifact('skills', 'alpha')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('completion_missing')
  })

  test('does not turn a shortened final timeout interval into successful stability', async () => {
    const f = await fixture()
    f.options.timeoutMs = 6_000
    f.options.sleep = async ms => { f.advance(ms); await Promise.all([f.marker('skills'), f.marker('plugins')]) }
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('首次同步未完成')
    expect(f.elapsed()).toBe(6_000)
  })

  test('malformed manifests never count as completed empty collections', async () => {
    const f = await fixture()
    await Promise.all([f.marker('skills'), f.marker('plugins')])
    await writeFile(f.path('skills', 'manifest.json'), '{')
    await expect(waitForClaudeSyncWarmup(f.options)).rejects.toThrow('manifest_invalid')
  })
})
