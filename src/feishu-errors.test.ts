import { expect, test } from 'bun:test'
import { feishuErrorDetails, formatFeishuError } from './feishu-errors'

test('API and card failures retain the upstream message and body log_id', () => {
  expect(formatFeishuError({ code: 300121, msg: 'Failed to replace element', error: { log_id: 'body-log' } }))
    .toBe('code=300121 message=Failed to replace element log_id=body-log')
  expect(formatFeishuError({ code: 300121, message: 'component rejected', logId: 'card-log' }))
    .toBe('code=300121 message=component rejected log_id=card-log')
  expect(formatFeishuError({ code: '230001', message: 'invalid message', log_id: 'top-log' }))
    .toBe('code=230001 message=invalid message log_id=top-log')
})

test('SDK HTTP exceptions prefer the actual API rejection over the wrapper message', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    code: 'ERR_BAD_REQUEST',
    response: {
      status: 400,
      data: { code: 230020, msg: 'group rate limit', error: { log_id: 'api-log' } },
      headers: { 'X-Tt-Logid': 'header-log', 'Retry-After': '2' },
    },
  })
  expect(feishuErrorDetails(error)).toEqual({
    code: 230020, message: 'group rate limit', logId: 'api-log', status: 400, retryAfter: '2',
  })
})

test('direct SDK data envelopes expose diagnostics without treating business data as an error', () => {
  const envelope = {
    data: { code: 1470403, msg: 'task permission denied', error: { log_id: 'task-log' } },
    headers: { 'X-Tt-Logid': 'header-log' }, status: 403,
  }
  expect(formatFeishuError(envelope)).toBe('code=1470403 message=task permission denied log_id=task-log')
  expect(formatFeishuError({ ...envelope, code: 'ERR_BAD_REQUEST', message: 'Request failed with status code 403' }))
    .toBe('code=1470403 message=task permission denied log_id=task-log')
  expect(formatFeishuError({ data: { msg: 'invalid task', log_id: 'task-log' } }))
    .toBe('code=MISS message=invalid task log_id=task-log')
  expect(formatFeishuError({ message: 'request failed', data: { message: 'private task description' } }))
    .toBe('code=MISS message=request failed log_id=MISS')
  expect(formatFeishuError({ message: 'request failed', data: { code: 0, msg: 'success' } }))
    .toBe('code=MISS message=request failed log_id=MISS')
  expect(formatFeishuError({ code: 300121, msg: 'original rejection', log_id: 'original-log', data: envelope.data }))
    .toBe('code=300121 message=original rejection log_id=original-log')
})

test('native Headers and plain case-insensitive SDK headers expose all supported request IDs', () => {
  for (const name of ['x-tt-logid', 'x-request-id', 'request-id']) {
    for (const headers of [new Headers({ [name]: 'request-log' }), { [name.toUpperCase()]: 'request-log' }]) {
      expect(feishuErrorDetails({ response: { headers } }).logId).toBe('request-log')
      expect(feishuErrorDetails({ headers }).logId).toBe('request-log')
    }
  }
  expect(feishuErrorDetails({ response: { headers: new Headers({ 'X-Ogw-Ratelimit-Reset': '4' }) } }).retryAfter).toBe('4')
})

test('missing diagnostics are explicit and zero remains a valid returned code', () => {
  expect(formatFeishuError(null)).toBe('code=MISS message=MISS log_id=MISS')
  expect(formatFeishuError({ code: 0, msg: '', log_id: '' })).toBe('code=0 message=MISS log_id=MISS')
  expect(formatFeishuError(new Error('connection reset'))).toBe('code=MISS message=connection reset log_id=MISS')
  expect(formatFeishuError('request cancelled')).toBe('code=MISS message=request cancelled log_id=MISS')
})

test('normalized errors retain apiMessage and never serialize SDK request credentials', () => {
  const failure = Object.assign(new Error('operation code=300121 message=wrong log_id=wrong'), {
    apiMessage: 'original rejection', code: 300121, logId: 'original-log',
    config: { headers: { Authorization: 'Bearer secret-token' }, data: 'private file contents' },
    toJSON() { throw new Error('SDK errors must not be serialized') },
  })
  expect(formatFeishuError(failure)).toBe('code=300121 message=original rejection log_id=original-log')
  expect(formatFeishuError({ config: failure.config })).toBe('code=MISS message=MISS log_id=MISS')
})
