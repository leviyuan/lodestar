import { describe, expect, test } from 'bun:test'
import { scrubAgentHostEnv } from './agent-env'

describe('agent host environment scrubbing', () => {
  test('drops Feishu credentials and host-only Lodestar state paths', () => {
    const env = scrubAgentHostEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      FEISHU_APP_ID: 'cli_x',
      FEISHU_APP_SECRET: 'secret',
      LODESTAR_RESTART_CONTINUE_CHAT_ID: 'oc_secret',
      LODESTAR_CONFIG: '/home/me/.config/lodestar/config.toml',
      LODESTAR_CONFIG_DIR: '/home/me/.config/lodestar',
      LODESTAR_DATA_DIR: '/home/me/.local/share/lodestar',
      LODESTAR_ATTACHMENT_DIR: '/tmp/x',
      LODESTAR_DISABLE_SKILL_SYNC: '1',
      LODESTAR_TEST_AGENT_RUNTIME_ROOT: '/tmp/runtime',
      LODESTAR_AGENT_SESSION: 'group-name',
      LODESTAR_PACKY_API_KEY: 'legacy',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me' })
  })

  test('keeps the Agent protocol and token-source routing variables', () => {
    const env = scrubAgentHostEnv({
      LODESTAR_AGENT_URL: 'http://127.0.0.1:9876',
      LODESTAR_AGENT_CAPABILITY: 'cap',
      LODESTAR_AGENT_ROLE: 'main',
      LODESTAR_DSH_PROVIDER: 'deepseek-official',
      LODESTAR_DSH_NODE: '/usr/bin/node',
      LODESTAR_RELAY_API_KEY: 'key',
      CODEX_HOME: '/home/me/.codex',
    })
    expect(env.LODESTAR_AGENT_CAPABILITY).toBe('cap')
    expect(env.LODESTAR_AGENT_SESSION).toBeUndefined()
    expect(env.LODESTAR_DSH_NODE).toBe('/usr/bin/node')
    expect(env.LODESTAR_RELAY_API_KEY).toBe('key')
    expect(env.CODEX_HOME).toBe('/home/me/.codex')
  })

  test('drops a DSH delegation context inherited from the host', () => {
    // A daemon started from a managed DSH shell must not hand that old task's context to new Agents.
    const env = scrubAgentHostEnv({
      PATH: '/usr/bin',
      DSH_LODESTAR_AGENT_CONTEXT: JSON.stringify({ baseUrl: 'http://127.0.0.1:9876', capability: 'old-task' }),
      LODESTAR_AGENT_URL: 'http://127.0.0.1:9876',
      LODESTAR_AGENT_CAPABILITY: 'this-launch',
    })
    expect(env).toEqual({ PATH: '/usr/bin', LODESTAR_AGENT_URL: 'http://127.0.0.1:9876', LODESTAR_AGENT_CAPABILITY: 'this-launch' })
  })

  test('Windows matches the rules regardless of case; other platforms keep exact names', () => {
    const host = {
      Path: 'C:\\Windows',
      feishu_app_secret: 'secret',
      Feishu_App_Id: 'cli_x',
      lodestar_data_dir: 'C:\\Users\\me\\AppData\\Local\\lodestar',
      Lodestar_Config: 'C:\\Users\\me\\lodestar.toml',
      dsh_lodestar_agent_context: '{"capability":"old-task"}',
      lodestar_future_path: 'x',
      lodestar_agent_capability: 'cap',
      Lodestar_Relay_Api_Key: 'key',
    }
    // Windows resolves these names case-insensitively, so each is the host variable itself.
    expect(scrubAgentHostEnv(host, 'win32')).toEqual({ Path: 'C:\\Windows', lodestar_agent_capability: 'cap', Lodestar_Relay_Api_Key: 'key' })
    // Elsewhere a differently cased name is a different variable and is left alone.
    expect(scrubAgentHostEnv(host, 'linux')).toEqual(host)
  })

  test('is a copy: the daemon environment is never mutated', () => {
    const source = { FEISHU_APP_SECRET: 'secret', PATH: '/usr/bin' }
    const scrubbed = scrubAgentHostEnv(source)
    expect(source.FEISHU_APP_SECRET).toBe('secret')
    expect(scrubbed.FEISHU_APP_SECRET).toBeUndefined()
  })
})
