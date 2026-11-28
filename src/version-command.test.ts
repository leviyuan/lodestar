import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_RUNTIMES_DIR } from './paths'
import { runVersion } from './version-command'

const codexState = join(AGENT_RUNTIMES_DIR, 'codex')

afterEach(() => rmSync(codexState, { recursive: true, force: true }))

function selectCodex(state: object): void {
  mkdirSync(codexState, { recursive: true })
  writeFileSync(join(codexState, 'current.json'), JSON.stringify({ checkedAt: 1, ...state }))
}

async function version(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runVersion(argv, { out: text => { out.push(text) }, err: text => { err.push(text) } })
  return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join('') }
}

describe('lodestar version', () => {
  test('a missing install directory is reported without its path unless --verbose', async () => {
    const directory = join(AGENT_RUNTIMES_DIR, 'codex', 'gone-runtime')
    selectCodex({ directory, versions: { '@openai/codex': '1.0.0' } })
    const plain = await version()
    expect(plain.code).toBe(1)
    expect(plain.err).toContain('codex: MISS（安装目录不存在（加 --verbose 查看路径））')
    expect(plain.all).not.toContain(directory)
    const json = await version('--json')
    expect(json.code).toBe(1)
    expect(json.out).not.toContain(directory)
    const verbose = await version('--verbose')
    expect(verbose.code).toBe(1)
    expect(verbose.err).toContain(directory)
  })

  test('read failures and invalid records hide runtime paths by default', async () => {
    const directory = join(AGENT_RUNTIMES_DIR, 'codex', 'empty-runtime')
    mkdirSync(directory, { recursive: true })
    selectCodex({ directory, versions: { '@openai/codex': '1.0.0' } })
    const plain = await version()
    expect(plain.code).toBe(1)
    expect(plain.err).toContain('<运行目录>')
    expect(plain.all).not.toContain(AGENT_RUNTIMES_DIR)
    expect((await version('--verbose')).err).toContain(directory)

    selectCodex({ directory: 'relative/runtime' })
    const invalid = await version()
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('Invalid codex runtime state: <运行目录>')
    expect(invalid.all).not.toContain(AGENT_RUNTIMES_DIR)
  })

  test('a healthy install prints its directory only with --verbose', async () => {
    const directory = join(AGENT_RUNTIMES_DIR, 'codex', 'ok-runtime')
    mkdirSync(join(directory, 'node_modules', '@openai', 'codex'), { recursive: true })
    writeFileSync(join(directory, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0' }))
    selectCodex({ directory, versions: { '@openai/codex': '1.0.0' } })
    const plain = await version()
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('codex: @openai/codex@1.0.0')
    expect(plain.all).not.toContain(directory)
    expect((await version('--json')).out).not.toContain(directory)
    expect((await version('--verbose')).out).toContain(`  ${directory}\n`)
    expect(JSON.parse((await version('--json', '--verbose')).out).agents.codex.directory).toBe(directory)
  })

  test('unknown options are usage errors', async () => {
    const failure = await version('--bogus').then(() => undefined, error => error)
    expect(failure?.name).toBe('UsageError')
  })
})
