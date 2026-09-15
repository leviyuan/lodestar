import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readReclaudeRuntime } from './reclaude-runtime'

test('ReClaude requires the matching native login, a live daemon, healthy gateway and CA', () => {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-reclaude-runtime-'))
  const state = { daemon: { running: true, pid: process.pid, port: 32123 }, gateway: { healthy: true } }
  const writeState = (value: unknown) => writeFileSync(join(root, 'state.json'), JSON.stringify(value))
  const writeCredentials = (token: string) => writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
  try {
    writeFileSync(join(root, 'device.json'), JSON.stringify({ sk: 'sk-rec-test-device' }))
    writeCredentials('sk-rec-test-device')
    writeState(state)
    writeFileSync(join(root, 'ca.pem'), 'test fixture')
    expect(readReclaudeRuntime(root, root)).toEqual({ proxyUrl: 'http://127.0.0.1:32123', caFile: join(root, 'ca.pem') })
    writeCredentials('another-native-subscription')
    expect(() => readReclaudeRuntime(root, root)).toThrow('不匹配')
    writeCredentials('sk-rec-test-device')
    writeState({ ...state, daemon: { ...state.daemon, running: false } })
    expect(() => readReclaudeRuntime(root, root)).toThrow('后台未运行')
    writeState({ ...state, daemon: { ...state.daemon, port: 65536 } })
    expect(() => readReclaudeRuntime(root, root)).toThrow('端口无效')
    writeState({ ...state, daemon: { ...state.daemon, pid: 2147483647 } })
    expect(() => readReclaudeRuntime(root, root)).toThrow()
    writeState({ ...state, gateway: { healthy: false } })
    expect(() => readReclaudeRuntime(root, root)).toThrow('接入服务当前不可用')
    writeState(state)
    rmSync(join(root, 'ca.pem'))
    expect(() => readReclaudeRuntime(root, root)).toThrow('ca.pem')
    writeFileSync(join(root, 'device.json'), '{}')
    expect(() => readReclaudeRuntime(root, root)).toThrow('设备未登录')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
