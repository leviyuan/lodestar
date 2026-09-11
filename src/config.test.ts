import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface FreshConfigResult {
  exitCode: number
  stdout: string
  stderr: string
}

function loadFreshConfig(extraToml = ''): FreshConfigResult {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-config-fresh-'))
  const configFile = join(root, 'config.toml')
  const minimumConfig = [
    '[feishu]',
    'app_id = "cli_test"',
    'app_secret = "secret"',
  ].join('\n')
  writeFileSync(configFile, `${minimumConfig}${extraToml ? `\n\n${extraToml.trim()}\n` : '\n'}`)

  try {
    const configModule = pathToFileURL(join(import.meta.dir, 'config.ts')).href
    const script = [
      `import { config } from ${JSON.stringify(configModule)}`,
      'process.stdout.write(JSON.stringify(config))',
    ].join('\n')
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_CONFIG: configFile },
    })

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('runtime live_elapsed', () => {
  test('defaults to bucket when omitted', () => {
    const result = loadFreshConfig()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).runtime.live_elapsed).toBe('bucket')
  })

  test('accepts bucket and second values case-insensitively', () => {
    const bucket = loadFreshConfig(`
      [runtime]
      live_elapsed = "Bucket"
    `)
    expect(bucket.exitCode).toBe(0)
    expect(JSON.parse(bucket.stdout).runtime.live_elapsed).toBe('bucket')

    const second = loadFreshConfig(`
      [runtime]
      live_elapsed = "SECOND"
    `)
    expect(second.exitCode).toBe(0)
    expect(JSON.parse(second.stdout).runtime.live_elapsed).toBe('second')
  })

  test('rejects unknown live_elapsed values', () => {
    const result = loadFreshConfig(`
      [runtime]
      live_elapsed = "realtime"
    `)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('[runtime].live_elapsed')
    expect(result.stderr).toContain('realtime')
  })
})

describe('runtime agent_auto_update', () => {
  test('existing configurations disable Agent auto-update by default', () => {
    const result = loadFreshConfig()
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).runtime.agent_auto_update).toBe(false)
  })

  test('only an explicit true enables periodic updates', () => {
    for (const value of ['true', 'false']) {
      const result = loadFreshConfig(`[runtime]\nagent_auto_update = ${value}`)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout).runtime.agent_auto_update).toBe(value === 'true')
    }
  })

  test('rejects an invalid update preference instead of silently changing it', () => {
    const result = loadFreshConfig('[runtime]\nagent_auto_update = "yes"')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('[runtime].agent_auto_update must be true or false')
  })
})

describe('TOML scalar parsing', () => {
  test('keeps # inside quoted credentials while stripping a real comment', () => {
    const result = loadFreshConfig(`
      [feishu]
      app_secret = "sec#ret" # operator note
    `)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).feishu.app_secret).toBe('sec#ret')
  })

  test('rejects a notify port with trailing junk', () => {
    const result = loadFreshConfig(`
      [notify]
      port = "9876junk"
    `)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('[notify].port must be an integer')
  })
})
