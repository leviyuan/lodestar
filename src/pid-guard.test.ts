import { expect, test } from 'bun:test'

function runScript(script: string): void {
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}

const fixture = `
  import assert from 'node:assert/strict'
  import * as fs from 'node:fs'
  import * as cp from 'node:child_process'
  import { mock } from 'bun:test'
  const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' })
  let raw = '12345\\n/project/daemon.ts'
  let command = 'bun\\0/project/daemon.ts\\0'
  let cwd = '/project'
  let fileError, commandError, probeError
  const executions = []
  const originalRead = fs.readFileSync
  mock.module('node:fs', () => ({ ...fs,
    readFileSync(path, ...args) {
      if (path === '/test/pid') { if (fileError) throw fileError; return raw }
      if (String(path).startsWith('/proc/')) { if (commandError) throw commandError; return command }
      return originalRead(path, ...args)
    },
    readlinkSync() { return cwd },
  }))
  mock.module('node:child_process', () => ({ ...cp,
    execFileSync(bin, args) { executions.push([bin, args]); if (commandError) throw commandError; return command },
  }))
  process.kill = (pid, signal) => { assert.equal(signal, 0); if (probeError) throw probeError; return true }
  const platform = value => Object.defineProperty(process, 'platform', { value, configurable: true })
  platform('linux')
  const { checkPidGuard, isOurDaemon, parseDaemonPid } = await import('./src/pid-guard')
`

test('PID guard distinguishes absence from unreadable records and process inspection failures', () => {
  runScript(fixture + `
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    fileError = enoent()
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'continue' })
    fileError = Object.assign(new Error('PID permission denied'), { code: 'EACCES' })
    assert.throws(() => checkPidGuard('/test/pid'), /PID permission denied/)
    fileError = undefined
    commandError = Object.assign(new Error('cmdline permission denied'), { code: 'EACCES' })
    assert.throws(() => checkPidGuard('/test/pid'), /cmdline permission denied/)
    commandError = enoent()
    assert.throws(() => checkPidGuard('/test/pid'), /not found/)
    probeError = Object.assign(new Error('gone'), { code: 'ESRCH' })
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'continue' })
    commandError = undefined
    probeError = Object.assign(new Error('probe denied'), { code: 'EPERM' })
    assert.throws(() => checkPidGuard('/test/pid'), /probe denied/)
    raw = '12345'
    assert.throws(() => checkPidGuard('/test/pid'), /probe denied/)
    probeError = undefined
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    for (const invalid of ['', '12345junk', '123.5', '-1', '0', '2147483648']) {
      raw = invalid + '\\n/project/daemon.ts'
      assert.equal(parseDaemonPid(invalid), null)
      assert.throws(() => checkPidGuard('/test/pid'), /PID 文件格式坏/)
    }
  `)
})

test('Linux PID guard recognizes relative entries without matching recycled PID arguments or prefixes', () => {
  runScript(fixture + `
    for (const args of [
      ['bun', 'daemon.ts'], ['bun', 'run', './daemon.ts'],
      ['node', '--require', '/preload.js', '/project/daemon.ts'],
    ]) {
      command = args.join('\\0') + '\\0'
      assert.equal(isOurDaemon(12345, '/project/daemon.ts'), true, args.join(' '))
    }
    command = ['bun', '/project with spaces/daemon.ts'].join('\\0') + '\\0'
    assert.equal(isOurDaemon(12345, '/project with spaces/daemon.ts'), true)
    for (const args of [
      ['node', '/project/daemon.ts.backup'], ['node', '/other.js', '/project/daemon.ts'],
      ['bash', '/project/daemon.ts'], ['node', '-e', 'setInterval(() => {}, 1000)', '/project/daemon.ts'],
      ['node', '-esetInterval(() => {}, 1000)', '/project/daemon.ts'],
      ['node', '-p1', '/project/daemon.ts'], ['node', '-pe1', '/project/daemon.ts'],
      ['node', '-c', '-', '/project/daemon.ts'], ['node', '--check', '-', '/project/daemon.ts'],
      ['node', '--run=script', '/project/daemon.ts'], ['node', '--run', 'script', '/project/daemon.ts'],
      ['node', '--watch-path', '/project/daemon.ts', '/other.js'], ['bun', 'run', 'run', '/project/daemon.ts'],
      ['node', '--eval=setInterval(() => {}, 1000)', '/project/daemon.ts'],
    ]) {
      command = args.join('\\0') + '\\0'
      assert.equal(isOurDaemon(12345, '/project/daemon.ts'), false, args.join(' '))
    }
    command = 'bun\\0daemon.ts\\0'
    cwd = '/different-project'
    assert.equal(isOurDaemon(12345, '/project/daemon.ts'), false)
    command = 'node\\0--future-option\\0/project/daemon.ts\\0/other.js\\0'
    assert.throws(() => isOurDaemon(12345, '/project/daemon.ts'), /未识别.*--future-option/)
  `)
})

test('macOS and Windows command queries surface failures and preserve entry boundaries', () => {
  runScript(fixture + `
    platform('darwin')
    command = '/usr/local/bin/node /project/daemon.ts'
    assert.equal(isOurDaemon(12345, '/project/daemon.ts'), true)
    command = '/usr/local/bin/node /project/daemon.ts.old'
    assert.equal(isOurDaemon(12345, '/project/daemon.ts'), false)
    command = '/usr/local/bin/node /project with spaces/daemon.ts'
    assert.throws(() => isOurDaemon(12345, '/project with spaces/daemon.ts'), /无法区分的空格/)
    commandError = new Error('ps timed out')
    assert.throws(() => isOurDaemon(12345, '/project/daemon.ts'), /ps timed out/)
    commandError = undefined
    platform('win32')
    const marker = 'C:/Program Files/Lodestar/lodestar.js'
    command = '"C:/Program Files/nodejs/node.exe" "c:/program files/lodestar/lodestar.js"'
    assert.equal(isOurDaemon(12345, marker), true)
    command = 'node.exe C:/other.js "' + marker + '"'
    assert.equal(isOurDaemon(12345, marker), false)
    command = 'node.exe "' + marker + '.backup"'
    assert.equal(isOurDaemon(12345, marker), false)
    command = ''
    assert.throws(() => isOurDaemon(12345, marker), /命令行为空/)
    commandError = new Error('CIM access denied')
    assert.throws(() => isOurDaemon(12345, marker), /CIM access denied/)
    assert.ok(executions.find(([bin, args]) => bin === 'powershell' && args.at(-1).includes('-ErrorAction Stop')))
  `)
})

test.skipIf(process.platform !== 'linux')('real Linux process entries distinguish relative scripts from stdin syntax checks', () => {
  runScript(`
    import assert from 'node:assert/strict'
    import { spawn } from 'node:child_process'
    import { once } from 'node:events'
    import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { isOurDaemon } from './src/pid-guard'
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-pid-real-'))
    const marker = join(dir, 'daemon.js')
    writeFileSync(marker, "#!/usr/bin/env node\\nconsole.log(process.argv[1]); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))")
    chmodSync(marker, 0o755)
    mkdirSync(join(dir, '.bin'))
    const binMarker = join(dir, '.bin', 'lodestar-daemon')
    symlinkSync('../daemon.js', binMarker)
    try {
      for (const [binary, args, expectedMarker, expected] of [
        ['node', ['daemon.js'], marker, true],
        ['node', ['-c', '-', marker], marker, false],
        ['./.bin/lodestar-daemon', [], binMarker, true],
      ]) {
        const child = spawn(binary, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
        await once(child, 'spawn')
        const exited = once(child, 'exit')
        try {
          if (expected) {
            const [stdout] = await once(child.stdout, 'data')
            assert.equal(stdout.toString().trim(), expectedMarker)
          }
          assert.equal(isOurDaemon(child.pid, expectedMarker), expected)
        }
        finally { child.stdin.end('const value = 1;\\n'); await exited }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  `)
})
