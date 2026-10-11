import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_TRANSLATION_ORIGINS, ClaudeTranslationContext, claudeTranslationOriginForRole } from './claude-translation-context'

const signal = () => new AbortController().signal
let directory: string
let workDir: string
let storeDir: string

function context(options: { resumeSessionId?: string; resumeSessionAt?: string; forkSession?: boolean; workDir?: string } = {}) {
  return new ClaudeTranslationContext({ workDir, storeDir, ...options })
}

function ledgerPath(): string {
  const workspace = readdirSync(storeDir)[0]!
  return join(storeDir, workspace, readdirSync(join(storeDir, workspace))[0]!)
}

function legacyEntry({ original, translated, origin: _origin, ...entry }: any) {
  const text = entry.role === 'user' ? `Original user text:\n${original}\nEnglish submitted text:\n${translated}`
    : entry.role === 'user/answer' ? `Original user answer:\n${original}\nSubmitted answer:\n${translated}`
      : `Original Claude output:\n${original}\nVerified display text:\n${translated}`
  return { ...entry, text }
}

async function sourceSession(markCheckpoint = true): Promise<ClaudeTranslationContext> {
  const source = context()
  await source.initialize(signal())
  source.bindSession('source')
  source.stageInput('user-1', '保留 API。', 'Keep the API.')
  source.confirmInput('user-1')
  source.recordOutput('message', 'I will preserve it.', '我会保留它。', 'assistant-1', 'message:assistant-1')
  if (markCheckpoint) source.recordDisplay({ checkpoint: 'assistant-1' })
  return source
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'claude-boundary-test-'))
  workDir = join(directory, 'project')
  storeDir = join(directory, 'boundary-ledgers')
  mkdirSync(workDir)
})

afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('Claude visible translation exchange context', () => {
  test('explicit speaker and surface labels survive input confirmation, persistence and fork without protocol IDs', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.stageInput('delegated-input', '检查任务。', 'Inspect the task.', CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
    expect(source.snapshot().entries[0]?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.delegatedRequest)
    source.confirmInput('delegated-input')
    source.recordInteraction('user/answer', '继续。', 'Continue.', CLAUDE_TRANSLATION_ORIGINS.delegatedAnswer)
    source.recordOutput('question', 'Continue?', '继续吗？', undefined, 'question-key', CLAUDE_TRANSLATION_ORIGINS.delegatedQuestion)
    source.recordDisplay({ output: { kind: 'message', original: 'Task finished.', display: '任务完成。',
      uuid: 'private-native-id', origin: CLAUDE_TRANSLATION_ORIGINS.subagentOutput }, checkpoint: 'fork-point' })
    source.recordOutput('message', 'Later reply.', '后续回复。', undefined, undefined, CLAUDE_TRANSLATION_ORIGINS.reply)
    const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'fork-point', forkSession: true })
    await fork.initialize(signal())
    expect(fork.snapshot().entries.map(entry => entry.origin)).toEqual([
      CLAUDE_TRANSLATION_ORIGINS.delegatedRequest, CLAUDE_TRANSLATION_ORIGINS.delegatedAnswer,
      CLAUDE_TRANSLATION_ORIGINS.delegatedQuestion, CLAUDE_TRANSLATION_ORIGINS.subagentOutput,
    ])
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
    const labels = restored.snapshot().entries.map(entry => entry.origin).join('\n')
    for (const internal of ['private-native-id', 'question-key', 'fork-point', 'delegated-input']) expect(labels).not.toContain(internal)
  })

  test('older v2 records derive only provenance that their recorded role actually proves', async () => {
    const source = await sourceSession()
    source.recordOutput('command-description', 'Inspect files.', '检查文件。')
    source.recordInteraction('user/answer', '继续。', 'Continue.', CLAUDE_TRANSLATION_ORIGINS.userAnswer)
    const path = ledgerPath(), ledger = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...ledger, entries: ledger.entries.map(({ origin: _origin, ...entry }: any) => entry) }))
    const before = readFileSync(path, 'utf8')
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries.map(entry => entry.origin)).toEqual([
      CLAUDE_TRANSLATION_ORIGINS.legacyUserMessage,
      CLAUDE_TRANSLATION_ORIGINS.legacyVisibleOutput,
      CLAUDE_TRANSLATION_ORIGINS.commandExplanation,
      CLAUDE_TRANSLATION_ORIGINS.legacyUserAnswer,
    ])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(claudeTranslationOriginForRole('assistant/message')).not.toBe(CLAUDE_TRANSLATION_ORIGINS.reply)
    expect(claudeTranslationOriginForRole('assistant/agent-message')).toBe(CLAUDE_TRANSLATION_ORIGINS.legacyVisibleOutput)
    expect(claudeTranslationOriginForRole('unclassified-old-record')).toBe(CLAUDE_TRANSLATION_ORIGINS.legacyUnknown)
    expect(restored.snapshot().entries[0]?.origin).not.toContain('Feishu')
    expect(restored.snapshot().entries.at(-1)?.origin).not.toContain('Feishu')
  })

  test('empty or invalid explicit provenance fails without adding an interaction', async () => {
    const source = await sourceSession(), before = source.snapshot()
    expect(() => source.stageInput('bad', '你好', 'Hello', '')).toThrow('origin is empty')
    expect(() => source.recordInteraction('user/answer', '继续', 'Continue', '  ')).toThrow('origin is empty')
    expect(() => source.recordOutput('message', 'Hello', '你好', undefined, undefined, '')).toThrow('origin is empty')
    expect(source.snapshot()).toEqual(before)
    const path = ledgerPath(), ledger = JSON.parse(readFileSync(path, 'utf8'))
    for (const origin of ['', '  ', 7, null]) {
      writeFileSync(path, JSON.stringify({ ...ledger, entries: ledger.entries.map((entry: any) => ({ ...entry, origin })) }))
      await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('malformed')
    }
  })

  test('fresh contexts isolate memory, preserve immutable snapshots, and persist only after binding', async () => {
    const first = context()
    const second = context()
    expect(() => first.snapshot()).toThrow('has not initialized')
    await first.initialize(signal())
    await second.initialize(signal())
    first.stageInput('input-1', '保留 API。', 'Keep the API.')
    const pending = first.snapshot()
    first.confirmInput('input-1')
    first.recordOutput('message', 'I will preserve it.', '我会保留它。')
    expect(existsSync(storeDir)).toBe(false)
    expect(second.snapshot().entries).toHaveLength(0)
    expect(pending.entries).toHaveLength(1)
    expect(pending.entries[0]?.status).toBe('pending')
    expect(pending.entries[0]?.origin).toBe(CLAUDE_TRANSLATION_ORIGINS.userMessage)
    expect(Object.isFrozen(pending.entries[0])).toBe(true)
    expect(first.snapshot().coverage).toBe('since-enabled')
    first.bindSession('first-session')
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8')).entries).toHaveLength(2)
    expect(() => first.bindSession('other-session')).toThrow('session mismatch')
  })

  test('resume reads only the visible bilingual exchanges from its own ledger', async () => {
    const source = await sourceSession()
    // Native-looking files are irrelevant, even when they contain conversation text.
    writeFileSync(join(workDir, 'source.jsonl'), '{"text":"PRIVATE NATIVE HISTORY"}\n')
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
    expect(restored.snapshot()).toMatchObject({ sessionId: 'source', sourceSessionId: 'source', coverage: 'since-enabled' })
    const text = restored.snapshot().entries.map(entry => `${entry.original}\n${entry.translated}`).join('\n')
    for (const value of ['保留 API', 'Keep the API', 'I will preserve it', '我会保留它']) expect(text).toContain(value)
    expect(text).not.toContain('PRIVATE NATIVE HISTORY')
    expect(restored.snapshot().entries.map(({ original, translated }) => ({ original, translated }))).toEqual([
      { original: '保留 API。', translated: 'Keep the API.' },
      { original: 'I will preserve it.', translated: '我会保留它。' },
    ])
  })

  test('version 1 ledgers migrate known bilingual pairs without changing consumption or fork boundaries', async () => {
    const source = await sourceSession()
    source.recordInteraction('user/answer', '是否继续？: 继续', 'Continue?: Continue')
    const path = ledgerPath()
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    const legacy = { ...ledger, version: 1,
      entries: ledger.entries.map(legacyEntry) }
    writeFileSync(path, JSON.stringify(legacy))
    const prior = readFileSync(path, 'utf8')
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries.map(entry => ({
      ...entry, origin: claudeTranslationOriginForRole(entry.role),
    })))
    expect(readFileSync(path, 'utf8')).toBe(prior)
    const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'assistant-1', forkSession: true })
    await fork.initialize(signal())
    expect(fork.snapshot().entries).toHaveLength(2)
    restored.recordOutput('message', 'Continue.', '继续。')
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2)
    expect(JSON.parse(readFileSync(path, 'utf8')).entries.every((entry: any) => !Object.hasOwn(entry, 'text'))).toBe(true)
  })

  test('older v2 diagnostic text is discarded without replacing the actual pair', async () => {
    const source = await sourceSession()
    const path = ledgerPath(), ledger = JSON.parse(readFileSync(path, 'utf8'))
    expect(ledger.entries.every((entry: any) => !Object.hasOwn(entry, 'text'))).toBe(true)
    writeFileSync(path, JSON.stringify({ ...ledger,
      entries: ledger.entries.map((entry: any) => ({ ...entry, text: 'Obsolete diagnostic copy.' })) }))
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
    restored.recordOutput('message', 'New response.', '新的回复。')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.entries.every((entry: any) => !Object.hasOwn(entry, 'text'))).toBe(true)
    expect(saved.entries.slice(0, ledger.entries.length)).toEqual(ledger.entries)
  })

  test('legacy migration rejects missing or ambiguous pair wrappers instead of guessing', async () => {
    await sourceSession()
    const path = ledgerPath()
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    const entries = ledger.entries.map(legacyEntry)
    for (const text of [
      'A legacy interaction without a bilingual record.',
      'Original user text:\n源文\nEnglish submitted text:\nFirst\nEnglish submitted text:\nSecond',
    ]) {
      writeFileSync(path, JSON.stringify({ ...ledger, version: 1, entries: [{ ...entries[0], text }] }))
      await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('legacy pair is malformed or ambiguous')
    }
  })

  test('new pair fields exclude fenced bodies and delivery protocol but retain conversational inline terms', async () => {
    const source = context()
    await source.initialize(signal())
    const body = '\n```ts\nPRIVATE_FILE_BODY\n```\n'
    source.stageInput('input', `请检查 \`clientId\` 和 /tmp/配置.json。${body}继续。\n[file: /tmp/private-input.txt]`,
      `Inspect \`clientId\` and /tmp/配置.json.${body}Continue.\n[file: /tmp/private-input.txt]`)
    source.confirmInput('input')
    source.recordOutput('message', `Updated \`clientId\`.${body}Done.\n[[send: /tmp/private-output.txt]]`,
      `已更新 \`clientId\`。${body}完成。\n[[send: /tmp/private-output.txt]]`)
    const pairs = source.snapshot().entries.map(({ original, translated }) => ({ original, translated }))
    const serialized = JSON.stringify(pairs)
    for (const excluded of ['PRIVATE_FILE_BODY', 'private-input.txt', 'private-output.txt', 'Code omitted', 'Original user text', 'Verified display text']) {
      expect(serialized).not.toContain(excluded)
    }
    for (const retained of ['clientId', '/tmp/配置.json', '继续', 'Continue', '完成', 'Done']) expect(serialized).toContain(retained)
    expect(pairs[0]?.original).toBe('请检查 `clientId` 和 /tmp/配置.json。\n继续。')
  })

  test('legacy omission notes are removed from pairs without reconstructing omitted native code', async () => {
    const source = await sourceSession()
    source.recordOutput('message', 'Inspect `PRIVATE_INLINE_CODE` now.', '现在检查 `PRIVATE_INLINE_CODE`。')
    const path = ledgerPath(), ledger = JSON.parse(readFileSync(path, 'utf8'))
    const entries = ledger.entries.map(legacyEntry)
    entries.at(-1)!.text = 'Original Claude output:\nInspect [Code omitted from translation context.] now.\nVerified display text:\n现在检查 [Code omitted from translation context.]。'
    writeFileSync(path, JSON.stringify({ ...ledger, version: 1, entries }))
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    const pair = restored.snapshot().entries.at(-1)!
    expect(pair.original).toBe('Inspect  now.')
    expect(pair.translated).toBe('现在检查 。')
    expect(pair).not.toHaveProperty('text')
  })

  test('an older unrecorded session begins with explicit since-enabled coverage', async () => {
    for (const options of [
      { resumeSessionId: 'older' },
      { resumeSessionId: 'older-fork-source', resumeSessionAt: 'unrecorded-point', forkSession: true },
    ]) {
      const restored = context(options)
      await restored.initialize(signal())
      expect(restored.snapshot()).toMatchObject({ coverage: 'since-enabled', entries: [] })
      restored.recordOutput('message', 'A newly visible response.', '新展示的回复。')
      if (options.forkSession) restored.bindSession('new-fork')
    }
  })

  test('fork inherits exactly the recorded checkpoint and never rewrites the source', async () => {
    const source = await sourceSession(false)
    source.recordDisplay({ tools: [{ id: 'tool-before', name: 'Bash' }] })
    source.recordOutput('command-description', 'Inspect the repository.', '检查仓库。', 'assistant-1', 'tool-before:desc')
    source.recordDisplay({ checkpoint: 'assistant-1' })
    const before = source.snapshot()
    source.stageInput('user-2', '未来输入', 'Future input')
    source.confirmInput('user-2')
    source.recordDisplay({ tools: [{ id: 'tool-after', name: 'Read' }] })
    source.recordOutput('message', 'Future response.', '未来回复。', 'assistant-2')
    source.recordDisplay({ checkpoint: 'assistant-2' })
    const sourceFile = ledgerPath()
    const savedSource = readFileSync(sourceFile, 'utf8')
    const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'assistant-1', forkSession: true })
    await fork.initialize(signal())
    expect(fork.snapshot().sessionId).toBeNull()
    expect(fork.snapshot().entries).toEqual(before.entries)
    expect(fork.toolName('tool-before')).toBe('Bash')
    expect(fork.toolName('tool-after')).toBeUndefined()
    expect(() => fork.bindSession('source')).toThrow('cannot bind')
    fork.bindSession('forked-session')
    fork.recordOutput('message', 'A separate branch.', '独立分支。')
    expect(readFileSync(sourceFile, 'utf8')).toBe(savedSource)
    const restoredFork = context({ resumeSessionId: 'forked-session' })
    await restoredFork.initialize(signal())
    expect(restoredFork.snapshot().entries).toEqual(fork.snapshot().entries)
  })


  test('replayed session IDs and completed message checkpoints do not rewrite or advance history', async () => {
    const source = await sourceSession()
    const boundary = source.snapshot()
    const path = ledgerPath()
    const initialInode = statSync(path).ino
    source.bindSession('source')
    source.recordDisplay({ checkpoint: 'assistant-1' })
    expect(statSync(path).ino).toBe(initialInode)
    source.stageInput('future-input', '后续输入', 'A later input')
    source.confirmInput('future-input')
    source.recordOutput('message', 'A later response.', '后续回复。', 'assistant-2', 'message:assistant-2')
    source.recordDisplay({ checkpoint: 'assistant-2' })
    const futureInode = statSync(path).ino
    source.recordOutput('message', 'I will preserve it.', '我会保留它。', 'assistant-1', 'message:assistant-1')
    source.recordDisplay({ checkpoint: 'assistant-1' })
    expect(statSync(path).ino).toBe(futureInode)
    const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'assistant-1', forkSession: true })
    await fork.initialize(signal())
    expect(fork.snapshot().entries).toEqual(boundary.entries)
  })

  test('existing ledgers reject missing fork checkpoints without guessing a boundary', async () => {
    await sourceSession()
    const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'missing', forkSession: true })
    await expect(fork.initialize(signal())).rejects.toThrow('checkpoint not found')
    expect(() => fork.snapshot()).toThrow('has not initialized')
  })

  test('different workspaces and session IDs never share recorded exchanges', async () => {
    await sourceSession()
    const differentSession = context({ resumeSessionId: 'different-session' })
    await differentSession.initialize(signal())
    expect(differentSession.snapshot().entries).toHaveLength(0)
    const otherWorkDir = join(directory, 'other-project')
    mkdirSync(otherWorkDir)
    const otherWorkspace = context({ resumeSessionId: 'source', workDir: otherWorkDir })
    await otherWorkspace.initialize(signal())
    expect(otherWorkspace.snapshot().entries).toHaveLength(0)
    otherWorkspace.recordOutput('message', 'Other workspace.', '另一个项目。')
    expect(readdirSync(storeDir)).toHaveLength(2)
    const alias = join(directory, 'project-alias')
    symlinkSync(workDir, alias, 'dir')
    const sameWorkspace = context({ resumeSessionId: 'source', workDir: alias })
    await sameWorkspace.initialize(signal())
    expect(sameWorkspace.snapshot().entries).toHaveLength(2)
  })

  test('corrupt records and mismatched ownership fail explicitly', async () => {
    await sourceSession()
    const path = ledgerPath()
    const valid = readFileSync(path, 'utf8')
    const checks: Array<[unknown, string]> = [
      ['{bad json', 'cannot be read'],
      [{ ...JSON.parse(valid), sessionId: 'other-session' }, 'session/cwd mismatch'],
      [{ ...JSON.parse(valid), workDir: '/different/workspace' }, 'session/cwd mismatch'],
      [{ ...JSON.parse(valid), version: 999 }, 'malformed'],
      [{ ...JSON.parse(valid), entries: [{ role: 'user', text: 'Not consumed', status: 'pending', sequence: 1 }] }, 'malformed'],
      [{ ...JSON.parse(valid), entries: JSON.parse(valid).entries.map(({ original: _original, ...entry }: any) => entry) }, 'malformed'],
    ]
    for (const [value, error] of checks) {
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
      const restored = context({ resumeSessionId: 'source' })
      await expect(restored.initialize(signal())).rejects.toThrow(error)
      expect(() => restored.snapshot()).toThrow('has not initialized')
    }
  })

  test('private files and directories use 0600/0700 and reject permission anomalies', async () => {
    await sourceSession()
    const path = ledgerPath()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(storeDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(storeDir, readdirSync(storeDir)[0]!)).mode & 0o777).toBe(0o700)
    chmodSync(path, 0o644)
    await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('permissions must be 600')
    chmodSync(path, 0o600)
    chmodSync(storeDir, 0o755)
    await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('permissions must be 700')
  })

  test('unreadable paths and symlink ledger files are not treated as missing history', async () => {
    await sourceSession()
    const path = ledgerPath()
    const original = path + '.original'
    writeFileSync(original, readFileSync(path), { mode: 0o600 })
    rmSync(path)
    symlinkSync(original, path)
    await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('not a regular file')
    rmSync(path)
    mkdirSync(path, { mode: 0o700 })
    await expect(context({ resumeSessionId: 'source' }).initialize(signal())).rejects.toThrow('not a regular file')
  })

  test('pending input never enters persisted history and moves to its consumption boundary', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.stageInput('queued', '也检查第二项。', 'Inspect the second item too.')
    source.recordOutput('message', 'First inspection complete.', '第一项检查完成。', 'before-consumption')
    const before = source.snapshot()
    const beforeResume = context({ resumeSessionId: 'source' })
    await beforeResume.initialize(signal())
    expect(beforeResume.snapshot().entries.map(entry => entry.uuid)).toEqual(['before-consumption'])
    source.confirmInput('queued')
    source.recordOutput('message', 'Inspecting the second item.', '检查第二项。', 'after-consumption')
    source.confirmInput('queued')
    expect(source.snapshot().entries.map(entry => entry.uuid)).toEqual(['before-consumption', 'queued', 'after-consumption'])
    expect(before.entries[0]?.status).toBe('pending')
    expect(before.entries.map(entry => entry.uuid)).toEqual(['queued', 'before-consumption'])
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
  })

  test('cancelling one or all pending inputs cannot erase consumed input', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.stageInput('first', '第一项', 'First item')
    source.stageInput('second', '第二项', 'Second item')
    source.stageInput('third', '第三项', 'Third item')
    source.confirmInput('first')
    source.cancelInput('first')
    source.cancelInput('second')
    source.cancelInput('unknown')
    expect(source.snapshot().entries.map(entry => [entry.uuid, entry.status])).toEqual([['third', 'pending'], ['first', 'consumed']])
    source.cancelPendingInputs()
    expect(source.snapshot().entries.map(entry => entry.uuid)).toEqual(['first'])
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
    expect(() => restored.stageInput('first', '重复', 'Duplicate')).toThrow('duplicated')
  })

  test('a late native consumption receipt restores stopped input while actual cancellation discards it', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.stageInput('consumed-before-stop', '保留这项要求。', 'Keep this requirement.')
    source.stageInput('cancelled-before-use', '取消这项要求。', 'Cancel this requirement.')
    source.cancelPendingInputs()
    expect(source.snapshot().entries).toEqual([])
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf8')).entries).toEqual([])
    expect(() => source.stageInput('consumed-before-stop', '重复', 'Duplicate')).toThrow('duplicated')
    source.cancelInput('cancelled-before-use')
    source.confirmInput('cancelled-before-use')
    expect(source.snapshot().entries).toEqual([])
    source.confirmInput('consumed-before-stop')
    source.confirmInput('consumed-before-stop')
    expect(source.snapshot().entries).toHaveLength(1)
    expect(source.snapshot().entries[0]).toMatchObject({ uuid: 'consumed-before-stop', status: 'consumed' })
    expect(source.snapshot().entries[0]?.translated).toBe('Keep this requirement.')
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
  })

  test('failure to persist a late consumption receipt does not lose its stopped input', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.stageInput('late-input', '保留它。', 'Keep it.')
    source.cancelPendingInputs()
    chmodSync(ledgerPath(), 0o644)
    expect(() => source.confirmInput('late-input')).toThrow('permissions must be 600')
    expect(source.snapshot().entries).toEqual([])
    chmodSync(ledgerPath(), 0o600)
    source.confirmInput('late-input')
    expect(source.snapshot().entries[0]).toMatchObject({ uuid: 'late-input', status: 'consumed' })
  })

  test('only explicit visible output is recorded and the tool index stays outside GLM context', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    source.recordDisplay({ tools: [{ id: 'private-tool-id', name: 'Bash' }] })
    source.recordOutput('command-description', 'Inspect the repository.', '检查仓库。', 'a1', 'command:a1')
    source.recordOutput('agent-message', 'The API is compatible.\n```ts\nprivateSource()\n```', 'API 兼容。\n```ts\nprivateSource()\n```', 'a2', 'message:a2')
    source.recordOutput('error', 'The file does not exist.', '文件不存在。')
    const text = JSON.stringify(source.snapshot())
    for (const visible of ['Inspect the repository', '检查仓库', 'API is compatible', 'API 兼容', 'The file does not exist']) expect(text).toContain(visible)
    for (const privateValue of ['private-tool-id', 'Bash', 'privateSource()']) expect(text).not.toContain(privateValue)
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.toolName('private-tool-id')).toBe('Bash')
    restored.recordOutput('command-description', 'Inspect the repository.', '检查仓库。', 'a1', 'command:a1')
    expect(restored.snapshot().entries).toEqual(source.snapshot().entries)
  })

  test('pair history excludes fenced bodies and retains conversational inline terms without diagnostic copies', async () => {
    const source = context()
    await source.initialize(signal())
    source.bindSession('source')
    const code = [
      '````md', '```ts', 'PRIVATE_NESTED_CODE', '```', 'PRIVATE_AFTER_INNER_FENCE', '````',
      '``PRIVATE_INLINE `inner` and ```longer``` PRIVATE_AFTER_INNER_TICKS``',
      '``PRIVATE_MULTILINE', 'PRIVATE_SECOND_LINE``',
    ].join('\n')
    source.stageInput('user-code', `检查代码\n${code}\n保留后文。`, `Inspect code\n${code}\nKeep the following prose.`)
    source.confirmInput('user-code')
    source.recordOutput('message', `The code follows.\n${code}\nThe review is complete.`, `代码如下。\n${code}\n检查完成。`)
    const snapshot = source.snapshot()
    const text = snapshot.entries.map(entry => `${entry.original}\n${entry.translated}`).join('\n')
    expect(snapshot.entries.every(entry => !Object.hasOwn(entry, 'text'))).toBe(true)
    for (const prose of ['检查代码', '保留后文', 'Inspect code', 'Keep the following prose', 'The review is complete', '检查完成']) {
      expect(text).toContain(prose)
    }
    const pairText = snapshot.entries.map(entry => `${entry.original}\n${entry.translated}`).join('\n')
    expect(pairText).not.toContain('PRIVATE_NESTED_CODE')
    expect(pairText).not.toContain('PRIVATE_AFTER_INNER_FENCE')
    expect(pairText).not.toContain('Code omitted')
    expect(pairText).toContain('PRIVATE_INLINE')
    const restored = context({ resumeSessionId: 'source' })
    await restored.initialize(signal())
    expect(restored.snapshot().entries).toEqual(snapshot.entries)
  })

  test('write failures propagate and do not add uncommitted output to snapshots', async () => {
    const source = await sourceSession()
    const before = source.snapshot()
    chmodSync(ledgerPath(), 0o644)
    expect(() => source.recordOutput('message', 'Must not appear as committed.', '不得成为已确认上下文。')).toThrow('permissions must be 600')
    expect(source.snapshot()).toEqual(before)
    expect(readdirSync(join(storeDir, readdirSync(storeDir)[0]!)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  test('visible output, tool identities and its checkpoint commit once or roll back together', async () => {
    const source = await sourceSession()
    const before = source.snapshot(), onDisk = readFileSync(ledgerPath(), 'utf8')
    const record = { tools: [{ id: 'atomic-tool', name: 'Bash' }],
      output: { kind: 'message', original: 'Visible result.', display: '可见结果。', uuid: 'atomic-assistant', key: 'atomic-output' },
      checkpoint: 'atomic-assistant' }
    const originalPersist = (source as any).persist.bind(source)
    let writes = 0
    const persistence = spyOn(source as any, 'persist').mockImplementation(() => {
      writes++
      expect((source as any).checkpoints.some((item: any) => item.uuid === 'atomic-assistant')).toBe(true)
      throw new Error('checkpoint write failed')
    })
    try {
      expect(() => source.recordDisplay(record)).toThrow('checkpoint write failed')
      expect(writes).toBe(1)
      expect(source.snapshot()).toEqual(before)
      expect(source.toolName('atomic-tool')).toBeUndefined()
      expect(readFileSync(ledgerPath(), 'utf8')).toBe(onDisk)
      persistence.mockImplementation(() => { writes++; originalPersist() })
      source.recordDisplay(record)
      source.recordDisplay(record)
      expect(writes).toBe(2)
      const fork = context({ resumeSessionId: 'source', resumeSessionAt: 'atomic-assistant', forkSession: true })
      await fork.initialize(signal())
      expect(fork.snapshot().entries).toEqual(source.snapshot().entries)
      expect(fork.toolName('atomic-tool')).toBe('Bash')
    } finally { persistence.mockRestore() }
  })

  test('a new process cannot overwrite an existing session ledger on bind', async () => {
    await sourceSession()
    const other = context()
    await other.initialize(signal())
    expect(() => other.bindSession('source')).toThrow('already exists')
    expect(other.snapshot().sessionId).toBeNull()
  })

  test('pre-cancelled initialization and invalid fork options fail explicitly', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    const stopped = context()
    expect(() => stopped.initialize(controller.signal)).toThrow('stopped')
    expect(() => stopped.snapshot()).toThrow('has not initialized')
    await expect(context({ forkSession: true }).initialize(signal())).rejects.toThrow('requires a fork/resume source')
  })

  test('large visible conversational history is not silently truncated', async () => {
    const source = context()
    await source.initialize(signal())
    const text = 'A full contextual requirement. '.repeat(10_000)
    source.recordInteraction('user', text, '完整译文。'.repeat(10_000))
    expect(source.snapshot().entries[0]?.original).toBe(text.trim())
    expect(source.snapshot().entries[0]?.translated).toBe('完整译文。'.repeat(10_000))
  })
})
