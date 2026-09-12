import { describe, expect, test } from 'bun:test'
import {
  parseAgentAnswerRequest,
  parseAgentFollowUpRequest,
  parseAgentRunRequest,
} from './agent-run-types'

describe('delegated-agent request parsing', () => {
  test('normalizes identities and preserves the raw prompt', () => {
    expect(parseAgentRunRequest({ identity_ids: ['a', 'a', 'b'], prompt: '  do it\n', effort: 'max' })).toEqual({
      identityIds: ['a', 'b'], prompt: '  do it\n', effort: 'max',
    })
  })

  test('parses follow-up and exact answer maps', () => {
    expect(parseAgentFollowUpRequest({ identity_id: 'a', prompt: 'next' })).toEqual({ identityId: 'a', prompt: 'next' })
    expect(parseAgentAnswerRequest({ request_id: 'r1', answers: { q1: 'yes' } })).toEqual({
      requestId: 'r1', answers: { q1: 'yes' },
    })
  })

  test('accepts a native session id with optional identity and preserves the new input', () => {
    expect(parseAgentRunRequest({ session_id: ' native-session ', prompt: '  second turn\n' })).toEqual({
      identityIds: [], sessionId: 'native-session', prompt: '  second turn\n',
    })
    expect(parseAgentRunRequest({ sessionId: 'sid', identityIds: ['a'], prompt: 'third', effort: 'low' })).toEqual({
      identityIds: ['a'], sessionId: 'sid', prompt: 'third', effort: 'low',
    })
  })

  test('rejects invalid session requests instead of starting a fresh conversation', () => {
    for (const session_id of ['', ' ', null, 12, {}, []]) {
      expect(() => parseAgentRunRequest({ session_id, identity_ids: ['a'], prompt: 'next' })).toThrow('session_id')
    }
    expect(() => parseAgentRunRequest({ session_id: 'sid', identity_ids: ['a', 'b'], prompt: 'next' }))
      .toThrow('at most one')
    expect(() => parseAgentRunRequest({ session_id: 'sid', sessionId: 'different', prompt: 'next' }))
      .toThrow('conflicting')
  })

  test('rejects empty tasks and malformed answers', () => {
    expect(() => parseAgentRunRequest({ identity_ids: [], prompt: 'x' })).toThrow('identity_id')
    expect(() => parseAgentRunRequest({ identity_ids: ['a'], prompt: ' ' })).toThrow('prompt')
    expect(() => parseAgentAnswerRequest({ request_id: 'r', answers: {} })).toThrow('at least one')
  })
})
