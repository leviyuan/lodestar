import { describe, expect, test } from 'bun:test'

import { diagnosticIdLabel } from './session-util'

describe('diagnosticIdLabel', () => {
  test('distinguishes concurrent UUIDv7 ids that share the timestamp prefix', () => {
    const first = '0198d6fa-1234-7000-8000-000000000001'
    const second = '0198d6fa-1234-7000-8000-000000000002'

    // First 8 hex = timestamp high bits: identical for every session created
    // within the same ~65s, so it cannot tell a source and its fork apart.
    expect(first.slice(0, 8)).toBe(second.slice(0, 8))
    expect(diagnosticIdLabel(first)).toBe('…000001')
    expect(diagnosticIdLabel(second)).toBe('…000002')
  })

  test('keeps the distinguishing tail for backend-native random ids', () => {
    expect(diagnosticIdLabel('424f8d9e-a2fc-4e27-a042-0c043a1e370e')).toBe('…1e370e')
  })

  test('does not pad short opaque ids', () => {
    expect(diagnosticIdLabel('short-id')).toBe('short-id')
  })
})
