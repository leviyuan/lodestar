import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ATTACHMENT_RETENTION_MS, attachmentDir, pruneStaleAttachmentDirs, removeAttachmentDir } from './attachments'
import { DATA_DIR } from './paths'

const extra: string[] = []

afterAll(() => {
  removeAttachmentDir()
  for (const path of extra) { try { rmSync(path, { recursive: true, force: true }) } catch {} }
})

function age(path: string, ms: number): void {
  const at = new Date(Date.now() - ms)
  utimesSync(path, at, at)
}

describe('inbound attachment storage', () => {
  test('tests only see a private temp root, never the system temp dir shared with the live daemon', () => {
    // test-preload points TMPDIR at <system temp>/lodestar-test-*/tmp, removed at exit.
    expect(basename(tmpdir())).toBe('tmp')
    expect(basename(dirname(tmpdir()))).toStartWith('lodestar-test-')
    expect(attachmentDir().startsWith(join(tmpdir(), ''))).toBe(true)
  })

  test('is private and outside the daemon data directory', () => {
    const dir = attachmentDir()
    expect(existsSync(dir)).toBe(true)
    expect(dir.startsWith(DATA_DIR)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('the directory is stable for the process and kept with its files at shutdown', () => {
    const dir = attachmentDir()
    expect(attachmentDir()).toBe(dir)
    const file = join(dir, 'received.txt')
    writeFileSync(file, 'bytes')
    // A restarted daemon resumes sessions whose history still names this file.
    removeAttachmentDir()
    expect(existsSync(file)).toBe(true)
    extra.push(dir)
    expect(attachmentDir()).not.toBe(dir)
  })

  test('a vanished directory is replaced by a new private one, not recreated at the old path', () => {
    const dir = attachmentDir()
    rmSync(dir, { recursive: true, force: true })
    const next = attachmentDir()
    expect(next).not.toBe(dir)
    expect(existsSync(next)).toBe(true)
  })

  test('prunes by age: stale directories, then expired files in active ones, keeping the current directory', () => {
    const stale = mkdtempSync(join(tmpdir(), 'lodestar-attachments-'))
    const active = mkdtempSync(join(tmpdir(), 'lodestar-attachments-'))
    extra.push(stale, active)
    writeFileSync(join(stale, 'old.txt'), 'old')
    writeFileSync(join(active, 'old.txt'), 'old')
    writeFileSync(join(active, 'new.txt'), 'new')
    const current = attachmentDir()
    writeFileSync(join(current, 'old.txt'), 'old')
    writeFileSync(join(current, 'new.txt'), 'new')
    const expired = ATTACHMENT_RETENTION_MS + 60_000
    age(join(stale, 'old.txt'), expired); age(stale, expired)
    age(join(active, 'old.txt'), expired)
    age(join(current, 'old.txt'), expired); age(current, expired)
    // Six days old is still within the 7-day retention.
    const recent = mkdtempSync(join(tmpdir(), 'lodestar-attachments-'))
    extra.push(recent)
    age(recent, 6 * 24 * 60 * 60_000)

    expect(pruneStaleAttachmentDirs()).toBe(3)
    expect(existsSync(stale)).toBe(false)
    expect(readdirSync(active)).toEqual(['new.txt'])
    expect(readdirSync(current)).toEqual(['new.txt'])
    expect(existsSync(recent)).toBe(true)
    expect(attachmentDir()).toBe(current)
  })

  test('never creates the attachment directory inside the data dir', () => {
    mkdirSync(DATA_DIR, { recursive: true })
    expect(attachmentDir().startsWith(join(DATA_DIR, ''))).toBe(false)
  })
})
