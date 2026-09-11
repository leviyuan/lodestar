import { describe, expect, test } from 'bun:test'
import { bypassProxy, createProxyResolver, isLoopback, parseGnomeProxy, parseKdeProxy, parseMacProxy, parseWindowsProxy, readSystemProxySettings, resolveProxy } from './network-proxy'

const target = new URL('https://openrouter.ai/api/v1/credits')
const proxy = 'http://127.0.0.1:7890/'

describe('shared outbound proxy policy', () => {
  test('explicit environment wins over system settings, with consistent scheme and casing rules', () => {
    const system = { https: 'http://system.example:8080', unsupported: 'PAC' }
    expect(resolveProxy(target, { HTTPS_PROXY: proxy }, system)).toBe(proxy)
    expect(resolveProxy(target, { HTTPS_PROXY: proxy, https_proxy: 'http://lower.example:8080' }, system)).toBe('http://lower.example:8080/')
    expect(resolveProxy(target, { HTTPS_PROXY: proxy, https_proxy: ' ' }, system)).toBe(proxy)
    expect(resolveProxy(target, { ALL_PROXY: proxy }, system)).toBe(proxy)
    expect(resolveProxy(target, { HTTP_PROXY: proxy }, { https: 'http://system.example:8080' })).toBe('http://system.example:8080/')
    expect(resolveProxy(new URL('http://example.com'), { HTTP_PROXY: proxy })).toBe(proxy)
    expect(resolveProxy(target, {})).toBeUndefined()
  })

  test('loopback and NO_PROXY are direct without consulting system settings', async () => {
    const readSystem = async () => { throw new Error('must not read system settings') }
    const resolve = createProxyResolver(readSystem, { HTTPS_PROXY: 'invalid-secret', NO_PROXY: 'openrouter.ai' })
    expect(await resolve(target)).toBeUndefined()
    for (const host of ['localhost', 'service.localhost', '127.0.0.1', '127.12.34.56', '[::1]', '[::ffff:127.0.0.1]']) {
      const url = new URL(`http://${host}/`)
      expect(isLoopback(url)).toBe(true)
      expect(await resolve(url)).toBeUndefined()
    }
    for (const host of ['localhost.example.com', '127.example.com', '[::2]']) expect(isLoopback(new URL(`http://${host}/`))).toBe(false)
  })

  test('bypass handles domain boundaries, ports, IPv4/IPv6 ranges and platform exceptions', () => {
    expect(bypassProxy(target, 'openrouter.ai')).toBe(true)
    expect(bypassProxy(target, '.openrouter.ai:443')).toBe(true)
    expect(bypassProxy(target, 'openrouter.ai:8443')).toBe(false)
    expect(bypassProxy(new URL('https://api.openrouter.ai'), '*.openrouter.ai')).toBe(true)
    expect(bypassProxy(new URL('https://evilopenrouter.ai'), 'openrouter.ai')).toBe(false)
    expect(bypassProxy(new URL('http://intranet'), '<local>')).toBe(true)
    expect(bypassProxy(new URL('http://10.1.2.3'), '10.0.0.0/8')).toBe(true)
    expect(bypassProxy(new URL('http://[fd00::42]'), 'fd00::/8')).toBe(true)
    expect(bypassProxy(new URL('http://[fd00::42]'), '10.0.0.0/8')).toBe(false)
    expect(bypassProxy(new URL('http://[fd00::42]:8080'), '[fd00::42]:8080')).toBe(true)
    expect(() => bypassProxy(target, 'not-a-network/99')).toThrow('invalid IP range')
  })

  test('invalid or unsupported explicit configuration never selects system proxy or direct', () => {
    for (const value of ['invalid-secret', 'socks5://user:secret@host:1080', 'http://user:secret@host/path']) {
      try { resolveProxy(target, { HTTPS_PROXY: value }, { https: proxy }); throw new Error('unexpected success') }
      catch (error) {
        expect(String(error)).toContain('network proxy:')
        expect(String(error)).not.toContain('secret')
      }
    }
    expect(() => resolveProxy(target, {}, { unsupported: 'PAC proxy is not supported' })).toThrow('PAC')
    expect(resolveProxy(target, { NO_PROXY: '*' }, { unsupported: 'PAC' })).toBeUndefined()
  })

  test('system discovery is shared and environment remains authoritative after discovery', async () => {
    let reads = 0
    const env: Record<string, string> = {}
    const resolve = createProxyResolver(async () => { reads++; return { https: proxy } }, env)
    expect(await Promise.all([resolve(target), resolve(target)])).toEqual([proxy, proxy])
    expect(reads).toBe(1)
    env.HTTPS_PROXY = 'http://new.example:8080'
    expect(await resolve(target)).toBe('http://new.example:8080/')
    expect(reads).toBe(1)
  })

  test('failed system discovery rejects and the next request performs a fresh lookup', async () => {
    let reads = 0
    const cause = new Error('settings unavailable')
    const resolve = createProxyResolver(async () => { if (++reads === 1) throw cause; return { https: proxy } }, {})
    await expect(resolve(target)).rejects.toMatchObject({ cause })
    expect(await resolve(target)).toBe(proxy)
    expect(reads).toBe(2)
  })

  test('expired system settings are not reused when refresh fails', async () => {
    let clock = 0
    let reads = 0
    const resolve = createProxyResolver(async () => {
      if (++reads === 2) throw new Error('settings refresh failed')
      return { https: reads === 1 ? proxy : 'http://changed.example:8080' }
    }, {}, () => clock)
    expect(await resolve(target)).toBe(proxy)
    clock = 30_001
    await expect(resolve(target)).rejects.toThrow('failed to read')
    expect(await resolve(target)).toBe('http://changed.example:8080/')
  })
})

describe('desktop system proxy settings', () => {
  if (process.platform === 'win32') test('Windows native discovery reads active WinHTTP settings without changing them', async () => {
    const settings = await readSystemProxySettings()
    expect(settings).toBeObject()
    for (const value of Object.values(settings)) expect(value === undefined || typeof value === 'string').toBe(true)
  }, 10_000)

  test('Windows manual per-scheme/shared servers, bypass and automatic-proxy boundaries', () => {
    expect(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http=host:8080;https=secure:8443', ProxyOverride: '*.internal;<local>' }))
      .toEqual({ http: 'http://host:8080', https: 'http://secure:8443', bypass: '*.internal;<local>' })
    expect(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'host:8080' }).all).toBe('http://host:8080')
    expect(parseWindowsProxy({ ProxyEnable: 0, ProxyServer: 'stale:8080' })).toEqual({})
    expect(parseWindowsProxy({ AutoConfigURL: 'http://settings.example/proxy.pac' }).unsupported).toContain('PAC')
    expect(() => parseWindowsProxy({ ProxyEnable: 1 })).toThrow('without a server')
  })

  test('macOS active HTTP/HTTPS settings and array exceptions', () => {
    const settings = parseMacProxy(`<dictionary> {
      HTTPEnable : 1
      HTTPProxy : 127.0.0.1
      HTTPPort : 7890
      HTTPSEnable : 1
      HTTPSProxy : ::1
      HTTPSPort : 7891
      ExceptionsList : <array> {
        0 : *.local
        1 : 10.0.0.0/8
      }
      ExcludeSimpleHostnames : 1
    }`)
    expect(settings).toEqual({ http: 'http://127.0.0.1:7890', https: 'http://[::1]:7891', bypass: '*.local,10.0.0.0/8,<local>' })
    expect(parseMacProxy('ProxyAutoConfigEnable : 1').unsupported).toContain('PAC')
    expect(() => parseMacProxy('HTTPEnable : 1\nHTTPProxy : host\nHTTPPort : 0')).toThrow('invalid host or port')
  })

  test('GNOME manual/shared proxy preserves authentication and bypass', () => {
    const settings = parseGnomeProxy([
      "org.gnome.system.proxy mode 'manual'",
      'org.gnome.system.proxy use-same-proxy true',
      "org.gnome.system.proxy ignore-hosts ['localhost', '*.internal', '10.0.0.0/8']",
      "org.gnome.system.proxy.http host 'proxy.example'",
      'org.gnome.system.proxy.http port 8080',
      'org.gnome.system.proxy.http use-authentication true',
      "org.gnome.system.proxy.http authentication-user 'user'",
      "org.gnome.system.proxy.http authentication-password 'test:p@ss'",
    ].join('\n'))
    expect(settings.http).toBe('http://user:test%3Ap%40ss@proxy.example:8080/')
    expect(settings.https).toBe(settings.http)
    expect(settings.bypass).toBe('localhost,*.internal,10.0.0.0/8')
    expect(parseGnomeProxy("org.gnome.system.proxy mode 'none'")).toEqual({})
    expect(parseGnomeProxy("org.gnome.system.proxy mode 'auto'").unsupported).toContain('PAC')
    expect(() => parseGnomeProxy('broken output')).toThrow('invalid GNOME')
  })

  test('KDE proxy group is isolated from unrelated configuration', () => {
    expect(parseKdeProxy('[Other]\nProxyType=2\n')).toBeUndefined()
    expect(parseKdeProxy('[Other]\nkey=x\n[Proxy Settings]\nProxyType=1\nhttpProxy=http://host 8080\nhttpsProxy=http://host 8081\nNoProxyFor=.internal\n[Other2]\nhttpProxy=wrong\n'))
      .toEqual({ http: 'http://host:8080', https: 'http://host:8081', bypass: '.internal' })
    expect(parseKdeProxy('[Proxy Settings]\nProxyType=2\n')?.unsupported).toContain('PAC')
  })
})
