import { describe, expect, test } from 'bun:test'
import { FEISHU_API_BASE, LARK_API_BASE, apiBaseFor, consoleBaseFor, normalizeDomain, openApiBaseFor } from './feishu-endpoint'

describe('feishu endpoint selection', () => {
  test('omitted or named feishu keeps the historical mainland base', () => {
    expect(apiBaseFor(undefined)).toBe(FEISHU_API_BASE)
    expect(apiBaseFor('feishu')).toBe(FEISHU_API_BASE)
    expect(openApiBaseFor(undefined)).toBe('https://open.feishu.cn/open-apis')
    expect(openApiBaseFor('feishu')).toBe('https://open.feishu.cn/open-apis')
    expect(consoleBaseFor(undefined)).toBe('https://open.feishu.cn')
  })

  test('lark selects the international base', () => {
    expect(apiBaseFor('lark')).toBe(LARK_API_BASE)
    expect(openApiBaseFor('lark')).toBe('https://open.larksuite.com/open-apis')
    expect(consoleBaseFor('lark')).toBe('https://open.larksuite.com')
  })

  test('custom origins are used verbatim after normalization', () => {
    expect(normalizeDomain('https://open.example.com/')).toBe('https://open.example.com')
    expect(apiBaseFor('https://open.example.com')).toBe('https://open.example.com')
    expect(openApiBaseFor('https://open.example.com')).toBe('https://open.example.com/open-apis')
    expect(consoleBaseFor('https://open.example.com')).toBe('https://open.example.com')
  })

  test('normalizes named regions and rejects malformed values', () => {
    expect(normalizeDomain(undefined)).toBeUndefined()
    expect(normalizeDomain(' feishu ')).toBe('feishu')
    expect(normalizeDomain('lark')).toBe('lark')
    expect(() => normalizeDomain('')).toThrow('[feishu].domain')
    expect(() => normalizeDomain('http://open.example.com')).toThrow('https origin')
    expect(() => normalizeDomain('https://open.example.com/api')).toThrow('https origin')
    expect(() => normalizeDomain('https://user:pass@open.example.com')).toThrow('https origin')
    expect(() => normalizeDomain('https://open.example.com?x=1')).toThrow('https origin')
    expect(() => normalizeDomain('not a url')).toThrow('not a valid URL')
  })
})
