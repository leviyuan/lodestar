import { test, expect } from 'bun:test'
import {
  writeBodyFromToolInput,
  turnListCard,
  resumeListCard,
  resumeSelectionResultCard,
  selectionResultCard,
  writeLogCard,
  writeLogEntriesFromToolInput,
} from './temp'

test('writeBodyFromToolInput:Write 取 content', () => {
  expect(writeBodyFromToolInput({ file_path: '/a', content: 'hello' })).toBe('hello')
})

test('writeBodyFromToolInput:Edit 取 new_string', () => {
  expect(writeBodyFromToolInput({ file_path: '/a', old_string: 'x', new_string: 'y' })).toBe('y')
})

test('writeBodyFromToolInput:MultiEdit 拼接所有 new_string', () => {
  expect(writeBodyFromToolInput({ edits: [{ new_string: 'a' }, { new_string: 'b' }] })).toBe('a\n---\nb')
})

test('writeBodyFromToolInput:无可识别字段返回空串', () => {
  expect(writeBodyFromToolInput({ file_path: '/a' })).toBe('')
  expect(writeBodyFromToolInput(null as any)).toBe('')
})

test('writeLogEntriesFromToolInput:保留 Claude Write/Edit 记录', () => {
  expect(writeLogEntriesFromToolInput('Write', { file_path: '/a', content: 'hello' })).toEqual([
    { tool: 'Write', path: '/a', body: 'hello' },
  ])
  expect(writeLogEntriesFromToolInput('Edit', { file_path: '/b', new_string: 'new' })).toEqual([
    { tool: 'Edit', path: '/b', body: 'new' },
  ])
})

test('writeLogEntriesFromToolInput:展开 Codex FileChange 多文件 path/diff', () => {
  expect(writeLogEntriesFromToolInput('FileChange', {
    changes: [
      { path: '/a', diff: '@@ -1 +1 @@\n-old\n+new' },
      { path: '/b', unified_diff: '@@ -0,0 +1 @@\n+created' },
    ],
  })).toEqual([
    { tool: 'FileChange', path: '/a', body: '@@ -1 +1 @@\n-old\n+new' },
    { tool: 'FileChange', path: '/b', body: '@@ -0,0 +1 @@\n+created' },
  ])
  expect(writeLogEntriesFromToolInput('Bash', { command: 'touch /tmp/a' })).toEqual([])
})

test('turnListCard:fork 模式生成合法卡片结构 + 按钮 kind', () => {
  const card = turnListCard({
    projectName: 'feishu',
    panelId: 'panel-fork-1',
    mode: 'fork',
    entries: [{ choiceId: 'choice-origin', preview: '帮我重构', ts: 1700000000000 }],
  }) as any
  expect(card.schema).toBe('2.0')
  expect(card.header.template).toBe('turquoise')
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.text.content).toBe('分叉')
  expect(btn.behaviors[0].value).toEqual({
    kind: 'temp_fork_select',
    panel_id: 'panel-fork-1',
    choice_id: 'choice-origin',
  })
  expect(JSON.stringify(card)).toContain('选中的输入本身不包含')
  expect(JSON.stringify(card)).toContain('共享 cwd 和磁盘文件')
  expect(JSON.stringify(card)).toContain('不复制或回滚文件')
  expect(JSON.stringify(card)).not.toContain('anchorIdx')
  expect(JSON.stringify(card)).not.toContain('sessionId')
})

test('turnListCard:back 模式按钮用 danger + temp_back_select', () => {
  const card = turnListCard({
    projectName: 'p',
    panelId: 'panel-back-1',
    mode: 'back',
    entries: [{ choiceId: 'choice-2', preview: 'x', ts: 1 }],
  }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.type).toBe('danger')
  expect(btn.behaviors[0].value).toEqual({
    kind: 'temp_back_select',
    panel_id: 'panel-back-1',
    choice_id: 'choice-2',
  })
  expect(card.header.template).toBe('orange')
  expect(JSON.stringify(card)).toContain('停止本群当前 turn 和后台任务')
  expect(JSON.stringify(card)).toContain('不会回滚 cwd 中的文件')
})

test('turnListCard:无 entries 显示提示,不崩', () => {
  const card = turnListCard({ projectName: 'p', panelId: 'panel-empty', mode: 'fork', entries: [] }) as any
  expect(card.body.elements.some((e: any) => e.tag === 'markdown')).toBe(true)
})

test('resumeListCard:按钮只带 panel/choice,并说明创建独立分支', () => {
  const card = resumeListCard({
    projectName: 'p',
    panelId: 'panel-resume-1',
    entries: [{
      choiceId: 'choice-session-1', preview: '修bug', lastPreview: '已经修好并跑通测试', ts: 1, label: '…c92e06',
    }],
  }) as any
  const btn = card.body.elements.find((e: any) => e.tag === 'column_set')!.columns[1].elements[0]
  expect(btn.behaviors[0].value).toEqual({
    kind: 'temp_resume_select',
    panel_id: 'panel-resume-1',
    choice_id: 'choice-session-1',
  })
  expect(btn.text.content).toBe('分支')
  // 相同主题的会话靠短标签区分；首句和末句都展示，标签不进回调。
  const row = card.body.elements[1].columns[0].elements[0].content
  expect(row).toContain('…c92e06')
  expect(row).toContain('🚩 `修bug`')
  expect(row).toContain('🏁 `已经修好并跑通测试`')
  expect(JSON.stringify(card)).toContain('创建独立对话分支')
  expect(JSON.stringify(card)).toContain('共享当前 cwd 和磁盘文件')
  expect(JSON.stringify(card)).not.toContain('sessionId')
})

test('selectionResultCard:终态卡不再包含 callback 按钮', () => {
  const card = selectionResultCard({ title: '⏪ 会话回滚', message: '已回滚', ok: true }) as any
  expect(card.config.update_multi).toBe(true)
  expect(card.header.template).toBe('green')
  expect(JSON.stringify(card)).toContain('已回滚')
  expect(JSON.stringify(card)).not.toContain('callback')
})

test('resumeSelectionResultCard:Codex 成功态原位展示所选历史和新分支', () => {
  const card = resumeSelectionResultCard({
    projectName: 'project',
    provider: 'codex',
    selectedPreview: '修复 Codex rs 历史选择',
    selectedLastPreview: '回归测试全部通过',
    selectedTs: new Date(2026, 7, 22, 14, 10).getTime(),
    sourceSessionId: '01a02552-0cd4-7a21-af8f-086262e9c892',
    sourceStatus: 'idle',
    previousSessionId: '01a026ed-92b4-7c10-8652-26c55154381e',
    newSessionId: '01a026ef-93c9-78d0-a74b-3c0fa8c92e06',
    bindingState: 'changed',
    message: '已创建并接入独立分支；源会话未修改',
    ok: true,
  }) as any
  const text = JSON.stringify(card)

  expect(card.header.template).toBe('green')
  expect(card.header.title.content).toContain('rs 已接入 · project')
  expect(text).toContain('所选历史 · Codex')
  expect(text).toContain('修复 Codex rs 历史选择')
  expect(text).toContain('…e9c892')
  expect(text).toContain('…c92e06')
  expect(text).toContain('🚩 `修复 Codex rs 历史选择`')
  expect(text).toContain('🏁 `回归测试全部通过`')
  expect(text).toContain('源会话 `…e9c892`')
  expect(text).toContain('新会话 `…c92e06`')
  expect(text).toContain('状态 `idle`')
  expect(text).toContain('共享 cwd 和磁盘文件')
  expect(text).not.toContain('callback')
  expect(text).not.toContain('panel_id')
  expect(text).not.toContain('/home/')
})

test('resumeSelectionResultCard:Claude 失败态保留所选快照、原因和原绑定', () => {
  const card = resumeSelectionResultCard({
    projectName: 'project',
    provider: 'claude',
    selectedPreview: '<旧会话> `需要修复`',
    selectedTs: new Date(2026, 7, 22, 14, 11).getTime(),
    sourceSessionId: '424f8d9e-a2fc-4e27-a042-0c043a1e370e',
    previousSessionId: 'cbab31ed-accf-4ae5-90b2-ec8e3bca7f84',
    newSessionId: null,
    bindingState: 'unchanged',
    message: '历史分支创建失败；[伪链接](https://example.com) 原会话绑定未改',
    ok: false,
  }) as any
  const text = JSON.stringify(card)
  const outcome = card.body.elements[2].content

  expect(card.header.template).toBe('red')
  expect(card.header.title.content).toContain('rs 未切换 · project')
  expect(text).toContain('所选历史 · Claude')
  expect(text).toContain('&lt;旧会话&gt;')
  expect(text).toContain('…1e370e')
  expect(text).toContain('本群原绑定 `…ca7f84`')
  expect(text).toContain('…ca7f84')
  expect(outcome).toContain('历史分支创建失败；\\[伪链接\\]\\(https://example\\.com\\) 原会话绑定未改')
  expect(text).not.toContain('[伪链接](https://example.com)')
  expect(text).not.toContain('callback')
})

test('resumeSelectionResultCard:Claude 已准备态不伪造尚未 materialize 的新 id', () => {
  const card = resumeSelectionResultCard({
    projectName: 'project',
    provider: 'claude',
    selectedPreview: '继续 Claude 历史',
    selectedTs: new Date(2026, 7, 22, 14, 12).getTime(),
    sourceSessionId: '424f8d9e-a2fc-4e27-a042-0c043a1e370e',
    previousSessionId: 'cbab31ed-accf-4ae5-90b2-ec8e3bca7f84',
    newSessionId: null,
    bindingState: 'prepared',
    message: 'Claude 独立分支已准备；首条消息时生成并接入新会话',
    ok: true,
  }) as any
  const text = JSON.stringify(card)

  expect(card.header.template).toBe('purple')
  expect(card.header.title.content).toContain('rs 已准备 · project')
  expect(text).toContain('发送下一条消息时生成并接入新会话')
  expect(text).not.toContain('新会话 `MISS`')
  expect(text).not.toContain('状态待确认')
  expect(text).not.toContain('callback')
})

test('resumeSelectionResultCard:长摘要截断且缺失 id 显式显示 MISS', () => {
  const longPreview = '甲'.repeat(90) + '不应出现'
  const card = resumeSelectionResultCard({
    projectName: 'project',
    provider: 'codex',
    selectedPreview: longPreview,
    selectedTs: 0,
    sourceSessionId: '',
    previousSessionId: null,
    newSessionId: null,
    bindingState: 'unknown',
    message: '后端没有返回新会话 id',
    ok: false,
  }) as any
  const text = JSON.stringify(card)

  expect(text).toContain('甲'.repeat(80))
  expect(text).not.toContain('不应出现')
  expect(card.header.title.content).toContain('rs 状态待确认')
  expect(card.header.template).toBe('orange')
  expect(text.match(/MISS/g)?.length).toBe(2)
  expect(text).not.toContain('未知')
})

test('writeLogCard:entries 拼成代码块,空则占位', () => {
  const full = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: 'x' }] }) as any
  const codeEl = full.body.elements.find((e: any) => e.tag === 'markdown' && String(e.content).includes('```'))
  expect(codeEl.content).toContain('/a  (Write)')
  expect(codeEl.content).toContain('x')
  expect(full.header.title.content).toContain('观察到的文件变更')
  expect(JSON.stringify(full)).toContain('只回退对话历史，不会回滚磁盘文件')
  expect(JSON.stringify(full)).toContain('Shell/MCP 等工具造成的副作用可能未被记录')

  const empty = writeLogCard({ projectName: 'p', entries: [] }) as any
  const emptyCode = empty.body.elements.find((e: any) => String(e.content ?? '').includes('```'))!
  expect(emptyCode.content).toContain('未观察到 Write/Edit/FileChange 类文件变更')
})

test('writeLogCard:超长 body 截断', () => {
  const long = 'x'.repeat(2000)
  const card = writeLogCard({ projectName: 'p', entries: [{ tool: 'Write', path: '/a', body: long }] }) as any
  const codeEl = card.body.elements.find((e: any) => String(e.content).includes('```'))!
  expect(codeEl.content).toContain('…(截断)')
})
