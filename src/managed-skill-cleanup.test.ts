import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    LODESTAR_DATA_DIR: profile === 'override' ? dataDir : '',
    XDG_DATA_HOME: profile === 'default' ? '' : xdgData,
    LOCALAPPDATA: localData,
    LODESTAR_DISABLE_SKILL_SYNC: '0',
  }
  return {
    root, skillRoots,
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
