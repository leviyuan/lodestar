/**
 * Codex project-trust maintenance.
 *
 * Lodestar used to append `[projects."<workDir>"] trust_level = "trusted"` to
 * the user's global `~/.codex/config.toml` for every project directory it
 * provisioned. That file is read by the Codex Agent itself, so the accumulated
 * entries would disclose every group/project directory name to any backend
 * Agent. New launches pass the same trust level with `-c` instead
 * (`codexProjectTrustArgs`); this module removes the entries Lodestar wrote
 * while leaving unrelated Codex settings untouched.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeStateFileAtomic } from './state-store'

const HEADER = /^\[projects\.("(?:[^"\\]|\\.)*")\]\s*$/
const TRUST_ONLY = 'trust_level = "trusted"'

export function codexConfigFile(home = homedir()): string {
  return join(home, '.codex', 'config.toml')
}

/** TOML 基本字符串:转义引号、反斜杠(Windows 路径)与控制字符,其余字符原样保留。 */
function tomlBasicString(value: string): string {
  return `"${value.replace(/[\\"\u0000-\u001f\u007f]/g, char => char === '\\' || char === '"'
    ? `\\${char}`
    : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

/**
 * 本次启动的项目信任参数,只随进程下发,不写共享的 `~/.codex/config.toml`。
 * Codex 的 `-c` 在第一个 `=` 处分出键,键再按 `.` 切分且不识别引号:
 * `projects."<path>".trust_level` 得到的是带引号的键(路径含点时还会被截断),
 * 永远匹配不到 cwd。因此键只写 `projects`,路径放进 TOML 内联表的带引号键里。
 * 实测 Codex 0.172 把 `-c` 作为 sessionFlags 层与 config.toml 深合并:内联表只增补
 * 或覆盖该路径的 `trust_level`,用户自建的其他 projects 项(包括上级仓库根的信任)
 * 照常生效;即使某个版本改为整表替换,本会话所需的工作目录信任也仍在表内。
 */
export function codexProjectTrustArgs(workDir: string): string[] {
  return ['-c', `projects={ ${tomlBasicString(workDir)} = { trust_level = "trusted" } }`]
}

/**
 * 中转站 provider 只能是 Lodestar 下发的那份定义。Codex 把 `-c` 与各层配置深合并：
 * 本机（用户、系统或托管配置）若也有同名 `[model_providers.<id>]`，它的请求头、查询参数、
 * 认证命令、模型目录地址等会混进来，而深合并删不掉这些键（覆盖成空表也只是合并进去）；
 * provider id 又记录在原生会话里，改名会让已有会话无法续接（原生报该 provider 未配置）。
 * 所以在任何请求发出前，用 `config/read` 的分层结果核对：除本进程的 sessionFlags 外，
 * 生效中的层定义了同名 provider 就拒绝启动。
 */
export function assertCodexProviderIsolated(configRead: unknown, provider: { id: string; name: string }): void {
  const layers = (configRead as { layers?: unknown } | null)?.layers
  if (!Array.isArray(layers)) throw new Error('Codex config/read 未返回配置分层，无法确认中转站 provider 没有混入本机配置')
  for (const layer of layers) {
    if (layer?.name?.type === 'sessionFlags' || layer?.disabledReason) continue
    const providers = layer?.config?.model_providers
    if (!providers || typeof providers !== 'object' || !Object.hasOwn(providers, provider.id)) continue
    const where = typeof layer.name?.file === 'string' ? layer.name.file : String(layer.name?.type ?? 'MISS')
    throw new Error(`本机 Codex 配置（${where}）也定义了 model provider「${provider.id}」，Codex 会把它与中转站「${provider.name}」的设置合并（如附加请求头、查询参数或认证方式），已停止启动；请删除或改名该 provider 后重试`)
  }
}

/** True only for a direct child of the configured projects root: those are the
 * group/worktree directories Lodestar provisions. Nested user repositories are
 * left alone. */
function isDirectProjectChild(path: string, projectsRoot: string): boolean {
  const rel = relative(resolve(projectsRoot), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
}

/**
 * Remove trust sections that (a) point at a direct child of `projectsRoot`,
 * and (b) contain nothing but `trust_level = "trusted"`. Returns how many were
 * removed; the file is only rewritten when at least one matched.
 */
export function pruneLodestarProjectTrust(
  file: string, projectsRoot: string, knownSessionNames?: ReadonlySet<string>,
): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    throw error
  }
  const lines = text.split('\n')
  const kept: string[] = []
  let removed = 0
  for (let index = 0; index < lines.length; index++) {
    const match = HEADER.exec(lines[index].trim())
    if (!match) {
      kept.push(lines[index])
      continue
    }
    let end = index + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
    const body = lines.slice(index + 1, end).map(line => line.trim()).filter(Boolean)
    let path: string
    try {
      path = JSON.parse(match[1]) as string
    } catch {
      kept.push(...lines.slice(index, end))
      index = end - 1
      continue
    }
    // The caller can restrict removal to directories bound to a Lodestar
    // session; without that guard a user-created trust entry for an unrelated
    // direct child would be removed too.
    const known = !knownSessionNames || knownSessionNames.has(basename(resolve(path)))
    if (body.length === 1 && body[0] === TRUST_ONLY && isDirectProjectChild(path, projectsRoot) && known) {
      removed++
      index = end - 1
      continue
    }
    kept.push(...lines.slice(index, end))
    index = end - 1
  }
  if (removed > 0) {
    // The file is the user's: rewrite a symlinked config (dotfiles managers) at
    // its real target instead of replacing the link, and keep its own mode.
    const target = realpathSync(file)
    writeStateFileAtomic(target, kept.join('\n'), { mode: statSync(target).mode & 0o777 })
  }
  return removed
}
