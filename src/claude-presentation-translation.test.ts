import { describe, expect, test } from 'bun:test'
import { ClaudePresentationTranslation, claudeToolInputContext, claudeToolInputOrigin, claudeToolResultContext } from './claude-presentation-translation'
import { CLAUDE_TRANSLATION_ORIGINS } from './claude-translation-context'
import { applyTaskTool } from './cards/task-board'

const signal = () => new AbortController().signal

function harness() {
  const batches: string[][] = []
  const origins: Array<string | readonly string[] | undefined> = []
  const presentation = new ClaudePresentationTranslation({
    async toChineseFields(fields, inputSignal, origin) {
      inputSignal.throwIfAborted()
      batches.push([...fields])
      origins.push(origin)
      return fields.map(value => `中文:${value}`)
    },
  })
  return { presentation, batches, origins }
}

describe('Claude display translation', () => {
  test('passes the selected text origin independently from tool schemas and payloads', async () => {
    const { presentation, batches, origins } = harness()
    await presentation.naturalFields({ message: 'A reply', id: 'private-message-id' }, ['message'], signal())
    await presentation.toolInput('Bash', { command: '# desc: Inspect project\ngit status' }, signal())
    await presentation.toolInput('TaskCreate', { subject: 'Review the change', task_id: 'private-task-id' }, signal())
    await presentation.toolInput('TodoWrite', { todos: [{ content: 'Run checks', status: 'pending' }] }, signal())
    await presentation.toolInput('Agent', { prompt: 'Review this change', name: 'private-agent-name' }, signal())
    await presentation.toolInput('AskUserQuestion', { question: 'Which test?' }, signal())
    await presentation.toolInput('UnknownTool', { description: 'Inspect the result' }, signal())
    expect(origins).toEqual([
      CLAUDE_TRANSLATION_ORIGINS.reply,
      CLAUDE_TRANSLATION_ORIGINS.commandExplanation,
      CLAUDE_TRANSLATION_ORIGINS.taskText,
      CLAUDE_TRANSLATION_ORIGINS.taskText,
      CLAUDE_TRANSLATION_ORIGINS.delegatedRequest,
      CLAUDE_TRANSLATION_ORIGINS.question,
      'Claude Code → Feishu user: explanation accompanying a tool call.',
    ])
    expect(batches).toEqual([
      ['A reply'], ['Inspect project'], ['Review the change'], ['Run checks'],
      ['Review this change'], ['Which test?'], ['Inspect the result'],
    ])
    expect(claudeToolInputOrigin('server_tool:exec_command')).toBe(CLAUDE_TRANSLATION_ORIGINS.commandExplanation)
    expect(claudeToolInputOrigin('Task')).toBe(CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
  })

  test('carries explicit origins through worker, background, structured and plain result paths', async () => {
    const { presentation, batches, origins } = harness()
    await presentation.naturalFields({ summary: 'Work is running' }, ['summary'], signal(), CLAUDE_TRANSLATION_ORIGINS.backgroundUpdate)
    await presentation.toolInput('Bash', { command: 'git status', description: 'Inspect repository' }, signal(), 'worker', CLAUDE_TRANSLATION_ORIGINS.delegatedOutput)
    await presentation.toolResult('Agent', 'Completed the review', false, signal())
    await presentation.toolResult('Agent', JSON.stringify({ result: 'No issues found', status: 'done' }), false, signal(), false, 'background', CLAUDE_TRANSLATION_ORIGINS.subagentOutput)
    await presentation.toolResult('Bash', JSON.stringify({ message: 'Execution failed', code: 'ERR', stderr: 'PRIVATE STDERR' }), true, signal(), false, 'background', CLAUDE_TRANSLATION_ORIGINS.subagentOutput)
    await presentation.toolResult('Read', 'The file is unavailable', true, signal(), false, 'main', CLAUDE_TRANSLATION_ORIGINS.error)
    expect(origins).toEqual([
      CLAUDE_TRANSLATION_ORIGINS.backgroundUpdate,
      CLAUDE_TRANSLATION_ORIGINS.delegatedOutput,
      CLAUDE_TRANSLATION_ORIGINS.toolResult,
      CLAUDE_TRANSLATION_ORIGINS.subagentOutput,
      CLAUDE_TRANSLATION_ORIGINS.subagentOutput,
      CLAUDE_TRANSLATION_ORIGINS.error,
    ])
    expect(batches).toEqual([
      ['Work is running'], ['Inspect repository'], ['Completed the review'],
      ['No issues found'], ['Execution failed'], ['The file is unavailable'],
    ])
  })

  test('translates command explanations in a display copy without changing executable bytes', async () => {
    const { presentation, batches } = harness()
    const input = {
      command: '# desc: Check the active service\nsystemctl --user status exact.service',
      description: 'Inspect service status', cwd: '/tmp/English Project',
      env: { description: 'DO_NOT_TRANSLATE', TITLE: 'Run the command' },
    }
    const original = structuredClone(input)
    const display = await presentation.toolInput('Bash', input, signal()) as typeof input & { __displayDescription: string }
    expect(input).toEqual(original)
    expect(display.command).toBe(input.command)
    expect(display.cwd).toBe(input.cwd)
    expect(display.env).toEqual(input.env)
    expect(display.env).not.toBe(input.env)
    expect(display.description).toBe('Inspect service status')
    expect(display.__displayDescription).toBe('中文:Check the active service')
    expect(batches).toEqual([['Check the active service']])
    expect(claudeToolInputContext('Bash', input)).toEqual(['Check the active service'])
    expect(claudeToolInputContext('Bash', display)).toEqual(['中文:Check the active service'])
    batches.length = 0
    const child = await presentation.toolInput('Bash', input, signal(), 'background')
    expect(child).toEqual(display)
    expect(batches).toEqual([['Check the active service']])
  })

  test('handles wrapped Mac/Linux shells and an explicit explanation without a comment', async () => {
    const { presentation } = harness()
    const wrapped = { cmd: "/bin/bash -lc '# desc: Read package version\ncat package.json'" }
    const display = await presentation.toolInput('functions.exec_command', wrapped, signal()) as typeof wrapped & { __displayDescription: string }
    expect(display.cmd).toBe(wrapped.cmd)
    expect(display.__displayDescription).toBe('中文:Read package version')
    const explicitInput = { command: 'git status', reason: 'Inspect the worktree' }
    const explicit = await presentation.toolInput('Bash', explicitInput, signal()) as typeof explicitInput & { __displayDescription: string }
    expect(explicit.__displayDescription).toBe('中文:Inspect the worktree')
    expect(explicit.command).toBe('git status')
  })

  test('does not invent or translate a shell explanation from an executable command', async () => {
    const { presentation, batches } = harness()
    const input = { command: 'git status --short' }
    expect(await presentation.toolInput('Bash', input, signal())).toEqual(input)
    expect(batches).toEqual([])
  })

  test('extracts a server-tool wrapper command prefix without adding hidden nested metadata', async () => {
    const { presentation } = harness()
    const input = { tool: 'exec_command', input: { cmd: '# desc: Inspect project\ngit status', workdir: '/tmp/Project' } }
    const display = await presentation.toolInput('server_tool:exec_command', input, signal()) as typeof input & {
      __displayDescription: string; input: typeof input.input & { __displayDescription: string }
    }
    expect(display.__displayDescription).toBe('中文:Inspect project')
    expect(display.input.__displayDescription).toBeUndefined()
    expect(display.input.cmd).toBe(input.input.cmd)
    expect(display.input.workdir).toBe(input.input.workdir)
    expect(input).toEqual({ tool: 'exec_command', input: { cmd: '# desc: Inspect project\ngit status', workdir: '/tmp/Project' } })
    expect(claudeToolInputContext('server_tool:exec_command', input)).toEqual(['Inspect project'])
  })

  test('server shell JSON retains its separately visible description while worker progress selects its own purpose', async () => {
    const { presentation, batches } = harness()
    const shell = { cmd: '# desc: Comment purpose\nprintf marker', description: 'Structured purpose' }
    const wrapper = { tool: 'exec_command', input: shell }
    const server = await presentation.toolInput('server_tool:exec_command', wrapper, signal()) as typeof wrapper & { __displayDescription: string }
    expect(server.input.description).toBe('中文:Structured purpose')
    expect(server.__displayDescription).toBe('中文:Comment purpose')
    expect(server.input.cmd).toBe(shell.cmd)
    expect(batches).toEqual([['Structured purpose', 'Comment purpose']])
    expect(claudeToolInputContext('server_tool:exec_command', wrapper)).toEqual(['Structured purpose', 'Comment purpose'])
    expect(claudeToolInputContext('server_tool:exec_command', server)).toEqual(['中文:Structured purpose', '中文:Comment purpose'])
    batches.length = 0
    const worker = await presentation.toolInput('exec_command', shell, signal(), 'worker')
    expect(worker).toEqual({ ...shell, description: '中文:Structured purpose' })
    expect(batches).toEqual([['Structured purpose']])
    expect(claudeToolInputContext('exec_command', shell, 'worker')).toEqual(['Structured purpose'])
    expect(claudeToolInputContext('exec_command', worker, 'worker')).toEqual(['中文:Structured purpose'])
  })

  test('translates todo prose and preserves identity, status and metadata', async () => {
    const { presentation } = harness()
    const input = { todos: [{ content: 'Review current behavior', activeForm: 'Reviewing current behavior', status: 'in_progress', id: 'task-1' }], metadata: { description: 'literal metadata' } }
    const display = await presentation.toolInput('TodoWrite', input, signal())
    expect(display.todos[0]).toEqual({ content: '中文:Review current behavior', activeForm: '中文:Reviewing current behavior', status: 'in_progress', id: 'task-1' })
    expect(display.metadata).toEqual(input.metadata)
    expect(input.todos[0]!.content).toBe('Review current behavior')
  })

  test('translates agent instructions and user-facing nested fields only', async () => {
    const { presentation, batches } = harness()
    const input = {
      name: 'test-runner', description: 'Run the tests', prompt: 'Verify the modified module.',
      options: { explanation: 'A focused check', path: '/tmp/Run tests' },
      schema: { description: 'Schema description', properties: { name: { title: 'Literal' } } },
      metadata: { title: 'Preserve metadata' },
    }
    const display = await presentation.toolInput('Agent', input, signal())
    expect(display.name).toBe('test-runner')
    expect(display.description).toBe('中文:Run the tests')
    expect(display.prompt).toBe('中文:Verify the modified module.')
    expect(display.options.explanation).toBe('中文:A focused check')
    expect(display.schema).toEqual(input.schema)
    expect(display.metadata).toEqual(input.metadata)
    expect(batches).toEqual([['Run the tests', 'Verify the modified module.', 'A focused check']])
  })

  test('translates native agent messages while preserving recipient and routing identities', async () => {
    const { presentation, batches } = harness()
    const input = { type: 'message', recipient: 'review-agent', content: 'Please check the latest change.', summary: 'Review request', id: 'message-1' }
    const display = await presentation.toolInput('SendMessage', input, signal())
    expect(display).toEqual({ ...input, content: '中文:Please check the latest change.', summary: '中文:Review request' })
    expect(input.content).toBe('Please check the latest change.')
    expect(batches).toEqual([['Please check the latest change.', 'Review request']])
    expect(claudeToolInputContext('SendMessage', input)).toEqual(['Please check the latest change.', 'Review request'])
    expect(claudeToolInputContext('Write', { content: 'File bytes must remain excluded' })).toEqual([])
  })

  test('preserves file payloads and search patterns even when they contain prose', async () => {
    const { presentation, batches } = harness()
    const input = {
      file_path: '/tmp/Article.md', content: 'Natural language file content',
      old_string: 'Find this sentence', new_string: 'Replace this sentence',
      new_source: 'const description = "Keep this"',
      edits: [{ old_string: 'Old', new_string: 'New' }],
      pattern: 'Find this sentence', query: 'Exact pattern',
      changes: [{ path: 'a.txt', diff: '+English prose' }],
    }
    for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'FileChange']) {
      expect(await presentation.toolInput(name, input, signal())).toEqual(input)
    }
    expect(batches).toEqual([])
  })

  test('translates web query and plan text while preserving URLs and commands', async () => {
    const { presentation } = harness()
    expect(await presentation.toolInput('WebSearch', { query: 'TypeScript module resolution', url: 'https://example.org/article' }, signal()))
      .toEqual({ query: '中文:TypeScript module resolution', url: 'https://example.org/article' })
    expect(await presentation.toolInput('ExitPlanMode', { plan: 'Check the system before changing it.', allowedPrompts: [{ tool: 'Bash', prompt: 'Run unit tests' }] }, signal()))
      .toEqual({ plan: '中文:Check the system before changing it.', allowedPrompts: [{ tool: 'Bash', prompt: '中文:Run unit tests' }] })
  })

  test('task JSON results retain keys, IDs, status, relationships and ordering', async () => {
    const { presentation } = harness()
    const raw = JSON.stringify({ tasks: [{ id: '5', subject: 'Inspect API', description: 'Inspect supported arguments', activeForm: 'Inspecting API', status: 'pending', blockedBy: ['1'], owner: 'api-owner' }] })
    const display = JSON.parse(await presentation.toolResult('TaskList', raw, false, signal()))
    expect(display).toEqual({ tasks: [{ id: '5', subject: '中文:Inspect API', description: 'Inspect supported arguments', activeForm: '中文:Inspecting API', status: 'pending', blockedBy: ['1'], owner: 'api-owner' }] })
    expect(JSON.parse(raw).tasks[0].subject).toBe('Inspect API')
  })

  test('translates agent prose without changing the raw result', async () => {
    const { presentation } = harness()
    const result = { result: 'The work is complete.', content: 'All checks passed.', status: 'completed', agent_id: 'agent-17' }
    expect(JSON.parse(await presentation.toolResult('Agent', JSON.stringify(result), false, signal())))
      .toEqual({ result: '中文:The work is complete.', content: '中文:All checks passed.', status: 'completed', agent_id: 'agent-17' })
  })

  test('native task success receipts stay exact for board parsing and never invoke translation', async () => {
    const { presentation, batches } = harness()
    const created = 'Task #1 created successfully: Inspect API'
    const updated = 'Updated task #1 status'
    for (const [name, content] of [['TaskCreate', created], ['TaskUpdate', updated]]) {
      const structured = JSON.stringify({ task: { id: '1', subject: 'Inspect API', status: 'completed' }, message: content })
      for (const receipt of [content!, structured]) {
        expect(await presentation.toolResult(name!, receipt, false, signal())).toBe(receipt)
        expect(claudeToolResultContext(name!, receipt, false)).toEqual([])
      }
    }
    expect(batches).toEqual([])
    const input = { subject: 'Inspect API', description: 'Inspect supported arguments' }
    const displayInput = await presentation.toolInput('TaskCreate', input, signal())
    const board = applyTaskTool([], 'TaskCreate', input, created, displayInput)
    expect(board).toEqual([{ id: '1', subject: '中文:Inspect API', description: 'Inspect supported arguments', status: 'pending' }])
    const update = { taskId: '1', status: 'completed', subject: 'API inspected' }
    const displayUpdate = await presentation.toolInput('TaskUpdate', update, signal())
    expect(applyTaskTool(board, 'TaskUpdate', displayUpdate, updated)).toEqual([
      { ...board[0], subject: '中文:API inspected', status: 'completed' },
    ])
    expect(input).toEqual({ subject: 'Inspect API', description: 'Inspect supported arguments' })
    expect(update).toEqual({ taskId: '1', status: 'completed', subject: 'API inspected' })
  })

  test('main task errors remain native and outside Flash and history while other tool results retain their boundaries', async () => {
    const { presentation } = harness()
    const content = 'Updated task #1 status'
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(await presentation.toolResult(name, content, true, signal())).toBe(content)
      expect(claudeToolResultContext(name, content, true)).toEqual([])
      const structured = JSON.stringify({ id: '1', message: 'Task status changed', status: 'completed' })
      expect(await presentation.toolResult(name, structured, true, signal())).toBe(structured)
      expect(claudeToolResultContext(name, structured, true)).toEqual([])
    }
    for (const name of ['server_tool:TaskCreate', 'server_tool:TaskUpdate', 'mcp__service__TaskUpdate', 'OtherTool']) {
      expect(await presentation.toolResult(name, content, false, signal())).toBe(`中文:${content}`)
      expect(claudeToolResultContext(name, content, false)).toEqual([content])
    }
  })

  test('excludes main AskUserQuestion success echoes while translating visible child receipts and failures', async () => {
    const { presentation, batches } = harness()
    const receipt = 'The user answered: "Choose?"="Charge". Read the answers carefully and follow what they actually say.'
    const structured = JSON.stringify({ message: receipt, reason: 'Internal answer echo',
      content: [{ type: 'text', text: receipt }], answers: { 'Choose?': 'Charge' } })
    for (const content of [receipt, structured]) {
      expect(await presentation.toolResult('AskUserQuestion', content, false, signal())).toBe(content)
      expect(claudeToolResultContext('AskUserQuestion', content, false)).toEqual([])
    }
    expect(batches).toEqual([])
    for (const [isError, receiptVisible] of [[true, false], [false, true], [true, true]] as const) {
      expect(await presentation.toolResult('AskUserQuestion', receipt, isError, signal(), receiptVisible)).toBe(`中文:${receipt}`)
      expect(claudeToolResultContext('AskUserQuestion', receipt, isError, receiptVisible)).toEqual([receipt])
      const display = JSON.parse(await presentation.toolResult('AskUserQuestion', structured, isError, signal(), receiptVisible))
      expect(display.message).toBe(`中文:${receipt}`)
      expect(display.answers).toEqual({ 'Choose?': 'Charge' })
      expect(claudeToolResultContext('AskUserQuestion', structured, isError, receiptVisible)).toContain(receipt)
    }
    expect(await presentation.toolResult('OtherTool', receipt, false, signal())).toBe(`中文:${receipt}`)
    expect(claudeToolResultContext('OtherTool', receipt, false)).toEqual([receipt])
    expect(await presentation.toolResult('server_tool:AskUserQuestion', receipt, false, signal())).toBe(`中文:${receipt}`)
    expect(claudeToolResultContext('server_tool:AskUserQuestion', receipt, false)).toEqual([receipt])
    expect(JSON.parse(await presentation.toolResult('OtherTool', structured, true, signal())).message).toBe(`中文:${receipt}`)
    expect(claudeToolResultContext('OtherTool', structured, true)).toContain(receipt)
  })

  test('visible native task receipts translate prose and record the same fields without changing machine values', async () => {
    const { presentation } = harness()
    for (const name of ['TaskCreate', 'TaskUpdate']) {
      const receipt = 'Task #7 status changed'
      expect(await presentation.toolResult(name, receipt, false, signal(), true)).toBe(`中文:${receipt}`)
      expect(claudeToolResultContext(name, receipt, false, true)).toEqual([receipt])
      const native = { id: '7', message: receipt, subject: 'Inspect API', status: 'completed' }
      const content = JSON.stringify(native)
      const display = await presentation.toolResult(name, content, false, signal(), true)
      expect(JSON.parse(display)).toEqual({ ...native, message: `中文:${receipt}`, subject: '中文:Inspect API' })
      expect(claudeToolResultContext(name, content, false, true)).toEqual([receipt, 'Inspect API'])
      expect(claudeToolResultContext(name, display, false, true)).toEqual([`中文:${receipt}`, '中文:Inspect API'])
      expect(native).toEqual({ id: '7', message: receipt, subject: 'Inspect API', status: 'completed' })
    }
  })

  test('main task-board inputs translate only visible labels while child steps retain descriptions', async () => {
    const { presentation, batches } = harness()
    const input = { taskId: '7', subject: 'Inspect API', description: 'Hidden implementation details', activeForm: 'Inspecting API', status: 'in_progress' }
    for (const name of ['TaskCreate', 'TaskUpdate']) {
      batches.length = 0
      const main = await presentation.toolInput(name, input, signal(), 'main')
      expect(main).toEqual({ ...input, subject: '中文:Inspect API', activeForm: '中文:Inspecting API' })
      expect(batches).toEqual([['Inspect API', 'Inspecting API']])
      expect(claudeToolInputContext(name, input, 'main')).toEqual(['Inspect API', 'Inspecting API'])
      expect(claudeToolInputContext(name, main, 'main')).toEqual(['中文:Inspect API', '中文:Inspecting API'])

      batches.length = 0
      const child = await presentation.toolInput(name, input, signal(), 'background')
      expect(child.description).toBe('中文:Hidden implementation details')
      expect(batches).toEqual([['Inspect API', 'Hidden implementation details', 'Inspecting API']])
      expect(claudeToolInputContext(name, input, 'background')).toEqual(['Inspect API', 'Hidden implementation details', 'Inspecting API'])
      expect(claudeToolInputContext(name, child, 'background')).toContain('中文:Hidden implementation details')
    }
    batches.length = 0
    const descriptionOnly = { taskId: '7', description: 'Invisible update' }
    expect(await presentation.toolInput('TaskUpdate', descriptionOnly, signal())).toEqual(descriptionOnly)
    expect(claudeToolInputContext('TaskUpdate', descriptionOnly)).toEqual([])
    expect(batches).toEqual([])
    expect(input.description).toBe('Hidden implementation details')
  })

  test('main task snapshots exclude hidden descriptions from Flash and context without affecting other surfaces', async () => {
    const { presentation, batches } = harness()
    const task = { id: '7', subject: 'Inspect API', description: 'Internal task details', activeForm: 'Inspecting API', status: 'in_progress' }
    for (const name of ['TaskList', 'TaskGet']) {
      const raw = JSON.stringify(name === 'TaskList' ? { tasks: [task] } : { task })
      batches.length = 0
      const main = await presentation.toolResult(name, raw, false, signal(), false, 'main')
      expect(batches).toEqual([['Inspect API', 'Inspecting API']])
      expect(claudeToolResultContext(name, raw, false, false, 'main')).toEqual(['Inspect API', 'Inspecting API'])
      expect(claudeToolResultContext(name, main, false, false, 'main')).toEqual(['中文:Inspect API', '中文:Inspecting API'])
      expect(main).toContain('"description": "Internal task details"')
      const child = await presentation.toolResult(name, raw, false, signal(), true, 'background')
      expect(child).toContain('中文:Internal task details')
      expect(claudeToolResultContext(name, child, false, true, 'background')).toContain('中文:Internal task details')
      const server = await presentation.toolResult(`server_tool:${name}`, raw, false, signal())
      expect(server).toContain('中文:Internal task details')
    }
    expect(task.description).toBe('Internal task details')
  })

  test('main task snapshots ignore prose and unconsumed JSON fields while background receipts remain visible', async () => {
    const { presentation, batches } = harness()
    const prose = 'Task #1: Inspect API\nStatus: completed\nDescription: Internal task details'
    for (const name of ['TaskList', 'TaskGet']) {
      const ignored = [prose, '{invalid JSON', JSON.stringify({ unrelated: { subject: 'Hidden nested subject', activeForm: 'Hidden nested activity' } })]
      for (const content of ignored) {
        expect(await presentation.toolResult(name, content, false, signal())).toBe(content)
        expect(claudeToolResultContext(name, content, false)).toEqual([])
      }
    }
    expect(batches).toEqual([])
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      for (const isError of [false, true]) {
        expect(await presentation.toolResult(name, prose, isError, signal(), true, 'background')).toBe(`中文:${prose}`)
        expect(claudeToolResultContext(name, prose, isError, true, 'background')).toEqual([prose])
        expect(claudeToolResultContext(name, `中文:${prose}`, isError, true, 'background')).toEqual([`中文:${prose}`])
      }
      const error = JSON.stringify({ message: 'Task operation failed', reason: 'Task does not exist', id: '1' })
      expect(JSON.parse(await presentation.toolResult(name, error, true, signal(), true, 'background')))
        .toEqual({ message: '中文:Task operation failed', reason: '中文:Task does not exist', id: '1' })
      expect(claudeToolResultContext(name, error, true, true, 'background'))
        .toEqual(['Task operation failed', 'Task does not exist'])
    }
  })

  test('main task snapshot extraction matches JSON entries consumed by the task board', async () => {
    const { presentation, batches } = harness()
    const task = { id: '1', subject: 'Inspect API', content: 'Unselected alias', activeForm: 'Inspecting API', status: 'in_progress',
      description: 'Hidden details', nested: { subject: 'Hidden nested subject' } }
    for (const name of ['TaskList', 'TaskGet'] as const) {
      for (const value of name === 'TaskList' ? [[task], { tasks: [task], subject: 'Hidden wrapper subject' }]
        : [task, { task, subject: 'Hidden wrapper subject' }]) {
        batches.length = 0
        const raw = JSON.stringify(value)
        const display = await presentation.toolResult(name, raw, false, signal())
        expect(batches).toEqual([['Inspect API', 'Inspecting API']])
        expect(claudeToolResultContext(name, raw, false)).toEqual(batches[0]!)
        expect(claudeToolResultContext(name, display, false)).toEqual(['中文:Inspect API', '中文:Inspecting API'])
        expect(applyTaskTool([], name, { taskId: '1' }, display)).toEqual([
          { id: '1', subject: '中文:Inspect API', activeForm: '中文:Inspecting API', description: 'Hidden details', status: 'in_progress' },
        ])
        expect(JSON.parse(raw)).toEqual(value)
      }
      const alias = { id: '2', content: 'Visible alias', status: 'completed' }
      const raw = JSON.stringify(name === 'TaskList' ? { tasks: [alias] } : { task: alias })
      const display = await presentation.toolResult(name, raw, false, signal())
      expect(claudeToolResultContext(name, raw, false)).toEqual(['Visible alias'])
      expect(applyTaskTool([], name, { taskId: '2' }, display)[0]?.subject).toBe('中文:Visible alias')
    }
    batches.length = 0
    const discarded = JSON.stringify({ tasks: [{ id: '3', activeForm: 'No subject' }, { subject: 'Deleted task', status: 'deleted' }] })
    expect(await presentation.toolResult('TaskList', discarded, false, signal())).toBe(discarded)
    expect(claudeToolResultContext('TaskList', discarded, false)).toEqual([])
    expect(batches).toEqual([])
  })

  test('worker progress translates only its selected description and leaves hidden payloads out of context', async () => {
    const { presentation, batches } = harness()
    const task = { subject: 'Unused title', description: 'Visible worker description', activeForm: 'Unused active form', prompt: 'Hidden prompt' }
    const shownTask = await presentation.toolInput('TaskCreate', task, signal(), 'worker')
    expect(shownTask).toEqual({ ...task, description: '中文:Visible worker description' })
    expect(batches).toEqual([['Visible worker description']])
    expect(claudeToolInputContext('TaskCreate', task, 'worker')).toEqual(['Visible worker description'])
    expect(claudeToolInputContext('TaskCreate', shownTask, 'worker')).toEqual(['中文:Visible worker description'])

    const bash = { command: '# desc: Inspect files\ncat /tmp/source.ts', subject: 'Unused shell title' }
    const shownBash = await presentation.toolInput('Bash', bash, signal(), 'worker') as typeof bash & { __displayDescription: string }
    expect(shownBash.__displayDescription).toBe('中文:Inspect files')
    expect(shownBash.command).toBe(bash.command)
    expect(claudeToolInputContext('Bash', bash, 'worker')).toEqual(['Inspect files'])
    expect(claudeToolInputContext('Bash', shownBash, 'worker')).toEqual(['中文:Inspect files'])
    expect(task.description).toBe('Visible worker description')
  })

  test('worker results and absent progress descriptions have no translated or historical presentation', async () => {
    const { presentation, batches } = harness()
    const input = { command: 'printf raw_bytes', subject: 'Unused title', prompt: 'Hidden prompt' }
    expect(await presentation.toolInput('Bash', input, signal(), 'worker')).toEqual(input)
    expect(claudeToolInputContext('Bash', input, 'worker')).toEqual([])
    for (const isError of [false, true]) {
      const content = JSON.stringify({ message: 'Result not shown by the worker progress card', status: isError ? 'error' : 'completed' })
      expect(await presentation.toolResult('TaskUpdate', content, isError, signal(), true, 'worker')).toBe(content)
      expect(claudeToolResultContext('TaskUpdate', content, isError, true, 'worker')).toEqual([])
    }
    expect(batches).toEqual([])
  })

  test('preserves successful file results and process output, including process errors', async () => {
    const { presentation, batches } = harness()
    const content = 'English content\nconst answer = "Hello"\n{"message":"program output"}'
    for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash', 'BashOutput', 'functions.exec_command', 'write_stdin']) {
      expect(await presentation.toolResult(name, content, false, signal())).toBe(content)
    }
    expect(await presentation.toolResult('Bash', content, true, signal())).toBe(content)
    expect(batches).toEqual([])
  })

  test('translates explicit error messages without touching stdout and error codes', async () => {
    const { presentation } = harness()
    const error = { message: 'The file does not exist.', code: 'ENOENT', status: 'error', path: '/tmp/English.txt', stdout: 'Program output', stderr: 'Traceback content' }
    expect(JSON.parse(await presentation.toolResult('Bash', JSON.stringify(error), true, signal())))
      .toEqual({ ...error, message: '中文:The file does not exist.' })
    expect(await presentation.toolResult('Read', 'The file does not exist.', true, signal()))
      .toBe('中文:The file does not exist.')
  })

  test('translates MCP text blocks but preserves image/resource/structured payloads', async () => {
    const { presentation, batches } = harness()
    const raw = {
      content: [{ type: 'text', text: 'The operation is complete.' }, { type: 'image', data: 'base64', mimeType: 'image/png' }, { type: 'resource', resource: { text: 'Raw file bytes', title: 'Literal file title' } }],
      structuredContent: { message: 'Machine data', status: 'done' },
    }
    const display = JSON.parse(await presentation.toolResult('mcp__service__execute', JSON.stringify(raw), false, signal()))
    expect(display.content[0].text).toBe('中文:The operation is complete.')
    expect(display.content.slice(1)).toEqual(raw.content.slice(1))
    expect(display.structuredContent).toEqual(raw.structuredContent)
    expect(batches).toEqual([['The operation is complete.']])
  })

  test('parses JSON nested in MCP text and never sends its keys or machine fields for translation', async () => {
    const { presentation, batches } = harness()
    const nested = { message: 'Operation completed', status: 'done', data: { message: 'Raw data' }, arbitrary: 'Leave this value' }
    const raw = { content: [{ type: 'text', text: JSON.stringify(nested) }] }
    const display = JSON.parse(await presentation.toolResult('mcp__service__execute', JSON.stringify(raw), false, signal()))
    expect(JSON.parse(display.content[0].text)).toEqual({ ...nested, message: '中文:Operation completed' })
    expect(batches).toEqual([['Operation completed']])
  })

  test('preserves unrecognized structured data exactly when no natural-language fields exist', async () => {
    const { presentation, batches } = harness()
    const content = '{ "status" : "completed", "ids": ["hello"], "arbitrary": "English machine value" }'
    expect(await presentation.toolResult('UnknownTool', content, false, signal())).toBe(content)
    expect(batches).toEqual([])
  })

  test('only translates explicitly requested event properties and makes a deep display clone', async () => {
    const { presentation, batches } = harness()
    const raw = { description: 'Working on the task', summary: 'Current progress', title: 'Keep title', id: 'task-3', metadata: { summary: 'Opaque' } }
    const display = await presentation.naturalFields(raw, ['description', 'summary'], signal())
    expect(display).toEqual({ ...raw, description: '中文:Working on the task', summary: '中文:Current progress' })
    expect(display.metadata).not.toBe(raw.metadata)
    expect(raw.description).toBe('Working on the task')
    expect(batches).toEqual([['Working on the task', 'Current progress']])
  })

  test('surfaces provider and shape failures without passing through original prose', async () => {
    const failure = new Error('Provider unavailable')
    const failing = new ClaudePresentationTranslation({ toChineseFields: async () => { throw failure } })
    await expect(failing.toolResult('Agent', 'Work complete', false, signal())).rejects.toBe(failure)
    const malformed = new ClaudePresentationTranslation({ toChineseFields: async () => [] })
    await expect(malformed.toolInput('Agent', { description: 'Inspect files' }, signal())).rejects.toThrow('无效字段')
  })

  test('honors cancellation before and after translation and leaves source state untouched', async () => {
    const controller = new AbortController()
    const error = new Error('Stop requested')
    const input = { description: 'Inspect files' }
    const presentation = new ClaudePresentationTranslation({ toChineseFields: async () => {
      controller.abort(error)
      return ['检查文件']
    } })
    await expect(presentation.toolInput('Agent', input, controller.signal)).rejects.toBe(error)
    expect(input).toEqual({ description: 'Inspect files' })
    await expect(presentation.toolResult('Read', 'Raw file bytes', false, controller.signal)).rejects.toBe(error)
  })
})
