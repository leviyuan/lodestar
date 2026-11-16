import { expect, test } from 'bun:test'
import { feishuErrorDetails, formatFeishuError, redactMemberIds } from './feishu-errors'

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

test('member IDs echoed in a Feishu rejection are removed while code, reason and log_id stay', () => {
  expect(redactMemberIds(
    'feishu chat.create failed code=232043 message=Your request contains unavailable ids, ext=bot is invisible to user ids: [ou_7d8a6e6df7621556ce0d21922b676706] log_id=20261116ABCDEF',
  )).toBe(
    'feishu chat.create failed code=232043 message=Your request contains unavailable ids, ext=bot is invisible to user ids: […] log_id=20261116ABCDEF',
  )
  expect(redactMemberIds('code=232028 message=External members can Not be added, invalid ids: [ou_a, on_b, 5d9bd123] log_id=x'))
    .toBe('code=232028 message=External members can Not be added, invalid ids: […] log_id=x')
  expect(redactMemberIds('rejected user_id: 5d9bd123, open_id=ou_abc; union id：on_def)'))
    .toBe('rejected user_id: …, open_id=…; union id：…)')
  // 单独出现的 ID 按真实形态识别：ou_/on_ 加 32 位小写十六进制。
  const openId = 'ou_7d8a6e6df7621556ce0d21922b676706'
  const unionId = 'on_0123456789abcdef0123456789abcdef'
  expect(redactMemberIds(`member ${openId} and ${unionId} left`)).toBe('member … and … left')
  expect(redactMemberIds(`invisible: ${openId},${unionId}.`)).toBe('invisible: …,….')
  expect(redactMemberIds(`ids: [${openId}, ${unionId}]`)).toBe('ids: […]')
})

test('member ID redaction leaves chat, message and log identifiers and ordinary words alone', () => {
  const text = 'refusing to delete chat oc_123: log_id=20261116ou_x message_id=om_1 button_click union_id_list chat_id=oc_9'
  expect(redactMemberIds(text)).toBe(text)
  expect(redactMemberIds('建临时会话失败: temporary group name already exists: project*修复登录')).toBe(
    '建临时会话失败: temporary group name already exists: project*修复登录',
  )
  // 像 ID 前缀的普通文本（备注、群名、路径）不能被改写。
  for (const ordinary of [
    'on_call',
    'project*on_call',
    'temporary group name already exists: project*on_call',
    '/work/on_call/x',
    'cannot open /work/ou_reports/2026/summary.md',
    'ou_short and on_duty_rotation_2026',
  ]) {
    expect(redactMemberIds(ordinary)).toBe(ordinary)
  }
})
