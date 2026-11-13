import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { sync } from 'cross-spawn'
import { isCodexChatGPTLoggedIn } from './setup'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

test('the Codex login probe passes the binary path as one argument without a shell', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('Logged in using ChatGPT\n'), pid: 1, output: [], signal: null }
  }) as unknown as typeof sync
  const bin = 'C:\\Program Files\\Lodestar Runtimes\\codex.cmd'
  expect(isCodexChatGPTLoggedIn(bin, run)).toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0].command).toBe(bin)
  expect(calls[0].args).toEqual(['login', 'status'])
  expect(calls[0].options.shell).toBeUndefined()
  expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
})

test.skipIf(process.platform === 'win32')('a real executable under a path with spaces is probed and its exit status respected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lodestar setup test '))
  temporary.push(root)
  const dir = join(root, 'runtime dir')
  await mkdir(dir)
  const loggedIn = join(dir, 'codex in')
  const loggedInStdout = join(dir, 'codex in stdout')
  const loggedOut = join(dir, 'codex out')
  const notLoggedIn = join(dir, 'codex none')
  // The installed Codex writes the status line to stderr; older builds wrote it to stdout.
  await writeFile(loggedIn, '#!/bin/sh\necho "Logged in using ChatGPT" >&2\n')
  await writeFile(loggedInStdout, '#!/bin/sh\necho "Logged in using ChatGPT"\n')
  await writeFile(loggedOut, '#!/bin/sh\necho "Logged in using ChatGPT" >&2\nexit 1\n')
  await writeFile(notLoggedIn, '#!/bin/sh\necho "Not logged in" >&2\n')
  for (const file of [loggedIn, loggedInStdout, loggedOut, notLoggedIn]) await chmod(file, 0o755)
  expect(isCodexChatGPTLoggedIn(loggedIn)).toBe(true)
  expect(isCodexChatGPTLoggedIn(loggedInStdout)).toBe(true)
  expect(isCodexChatGPTLoggedIn(notLoggedIn)).toBe(false)
  expect(isCodexChatGPTLoggedIn(loggedOut)).toBe(false)
  expect(isCodexChatGPTLoggedIn(join(dir, 'missing'))).toBe(false)
})
