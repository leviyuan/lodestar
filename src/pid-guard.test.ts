import { expect, spyOn, test } from 'bun:test'

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
  let stat = '12345 (bun) S 1 12345 12345 0 -1 4194304 0 0'
  let emptyCommandReads = 0
  let commandReads = 0
  const executions = []
  const realpaths = {}
  const originalRead = fs.readFileSync
  const realpath = path => { if (path in realpaths) return realpaths[path]; throw enoent() }
  mock.module('node:fs', () => ({ ...fs,
    realpathSync: Object.assign(realpath, { native: realpath }),
    readFileSync(path, ...args) {
      if (path === '/test/pid') { if (fileError) throw fileError; return raw }
      if (String(path).startsWith('/proc/')) {
        if (commandError) throw commandError
        if (String(path).endsWith('/stat')) return stat
        commandReads++
        return emptyCommandReads-- > 0 ? '' : command
      }
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
    // 另一用户的进程：探测被拒绝只说明进程存在，仍按命令行判断是否为 daemon。
    probeError = Object.assign(new Error('probe denied'), { code: 'EPERM' })
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    command = '/usr/sbin/sshd\\0-D\\0'
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'continue' })
    commandError = Object.assign(new Error('cmdline permission denied'), { code: 'EACCES' })
    assert.throws(() => checkPidGuard('/test/pid'), /cmdline permission denied/)
    commandError = undefined
    command = 'bun\\0/project/daemon.ts\\0'
    raw = '12345'
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    probeError = Object.assign(new Error('probe failed'), { code: 'EINVAL' })
    assert.throws(() => checkPidGuard('/test/pid'), /probe failed/)
    probeError = undefined
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    for (const invalid of ['', '12345junk', '123.5', '-1', '0', '2147483648']) {
      raw = invalid + '\\n/project/daemon.ts'
      assert.equal(parseDaemonPid(invalid), null)
      assert.throws(() => checkPidGuard('/test/pid'), /PID 文件格式坏/)
    }
  `)
})

test('Linux PID guard treats zombies and kernel threads as absent and rereads a command line caught mid-exec', () => {
  runScript(fixture + `
    // 僵尸进程与内核线程没有命令行，不可能是 daemon，也不应阻止启动或让停止流程报错。
    emptyCommandReads = Infinity
    stat = '12345 (node) Z 1 12345 12345 0 -1 4228100 0 0'
    assert.equal(isOurDaemon(12345, '/project/daemon.ts'), false)
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'continue' })
    stat = '12345 (kworker/0:1 (x)) I 2 0 0 0 -1 69238880 0 0'
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'continue' })

    // exec 切换瞬间读到的空值在重读后恢复，按真实入口判断。
    stat = '12345 (bun) R 1 12345 12345 0 -1 4194304 0 0'
    emptyCommandReads = 2
    commandReads = 0
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    assert.equal(commandReads, 3)

    // 始终读不到命令行的普通进程仍无法核对身份，必须报错而不是放行。
    emptyCommandReads = Infinity
    commandReads = 0
    assert.throws(() => checkPidGuard('/test/pid'), /命令行为空/)
    assert.equal(commandReads, 5)
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

test('the same entry file reached through a symlink or a versioned runtime is recognized on every platform', () => {
  runScript(fixture + `
    // Bun records the resolved entry; ps, /proc and Windows show the path the daemon was started with.
    realpaths['/link/daemon.ts'] = '/real/daemon.ts'
    realpaths['/real/daemon.ts'] = '/real/daemon.ts'
    command = 'bun\\0/link/daemon.ts\\0'
    assert.equal(isOurDaemon(12345, '/real/daemon.ts'), true)
    // Keeps the PID guard's direction: the running daemon still blocks a second one.
    raw = '12345\\n/real/daemon.ts'
    assert.deepEqual(checkPidGuard('/test/pid'), { state: 'exit', pid: 12345 })
    realpaths['/link/daemon.ts'] = '/real/other.ts'
    assert.equal(isOurDaemon(12345, '/real/daemon.ts'), false)
    delete realpaths['/link/daemon.ts']
    // An unresolvable path proves nothing: only a literal match counts.
    assert.equal(isOurDaemon(12345, '/real/daemon.ts'), false)
    for (const runtime of ['node-22', 'node22', 'nodejs-22', 'node-v22.19.0', 'bun-1.3.11', '/opt/node-22/bin/node22']) {
      command = runtime + '\\0/project/daemon.ts\\0'
      assert.equal(isOurDaemon(12345, '/project/daemon.ts'), true, runtime)
    }
    for (const runtime of ['nodemon', 'nodenv', 'bunx']) {
      command = runtime + '\\0/project/daemon.ts\\0'
      assert.equal(isOurDaemon(12345, '/project/daemon.ts'), false, runtime)
    }
    platform('darwin')
    realpaths['/link/daemon.ts'] = '/real/daemon.ts'
    command = '/usr/local/bin/node-22 /link/daemon.ts'
    assert.equal(isOurDaemon(12345, '/real/daemon.ts'), true)
    platform('win32')
    realpaths['C:/Link/lodestar.js'] = 'C:\\\\Real\\\\lodestar.js'
    realpaths['C:/Real/lodestar.js'] = 'C:\\\\real\\\\Lodestar.js'
    command = '"C:/nodejs/node.exe" "C:/Link/lodestar.js"'
    assert.equal(isOurDaemon(12345, 'C:/Real/lodestar.js'), true)
  `)
})

test.skipIf(process.platform === 'win32')('a real Bun process started through a symlinked directory matches its resolved entry', () => {
  runScript(`
    import assert from 'node:assert/strict'
    import { spawn } from 'node:child_process'
    import { once } from 'node:events'
    import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { isOurDaemon } from './src/pid-guard'
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lodestar-pid-link-')))
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'daemon.js'), "console.log(process.argv[1]); setTimeout(() => {}, 30000)")
    symlinkSync(join(dir, 'real'), join(dir, 'linked'), 'dir')
    const child = spawn(process.execPath, [join(dir, 'linked', 'daemon.js')], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const [stdout] = await once(child.stdout, 'data')
      // The marker a Bun daemon writes for itself is its resolved entry.
      const marker = stdout.toString().trim()
      assert.equal(marker, join(dir, 'real', 'daemon.js'))
      assert.equal(isOurDaemon(child.pid, marker), true)
    } finally { child.kill(); rmSync(dir, { recursive: true, force: true }) }
  `)
})

test('a live process keeps one start identity while the wall clock steps; none without the process', async () => {
  const { processStartId, sameProcessStart } = await import('./pid-guard')
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 30000)'])
  const clock = spyOn(Date, 'now')
  try {
    await Bun.sleep(200)
    const first = await processStartId(child.pid)
    expect(first).not.toBeNull()
    // The identity is the process's own start record, not a time derived from Date.now.
    const real = Date.now()
    for (const step of [30_000, -30_000]) {
      clock.mockReturnValue(real + step)
      const again = await processStartId(child.pid)
      expect(again).not.toBeNull()
      expect(sameProcessStart(again!, first!)).toBe(true)
    }
    clock.mockRestore()
    // A process started long before (PID 1 at boot) has another identity.
    if (process.platform !== 'win32') expect(sameProcessStart(await processStartId(1) ?? 'linux:0', first!)).toBe(false)
  } finally {
    clock.mockRestore()
    child.kill()
    await child.exited
  }
  expect(await processStartId(child.pid)).toBeNull()
  expect(await processStartId(0)).toBeNull()
})

test('start identities compare exactly on Linux and within a second where they are clock times', async () => {
  const { sameProcessStart } = await import('./pid-guard')
  expect(sameProcessStart('linux:98765', 'linux:98765')).toBe(true)
  expect(sameProcessStart('linux:98765', 'linux:98766')).toBe(false)
  expect(sameProcessStart('darwin:1795832636000', 'darwin:1795832637000')).toBe(true)
  expect(sameProcessStart('darwin:1795832636000', 'darwin:1795832638000')).toBe(false)
  expect(sameProcessStart('win32:1795832636123', 'win32:1795832636999')).toBe(true)
  expect(sameProcessStart('linux:98765', 'darwin:98765')).toBe(false)
  expect(sameProcessStart('linux:98765', 'linux:')).toBe(false)
  expect(sameProcessStart('', '')).toBe(false)
})

test('Linux start identity is the raw starttime, unchanged by a wall-clock step while the lock is held', async () => {
  const { linuxStartId, sameProcessStart } = await import('./pid-guard')
  // The holder started 987.65 s after boot; its /proc record never changes, whatever the wall
  // clock does afterwards (the earlier wall-clock conversion moved with a 30-second step).
  const stat = '4321 (bun (x) y) S 1 4321 4321 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 12345678 99 0\n'
  const clock = spyOn(Date, 'now')
  try {
    clock.mockReturnValue(1_795_832_636_000)
    const recorded = linuxStartId(stat)
    clock.mockReturnValue(1_795_832_636_000 + 50_000)
    const later = linuxStartId(stat)
    expect(recorded).toBe('linux:98765')
    expect(sameProcessStart(later!, recorded!)).toBe(true)
  } finally { clock.mockRestore() }
  // Another process that got PID 4321 has a different start.
  expect(sameProcessStart(linuxStartId(stat.replace(' 98765 ', ' 412345 '))!, 'linux:98765')).toBe(false)
  expect(linuxStartId('4321 (bun) S 1')).toBeNull()
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
