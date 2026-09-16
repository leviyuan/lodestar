const { readFileSync, rmSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { managedClaudePluginDir } = require('./data-dir.cjs')

// Requires no config, credentials, Agent runtime, or prior build.
function removeManagedSkill (name, roots, report = console.log) {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    report(`skill: sync disabled, skip removal ${name}`)
    return
  }
  const targetRoots = roots ?? [
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(managedClaudePluginDir(), 'skills'),
  ]
  const errors = []
  for (const root of targetRoots) {
    const dir = join(root, name)
    const skillFile = join(dir, 'SKILL.md')
    let body
    try {
      body = readFileSync(skillFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      const failure = new Error(`skill: obsolete removal failed (${skillFile}): ${error}`, { cause: error })
      report(failure.message)
      errors.push(failure)
      continue
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1]
    const declaredName = /^name:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]+))[ \t]*$/m.exec(frontmatter ?? '')
    if (!declaredName || (declaredName[1] ?? declaredName[2] ?? declaredName[3]) !== name) {
      report(`skill: obsolete path preserved because ownership is unclear ${skillFile}`)
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: false })
      report(`skill: removed obsolete ${dir}`)
    } catch (error) {
      const failure = new Error(`skill: obsolete removal failed (${dir}): ${error}`, { cause: error })
      report(failure.message)
      errors.push(failure)
    }
  }
  if (errors.length) throw new AggregateError(errors, `Failed to remove obsolete Skill ${name}`)
}

module.exports = { removeManagedSkill }
