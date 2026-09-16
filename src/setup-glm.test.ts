import { expect, test } from 'bun:test'

test('fresh setup validates GLM before saving and leaves existing settings intact on failure', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { mock } from 'bun:test'

    // Fresh installation has no Lodestar config; importing setup must not require it.
    unlinkSync(process.env.LODESTAR_CONFIG)
    mock.module('node:readline/promises', () => ({ createInterface: () => ({ close() {} }) }))
    const { writeClaudeGlmEnv } = await import('./src/setup')
    const settingsPath = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
    unlinkSync(settingsPath)
    let payload = { code: 401, msg: '令牌已过期或验证不正确', success: false }
    globalThis.fetch = async () => Response.json(payload)

    const first = await writeClaudeGlmEnv('invalid-test-key')
    assert.match(first.error, /code=401.*令牌已过期或验证不正确/)
    assert.equal(existsSync(settingsPath), false)

    const previous = JSON.stringify({ env: { KEEP_ME: 'yes', ANTHROPIC_AUTH_TOKEN: 'previous-test-key' },
      permissions: { allow: ['Read'] }, hooks: {} })
    writeFileSync(settingsPath, previous)
    const retry = await writeClaudeGlmEnv('invalid-test-key')
    assert.match(retry.error, /code=401/)
    assert.equal(readFileSync(settingsPath, 'utf8'), previous)

    payload = { data: [] }
    assert.match((await writeClaudeGlmEnv('empty-test-key')).error, /模型目录为空/)
    assert.equal(readFileSync(settingsPath, 'utf8'), previous)

    globalThis.fetch = async () => { throw new Error('diagnostic timeout') }
    assert.match((await writeClaudeGlmEnv('offline-test-key')).error, /diagnostic timeout/)
    assert.equal(readFileSync(settingsPath, 'utf8'), previous)

    payload = { data: [{ id: 'glm-4.7', display_name: 'GLM-4.7' }, { id: 'glm-5.3', display_name: 'GLM-5.3' }] }
    globalThis.fetch = async () => Response.json(payload)
    assert.deepEqual(await writeClaudeGlmEnv('valid-test-key'), { path: settingsPath })
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, 'valid-test-key')
    assert.equal(saved.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic')
    assert.equal(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'GLM-5.3[1m]')
    assert.equal(saved.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'GLM-5.3[1m]')
    assert.equal(saved.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'GLM-4.7')
    assert.equal(saved.env.KEEP_ME, 'yes')
    assert.deepEqual(saved.permissions, { allow: ['Read'] })
    assert.deepEqual(saved.hooks, {})
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})

test('setup repeats a failed GLM prompt and accepts explicit skip without saving the invalid key', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { readFileSync, unlinkSync } from 'node:fs'
    import { join } from 'node:path'
    import { mock } from 'bun:test'
    unlinkSync(process.env.LODESTAR_CONFIG)
    const settings = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
    const before = readFileSync(settings, 'utf8')
    let glmPrompts = 0
    Object.defineProperty(process.stdin, 'isTTY', { value: true })
    const output = []
    console.log = (...args) => output.push(args.join(' '))
    mock.module('./src/agent-updates', () => ({ updateAgentRuntime: async () => {}, agentBin: () => '/test/claude' }))
    const { Interface } = await import('node:readline/promises')
    Interface.prototype.question = async prompt => {
        if (prompt.includes('按 Enter 开始')) return ''
        if (prompt.includes('GLM API key')) return ++glmPrompts === 1 ? 'invalid-test-key' : ''
        if (prompt.includes('顺便配置 Codex')) throw new Error('expected-test-stop')
        throw new Error('unexpected prompt: ' + prompt)
    }
    globalThis.fetch = async () => Response.json({ code: 401, success: false, msg: '令牌已过期或验证不正确' })
    const { runSetup } = await import('./src/setup')
    await assert.rejects(runSetup(), /expected-test-stop/)
    assert.equal(glmPrompts, 2)
    assert.equal(readFileSync(settings, 'utf8'), before)
    assert.match(output.join('\\n'), /认证失败/)
    assert.match(output.join('\\n'), /已跳过 GLM/)
    assert.doesNotMatch(output.join('\\n'), /GLM 路由已写入|invalid-test-key/)
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
})
