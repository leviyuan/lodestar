import { expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const postinstall = fileURLToPath(new URL('../scripts/postinstall.cjs', import.meta.url))

function fixture(profile: 'default' | 'xdg' | 'override') {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-postinstall-'))
  const localData = join(root, 'local-data')
  const xdgData = join(root, 'xdg-data')
  const dataDir = profile === 'override' ? join(root, 'custom-state')
    : profile === 'xdg' ? join(xdgData, 'lodestar')
      : process.platform === 'win32' ? join(localData, 'Lodestar')
        : join(root, '.local', 'share', 'lodestar')
  const skillRoots = [
    join(root, '.codex', 'skills'),
    join(root, '.claude', 'skills'),
    join(dataDir, 'managed-claude-plugin', 'skills'),
  ]
  for (const skillRoot of skillRoots) {
    mkdirSync(join(skillRoot, 'lodestar-files'), { recursive: true })
    writeFileSync(join(skillRoot, 'lodestar-files', 'SKILL.md'), '---\nname: lodestar-files\n---\n')
    mkdirSync(join(skillRoot, 'lodestar-agent'))
    writeFileSync(join(skillRoot, 'lodestar-agent', 'SKILL.md'), 'active skill\n')
  }
  // Override homedir inside this child only; never modify the user's HOME or skills.
  const preload = join(root, 'isolate-home.cjs')
  writeFileSync(preload, "require('node:os').homedir = () => process.env.LODESTAR_TEST_SKILL_HOME\n")
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    LODESTAR_TEST_SKILL_HOME: root,
    CODEX_HOME: join(root, '.codex'),
    LODESTAR_DATA_DIR: profile === 'override' ? dataDir : '',
    XDG_DATA_HOME: profile === 'default' ? '' : xdgData,
    LOCALAPPDATA: localData,
    LODESTAR_DISABLE_SKILL_SYNC: '0',
  }
  return {
    root, skillRoots, dataDir,
    run: (disabled = false) => Bun.spawnSync(['node', '--require', preload, postinstall], {
      cwd: root,
      env: { ...env, LODESTAR_DISABLE_SKILL_SYNC: disabled ? '1' : '0' },
      stdout: 'pipe', stderr: 'pipe',
    }),
  }
}

test.each(['default', 'xdg', 'override'] as const)('npm postinstall removes old file Skills using %s paths without a daemon or build', profile => {
  const f = fixture(profile)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run()
      if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
      for (const root of f.skillRoots) {
        expect(existsSync(join(root, 'lodestar-files'))).toBe(false)
        expect(readFileSync(join(root, 'lodestar-agent', 'SKILL.md'), 'utf8')).toBe('active skill\n')
      }
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('npm postinstall reports cleanup failures, exits nonzero and still cleans independent roots', () => {
  const f = fixture('override')
  try {
    const broken = join(f.skillRoots[0], 'lodestar-files', 'SKILL.md')
    rmSync(broken)
    mkdirSync(broken)
    const result = f.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Lodestar 安装清理失败')
    expect(result.stderr.toString()).toContain(broken)
    expect(result.stdout.toString()).not.toContain('✓ Lodestar 已安装')
    expect(existsSync(broken)).toBe(true)
    for (const root of f.skillRoots.slice(1)) expect(existsSync(join(root, 'lodestar-files'))).toBe(false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('npm postinstall honors an explicit managed Skill sync opt-out', () => {
  const f = fixture('override')
  try {
    const result = f.run(true)
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString())
    for (const root of f.skillRoots) expect(existsSync(join(root, 'lodestar-files', 'SKILL.md'))).toBe(true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test.each(['default', 'xdg', 'override'] as const)('npm postinstall migrates old Codex plugin links using %s paths', profile => {
  const f = fixture(profile)
  try {
    const source = join(f.root, '.codex', 'plugins')
    const home = join(f.dataDir, 'codex-accounts', '11111111-1111-4111-8111-111111111111')
    mkdirSync(source, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(source, 'cached-plugin'), 'cached bytes')
    symlinkSync(source, join(home, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
    // Skill sync opt-out must not leave the old destructive cache sharing in place.
    const result = f.run(true)
    expect(result.exitCode).toBe(0)
    expect(lstatSync(join(home, 'plugins')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(home, 'plugins', 'cached-plugin'), 'utf8')).toBe('cached bytes')
    rmSync(join(home, 'plugins', 'cached-plugin'))
    expect(readFileSync(join(source, 'cached-plugin'), 'utf8')).toBe('cached bytes')
    expect(f.run().exitCode).toBe(0)
    expect(existsSync(join(home, 'plugins', 'cached-plugin'))).toBe(false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('npm postinstall rejects unknown plugin links instead of announcing successful installation', () => {
  const f = fixture('override')
  try {
    const foreign = join(f.root, 'foreign')
    const home = join(f.dataDir, 'codex-accounts', '11111111-1111-4111-8111-111111111111')
    mkdirSync(foreign)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(foreign, 'keep'), 'foreign bytes')
    symlinkSync(foreign, join(home, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = f.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('未知位置')
    expect(result.stdout.toString()).not.toContain('✓ Lodestar 已安装')
    expect(lstatSync(join(home, 'plugins')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('foreign bytes')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
