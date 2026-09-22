import { describe, expect, test } from 'bun:test'

import {
  applyBgTaskStarted,
  applyBgTaskProgress,
  applyBgTaskUpdated,
  promotePendingOnAdvance,
  applyBgTaskSettled,
  applyBgToolUse,
  applyBgToolResult,
  isBgTerminal,
  hasActiveBgTask,
  backgroundTaskPanel,
  emptyBgStore,
  BG_ELEMENTS,
  elapsedBucket,
  liveElapsed,
  LIVE_ELAPSED_SECOND_FOOTER_TICK_MS,
  type BgTaskEntry,
  type BgStore,
} from './background'

const mk = (over: Partial<BgTaskEntry> & Pick<BgTaskEntry, 'id' | 'status'>): BgTaskEntry => ({
  type: 'subagent',
  description: 'd',
  startedAt: 0,
  steps: [],
  ...over,
})

describe('elapsedBucket', () => {
  test('maps live elapsed time to stable labels and exact next boundaries', () => {
    expect(elapsedBucket(-1)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(0)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(29_999)).toEqual({ label: '<30s', nextDelayMs: 1 })
    expect(elapsedBucket(30_000)).toEqual({ label: '<1m', nextDelayMs: 30_000 })
    expect(elapsedBucket(59_999)).toEqual({ label: '<1m', nextDelayMs: 1 })
    expect(elapsedBucket(60_000)).toEqual({ label: '<3m', nextDelayMs: 120_000 })
    expect(elapsedBucket(180_000)).toEqual({ label: '<5m', nextDelayMs: 120_000 })
    expect(elapsedBucket(300_000)).toEqual({ label: '<10m', nextDelayMs: 300_000 })
    expect(elapsedBucket(600_000)).toEqual({ label: '10m+', nextDelayMs: 600_000 })
    expect(elapsedBucket(1_199_999)).toEqual({ label: '10m+', nextDelayMs: 1 })
    expect(elapsedBucket(1_200_000)).toEqual({ label: '20m+', nextDelayMs: 600_000 })
    expect(elapsedBucket(3_600_000)).toEqual({ label: '1h+', nextDelayMs: 600_000 })
    expect(elapsedBucket(4_200_000)).toEqual({ label: '1.1h+', nextDelayMs: 600_000 })
    expect(elapsedBucket(10_800_000)).toEqual({ label: '3h+', nextDelayMs: 600_000 })
  })

  test('normalizes non-finite input instead of producing a zero-delay timer loop', () => {
    expect(elapsedBucket(Number.NaN)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
    expect(elapsedBucket(Number.POSITIVE_INFINITY)).toEqual({ label: '<30s', nextDelayMs: 30_000 })
  })
})

describe('liveElapsed', () => {
  test('bucket mode delegates to elapsedBucket', () => {
    expect(liveElapsed(45_000, 'bucket')).toEqual(elapsedBucket(45_000))
    expect(liveElapsed(45_000)).toEqual(elapsedBucket(45_000))
  })

  test('second mode uses a single duration unit and preserves refresh boundaries', () => {
    expect(liveElapsed(0, 'second')).toEqual({ label: '0s', nextDelayMs: LIVE_ELAPSED_SECOND_FOOTER_TICK_MS })
    expect(liveElapsed(999, 'second')).toEqual({ label: '0s', nextDelayMs: 1000 })
    expect(liveElapsed(1_500, 'second')).toEqual({ label: '1s', nextDelayMs: 1000 })
    expect(liveElapsed(45_000, 'second')).toEqual({ label: '45s', nextDelayMs: 1000 })
    expect(liveElapsed(60_000, 'second')).toEqual({ label: '1m', nextDelayMs: 1000 })
    expect(liveElapsed(90_000, 'second')).toEqual({ label: '1.5m', nextDelayMs: 1000 })
    // 边界:599_999ms 仍每秒刷新,600_000ms(整 10m)切档位。
    expect(liveElapsed(599_999, 'second')).toEqual({ label: '10m', nextDelayMs: 1000 })
    // 超 10m:不再按秒,改 5m 颗粒度档位(10m+ / 15m+ / 20m+…),只在 5m 边界 push。
    expect(liveElapsed(600_000, 'second')).toEqual({ label: '10m+', nextDelayMs: 300_000 })
    expect(liveElapsed(899_999, 'second')).toEqual({ label: '10m+', nextDelayMs: 1 })
    expect(liveElapsed(900_000, 'second')).toEqual({ label: '15m+', nextDelayMs: 300_000 })
    expect(liveElapsed(1_200_000, 'second')).toEqual({ label: '20m+', nextDelayMs: 300_000 })
    expect(liveElapsed(3_600_000, 'second')).toEqual({ label: '1h+', nextDelayMs: 300_000 })
    expect(liveElapsed(4_200_000, 'second')).toEqual({ label: '1.1h+', nextDelayMs: 300_000 })
    expect(liveElapsed(10_800_000, 'second')).toEqual({ label: '3h+', nextDelayMs: 300_000 })
  })
})

describe('applyBgTaskStarted — 白名单直入 active / 前台落 pending', () => {
  test('workflow 白名单直入 active 并标 isBackgrounded', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'w1', task_type: 'local_workflow', description: '跑 spec', workflow_name: 'spec' }, 1000)
    expect(s.active).toHaveLength(1)
    expect(s.pending).toHaveLength(0)
    expect(s.active[0]).toMatchObject({ id: 'w1', type: 'workflow', status: 'running', startedAt: 1000, workflowName: 'spec', isBackgrounded: true })
  })

  test('monitor 白名单直入 active', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'm1', task_type: 'local_monitor', description: '盯盘' })
    expect(s.active[0].type).toBe('monitor')
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.pending).toHaveLength(0)
  })

  test('前台 shell(Bash 命令)进 pending,active 空,不标 isBackgrounded', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'build' })
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0]).toMatchObject({ id: 'b1', type: 'shell', status: 'running' })
    expect(s.pending[0].isBackgrounded).toBeUndefined()
  })

  test('前台子 Agent 直接展示', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'a1', description: '搜索', subagent_type: 'Explore' })
    expect(s.pending).toHaveLength(0)
    expect(s.active[0]).toMatchObject({ id: 'a1', type: 'subagent', subagentType: 'Explore' })
  })

  test('DSH agent 类型直接显示为子 Agent', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'dsh', task_type: 'agent', description: '检查' })
    expect(s.pending).toHaveLength(0)
    expect(s.active[0].type).toBe('subagent')
  })

  test('SDK 后补子 Agent 类型时立即从观察池展示', () => {
    const unknown = applyBgTaskStarted(emptyBgStore(), { task_id: 'child', description: '检查' })
    expect(unknown.pending).toHaveLength(1)
    const known = applyBgTaskStarted(unknown, { task_id: 'child', description: '检查', subagent_type: 'Explore' })
    expect(known.pending).toHaveLength(0)
    expect(known.active[0].type).toBe('subagent')
  })

  test('SDK task id 回填沿用启动工具的状态与步骤，续跑重新计时', () => {
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'tool', tool_use_id: 'tool', task_type: 'subagent', description: '检查' }, 100)
    s = applyBgToolUse(s, 'tool', 'read', 'Read', { file_path: '/repo/a.ts' })
    s = applyBgTaskStarted(s, { task_id: 'sdk-task', tool_use_id: 'tool', description: '检查代码' }, 200)
    expect(s.active).toHaveLength(1)
    expect(s.active[0]).toMatchObject({ id: 'sdk-task', type: 'subagent', startedAt: 100 })
    expect(s.active[0].steps).toHaveLength(1)
    s = applyBgTaskSettled(s, { task_id: 'sdk-task', status: 'completed', summary: '已完成' }, 300)
    s = applyBgTaskStarted(s, { task_id: 'sdk-task', tool_use_id: 'tool', task_type: 'subagent', description: '续跑' }, 400)
    expect(s.active[0]).toMatchObject({ startedAt: 400, status: 'running', steps: [] })
    expect(s.active[0].endTime).toBeUndefined()
    expect(s.active[0].summary).toBeUndefined()
  })

  test('local_ 前缀归一化:local_bash→shell / local_agent→subagent / local_workflow→workflow', () => {
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'b', task_type: 'local_bash', description: 'x' }).pending[0].type).toBe('shell')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'a', task_type: 'local_agent', description: 'x' }).active[0].type).toBe('subagent')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'w', task_type: 'local_workflow', description: 'x' }).active[0].type).toBe('workflow')
  })

  test('重复 task_id 不堆叠,补全字段但留在原池 + 保留 status/startedAt', () => {
    // pending 里的前台 task 再次收到 started:补全字段,不提升
    const s0: BgStore = {
      active: [],
      pending: [mk({ id: 't1', type: 'unknown', description: '旧', status: 'running', startedAt: 1000, usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 } })],
    }
    const s = applyBgTaskStarted(s0, { task_id: 't1', task_type: 'shell', description: '新描述' }, 9999)
    expect(s.pending).toHaveLength(1)
    expect(s.active).toHaveLength(0)
    expect(s.pending[0].description).toBe('新描述')
    expect(s.pending[0].type).toBe('shell')
    expect(s.pending[0].startedAt).toBe(1000)  // 不被覆盖
    expect(s.pending[0].usage?.total_tokens).toBe(100)
  })
})

describe('applyBgTaskProgress — active/pending 双池刷新', () => {
  test('刷 active 里的 task', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running', subagentType: 'Explore' })], pending: [] }
    const s = applyBgTaskProgress(s0, { task_id: 't1', usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 }, last_tool_name: 'Grep', summary: '命中 3 处' })
    expect(s.active[0].usage?.total_tokens).toBe(500)
    expect(s.active[0].lastToolName).toBe('Grep')
    expect(s.active[0].summary).toBe('命中 3 处')
  })

  test('刷 pending 里的前台 task(提升前攒数据)', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running' })] }
    const s = applyBgTaskProgress(s0, { task_id: 't1', summary: '跑着' })
    expect(s.pending[0].summary).toBe('跑着')
  })

  test('pending → running 状态提升', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'pending' })] }
    const s = applyBgTaskProgress(s0, { task_id: 't1' })
    expect(s.pending[0].status).toBe('running')
  })

  test('未知 task_id no-op', () => {
    const s: BgStore = { active: [mk({ id: 't1', status: 'running' })], pending: [] }
    expect(applyBgTaskProgress(s, { task_id: 'tX' })).toBe(s)
  })
})

describe('applyBgTaskUpdated — is_backgrounded 提升 + 原池 patch', () => {
  test('is_backgrounded:true 把 pending 前台 task 提升到 active,带 steps', () => {
    const s0: BgStore = {
      active: [],
      pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', description: 'build', status: 'running', steps: [{ toolUseId: 'tu', tool: 'Bash', brief: 'old' }] })],
    }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { is_backgrounded: true } })
    expect(s.pending).toHaveLength(0)
    expect(s.active).toHaveLength(1)
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.active[0].steps).toHaveLength(1)  // steps 带过来
  })

  test('已在 active 的 task 收 is_backgrounded:true 不重复添加(原地标记)', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running' })], pending: [] }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { is_backgrounded: true, status: 'paused', error: 'oom' } })
    expect(s.active).toHaveLength(1)
    expect(s.active[0].isBackgrounded).toBe(true)
    expect(s.active[0].status).toBe('paused')
    expect(s.active[0].error).toBe('oom')
  })

  test('pending 里的非提升 patch(改 status)不提升', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running' })] }
    const s = applyBgTaskUpdated(s0, { task_id: 't1', patch: { status: 'paused' } })
    expect(s.pending).toHaveLength(1)
    expect(s.active).toHaveLength(0)
    expect(s.pending[0].status).toBe('paused')
  })

  test('未知 task_id no-op(不凭空造)', () => {
    const s: BgStore = { active: [], pending: [] }
    expect(applyBgTaskUpdated(s, { task_id: 'tX', patch: { is_backgrounded: true } })).toBe(s)
  })
})

describe('applyBgTaskSettled — 前台丢弃 / active 结算墓碑', () => {
  test('pending 前台 task 结算 → 直接丢,不进 active', () => {
    const s0: BgStore = { active: [], pending: [mk({ id: 't1', status: 'running', startedAt: 1000 })] }
    const s = applyBgTaskSettled(s0, { task_id: 't1', status: 'completed' }, 8000)
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(0)
  })

  test('active 后台 task 结算 → 墓碑 + endTime', () => {
    const s0: BgStore = { active: [mk({ id: 't1', status: 'running', startedAt: 1000 })], pending: [] }
    const s = applyBgTaskSettled(s0, { task_id: 't1', status: 'completed', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 7000 } }, 8000)
    expect(s.active[0]).toMatchObject({ status: 'completed', endTime: 8000 })
    expect(s.active[0].usage?.duration_ms).toBe(7000)
  })

  test('failed/stopped → failed/killed', () => {
    const s0: BgStore = {
      active: [
        mk({ id: 't1', status: 'running', startedAt: 1000 }),
        mk({ id: 't2', status: 'running', startedAt: 1000 }),
      ],
      pending: [],
    }
    let s = applyBgTaskSettled(s0, { task_id: 't1', status: 'failed' }, 8000)
    s = applyBgTaskSettled(s, { task_id: 't2', status: 'stopped' }, 8000)
    expect(s.active.map(t => t.status)).toEqual(['failed', 'killed'])
  })

  test('未知 task 终态 no-op(不补建墓碑,避免冒充后台任务)', () => {
    const s: BgStore = { active: [], pending: [] }
    expect(applyBgTaskSettled(s, { task_id: 'tZ', status: 'completed', summary: 'done' }, 8000)).toBe(s)
  })
})

describe('applyBgToolUse / applyBgToolResult — 双池 steps 累积', () => {
  test('parentToolUseId 匹配的 task 追加 step;主线程(null)/不匹配跳过', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'parent_1', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'parent_1', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0]).toMatchObject({ toolUseId: 'tu_1', tool: 'Grep' })
    expect(s.active[0].steps[0].brief).toContain('auth')
    // 主线程工具(null)跳过
    expect(applyBgToolUse(s, null, 'tu_2', 'Bash', { command: 'ls' })).toBe(s)
    // 不匹配的 parent 跳过
    expect(applyBgToolUse(s, 'other_parent', 'tu_3', 'Read', { file_path: '/x' })).toBe(s)
  })

  test('pending 里的前台子 agent 也累积 steps(提升前攒过程)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(s.pending[0].steps).toHaveLength(1)
  })

  test('tool_result 按 tool_use_id 回填结果到对应 step(双池)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中 3 处', false)
    expect(s.pending[0].steps[0].brief).toBe('Grep "auth" in src → 命中 3 处')
  })

  test('Bash step 的 brief 走 shell-command 解析:PowerShell 包装显示 desc 说明', () => {
    // Windows 子 agent 的命令被包进 powershell.exe -Command '...',steps 里
    // 应显示中文说明,不显示 powershell.exe 路径 / # desc 注释。
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', {
      command: `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command '# desc: 查看 xyq 项目模板状态\nGet-ChildItem "C:\\xyq" -Recurse'`,
    })
    expect(s.active[0].steps[0].brief).toBe('Bash 查看 xyq 项目模板状态')
    expect(s.active[0].steps[0].brief).not.toContain('powershell')
    expect(s.active[0].steps[0].brief).not.toContain('# desc')
  })

  test('tool_result 错误加 ❌', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu', 'Bash', { command: 'npm test' })
    s = applyBgToolResult(s, 'p', 'tu', 'tests failed', true)
    expect(s.active[0].steps[0].brief).toContain('❌')
    expect(s.active[0].steps[0].brief).toContain('tests failed')
  })

  test('DSH 结构化工具结果可在后台和观察池中显示，保留错误信息', () => {
    for (const pool of ['active', 'pending'] as const) {
      let s: BgStore = { active: [], pending: [] }
      s[pool] = [mk({ id: 'dsh-child', toolUseId: 'parent', status: 'running' })]
      s = applyBgToolUse(s, 'parent', 'bash', 'Bash', { command: 'echo child' })
      s = applyBgToolResult(s, 'parent', 'bash', [
        { type: 'text', text: 'started background job bash-1' },
        { type: 'text', text: 'second line' },
      ], false)
      expect(s[pool][0].steps[0].brief).toContain('started background job bash-1 second line')
      s = applyBgToolUse(s, 'parent', 'failed', 'Bash', { command: 'false' })
      s = applyBgToolResult(s, 'parent', 'failed', [{ type: 'text', text: 'command failed' }], true)
      expect(s[pool][0].steps[1].brief).toContain('❌ command failed')
    }
  })

  test('trim:steps 累积超 ~1000 字只留最新', () => {
    let s: BgStore = { active: [mk({ id: 't1', toolUseId: 'p', status: 'running' })], pending: [] }
    for (let i = 0; i < 50; i++) {
      s = applyBgToolUse(s, 'p', `tu_${i}`, 'Read', { file_path: `/very/long/path/to/file/number/${i}/source.ts` })
    }
    const totalBrief = s.active[0].steps.reduce((n, st) => n + st.brief.length + 5, 0)
    expect(totalBrief).toBeLessThanOrEqual(1100)
    expect(s.active[0].steps.length).toBeLessThan(50)
    expect(s.active[0].steps[s.active[0].steps.length - 1].brief).toContain('number/49')
  })

  test('子 Agent 前后台切换保留同一项及工具步骤', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'a1', task_type: 'local_agent', description: '搜索', subagent_type: 'Explore', tool_use_id: 'p' })
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中', false)
    expect(s.active).toHaveLength(1)
    expect(s.active[0].steps).toHaveLength(1)
    // 后台化 → 提升,steps 带到 active
    s = applyBgTaskUpdated(s, { task_id: 'a1', patch: { is_backgrounded: true } })
    expect(s.active).toHaveLength(1)
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.pending).toHaveLength(0)
  })
})

describe('端到端:前台命令全程不进 active(治「随便跑个命令就冒一项」)', () => {
  test('前台 Bash:started→pending,settled→丢,active 全程空,不建卡', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'b1', task_type: 'local_bash', description: 'echo hi' })
    expect(hasActiveBgTask(s.active)).toBe(false)  // active 空,不该建卡
    s = applyBgTaskSettled(s, { task_id: 'b1', status: 'completed' })
    expect(s.active).toHaveLength(0)
    expect(s.pending).toHaveLength(0)
    expect(hasActiveBgTask(s.active)).toBe(false)
  })

  test('前台命令被 Ctrl+B 后台化 → 入卡 → 结算墓碑', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'b2', task_type: 'local_bash', description: '长跑构建' })
    expect(hasActiveBgTask(s.active)).toBe(false)
    s = applyBgTaskUpdated(s, { task_id: 'b2', patch: { is_backgrounded: true } })
    expect(hasActiveBgTask(s.active)).toBe(true)  // 后台化后该建卡
    s = applyBgTaskSettled(s, { task_id: 'b2', status: 'completed' })
    expect(s.active[0].status).toBe('completed')
    expect(hasActiveBgTask(s.active)).toBe(false)  // 终态,不再活跃
  })

  test('workflow 天生后台:started 即入 active', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'w1', task_type: 'local_workflow', description: 'spec', workflow_name: 'spec' })
    expect(hasActiveBgTask(s.active)).toBe(true)
  })
})

describe('isBgTerminal / hasActiveBgTask', () => {
  test('终态判定', () => {
    expect(isBgTerminal(mk({ id: 'x', status: 'completed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'failed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'killed' }))).toBe(true)
    expect(isBgTerminal(mk({ id: 'x', status: 'running' }))).toBe(false)
    expect(isBgTerminal(mk({ id: 'x', status: 'paused' }))).toBe(false)
  })
  test('hasActiveBgTask', () => {
    expect(hasActiveBgTask([mk({ id: 'a', status: 'completed' }), mk({ id: 'b', status: 'failed' })])).toBe(false)
    expect(hasActiveBgTask([mk({ id: 'a', status: 'completed' }), mk({ id: 'b', status: 'running' })])).toBe(true)
    expect(hasActiveBgTask([])).toBe(false)
  })
})

describe('任务面板：标题简洁，详情折叠', () => {
  test('长说明保持单行，展开保留错误、结果及最近三步', () => {
    const panel = backgroundTaskPanel(mk({
      id: 'long', status: 'failed', description: '很长的说明\n'.repeat(30), error: '读取失败', summary: '部分结果',
      steps: [1, 2, 3, 4].map(i => ({ toolUseId: String(i), tool: 'Read', brief: `检查步骤 ${i}` })),
    })) as any
    expect(panel.expanded).toBe(false)
    expect(panel.header.title.content).not.toContain('\n')
    expect(panel.header.title.content.length).toBeLessThan(60)
    const body = panel.elements[0].content
    expect(body).toContain('读取失败')
    expect(body).toContain('部分结果')
    expect(body).not.toContain('检查步骤 1')
    expect(body).toContain('检查步骤 4')
  })
  test('标题只展示状态与短说明，类型放入详情', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t) as any
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.element_id).toBe(BG_ELEMENTS.panel('t1'))
    expect(panel.header.title.content).toBe('⏳ 子 Agent正在执行 · 搜索认证')
    expect(panel.elements[0].content).toContain('Explore')
    expect(panel.elements[0].content).not.toContain('<1m')
  })

  test('运行中详情不展示静止的计时数字', () => {
    const t = mk({ id: 't1', type: 'subagent', description: '搜索认证', status: 'running', startedAt: 0, subagentType: 'Explore' })
    const panel = backgroundTaskPanel(t) as any
    expect(panel.elements[0].content).not.toContain('45s')
    expect(panel.header.title.content).not.toContain('<1m')
  })

  test('完成任务在详情显示实际耗时', () => {
    const t = mk({ id: 't1', type: 'shell', description: 'build', status: 'completed', startedAt: 0, usage: { total_tokens: 10, tool_uses: 1, duration_ms: 10_800_000 } })
    const panel = backgroundTaskPanel(t) as any
    expect(panel.elements[0].content).toContain('用时 3h')
  })

  test('失败状态在标题可见，详情保留耗时', () => {
    const t = mk({ id: 't1', status: 'failed', startedAt: 0, usage: { total_tokens: 1, tool_uses: 1, duration_ms: 12000 } })
    const panel = backgroundTaskPanel(t) as any
    expect(panel.header.title.content).toContain('失败')
    expect(panel.elements[0].content).toContain('12s')
  })

  test('运行中摘要可见，不堆砌用量元数据', () => {
    const t = mk({ id: 't1', type: 'subagent', description: 'd', status: 'running', subagentType: 'Explore', usage: { total_tokens: 1200, tool_uses: 8, duration_ms: 1000 }, summary: '命中 3 处' })
    const panel = backgroundTaskPanel(t) as any
    const body = panel.elements[0]
    expect(body.element_id).toBe(BG_ELEMENTS.body('t1'))
    expect(body.content).not.toContain('1.2K tok')
    expect(body.content).toContain('命中 3 处')
    expect(body.content).toContain('进度')
  })

  test('详情包含任务说明和最近动作', () => {
    let s: BgStore = { active: [mk({ id: 't1', type: 'subagent', toolUseId: 'p', description: '搜索', status: 'running', subagentType: 'Explore', prompt: '找 auth 代码' })], pending: [] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中 3 处', false)
    const panel = backgroundTaskPanel(s.active[0]) as any
    const body = panel.elements[0]
    expect(body.content).toContain('Grep')
    expect(body.content).toContain('命中 3 处')
    expect(body.content).not.toContain('执行过程')
    expect(body.content).toContain('找 auth 代码')
  })

  test('标题明确区分后台进程和子 Agent', () => {
    const processPanel = backgroundTaskPanel(mk({ id: 'shell', type: 'shell', description: '构建', status: 'failed' })) as any
    const childPanel = backgroundTaskPanel(mk({ id: 'child', type: 'subagent', description: '检查', status: 'failed' })) as any
    expect(processPanel.header.title.content).toContain('❌ 后台进程失败')
    expect(childPanel.header.title.content).toContain('❌ 子 Agent失败')
    expect(processPanel.elements[0].content).toContain('后台进程')
    expect(childPanel.elements[0].content).toContain('子 Agent')
  })

  test('终态结果完整展示，任务说明只显示精简摘要', () => {
    const panel = backgroundTaskPanel(mk({
      id: 'long-content', type: 'subagent', description: '检查', status: 'completed',
      prompt: `先检查 ${'任务细节 '.repeat(200)}任务末尾标记`,
      summary: `${'完整结果 '.repeat(1000)}结果末尾标记`,
    })) as any
    const body = panel.elements[0].content
    expect(body).toContain('任务内容已精简')
    expect(body).not.toContain('任务末尾标记')
    expect(body).toContain('结果末尾标记')

    const oversized = backgroundTaskPanel(mk({
      id: 'oversized-result', type: 'subagent', description: '检查', status: 'completed',
      summary: `${'完整结果 '.repeat(2000)}结果截断标记`,
    })) as any
    const oversizedBody = oversized.elements[0].content
    expect(oversizedBody).toContain('结果超过卡片安全上限，已截断')
    expect(oversizedBody).not.toContain('结果截断标记')
  })
})

describe('promotePendingOnAdvance — 主线程推进判后台', () => {
  test('pending 里的 shell task 在主线程推进时提升到 active,标 isBackgrounded', () => {
    const s0 = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'codex 出图' })
    expect(s0.active).toHaveLength(0)
    expect(s0.pending).toHaveLength(1)
    const s1 = promotePendingOnAdvance(s0)
    expect(s1.pending).toHaveLength(0)
    expect(s1.active).toHaveLength(1)
    expect(s1.active[0]).toMatchObject({ id: 'b1', isBackgrounded: true, status: 'running' })
  })

  test('空 pending 返回原引用(无推进 no-op)', () => {
    const s = emptyBgStore()
    expect(promotePendingOnAdvance(s)).toBe(s)
  })

  test('多个 pending task 全部提升,active 原有保留', () => {
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'b1', task_type: 'local_bash', description: 'a' })
    s = applyBgTaskStarted(s, { task_id: 'b2', task_type: 'local_agent', subagent_type: 'Explore', description: 'b' })
    const r = promotePendingOnAdvance(s)
    expect(r.active).toHaveLength(2)
    expect(r.pending).toHaveLength(0)
    expect(r.active.map(t => t.id).sort()).toEqual(['b1', 'b2'])
    expect(r.active.find(t => t.id === 'b1')?.isBackgrounded).toBe(true)
    expect(r.active.find(t => t.id === 'b2')?.type).toBe('subagent')
  })

  test('前台 task 先结算被从 pending 丢,推进时不会被提', () => {
    // 前台生命周期:started(pending) → settled(从 pending 丢);主线程推进时 pending 已空
    let s = applyBgTaskStarted(emptyBgStore(), { task_id: 'f1', task_type: 'local_bash', description: 'echo' })
    s = applyBgTaskSettled(s, { task_id: 'f1', status: 'completed' })
    expect(s.pending).toHaveLength(0)
    const r = promotePendingOnAdvance(s)
    expect(r.active).toHaveLength(0)
  })
})

describe('background element ids for UUID task ids', () => {
  test('codex agent thread UUID maps to cardkit-legal short element id (<=20 chars, stable)', () => {
    const uuid = '01a01228-ebc1-7593-95b3-3175513ed9a4'
    const panel = BG_ELEMENTS.panel(uuid)
    const body = BG_ELEMENTS.body(uuid)
    // 飞书规则:字母开头、字母数字下划线、<=20 字符
    expect(panel).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    expect(panel.length).toBeLessThanOrEqual(20)
    expect(body.length).toBeLessThanOrEqual(20)
    // 稳定:同 id 同 hash;不同 id 不同 hash(此样本对)
    expect(BG_ELEMENTS.panel(uuid)).toBe(panel)
    expect(BG_ELEMENTS.panel('01a01228-ebc1-7593-95b3-3175513ed9a5')).not.toBe(panel)
  })
})
