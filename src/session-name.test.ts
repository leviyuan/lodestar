import { describe, expect, test } from 'bun:test'
import { mainSessionName, normalizeTempRole, stripTempSuffix, tempProjectName } from './session-name'

describe('temporary-session name suffixes', () => {
  test('strips time-stamped and role-named BTW suffixes', () => {
    expect(stripTempSuffix('project')).toBe('project')
    expect(stripTempSuffix('project[feature]')).toBe('project[feature]')
    expect(stripTempSuffix('project*0821-1337')).toBe('project')
    expect(stripTempSuffix('project*0821-1337-2')).toBe('project')
    expect(stripTempSuffix('project*修复登录')).toBe('project')
    expect(stripTempSuffix('project*修复登录-2')).toBe('project')
    expect(stripTempSuffix('project[feature]*修复登录')).toBe('project[feature]')
    expect(stripTempSuffix('project[feature]*0821-1337')).toBe('project[feature]')
    expect(stripTempSuffix('project*a*b')).toBe('project')
    expect(stripTempSuffix('project*')).toBe('project*')
  })

  test('resolves temp project and main session names', () => {
    expect(tempProjectName('project')).toBeNull()
    expect(tempProjectName('project[feature]')).toBeNull()
    expect(tempProjectName('project*0821-1337')).toBe('project')
    expect(tempProjectName('project*修复登录')).toBe('project')
    expect(tempProjectName('project*修复登录-2')).toBe('project')
    expect(tempProjectName('project[feature]*修复登录')).toBe('project[feature]')

    expect(mainSessionName('project')).toBe('project')
    expect(mainSessionName('project[feature]')).toBe('project')
    expect(mainSessionName('project*0821-1337')).toBe('project')
    expect(mainSessionName('project*修复登录')).toBe('project')
    expect(mainSessionName('project[feature]*修复登录')).toBe('project')
  })
})

describe('btw role normalization', () => {
  test('keeps characters that survive sanitizeSessionName', () => {
    expect(normalizeTempRole(' 修复 登录 ')).toBe('修复_登录')
    expect(normalizeTempRole('fix-login_2')).toBe('fix-login_2')
    expect(normalizeTempRole('前端/接口')).toBe('前端_接口')
  })

  test('removes reserved suffix markers and unsupported characters', () => {
    expect(normalizeTempRole('fix*[login]')).toBe('fix_login')
    expect(normalizeTempRole('*[a]*')).toBe('a')
    expect(normalizeTempRole('🚀')).toBe('')
    expect(normalizeTempRole('---')).toBe('')
    expect(normalizeTempRole('')).toBe('')
  })

  test('caps the suffix length and trims separators after truncation', () => {
    expect(normalizeTempRole('a'.repeat(40))).toBe('a'.repeat(32))
    expect(normalizeTempRole(`${'a'.repeat(31)}-tail`)).toBe('a'.repeat(31))
    expect(normalizeTempRole(`a${' '.repeat(4)}b`)).toBe('a_b')
  })
})
