// Shared by paths.ts and npm postinstall, including installs from a source checkout.
const { homedir } = require('node:os')
const { join } = require('node:path')

function lodestarDataDir () {
  if (process.env.LODESTAR_DATA_DIR) return process.env.LODESTAR_DATA_DIR
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'lodestar')
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lodestar')
  }
  return join(homedir(), '.local', 'share', 'lodestar')
}

function managedClaudePluginDir () {
  return join(lodestarDataDir(), 'managed-claude-plugin')
}

module.exports = { lodestarDataDir, managedClaudePluginDir }
