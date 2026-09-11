/** Proxy policy for Lodestar's own requests. Agent applications own their networking. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Address4, Address6 } from 'ip-address'

export interface ProxySettings {
  http?: string
  https?: string
  all?: string
  bypass?: string
  unsupported?: string
}

type Environment = Record<string, string | undefined>
const execute = promisify(execFile)

function envValue(env: Environment, name: string): string | undefined {
  return env[name.toLowerCase()]?.trim() || env[name]?.trim() || undefined
}

export function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
    || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host)
}

export function bypassProxy(url: URL, bypass = ''): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return bypass.split(/[,;\s]+/).filter(Boolean).some(raw => {
    const entry = raw.toLowerCase()
    if (entry === '*') return true
    if (entry === '<local>') return !host.includes('.') && !host.includes(':')
    if (entry.includes('/')) {
      if (Address4.isValid(entry)) return Address4.isValid(host) && new Address4(host).isInSubnet(new Address4(entry))
      if (Address6.isValid(entry)) return Address6.isValid(host) && new Address6(host).isInSubnet(new Address6(entry))
      throw new Error('network proxy: invalid IP range in bypass list')
    }
    const match = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
    if (match && match[2] !== port) return false
    const domain = (match ? match[1]! : entry).replace(/^\[|\]$/g, '').replace(/^\*?\./, '')
    return host === domain || host.endsWith(`.${domain}`)
  })
}

function checkedProxy(raw: string, source: string): string {
  let proxy: URL
  try { proxy = new URL(raw) } catch { throw new Error(`network proxy: ${source} contains an invalid proxy URL`) }
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error(`network proxy: ${source} must use an HTTP(S) proxy; SOCKS and PAC are not supported`)
  }
  if (!proxy.hostname || proxy.search || proxy.hash || (proxy.pathname && proxy.pathname !== '/')) {
    throw new Error(`network proxy: ${source} must contain a proxy host and port without a path or query`)
  }
  return proxy.href
}

/** Undefined settings mean no proxy configured, never a failed settings lookup. */
export function resolveProxy(url: URL, env: Environment, system: ProxySettings = {}): string | undefined {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`network: unsupported URL protocol ${url.protocol}`)
  if (isLoopback(url) || bypassProxy(url, envValue(env, 'NO_PROXY'))) return undefined
  const scheme = url.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY'
  const explicit = envValue(env, scheme) || envValue(env, 'ALL_PROXY')
  if (explicit) return checkedProxy(explicit, 'environment')
  if (system.unsupported) throw new Error(`network proxy: ${system.unsupported}`)
  if (bypassProxy(url, system.bypass)) return undefined
  const value = (url.protocol === 'https:' ? system.https : system.http) || system.all
  return value ? checkedProxy(value, 'system settings') : undefined
}

function endpoint(host: unknown, port: unknown, protocol = 'http'): string {
  if (typeof host !== 'string' || !host.trim() || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('network proxy: system proxy has an invalid host or port')
  }
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${protocol}://${hostname}:${port}`
}

export function parseWindowsProxy(settings: Record<string, unknown>): ProxySettings {
  if (settings.AutoConfigURL) return { unsupported: 'Windows PAC proxy is not supported; configure a manual HTTP(S) proxy or proxy environment variables' }
  if (!settings.ProxyEnable) {
    return settings.AutoDetect ? { unsupported: 'Windows automatic proxy discovery is not supported; configure a manual HTTP(S) proxy or proxy environment variables' } : {}
  }
  if (typeof settings.ProxyServer !== 'string' || !settings.ProxyServer.trim()) throw new Error('network proxy: Windows proxy is enabled without a server')
  const result: ProxySettings = { bypass: String(settings.ProxyOverride ?? '') }
  for (const entry of settings.ProxyServer.split(';').map(value => value.trim()).filter(Boolean)) {
    const match = entry.match(/^(http|https|socks)=(.+)$/i)
    const value = match ? match[2]! : entry
    const address = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : `http://${value}`
    if (!match) result.all = address
    else if (match[1]!.toLowerCase() === 'socks') result.all = `socks://${value.replace(/^socks\w*:\/\//, '')}`
    else result[match[1]!.toLowerCase() as 'http' | 'https'] = address
  }
  return result
}

export function parseMacProxy(text: string): ProxySettings {
  const value = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1]
  if (value('ProxyAutoConfigEnable') === '1' || value('ProxyAutoDiscoveryEnable') === '1') {
    return { unsupported: 'macOS PAC/automatic proxy discovery is not supported; configure a manual HTTP(S) proxy or proxy environment variables' }
  }
  const result: ProxySettings = {}
  if (value('HTTPEnable') === '1') result.http = endpoint(value('HTTPProxy'), value('HTTPPort'))
  if (value('HTTPSEnable') === '1') result.https = endpoint(value('HTTPSProxy'), value('HTTPSPort'))
  if (value('SOCKSEnable') === '1') result.all = endpoint(value('SOCKSProxy'), value('SOCKSPort'), 'socks')
  const exceptions = text.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] ?? ''
  result.bypass = [...exceptions.matchAll(/^\s*\d+\s*:\s*(.*?)\s*$/gm)].map(match => match[1]).join(',')
  if (value('ExcludeSimpleHostnames') === '1') result.bypass += ',<local>'
  return result
}

function gvariantString(value: string | undefined): string {
  if (value === undefined) return ''
  if (!/^(['"]).*\1$/.test(value)) throw new Error('network proxy: invalid GNOME proxy string')
  return value.slice(1, -1).replace(/\\([\\'"])/g, '$1')
}

export function parseGnomeProxy(text: string): ProxySettings {
  const values = new Map(text.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^org\.gnome\.system\.proxy(\.\w+)?\s+([\w-]+)\s+(.*)$/)
    if (!match) throw new Error('network proxy: invalid GNOME proxy settings')
    return [`${match[1] ?? ''}/${match[2]}`, match[3]!] as const
  }))
  const mode = gvariantString(values.get('/mode'))
  if (mode === 'none') return {}
  if (mode === 'auto') return { unsupported: 'GNOME PAC proxy is not supported; configure a manual HTTP(S) proxy or proxy environment variables' }
  if (mode !== 'manual') throw new Error('network proxy: unknown GNOME proxy mode')
  const result: ProxySettings = {}
  for (const scheme of ['http', 'https', 'socks'] as const) {
    const host = gvariantString(values.get(`.${scheme}/host`))
    if (!host) continue
    const proxy = new URL(endpoint(host, values.get(`.${scheme}/port`), scheme === 'socks' ? 'socks' : 'http'))
    if (scheme === 'http' && values.get('.http/use-authentication') === 'true') {
      proxy.username = gvariantString(values.get('.http/authentication-user'))
      proxy.password = gvariantString(values.get('.http/authentication-password'))
    }
    result[scheme === 'socks' ? 'all' : scheme] = proxy.href
  }
  if (values.get('/use-same-proxy') === 'true' && result.http) result.https = result.http
  result.bypass = [...(values.get('/ignore-hosts') ?? '').matchAll(/'((?:\\.|[^'])*)'/g)].map(match => match[1]).join(',')
  return result
}

export function parseKdeProxy(text: string): ProxySettings | undefined {
  const section = text.match(/^\[Proxy Settings\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]
  if (section === undefined) return undefined
  const values = new Map(section.split('\n').filter(line => line.includes('=')).map(line => {
    const eq = line.indexOf('=')
    return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()] as const
  }))
  const mode = values.get('ProxyType') ?? '0'
  if (mode === '0' || mode === '4') return {} // KDE mode 4 delegates to the environment already checked above.
  if (mode !== '1') return { unsupported: 'KDE PAC/automatic proxy discovery is not supported; configure a manual HTTP(S) proxy or proxy environment variables' }
  if (values.get('ReversedException') === 'true') return { unsupported: 'KDE reversed proxy exceptions are not supported' }
  const result: ProxySettings = { bypass: values.get('NoProxyFor') }
  for (const scheme of ['http', 'https', 'socks'] as const) {
    const raw = values.get(`${scheme}Proxy`)
    if (!raw) continue
    const value = raw.replace(/\s+(\d+)$/, ':$1')
    result[scheme === 'socks' ? 'all' : scheme] = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : `${scheme === 'socks' ? 'socks' : 'http'}://${value}`
  }
  return result
}

async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await execute(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true })
  return stdout
}

// WinHTTP returns the active per-user configuration, including PAC/WPAD flags.
// Raw registry values can retain a disabled proxy and do not reliably expose those flags.
const WINDOWS_PROXY_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LodestarProxy {
  [StructLayout(LayoutKind.Sequential)]
  public struct Settings {
    [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
    public IntPtr AutoConfigUrl, Proxy, Bypass;
  }
  [DllImport("winhttp.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Settings settings);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr pointer);
}
'@
$settings = New-Object LodestarProxy+Settings
if (-not [LodestarProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$settings)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq 2) { '{}'; exit 0 }
  throw (New-Object ComponentModel.Win32Exception($code))
}
try {
  $proxy = [Runtime.InteropServices.Marshal]::PtrToStringUni($settings.Proxy)
  @{
    ProxyEnable = -not [string]::IsNullOrEmpty($proxy)
    ProxyServer = $proxy
    ProxyOverride = [Runtime.InteropServices.Marshal]::PtrToStringUni($settings.Bypass)
    AutoConfigURL = [Runtime.InteropServices.Marshal]::PtrToStringUni($settings.AutoConfigUrl)
    AutoDetect = $settings.AutoDetect
  } | ConvertTo-Json -Compress
} finally {
  foreach ($pointer in @($settings.Proxy, $settings.Bypass, $settings.AutoConfigUrl)) {
    if ($pointer -ne [IntPtr]::Zero) { [void][LodestarProxy]::GlobalFree($pointer) }
  }
}
`

export async function readSystemProxySettings(): Promise<ProxySettings> {
  if (process.platform === 'win32') {
    // Read the current user's settings; never import/change machine or browser configuration.
    return parseWindowsProxy(JSON.parse(await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROXY_QUERY])))
  }
  if (process.platform === 'darwin') return parseMacProxy(await command('/usr/sbin/scutil', ['--proxy']))
  if (process.platform === 'linux') {
    const kde = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kioslaverc')
    try {
      const settings = parseKdeProxy(await readFile(kde, 'utf8'))
      if (settings && (!process.env.XDG_CURRENT_DESKTOP || /kde/i.test(process.env.XDG_CURRENT_DESKTOP))) return settings
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    let schemas: string
    try { schemas = await command('gsettings', ['list-schemas']) }
    catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error }
    if (!schemas.split(/\r?\n/).includes('org.gnome.system.proxy')) return {}
    return parseGnomeProxy(await command('gsettings', ['list-recursively', 'org.gnome.system.proxy']))
  }
  return {}
}

/** Share in-flight discovery and refresh every 30 seconds; never reuse a failed/stale lookup. */
export function createProxyResolver(readSystem: () => Promise<ProxySettings> = readSystemProxySettings, env: Environment = process.env, now = Date.now) {
  let snapshot: { until: number; value: Promise<ProxySettings> } | undefined
  return async (url: URL): Promise<string | undefined> => {
    if (isLoopback(url) || bypassProxy(url, envValue(env, 'NO_PROXY')) || envValue(env, url.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY') || envValue(env, 'ALL_PROXY')) {
      return resolveProxy(url, env)
    }
    if (!snapshot || snapshot.until <= now()) {
      const value = readSystem().catch((error: unknown) => {
        if (snapshot?.value === value) snapshot = undefined
        if (error instanceof Error && error.message.startsWith('network proxy:')) throw error
        const reason = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : 'unknown error'
        throw new Error(`network proxy: failed to read ${process.platform} system proxy settings (${reason})`, { cause: error })
      })
      snapshot = { until: now() + 30_000, value }
    }
    return resolveProxy(url, env, await snapshot.value)
  }
}

export const proxyForUrl = createProxyResolver()
