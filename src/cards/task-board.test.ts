import { describe, expect, test } from 'bun:test'

import {
  applyTaskTool,
  asTaskToolName,
  summarizeTaskBoard,
  taskBoardElement,
  taskBoardLiveElement,
  type TaskBoardEntry,
} from './task-board'

describe('asTaskToolName', () => {
  test('识别 4 个 Task 工具,其余返回 null', () => {
    expect(asTaskToolName('TaskCreate')).toBe('TaskCreate')
    expect(asTaskToolName('TaskUpdate')).toBe('TaskUpdate')
    expect(asTaskToolName('TaskList')).toBe('TaskList')
    expect(asTaskToolName('TaskGet')).toBe('TaskGet')
    expect(asTaskToolName('TodoWrite')).toBeNull()
    expect(asTaskToolName('Bash')).toBeNull()
    expect(asTaskToolName('Read')).toBeNull()
  })
})

describe('applyTaskTool — 累积语义', () => {
  test('TaskCreate 从 output 抓 id 逐条追加', () => {
    let board: TaskBoardEntry[] = []
    board = applyTaskTool(board, 'TaskCreate', { subject: '读文件' }, JSON.stringify({ task: { id: 'task_1', subject: '读文件' } }))
    board = applyTaskTool(board, 'TaskCreate', { subject: '改代码' }, JSON.stringify({ task: { id: 'task_2', subject: '改代码' } }))
    expect(board).toEqual([
      { id: 'task_1', subject: '读文件', status: 'pending' },
      { id: 'task_2', subject: '改代码', status: 'pending' },
    ])
  })

  test('TaskCreate 重复 id 不堆叠,而是更新', () => {
    let board: TaskBoardEntry[] = [{ id: 'task_1', subject: '旧', status: 'completed' }]
    board = applyTaskTool(board, 'TaskCreate', { subject: '新' }, JSON.stringify({ task: { id: 'task_1', subject: '新' } }))
    expect(board).toHaveLength(1)
    expect(board[0].subject).toBe('新')
    // 已存在的非 deleted status 不被重置回 pending
    expect(board[0].status).toBe('completed')
  })

  test('TaskUpdate 按 taskId 改 status(防御性读 id/task_id)', () => {
    let board: TaskBoardEntry[] = [{ id: 'task_1', subject: '读文件', status: 'pending' }]
    board = applyTaskTool(board, 'TaskUpdate', { taskId: 'task_1', status: 'in_progress' }, 'Updated')
    expect(board[0].status).toBe('in_progress')
    // task_id 别名也能识别
    board = applyTaskTool(board, 'TaskUpdate', { task_id: 'task_1', status: 'completed' }, 'Updated')
    expect(board[0].status).toBe('completed')
  })

  test('TaskUpdate status=deleted 移除该条', () => {
    let board: TaskBoardEntry[] = [
      { id: 'task_1', subject: 'A', status: 'pending' },
      { id: 'task_2', subject: 'B', status: 'pending' },
    ]
    board = applyTaskTool(board, 'TaskUpdate', { taskId: 'task_1', status: 'deleted' }, 'Deleted')
    expect(board).toEqual([{ id: 'task_2', subject: 'B', status: 'pending' }])
  })

  test('TaskUpdate 未知 id 不造假条目(no-op,等 Create/List 校正)', () => {
    // 曾经的 bug:找不到 id 时用 taskId 当 subject 显示成裸 "1/2/3"。
    // 现在 no-op —— TaskCreate 拿到正确 id 后自然对上,或等 TaskList 校正。
    const board = applyTaskTool([], 'TaskUpdate', { taskId: 'task_9', status: 'in_progress' }, 'Updated')
    expect(board).toEqual([])
  })

  test('TaskCreate 纯文本 output 解析 id(实测 Claude Code 流的是文本非 JSON)', () => {
    // 官方文档说 tool_result 是 JSON {task:{id}},但真实流是
    // "Task #N created successfully: <subject>" 纯文本。必须正则解析 #N。
    let board: TaskBoardEntry[] = []
    board = applyTaskTool(board, 'TaskCreate', { subject: '查询模型' }, 'Task #1 created successfully: 查询模型')
    board = applyTaskTool(board, 'TaskCreate', { subject: '调研口碑' }, 'Task #2 created successfully: 调研口碑')
    expect(board).toEqual([
      { id: '1', subject: '查询模型', status: 'pending' },
      { id: '2', subject: '调研口碑', status: 'pending' },
    ])
  })

  test('TaskCreate 文本 id + TaskUpdate taskId 对得上(不再显示裸 1/2/3)', () => {
    let board: TaskBoardEntry[] = []
    board = applyTaskTool(board, 'TaskCreate', { subject: '查询模型' }, 'Task #1 created successfully: 查询模型')
    // TaskUpdate input taskId="1" 必须命中 TaskCreate 解析出的 id="1"
    board = applyTaskTool(board, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status')
    expect(board).toEqual([{ id: '1', subject: '查询模型', status: 'in_progress' }])
  })

  test('TaskUpdate 无 status 字段(只改 addBlockedBy 等)不动状态', () => {
    let board: TaskBoardEntry[] = [{ id: '1', subject: 'A', status: 'pending' }]
    board = applyTaskTool(board, 'TaskUpdate', { taskId: '1', addBlockedBy: ['2'] }, 'Updated task #1 blockedBy')
    expect(board[0].status).toBe('pending')
  })

  test('TaskList 全量替换(权威快照,校正之前漂移)', () => {
    let board: TaskBoardEntry[] = [{ id: 'old', subject: '过期', status: 'pending' }]
    board = applyTaskTool(board, 'TaskList', {}, JSON.stringify({ tasks: [
      { id: 'task_1', subject: '读文件', status: 'in_progress' },
      { id: 'task_2', subject: '改代码', status: 'pending' },
    ] }))
    expect(board.map(t => t.id)).toEqual(['task_1', 'task_2'])
    expect(board[0].status).toBe('in_progress')
  })

  test('TaskList 合法空数组清空(no-fallbacks:尊重上游明确结果)', () => {
    const board = applyTaskTool(
      [{ id: 'task_1', subject: 'A', status: 'completed' }],
      'TaskList',
      {},
      JSON.stringify({ tasks: [] }),
    )
    expect(board).toEqual([])
  })

  test('TaskList 无 tasks 字段/解析失败 保留旧 board(数据缺失不兜底成空)', () => {
    const prev: TaskBoardEntry[] = [{ id: 'task_1', subject: 'A', status: 'pending' }]
    expect(applyTaskTool(prev, 'TaskList', {}, 'not json')).toEqual(prev)
    expect(applyTaskTool(prev, 'TaskList', {}, null)).toEqual(prev)
    expect(applyTaskTool(prev, 'TaskList', {}, JSON.stringify({ foo: 1 }))).toEqual(prev)
  })

  test('TaskGet 从 output 补全单条(板里已有则合并)', () => {
    let board: TaskBoardEntry[] = [{ id: 'task_1', subject: '读文件', status: 'in_progress' }]
    board = applyTaskTool(board, 'TaskGet', { taskId: 'task_1' }, JSON.stringify({ task: { id: 'task_1', subject: '读文件', description: '详情', activeForm: '正在读文件' } }))
    expect(board[0]).toMatchObject({ id: 'task_1', description: '详情', activeForm: '正在读文件', status: 'in_progress' })
  })

  test('完整 4 步流累积出正确进度', () => {
    let board: TaskBoardEntry[] = []
    board = applyTaskTool(board, 'TaskCreate', { subject: '读文件' }, JSON.stringify({ task: { id: 'task_1', subject: '读文件' } }))
    board = applyTaskTool(board, 'TaskCreate', { subject: '改代码' }, JSON.stringify({ task: { id: 'task_2', subject: '改代码' } }))
    board = applyTaskTool(board, 'TaskUpdate', { taskId: 'task_1', status: 'in_progress' }, 'Updated')
    expect(summarizeTaskBoard(board)).toBe('2 项 · 进行中 1 · 待办 1')
    board = applyTaskTool(board, 'TaskUpdate', { taskId: 'task_1', status: 'completed' }, 'Updated')
    expect(summarizeTaskBoard(board)).toBe('2 项 · 待办 1 · 完成 1')
  })

  test('isError=true 不污染 board', () => {
    const prev: TaskBoardEntry[] = [{ id: 'task_1', subject: 'A', status: 'pending' }]
    // completeTaskTool 在 isError 时不调 applyTaskTool,这里直接验证:
    // 即使调了,TaskList 坏 output 也不会清空(上一测试覆盖)。本测试确认
    // applyTaskTool 本身是无副作用的纯函数(返回新数组,不改入参)。
    const next = applyTaskTool(prev, 'TaskUpdate', { taskId: 'task_1', status: 'completed' }, 'Updated')
    expect(prev[0].status).toBe('pending') // 入参未被改
    expect(next[0].status).toBe('completed')
  })
})

describe('taskBoardLiveElement — 实时总览面板(footer 正前常驻)', () => {
  test('固定 element_id、默认展开、header 含 📋 任务总览 + 统计、body 列出全部项', () => {
    const board: TaskBoardEntry[] = [
      { id: '1', subject: '读文件', status: 'in_progress' },
      { id: '2', subject: '改代码', status: 'pending' },
    ]
    const el = taskBoardLiveElement(board) as any
    expect(el.tag).toBe('collapsible_panel')
    expect(el.element_id).toBe('task_board_live')
    expect(el.expanded).toBe(true)  // 与 timeline 面板(expanded:false)的关键区别
    expect(el.header.title.content).toBe('📋 任务总览 · 2 项 · 进行中 1 · 待办 1')
    const body: string = el.elements[0].content
    expect(body).toContain('- 🔄 读文件')
    expect(body).toContain('- ⬜ 改代码')
  })

  test('空 board 也渲染(header 显示 空,不抛)—— live 区一旦建立就常驻,空态要能显示', () => {
    const el = taskBoardLiveElement([]) as any
    expect(el.expanded).toBe(true)
    expect(el.header.title.content).toBe('📋 任务总览 · 空')
  })

  test('body 与 timeline 面板同源(同 renderTaskBoardBody)—— 按 #N 排序、进行中用 activeForm', () => {
    const board: TaskBoardEntry[] = [
      { id: '1', subject: '完成项', status: 'completed' },
      { id: '2', subject: '重构', activeForm: '正在重构', status: 'in_progress' },
    ]
    const liveEl = taskBoardLiveElement(board) as any
    const timelineEl = taskBoardElement(0, board, { name: 'TaskList', status: '✅' }) as any
    expect(liveEl.elements[0].content).toBe(timelineEl.elements[0].content)
  })
})

describe('summarizeTaskBoard', () => {
  test('空板', () => {
    expect(summarizeTaskBoard([])).toBe('空')
  })
  test('统计顺序固定:进行中→待办→完成', () => {
    const board: TaskBoardEntry[] = [
      { id: '1', subject: 'a', status: 'completed' },
      { id: '2', subject: 'b', status: 'in_progress' },
      { id: '3', subject: 'c', status: 'pending' },
    ]
    expect(summarizeTaskBoard(board)).toBe('3 项 · 进行中 1 · 待办 1 · 完成 1')
  })
  test('deleted 不计入', () => {
    const board: TaskBoardEntry[] = [
      { id: '1', subject: 'a', status: 'pending' },
      { id: '2', subject: 'b', status: 'deleted' },
    ]
    expect(summarizeTaskBoard(board)).toBe('1 项 · 待办 1')
  })
})

describe('taskBoardElement — 渲染整个 board', () => {
  test('header 含操作名 + board 统计,body 列出全部可见项', () => {
    const board: TaskBoardEntry[] = [
      { id: 'task_1', subject: '读文件', status: 'in_progress' },
      { id: 'task_2', subject: '改代码', status: 'pending' },
    ]
    const el = taskBoardElement(0, board, { name: 'TaskUpdate', status: '✅' }) as any
    expect(el.tag).toBe('collapsible_panel')
    expect(el.element_id).toBe('tool_0')
    expect(el.header.title.content).toBe('✅ 🔧 更新任务: 2 项 · 进行中 1 · 待办 1')
    const body: string = el.elements[0].content
    expect(body).toContain('**待办**: 2 项')
    expect(body).toContain('- 🔄 读文件')
    expect(body).toContain('- ⬜ 改代码')
  })

  test('进行中项优先用 activeForm', () => {
    const board: TaskBoardEntry[] = [
      { id: '1', subject: '重构', activeForm: '正在重构', status: 'in_progress' },
    ]
    const el = taskBoardElement(0, board, { name: 'TaskList', status: '✅' }) as any
    expect(el.elements[0].content).toContain('- 🔄 正在重构')
  })

  test('始终按 #N(创建顺序)排列,不按状态重排', () => {
    // 之前按状态排序(进行中→待办→完成),#1 完成就沉底顺序乱;现按 id 数字升序。
    const board: TaskBoardEntry[] = [
      { id: '1', subject: '完成项', status: 'completed' },
      { id: '2', subject: '进行项', status: 'in_progress' },
      { id: '3', subject: '待办项', status: 'pending' },
    ]
    const el = taskBoardElement(0, board, { name: 'TaskList', status: '✅' }) as any
    const lines: string[] = el.elements[0].content.split('\n')
    const items = lines.filter(l => l.startsWith('- '))
    expect(items[0]).toContain('完成项')  // #1
    expect(items[1]).toContain('进行项')  // #2
    expect(items[2]).toContain('待办项')  // #3
  })

  test('resolvedNote 附加在 body 末尾', () => {
    const el = taskBoardElement(0, [], { name: 'TaskList', status: '✅' }, '✅ **已允许** by Alice') as any
    expect(el.elements[0].content).toContain('✅ **已允许** by Alice')
  })

  test('超过 12 项截断提示', () => {
    const board: TaskBoardEntry[] = Array.from({ length: 15 }, (_, k) => ({
      id: `t${k}`, subject: `项${k}`, status: 'pending' as const,
    }))
    const el = taskBoardElement(0, board, { name: 'TaskList', status: '✅' }) as any
    expect(el.elements[0].content).toContain('还有 3 项未显示')
  })
})
