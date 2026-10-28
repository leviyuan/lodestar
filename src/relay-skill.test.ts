import { expect, test } from 'bun:test'
import { relaySkillBody } from './relay-skill'

test('relay-config Skill documents live Agent validation and hot reload', () => {
  const body = relaySkillBody()
  expect(body).toContain('name: relay-config')
  expect(body).toContain('/agents/relays/test')
  expect(body).toContain('/agents/relays/configure')
  expect(body).toContain('/agents/relays/reload')
  expect(body).toContain('api.zhongzhuan.win')
  expect(body).toContain('aicost.me')
  expect(body).toContain('yatui.cc')
  expect(body).not.toContain('sk-')
})
