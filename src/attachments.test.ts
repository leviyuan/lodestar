import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentDir, pruneStaleAttachmentDirs, removeAttachmentDir } from './attachments'
import { DATA_DIR } from './paths'

const extra: string[] = []

afterAll(() => {
  removeAttachmentDir()
  for (const path of extra) { try { rmSync(path, { recursive: true, force: true }) } catch {} }
})

describe('inbound attachment storage', () => {
  test('is private and outside the daemon data directory', () => {
    const dir = attachmentDir()
    expect(existsSync(dir)).toBe(true)
    expect(dir.startsWith(DATA_DIR)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('the directory is stable for the process and removed on shutdown', () => {
    const dir = attachmentDir()
    expect(attachmentDir()).toBe(dir)
    removeAttachmentDir()
    expect(existsSync(dir)).toBe(false)
    expect(attachmentDir()).not.toBe(dir)
  })

  test('prunes only stale attachment directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-attachments-'))
    extra.push(root)
    const recent = mkdtempSync(join(tmpdir(), 'lodestar-attachments-'))
    extra.push(recent)
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    utimesSync(root, old, old)
    expect(pruneStaleAttachmentDirs()).toBeGreaterThanOrEqual(1)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('never creates the attachment directory inside the data dir', () => {
    mkdirSync(DATA_DIR, { recursive: true })
    expect(attachmentDir().startsWith(join(DATA_DIR, ''))).toBe(false)
  })
})
