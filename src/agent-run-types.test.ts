import { describe, expect, test } from 'bun:test'
import {
  parseAgentAnswerRequest,
  parseAgentFollowUpRequest,
  parseAgentRunRequest,
} from './agent-run-types'

describe('delegated-agent request parsing', () => {
  test('normalizes identities and preserves the raw prompt', () => {
    expect(parseAgentRunRequest({ description: '任务说明', identity_ids: ['a', 'a', 'b'], prompt: '  do it\n', effort: 'max' })).toEqual({ description: '任务说明',
      identityIds: ['a', 'b'], prompt: '  do it\n', effort: 'max',
    })
  })

  test('parses follow-up and exact answer maps', () => {
    expect(parseAgentFollowUpRequest({ description: '任务说明', identity_id: 'a', prompt: 'next' })).toEqual({ description: '任务说明', identityId: 'a', prompt: 'next' })
    expect(parseAgentAnswerRequest({ request_id: 'r1', answers: { q1: 'yes' } })).toEqual({
      requestId: 'r1', answers: { q1: 'yes' },
    })
  })

  test('accepts work_dir aliases for new runs and continuations without trimming the path', () => {
    for (const field of ['work_dir', 'workDir']) {
      const request = { description: '指定目录', prompt: 'work', [field]: 'packages/app with spaces ' }
      expect(parseAgentRunRequest({ ...request, identity_ids: ['a'] })).toMatchObject({ workDir: 'packages/app with spaces ' })
      expect(parseAgentRunRequest({ ...request, session_id: 'sid' })).toMatchObject({ workDir: 'packages/app with spaces ' })
      expect(parseAgentFollowUpRequest(request)).toMatchObject({ workDir: 'packages/app with spaces ' })
    }
  })

  test('rejects invalid or conflicting directory options instead of using the default directory', () => {
    const request = { description: '检查目录', prompt: 'work', identity_ids: ['a'] }
    for (const work_dir of ['', ' ', null, 7, {}, [], 'invalid\0path']) {
      expect(() => parseAgentRunRequest({ ...request, work_dir })).toThrow('work_dir')
      expect(() => parseAgentFollowUpRequest({ ...request, work_dir })).toThrow('work_dir')
    }
    expect(() => parseAgentRunRequest({ ...request, work_dir: 'a', workDir: 'b' })).toThrow('conflicting')
    expect(() => parseAgentFollowUpRequest({ ...request, work_dir: 'a', workDir: 'b' })).toThrow('conflicting')
  })

  test('accepts a native session id with optional identity and preserves the new input', () => {
    expect(parseAgentRunRequest({ description: '任务说明', session_id: ' native-session ', prompt: '  second turn\n' })).toEqual({ description: '任务说明',
      identityIds: [], sessionId: 'native-session', prompt: '  second turn\n',
    })
    expect(parseAgentRunRequest({ description: '任务说明', sessionId: 'sid', identityIds: ['a'], prompt: 'third', effort: 'low' })).toEqual({ description: '任务说明',
      identityIds: ['a'], sessionId: 'sid', prompt: 'third', effort: 'low',
    })
  })

  test('rejects invalid session requests instead of starting a fresh conversation', () => {
    for (const session_id of ['', ' ', null, 12, {}, []]) {
      expect(() => parseAgentRunRequest({ description: '任务说明', session_id, identity_ids: ['a'], prompt: 'next' })).toThrow('session_id')
    }
    expect(() => parseAgentRunRequest({ description: '任务说明', session_id: 'sid', identity_ids: ['a', 'b'], prompt: 'next' }))
      .toThrow('at most one')
    expect(() => parseAgentRunRequest({ description: '任务说明', session_id: 'sid', sessionId: 'different', prompt: 'next' }))
      .toThrow('conflicting')
  })

  test('requires a brief single-line description for new runs and continuations', () => {
    for (const description of [undefined, null, '', '  ', 7, '一行\n另一行', 'x'.repeat(61)]) {
      expect(() => parseAgentRunRequest({ identity_ids: ['a'], prompt: 'task', description })).toThrow('description')
      expect(() => parseAgentRunRequest({ session_id: 'sid', prompt: 'task', description })).toThrow('description')
      expect(() => parseAgentFollowUpRequest({ prompt: 'task', description })).toThrow('description')
    }
    expect(parseAgentRunRequest({ identity_ids: ['a'], prompt: '  unchanged\n', description: '  检查接口  ' }))
      .toMatchObject({ description: '检查接口', prompt: '  unchanged\n' })
  })

  test('rejects empty tasks and malformed answers', () => {
    expect(() => parseAgentRunRequest({ description: '任务说明', identity_ids: [], prompt: 'x' })).toThrow('identity_id')
    expect(() => parseAgentRunRequest({ description: '任务说明', identity_ids: ['a'], prompt: ' ' })).toThrow('prompt')
    expect(() => parseAgentAnswerRequest({ request_id: 'r', answers: {} })).toThrow('at least one')
  })
})
