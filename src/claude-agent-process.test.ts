import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'

const {
  buildClaudeSpawnPath,
  CLAUDE_PERMISSION_MODE,
  ClaudeAgentProcess,
  claudeTranscriptPath,
  readLastCallUsageFromTranscript,
  readProjectMcpServers,
  resetClaudeContextWindowCache,
  resolveClaudeExecutableConfig,
  settingSourcesFromProfile,
  toolsFromProfile,
  claudeManagedSkillOptions,
} = await import('./claude-agent-process')
const {
  resolveClaudeSdkModel,
} = await import('./claude-models')
const { config } = await import('./config')
const agentUpdates = await import('./agent-updates')

// context window 是 daemon 全局缓存(按路由 key 跨 session 共享),
// 每个用例前重置,避免互相污染。
beforeEach(() => resetClaudeContextWindowCache())

describe('Claude model profiles', () => {
  test('SDK launches opt into task tracking while preserving routing and project tool restrictions', async () => {
    const captured: any[] = []
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk').mockResolvedValue({
      query: ({ options }: any) => {
        captured.push(options)
        return (async function* () {})()
      },
    } as any)
    try {
      for (const resumed of [false, true]) {
        const proc = new ClaudeAgentProcess({
          workDir: tmpdir(), model: resumed ? 'GLM-5.3-Flash' : 'claude-opus-5', effort: 'max',
          ...(resumed ? { resumeSessionId: 'task-session' } : {}),
          profile: resumed ? { tools: 'Read,TaskCreate,TaskUpdate,TaskList', loadProjectMcp: false } : { loadProjectMcp: false },
          settingSources: resumed ? ['project', 'local'] : ['user', 'project', 'local'],
          transformEnv: env => ({ ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '0',
            ANTHROPIC_BASE_URL: 'https://provider.invalid', ANTHROPIC_AUTH_TOKEN: 'test-only' }),
        }) as any
        proc.sendInitialize()
        await proc.queryStart
        expect(captured).toHaveLength(resumed ? 2 : 1)
        const options = captured.at(-1)
        expect(options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
        expect(options.env.ANTHROPIC_BASE_URL).toBe('https://provider.invalid')
        expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe('test-only')
        expect(options.resume).toBe(resumed ? 'task-session' : undefined)
        expect(options.tools).toEqual(resumed
          ? ['Read', 'TaskCreate', 'TaskUpdate', 'TaskList']
          : { type: 'preset', preset: 'claude_code' })
      }
    } finally { sdk.mockRestore() }
  })

  test('thinking estimates update progress without changing billed usage', () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const progress: unknown[] = []
    proc.on('thinking_progress', (event: unknown) => progress.push(event))
    proc.handleMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 123, estimated_tokens_delta: 4 })
    expect(proc.lastThinkingTokens).toBe(123)
    expect(proc.lastUsage).toBeNull()
    expect(progress).toEqual([{ estimatedTokens: 123 }])
    proc.handleMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: -1 })
    expect(proc.lastThinkingTokens).toBe(123)
  })

  test('an empty upstream tool name remains visible as MISS with its original tool id', () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const uses: unknown[] = []
    proc.on('tool_use', (event: unknown) => uses.push(event))
    proc.handleMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'invalid-tool', name: '', input: {} }] } })
    expect(uses).toEqual([{ id: 'invalid-tool', name: 'MISS', input: {}, parentToolUseId: null }])
  })
  test('hot settings preserve explicit max and reject a change requiring a different process environment', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'high' }) as any
    const updates: unknown[] = []
    proc.started = true
    proc.query = { setModel: async () => {}, applyFlagSettings: async (settings: unknown) => { updates.push(settings) } }
    await proc.setModelSettings('moonshotai/kimi-k3', 'max')
    await expect(proc.setModelSettings('xiaomi/mimo-v2.5-pro', 'default')).rejects.toThrow('启动环境')
    await proc.setModelSettings('google/gemini-3.8-flash', 'high')
    expect(updates).toEqual([
      { effortLevel: 'max', ultracode: null },
      { effortLevel: 'high', ultracode: null },
    ])
    expect(proc.lastEffort).toBe('high')
    const nativeDefault = new ClaudeAgentProcess({ workDir: tmpdir(), effort: 'default' }) as any
    nativeDefault.started = true
    nativeDefault.query = proc.query
    await nativeDefault.setModelSettings('minimax/minimax-m3', 'default')
    expect(updates.at(-1)).toEqual({ effortLevel: null, ultracode: null })
  })
  test('a rejected model control does not attempt effort or report the old settings as confirmed', async () => {
    const proc = new ClaudeAgentProcess({ workDir: tmpdir(), model: 'old-model', effort: 'high' }) as any
    proc.started = true
    let flagCalls = 0
    proc.query = {
      setModel: async () => { throw new Error('model control transport closed') },
      applyFlagSettings: async () => { flagCalls++ },
    }
    await expect(proc.setModelSettings('new-model', 'max')).rejects.toMatchObject({
      confirmedModel: null, message: '模型设置未确认：model control transport closed',
    })
    expect(flagCalls).toBe(0)
    expect(proc.lastModel).toBeNull()
    expect(proc.lastEffort).toBeNull()
  })

  test('loads daemon-managed Skills as a plugin only when user settings are excluded', () => {
    expect(claudeManagedSkillOptions(['project', 'local'], '/data/lodestar-plugin')).toEqual({
      plugins: [{ type: 'local', path: '/data/lodestar-plugin', skipMcpDiscovery: true }],
      skills: 'all',
    })
    expect(claudeManagedSkillOptions(['user', 'project'], '/data/lodestar-plugin')).toEqual({})
  })
  test('uses SDK default executable when no global Claude command is found', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: '',
      configuredBin: null,
      exists: () => false,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('Windows default uses the managed SDK even when an unrelated global npm shim exists', () => {
    const binDir = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const shim = win32.join(binDir, 'claude.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: binDir,
      configuredBin: null,
      exists: path => path === shim,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('win32 native exe falls through to SDK default entry (not passed directly, so dialog tools work)', () => {
    const binDir = 'C:\\Program Files\\ClaudeCode'
    const exe = win32.join(binDir, 'claude.exe')
    const shim = win32.join(binDir, 'claude.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: binDir,
      configuredBin: null,
      exists: path => path === exe || path === shim,
    })

    // 走 SDK 默认入口(不显式传 pathToClaudeCodeExecutable):显式传会让 claude 走
    // CLI stream-json 模式,不下发 AskUserQuestion 等 dialog 工具。SDK 默认入口
    // 自己解析平台 native binary。见 resolveClaudeExecutableConfig 201-204 注释。
    expect(executable.pathToClaudeCodeExecutable).toBeUndefined()
    expect(executable.spawnClaudeCodeProcess).toBeUndefined()
    expect(executable.description).toBe('sdk-default')
  })

  test.skipIf(process.platform === 'win32')('keeps npm-global, local bins, and existing PATH in Claude spawn PATH', () => {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ['/opt/custom/bin', '/usr/bin'].join(delimiter)
      const entries = buildClaudeSpawnPath().split(delimiter)

      expect(entries).toContain(join(homedir(), '.local', 'npm-global', 'bin'))
      expect(entries).toContain(join(homedir(), '.local', 'bin'))
      expect(entries).toContain('/opt/custom/bin')
      expect(entries.filter(entry => entry === '/usr/bin')).toHaveLength(1)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('maps claude profiles to SDK model alias', () => {
    const previousModels = config.claude.models
    config.claude.models = {
      custom: { model: ' sonnet ' },
      empty: {},
      'real-model': { model: 'haiku' },
      default: { model: 'haiku' },
    }
    try {
      expect(resolveClaudeSdkModel(null)).toBe('opus')
      expect(resolveClaudeSdkModel('claude:default')).toBe('opus')
      expect(resolveClaudeSdkModel('claude:glm')).toBe('opus')
      expect(resolveClaudeSdkModel('claude:custom')).toBe('sonnet')
      expect(resolveClaudeSdkModel('claude:empty')).toBe('opus')
      expect(resolveClaudeSdkModel('claude:unlisted')).toBe('unlisted')
      expect(resolveClaudeSdkModel('real-model')).toBe('real-model')
      expect(resolveClaudeSdkModel('GLM-5.2[1m]')).toBe('GLM-5.2[1m]')
      config.claude.models.glm = { model: 'custom-glm' }
      expect(resolveClaudeSdkModel('claude:glm')).toBe('custom-glm')
    } finally {
      config.claude.models = previousModels
    }
  })
})

describe('Claude configured executable ([claude] bin)', () => {
  test('uses configured bin as the SDK executable', () => {
    const bin = '/home/me/.local/bin/claude-wrapper'
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBe(bin)
    expect(executable.spawnClaudeCodeProcess).toBeUndefined()
    expect(executable.description).toBe(`config:${bin}`)
  })

  test('throws instead of silently falling back when configured bin is missing', () => {
    expect(() => resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: '/nope/claude-wrapper',
      exists: () => false,
    })).toThrow('/nope/claude-wrapper')
  })

  test('runs configured Windows .cmd bin through the shell shim spawn hook', () => {
    const bin = win32.join('C:\\Users\\me\\bin', 'claude-wrapper.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBe(bin)
    expect(typeof executable.spawnClaudeCodeProcess).toBe('function')
    expect(executable.description).toBe(`windows-shell-shim:${bin}`)
  })

  test('explicit null configuredBin falls back to auto discovery', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: '',
      configuredBin: null,
      exists: () => false,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })

  test('sendInitialize 配错 bin 路径时走 error/exit 事件而非同步抛出', () => {
    // [claude].bin 指向不存在的路径 → resolveClaudeExecutableConfig 同步抛出;
    // 修复确保该抛出在 sendInitialize 的 try/catch 内被捕获,转为事件输出,
    // 调用方不会收到同步异常,session 层可通过 error/exit 事件做正常清理。
    const previousBin = config.claude.bin
    ;(config.claude as any).bin = '/nope/claude-wrapper'
    try {
      const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' })
      const errors: Error[] = []
      const exits: any[] = []
      proc.on('error', (err: Error) => errors.push(err))
      proc.on('exit', (ev: any) => exits.push(ev))

      // 不能同步抛出
      expect(() => proc.sendInitialize()).not.toThrow()

      // error 事件携带路径信息
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('/nope/claude-wrapper')

      // exit 事件 code=1
      expect(exits).toHaveLength(1)
      expect(exits[0].code).toBe(1)
    } finally {
      if (previousBin === undefined) delete (config.claude as any).bin
      else config.claude.bin = previousBin
    }
  })

  test('原生目录、额度和设置查询保留初始化失败的原始错误', async () => {
    // sendInitialize 因配错 bin 走 catch → this.query 保持 undefined。
    // 旧实现此时调 listModels/setModelSettings 会抛模糊的
    // "Cannot read properties of undefined (reading 'supportedModels')";
    // 保留初始化的原始路径错误，不能用泛化的 SDK 错误掩盖原因。
    const previousBin = config.claude.bin
    ;(config.claude as any).bin = '/nope/claude-wrapper'
    try {
      const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' })
      proc.sendInitialize() // 走 catch,this.query 仍 undefined

      await expect(proc.listModels()).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
      await expect(proc.readSubscriptionUsage()).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
      await expect(proc.setModelSettings('opus', 'high')).rejects.toThrow('[claude].bin not found: /nope/claude-wrapper')
    } finally {
      if (previousBin === undefined) delete (config.claude as any).bin
      else config.claude.bin = previousBin
    }
  })
})

describe('Claude permission mode', () => {
  test('runs Claude Code in default mode so canUseTool can intercept AskUserQuestion', () => {
    // bypassPermissions 会 shadow canUseTool(SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED),
    // AskUserQuestion 被秒批空答案;改 default 后 canUseTool 才能拦下渲染卡片。
    expect(CLAUDE_PERMISSION_MODE).toBe('default')
  })
})

describe('Claude shutdown reliability', () => {
  test('drops queued user inputs when the process is killed', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.input.push({ type: 'user', message: { role: 'user', content: [] } })

    await proc.kill()

    await expect(proc.input.next()).resolves.toEqual({ value: undefined, done: true })
  })

  test('resolves pending SDK permissions with a legal deny on exit', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const ac = new AbortController()
    const permission = proc.canUseTool(
      'AskUserQuestion',
      { question: 'Continue?', options: ['Yes', 'No'] },
      { signal: ac.signal, toolUseID: 'dialog-stop-1' },
    )

    proc.finishExit(0, null)

    await expect(permission).resolves.toEqual({ behavior: 'deny', message: 'claude process exited' })
    expect(proc.pendingPermissions.size).toBe(0)
  })

  test('uses SDK close and abort, then waits for the read loop exit', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const exits: any[] = []
    let closeCalls = 0
    proc.started = true
    proc.query = {
      close: () => {
        closeCalls++
        queueMicrotask(() => proc.finishExit(null, null))
      },
    }
    proc.on('exit', (event: any) => exits.push(event))

    await expect(proc.kill(20)).resolves.toBeUndefined()

    expect(closeCalls).toBe(1)
    expect(proc.abortController.signal.aborted).toBe(true)
    expect(exits).toEqual([{ code: null, signal: null, expected: true }])
  })

  test('does not fabricate SIGKILL success when SDK close/abort never exits', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const exits: any[] = []
    proc.started = true
    proc.query = { close: () => {} }
    proc.on('exit', (event: any) => exits.push(event))

    await expect(proc.kill(5)).rejects.toThrow('did not exit within 5ms')

    expect(proc.abortController.signal.aborted).toBe(true)
    expect(proc.alive).toBe(true)
    expect(exits).toEqual([])
  })

  test('surfaces SDK close errors even when abort completes shutdown', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    proc.started = true
    proc.query = {
      close: () => {
        queueMicrotask(() => proc.finishExit(null, null))
        throw new Error('close exploded')
      },
    }

    await expect(proc.kill(20)).rejects.toThrow('SDK close failed: close exploded')
    expect(proc.alive).toBe(false)
  })
})

describe('Claude background task protocol validation', () => {
  test('does not turn an unknown terminal status into completed', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const settled: any[] = []
    proc.on('bg_task_settled', (event: any) => settled.push(event))

    proc.handleMessage({
      type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'future_status',
    })
    expect(settled).toEqual([])

    proc.handleMessage({
      type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed',
    })
    expect(settled).toEqual([{ task_id: 'task-1', status: 'completed', tool_use_id: undefined, summary: undefined, usage: undefined }])
  })
})

describe('Claude user dialog bridge', () => {
  test('emits only SDK meta string prompts as scheduled turn input', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const scheduled: any[] = []
    proc.on('scheduled_turn_input', (event: any) => scheduled.push(event))

    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptSource: 'sdk',
      promptId: 'cron-prompt-1',
      permissionMode: 'default',
      message: { role: 'user', content: '【CrossEX 半小时运行巡检】检查服务并汇报。' },
    })
    // 手动用户消息由 Lodestar 自己的 input claim/card 负责，不是 scheduled。
    proc.handleMessage({
      type: 'user',
      isMeta: false,
      promptSource: 'sdk',
      promptId: 'manual-prompt',
      permissionMode: 'default',
      message: { role: 'user', content: [{ type: 'text', text: '手动检查一下' }] },
    })
    // Claude 图片结果也是 meta string，但不是 SDK prompt，不能误开定时卡。
    proc.handleMessage({
      type: 'user',
      isMeta: true,
      promptId: 'image-result',
      message: { role: 'user', content: '[Image: original 1440x2400]' },
    })

    expect(scheduled).toEqual([{
      text: '【CrossEX 半小时运行巡检】检查服务并汇报。',
      promptId: 'cron-prompt-1',
    }])
  })

  test('marks subagent assistant text with its parent and never promotes its UUID to the main checkpoint', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const texts: any[] = []
    const stops: any[] = []
    proc.on('assistant_text', (event: any) => texts.push(event))
    proc.on('assistant_block_stop', (event: any) => stops.push(event))

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-child',
      parent_tool_use_id: 'task-main-1',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '子 Agent 的阶段性独白' }],
      },
    })

    expect(texts).toEqual([{
      uuid: 'assistant-child',
      text: '子 Agent 的阶段性独白',
      parentToolUseId: 'task-main-1',
    }])
    expect(stops).toEqual([{
      index: 'assistant-child',
      parentToolUseId: 'task-main-1',
    }])
    expect(proc.lastAssistantUuid).toBeNull()

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-main',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '主 Agent 正文' }],
      },
    })

    expect(texts.at(-1)).toEqual({
      uuid: 'assistant-main',
      text: '主 Agent 正文',
      parentToolUseId: null,
    })
    expect(stops.at(-1)).toEqual({
      index: 'assistant-main',
      parentToolUseId: null,
    })
    expect(proc.lastAssistantUuid).toBe('assistant-main')
  })

  test('uses session_state_changed running as turn start boundary', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const inits: any[] = []
    const started: any[] = []
    proc.on('init', (event: any) => inits.push(event))
    proc.on('turn_started', (event: any) => started.push(event))

    proc.handleMessage({
      type: 'system',
      subtype: 'init',
      uuid: 'init-1',
      session_id: 'claude-session-1',
      model: 'sonnet',
    })
    expect(inits).toHaveLength(1)
    expect(started).toEqual([])

    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'requires_action',
      uuid: 'turn-1-permission',
      session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-1-resumed',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([{ turn_id: 'turn-1', thread_id: 'claude-session-1' }])

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'turn-2',
      session_id: 'claude-session-1',
    })
    expect(started).toEqual([
      { turn_id: 'turn-1', thread_id: 'claude-session-1' },
      { turn_id: 'turn-2', thread_id: 'claude-session-1' },
    ])
  })

  test('emits a turn-local Claude checkpoint and clears it at the next turn boundary', () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const results: any[] = []
    proc.on('result', (event: any) => results.push(event))
    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-1', session_id: 'claude-session-1',
    })
    proc.handleMessage({
      type: 'assistant', uuid: 'assistant-1',
      message: { model: 'opus', content: [{ type: 'text', text: 'done' }] },
    })
    proc.handleMessage({
      type: 'result', subtype: 'success', session_id: 'claude-session-1',
      is_error: false, duration_ms: 1, usage: {}, modelUsage: {},
    })
    expect(results[0].checkpoint).toEqual({
      provider: 'claude', kind: 'assistant-message', id: 'assistant-1',
      source: { provider: 'claude', sessionId: 'claude-session-1', cwd: '/tmp' },
    })

    proc.handleMessage({
      type: 'system', subtype: 'session_state_changed', state: 'running',
      uuid: 'turn-2', session_id: 'claude-session-1',
    })
    expect(proc.lastAssistantUuid).toBeNull()
    proc.handleMessage({
      type: 'result', subtype: 'error', session_id: 'claude-session-1',
      is_error: true, duration_ms: 1, usage: {}, modelUsage: {},
    })
    expect(results[1].checkpoint).toBeNull()
  })

  test('routes AskUserQuestion through canUseTool permission flow', async () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const toolUses: any[] = []
    const permissions: any[] = []
    proc.on('tool_use', (event: any) => toolUses.push(event))
    proc.on('can_use_tool', (event: any) => {
      permissions.push(event)
      proc.sendPermissionResponse(event.request_id, 'allow', {
        updatedInput: {
          ...event.input,
          answers: { 'Pick one?': 'A' },
        },
      })
    })

    const abortController = new AbortController()
    const resultPromise = proc.canUseTool(
      'AskUserQuestion',
      { question: 'Pick one?', options: ['A', 'B'] },
      { signal: abortController.signal, toolUseID: 'tool_dialog_1' },
    )

    expect(toolUses).toEqual([{
      id: 'tool_dialog_1',
      name: 'AskUserQuestion',
      input: {
        question: 'Pick one?',
        options: ['A', 'B'],
        questions: [{
          question: 'Pick one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
      parentToolUseId: null,
    }])
    expect(permissions).toHaveLength(1)
    expect(permissions[0].tool_name).toBe('AskUserQuestion')
    expect(permissions[0].tool_use_id).toBe('tool_dialog_1')

    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        question: 'Pick one?',
        options: ['A', 'B'],
        questions: [{
          question: 'Pick one?',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  test('canUseTool auto-allows non-AskUserQuestion tools (replicates bypass)', async () => {
    const proc = new ClaudeAgentProcess({ workDir: '/tmp', effort: 'high' }) as any
    const toolUses: any[] = []
    const permissions: any[] = []
    proc.on('tool_use', (event: any) => toolUses.push(event))
    proc.on('can_use_tool', (event: any) => permissions.push(event))
    const ac = new AbortController()
    const result = await proc.canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: ac.signal, toolUseID: 'call_bash_1' },
    )
    // allow 分支 updatedInput 运行时必填(SDK Zod),回传原 input=不改
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'echo hi' } })
    // 非 AskUserQuestion 不走卡片机器:不发 tool_use、不发 can_use_tool
    expect(toolUses).toEqual([])
    expect(permissions).toEqual([])
  })

  test('bridges provider server tools and suppresses scaffold text', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const events: Array<[string, any]> = []
    proc.on('assistant_text', (event: any) => events.push(['assistant_text', event]))
    proc.on('tool_use', (event: any) => events.push(['tool_use', event]))
    proc.on('tool_result', (event: any) => events.push(['tool_result', event]))

    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-intro',
      message: {
        model: 'opus',
        content: [{ type: 'text', text: '我用视觉分析工具来看这两张图。' }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-scaffold',
      message: {
        model: 'opus',
        content: [{
          type: 'text',
          text: '**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://signed.example/img","prompt":"识别截图内容"}\n```',
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-use',
      message: {
        model: 'opus',
        content: [{
          type: 'server_tool_use',
          id: 'call_image_1',
          name: 'analyze_image',
          input: {},
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-output-scaffold',
      message: {
        model: 'opus',
        content: [{
          type: 'text',
          text: '**Output:**\n**analyze_image_result_summary:** [{"text":"完整识图结果"}]',
        }],
      },
    })
    proc.handleMessage({
      type: 'assistant',
      uuid: 'assistant-server-tool-result',
      message: {
        model: 'opus',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_image_1',
          content: '["完整识图结果"]',
        }],
      },
    })

    expect(events).toEqual([
      ['assistant_text', {
        uuid: 'assistant-intro',
        text: '我用视觉分析工具来看这两张图。',
        parentToolUseId: null,
      }],
      ['tool_use', {
        id: 'call_image_1',
        name: 'server_tool:analyze_image',
        input: {
          tool: 'analyze_image',
          input: {
            imageSource: 'https://signed.example/img',
            prompt: '识别截图内容',
          },
        },
        parentToolUseId: null,
      }],
      ['tool_result', {
        tool_use_id: 'call_image_1',
        content: '完整识图结果',
        is_error: false,
        parentToolUseId: null,
      }],
    ])
  })
})

describe('Claude token accounting', () => {
  test('accumulates per-result usage when modelUsage totals are absent', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {},
    })
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: {
        input_tokens: 7,
        output_tokens: 1,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 3,
      },
      modelUsage: {},
    })

    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[1].usage).toEqual({
      input_tokens: 7,
      output_tokens: 1,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 12,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 17,
      output_tokens: 3,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 24,
    })
    expect(proc.lastTotalUsage).toEqual(usageEvents[1].totalUsage)
  })

  test('parses camelCase per-result usage fields', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-camel-usage',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 3,
      },
      modelUsage: {},
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 16,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 3,
      total_tokens: 16,
    })
  })

  test('uses modelUsage as authoritative cumulative totals when present', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: {
        opus: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          contextWindow: 200000,
          costUSD: 0.25,
        },
      },
    })
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 12,
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1 },
      modelUsage: {
        glm: {
          input_tokens: 130,
          output_tokens: 25,
          cache_creation_input_tokens: 8,
          cache_read_input_tokens: 40,
          context_window: 258000,
          cost_usd: 0.31,
        },
      },
    })

    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      total_tokens: 155,
    })
    expect(usageEvents[0].contextWindow).toBe(200000)

    expect(usageEvents[1].usage).toEqual({
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
    })
    expect(usageEvents[1].totalUsage).toEqual({
      input_tokens: 130,
      output_tokens: 25,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 40,
      total_tokens: 203,
    })
    expect(usageEvents[1].contextWindow).toBe(258000)
    // 占用从 transcript 读 per-call usage,test 环境无 transcript → null(MISS)。
    // (result.usage 是 turn 聚合、modelUsage 是 session 累计,都不代表当前上下文)
    expect(proc.lastContextTokens).toBeNull()
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
  })

  test('uses model_usage alias as authoritative cumulative totals when present', () => {
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-snake-model-usage',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
      model_usage: {
        opus: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 30,
          contextWindow: 200000,
          costUSD: 0.25,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usageEvents[0].totalUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      total_tokens: 155,
    })
    expect(usageEvents[0].contextWindow).toBe(200000)
    expect(proc.lastResult.cost_usd).toBeNull()
    expect(proc.lastResult.cost_delta_usd).toBeNull()
  })

  test('single SDK context-window report becomes the locked denominator', () => {
    // 优先采用 SDK 当前明确上报的窗口。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-glm-sdk-window',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 87_000, output_tokens: 700 },
      modelUsage: {
        opus: {
          inputTokens: 87_000,
          outputTokens: 700,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          contextWindow: 100_000,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    // SDK 实测 100K 优先于 profile 声明的 1M
    expect(usageEvents[0].contextWindow).toBe(100_000)
    expect(proc.lastContextWindow).toBe(100_000)
    // 占用从 transcript 读 per-call usage,test 无 transcript → null
    expect(proc.lastContextTokens).toBeNull()
  })

  test('context window follows fresh reports even when capacity decreases', () => {
    // 新上报的窗口无论变大还是变小，都不能被历史缓存覆盖。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const events: any[] = []
    proc.on('token_usage', (e: any) => events.push(e))

    const result = (ctx: number) => proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: `r-${ctx}`,
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: ctx } },
    })

    result(200_000)
    expect(events).toHaveLength(1)
    expect(proc.lastContextWindow).toBe(200_000)
    expect(events[0].contextWindow).toBe(200_000)
    result(1_000_000)
    expect(proc.lastContextWindow).toBe(1_000_000) // 升到真实窗口
    expect(events[1].contextWindow).toBe(1_000_000)
    result(200_000)
    expect(proc.lastContextWindow).toBe(200_000)
    expect(events[2].contextWindow).toBe(200_000)
    result(258_000)
    expect(proc.lastContextWindow).toBe(258_000)
  })

  test('fresh context windows update their route without crossing sources', () => {
    // 同路由新的 SDK 上报可更新缓存，不同来源与路由仍然隔离。
    const proc1 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'glm',
    }) as any
    proc1.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-1', session_id: 's1',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 1_000_000 } },
    })
    expect(proc1.lastContextWindow).toBe(1_000_000)

    // 同路由的新实例收到更小的明确数值，应采用该值。
    const proc2 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'glm',
    }) as any
    proc2.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-2', session_id: 's2',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc2.lastContextWindow).toBe(200_000)

    // 不同路由不串扰:default 路由的探测独立于 glm 路由
    const proc3 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:default',
    }) as any
    proc3.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-3', session_id: 's3',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc3.lastContextWindow).toBe(200_000) // default 路由独立, 200K

    const proc4 = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'claude:glm', tokenSourceId: 'deepseek',
    }) as any
    proc4.handleMessage({
      type: 'result', subtype: 'success', uuid: 'r-global-4', session_id: 's4',
      is_error: false, duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 1000, output_tokens: 10 },
      modelUsage: { opus: { inputTokens: 1000, outputTokens: 10, contextWindow: 200_000 } },
    })
    expect(proc4.lastContextWindow).toBe(200_000) // 同 model slug、不同 source 不串扰
  })

  test('context errors preserve the observed window and expose the actual SDK error list', async () => {
    const { observedContextWindow } = await import('./context-window-observe')
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp', effort: 'high', model: 'audit-window[1m]', tokenSourceId: 'audit-window-source',
    }) as any
    const results: any[] = []
    proc.on('result', (result: any) => results.push(result))
    proc.handleMessage({
      type: 'result', subtype: 'success', session_id: 'window-session', is_error: false,
      modelUsage: { 'audit-window[1m]': { inputTokens: 100, outputTokens: 10, contextWindow: 1_000_000 } },
    })
    proc.handleMessage({
      type: 'result', subtype: 'error_during_execution', session_id: 'window-session', is_error: true,
      result: 'prompt is too long', errors: ['Request exceeds the context window', 'Reduce this request'],
      modelUsage: {},
    })
    expect(observedContextWindow('audit-window-source', 'audit-window')).toBe(1_000_000)
    expect(proc.opts.model).toBe('audit-window[1m]')
    expect(results.at(-1)).toMatchObject({
      is_error: true, error: 'Request exceeds the context window\nReduce this request',
    })
  })

  test('context window stays null when SDK does not report one', () => {
    // SDK 没上报 contextWindow → null,不为它兜底假窗口(no fallback)。
    const proc = new ClaudeAgentProcess({
      workDir: '/tmp',
      effort: 'high',
      model: 'claude:glm',
    }) as any
    const usageEvents: any[] = []
    proc.on('token_usage', (event: any) => usageEvents.push(event))

    proc.handleMessage({
      type: 'result',
      subtype: 'success',
      uuid: 'result-glm-no-sdk-window',
      session_id: 'claude-session-1',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      usage: { input_tokens: 87_000, output_tokens: 700 },
      modelUsage: {
        opus: {
          inputTokens: 87_000,
          outputTokens: 700,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].contextWindow).toBeNull()
    expect(proc.lastContextWindow).toBeNull()
  })
})

describe('Claude transcript context tokens', () => {
  test('claudeTranscriptPath encodes cwd slashes to dashes', () => {
    const p = claudeTranscriptPath('/home/leviyuan/feishu', 'sid-1')
    expect(p.endsWith('projects/-home-leviyuan-feishu/sid-1.jsonl')).toBe(true)
  })

  test('readLastCallUsageFromTranscript returns the last assistant per-call usage', () => {
    const tmp = join(tmpdir(), `lodestar-t-${Date.now()}.jsonl`)
    writeFileSync(tmp, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 } } }),
    ].join('\n'))
    // 取最后一条 assistant 的 per-call usage(transcript finalize 后的真实值,
    // = session 当前上下文,与 omc hud context_window.current_usage 同口径)
    expect(readLastCallUsageFromTranscript(tmp)).toEqual({ input_tokens: 30, cache_read_input_tokens: 41728, cache_creation_input_tokens: 0 })
    unlinkSync(tmp)
  })

  test('readLastCallUsageFromTranscript returns null when file missing', () => {
    expect(readLastCallUsageFromTranscript(join(tmpdir(), 'lodestar-no-such.jsonl'))).toBeNull()
  })
})

describe('Claude project profile overrides', () => {
  test('settingSourcesFromProfile falls back to project+local when absent (排除 user: settings.json env 段不覆盖 token source spawnEnv)', () => {
    expect(settingSourcesFromProfile(undefined)).toEqual(['project', 'local'])
    expect(settingSourcesFromProfile({})).toEqual(['project', 'local'])
  })

  test('settingSourcesFromProfile splits and trims comma-separated sources', () => {
    expect(settingSourcesFromProfile({ settingSources: 'project' })).toEqual(['project'])
    expect(settingSourcesFromProfile({ settingSources: 'user, project' })).toEqual(['user', 'project'])
  })

  test('settingSourcesFromProfile falls back to project+local when only blanks given', () => {
    expect(settingSourcesFromProfile({ settingSources: '' })).toEqual(['project', 'local'])
    expect(settingSourcesFromProfile({ settingSources: ' , ' })).toEqual(['project', 'local'])
  })

  test('toolsFromProfile falls back to claude_code preset when absent', () => {
    expect(toolsFromProfile(undefined)).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(toolsFromProfile({})).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  test('toolsFromProfile splits comma-separated built-in tool names', () => {
    expect(toolsFromProfile({ tools: 'Read,Write,Edit,Bash,Glob,Grep' })).toEqual([
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
    ])
  })

  test('toolsFromProfile falls back when only blanks given', () => {
    expect(toolsFromProfile({ tools: '' })).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(toolsFromProfile({ tools: ' , ' })).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  test('readProjectMcpServers reads <workDir>/.mcp.json mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { evolving: { command: '/bin/evolving', args: ['mcp-notify'] } },
    }))
    expect(readProjectMcpServers(dir)).toEqual({
      evolving: { command: '/bin/evolving', args: ['mcp-notify'] },
    })
  })

  test('readProjectMcpServers returns undefined when .mcp.json missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    expect(readProjectMcpServers(dir)).toBeUndefined()
  })

  test('readProjectMcpServers rejects malformed json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), '{ not json')
    try { expect(() => readProjectMcpServers(dir)).toThrow('project .mcp.json parse failed') }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('readProjectMcpServers rejects missing and non-object mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    try {
      for (const value of [{ foo: 'bar' }, { mcpServers: [] }, { mcpServers: null }, null]) {
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify(value))
        expect(() => readProjectMcpServers(dir)).toThrow('no valid mcpServers object')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('readProjectMcpServers exposes filesystem errors instead of omitting configured tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    mkdirSync(join(dir, '.mcp.json'))
    try { expect(() => readProjectMcpServers(dir)).toThrow('project .mcp.json not readable') }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('invalid project MCP configuration fails initialization before the SDK starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-mcp-'))
    writeFileSync(join(dir, '.mcp.json'), '{ not json')
    const sdk = spyOn(agentUpdates, 'loadClaudeSdk')
    const proc = new ClaudeAgentProcess({ workDir: dir, effort: 'high' })
    const errors: Error[] = []
    const exits: unknown[] = []
    proc.on('error', error => errors.push(error))
    proc.on('exit', event => exits.push(event))
    try {
      await expect(proc.listModels()).rejects.toThrow('project .mcp.json parse failed')
      expect(sdk).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      expect(exits).toEqual([{ code: 1, signal: null, expected: false }])
      expect(proc.isAlive()).toBe(false)
    } finally {
      sdk.mockRestore()
      await proc.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
