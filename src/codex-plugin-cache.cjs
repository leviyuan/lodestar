// Shared by account startup and npm postinstall. No config, auth or Agent imports.
const fs = require('node:fs')
const { homedir } = require('node:os')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { codexAccountsDir } = require('./data-dir.cjs')

const BACKUP = '.lodestar-plugins-shared-link'
const LOCK = '.lodestar-plugins-migration.lock'

function stat (path) {
  try { return fs.lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

// Resolve existing ancestors too, so relative links, home aliases and missing
// legacy targets can all be checked without creating anything at the target.
function canonical (path) {
  try { return fs.realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(canonical(parent), relative(parent, path))
  }
}

function isWithin (root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertLegacyLink (path, source) {
  const info = stat(path)
  if (!info?.isSymbolicLink()) throw new Error(`Codex 插件迁移路径不是旧共享链接：${path}`)
  const target = resolve(dirname(path), fs.readlinkSync(path))
  if (canonical(target) !== canonical(source)) throw new Error(`Codex 插件共享链接指向未知位置：${path}`)
}

function assertHome (home, defaultHome) {
  const info = stat(home)
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`Codex 账号目录不是独立目录：${home}`)
  if (canonical(home) === canonical(defaultHome)) throw new Error('额外账号不能使用默认认证目录')
}

function preflight (home, defaultHome) {
  assertHome(home, defaultHome)
  const source = join(defaultHome, 'plugins')
  const plugins = join(home, 'plugins')
  const backup = join(home, BACKUP)
  if (stat(backup)) assertLegacyLink(backup, source)
  const current = stat(plugins)
  if (current?.isSymbolicLink()) assertLegacyLink(plugins, source)
  else if (current && !current.isDirectory()) throw new Error(`Codex 插件路径不是目录：${plugins}`)
  // A custom data directory may sit under the native plugin directory. Copying
  // that source would also copy this account and its newly created staging tree.
  if ((current?.isSymbolicLink() || (!current && stat(backup))) && isWithin(canonical(source), canonical(home))) {
    throw new Error(`Codex 账号目录位于默认插件目录内，拒绝递归复制：${home}`)
  }
}

function acquireLock (home) {
  const path = join(home, LOCK)
  // A hard link publishes the complete owner atomically; observers never see
  // an empty PID file. A live owner fails visibly instead of blocking startup.
  const candidate = join(home, `${LOCK}.${randomUUID()}`)
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(candidate, path)
        const owned = fs.lstatSync(path)
        return () => {
          const current = stat(path)
          if (current && current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(path)
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const before = stat(path)
        if (!before) continue
        if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Codex 插件迁移锁无效：${path}`)
        const owner = JSON.parse(fs.readFileSync(path, 'utf8'))
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Codex 插件迁移锁无效：${path}`)
        try {
          process.kill(owner.pid, 0)
          throw new Error('Codex 插件目录正在迁移，请稍后重试')
        } catch (status) {
          if (status.code !== 'ESRCH') throw status
        }
        const after = stat(path)
        if (after && before.ino === after.ino && before.dev === after.dev) fs.unlinkSync(path)
      }
    }
    throw new Error('Codex 插件迁移锁持续变化，请稍后重试')
  } finally {
    fs.unlinkSync(candidate)
  }
}

function copyTree (source, target, sourceRoot, targetRoot, finalRoot) {
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) {
    const linked = canonical(resolve(dirname(source), fs.readlinkSync(source)))
    if (!isWithin(sourceRoot, linked)) throw new Error(`Codex 插件缓存包含目录外链接，拒绝复制：${source}`)
    const isolated = join(targetRoot, relative(sourceRoot, linked))
    let directory = false
    try { directory = fs.statSync(source).isDirectory() } catch (error) { if (error.code !== 'ENOENT') throw error }
    fs.symlinkSync(process.platform === 'win32' && directory ? join(finalRoot, relative(sourceRoot, linked)) : relative(dirname(target), isolated),
      target, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file')
  } else if (info.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 })
    for (const child of fs.readdirSync(source)) copyTree(join(source, child), join(target, child), sourceRoot, targetRoot, finalRoot)
  } else if (info.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  } else {
    throw new Error(`Codex 插件缓存包含不支持的文件类型：${source}`)
  }
}

function prepareCodexPluginDirectory (home, defaultHome) {
  home = resolve(home)
  defaultHome = resolve(defaultHome)
  preflight(home, defaultHome)
  const plugins = join(home, 'plugins')
  const source = join(defaultHome, 'plugins')
  const backup = join(home, BACKUP)
  // Keep existing independent directories completely untouched.
  if (stat(plugins)?.isDirectory() && !stat(backup)) return
  const release = acquireLock(home)
  try {
    preflight(home, defaultHome)
    if (stat(backup)) {
      // A crash before publication leaves the old link here; a crash after
      // publication leaves an independent directory plus this redundant link.
      if (!stat(plugins)) fs.renameSync(backup, plugins)
      else if (stat(plugins).isDirectory()) fs.unlinkSync(backup)
      else throw new Error(`Codex 插件迁移存在冲突链接：${backup}`)
    }
    const current = stat(plugins)
    if (!current) {
      fs.mkdirSync(plugins, { mode: 0o700 })
      return
    }
    if (current.isDirectory()) return
    assertLegacyLink(plugins, source)
    const temporary = fs.mkdtempSync(join(home, '.lodestar-plugins-copy-'))
    const staged = join(temporary, 'plugins')
    try {
      let sourceRoot
      try { sourceRoot = fs.realpathSync(source) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (sourceRoot) {
        if (!fs.statSync(sourceRoot).isDirectory()) throw new Error(`Codex 默认插件路径不是目录：${source}`)
        copyTree(sourceRoot, staged, sourceRoot, staged, plugins)
      } else fs.mkdirSync(staged, { mode: 0o700 })
      // Copy failure never removes the old link. Recheck immediately before
      // swapping; an unexpected path is not overwritten or recursively removed.
      assertLegacyLink(plugins, source)
      fs.renameSync(plugins, backup)
      try {
        fs.renameSync(staged, plugins)
      } catch (error) {
        if (!stat(plugins)) fs.renameSync(backup, plugins)
        throw error
      }
      fs.unlinkSync(backup)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  } finally {
    release()
  }
}

function migrateCodexPluginCaches (options = {}) {
  const defaultHome = resolve(options.defaultHome || process.env.CODEX_HOME || join(homedir(), '.codex'))
  const root = resolve(options.accountsRoot || codexAccountsDir())
  const info = stat(root)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Codex 账号根目录不是独立目录：${root}`)
  // Do not read credentials or infer arbitrary homes from names. Unregistered
  // UUID homes from an interrupted account creation need the same repair.
  const homes = fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => join(root, name))
  for (const home of homes) preflight(home, defaultHome)
  for (const home of homes) prepareCodexPluginDirectory(home, defaultHome)
}

module.exports = { prepareCodexPluginDirectory, migrateCodexPluginCaches }
