import { describe, expect, test } from 'bun:test'

import { extractSendMarkerPaths, normalizeOutboundPath } from './outbound-markers'

describe('outbound send markers', () => {
  test('extracts paths that contain square brackets', () => {
    const text = '[[send: /home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png]]'

    expect(extractSendMarkerPaths(text)).toEqual([
      '/home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png',
    ])
  })

  test('extracts multiple markers and trims marker padding', () => {
    const text = [
      'first [[send:  /tmp/a.png  ]]',
      'second [[send: /tmp/out[1].jpg]]',
    ].join('\n')

    expect(extractSendMarkerPaths(text)).toEqual([
      '/tmp/a.png',
      '/tmp/out[1].jpg',
    ])
  })

  test('does not match markers split across lines', () => {
    expect(extractSendMarkerPaths('[[send: /tmp/a.png\n]]')).toEqual([])
  })

  test('trims tabs and spaces around the path and ignores empty markers', () => {
    expect(extractSendMarkerPaths('[[send:\t /tmp/a b.png \t]] [[send:   ]] [[send:/tmp/c.png]]')).toEqual([
      '/tmp/a b.png',
      '/tmp/c.png',
    ])
  })

  test('an unterminated marker followed by blanks is scanned in linear time', () => {
    // Runs on the whole accumulated reply for every streamed delta. The former pattern
    // needed over ten seconds for a few thousand blanks and froze the daemon.
    const text = `x [[send:${' '.repeat(200_000)}\nrest [[send: /tmp/after.png]]`
    const started = performance.now()
    expect(extractSendMarkerPaths(text)).toEqual(['/tmp/after.png'])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('normalizeOutboundPath', () => {
  test('win32: rewrites MSYS drive prefix to native path', () => {
    expect(normalizeOutboundPath('/c/Users/maoxiandao2/winctl_screen.jpg', 'win32'))
      .toBe('C:\\Users\\maoxiandao2\\winctl_screen.jpg')
    expect(normalizeOutboundPath('/d/projects/a/b.png', 'win32'))
      .toBe('D:\\projects\\a\\b.png')
  })

  test('win32: leaves native Windows paths untouched', () => {
    expect(normalizeOutboundPath('C:\\Users\\a\\x.jpg', 'win32')).toBe('C:\\Users\\a\\x.jpg')
    expect(normalizeOutboundPath('C:/Users/a/x.jpg', 'win32')).toBe('C:/Users/a/x.jpg')
  })

  test('win32: leaves non-drive POSIX absolutes untouched', () => {
    expect(normalizeOutboundPath('/home/a/x.jpg', 'win32')).toBe('/home/a/x.jpg')
    expect(normalizeOutboundPath('/tmp/a', 'win32')).toBe('/tmp/a')
    expect(normalizeOutboundPath('/usr/bin/x', 'win32')).toBe('/usr/bin/x')
  })

  test('non-win32: no-op even for MSYS-looking paths', () => {
    expect(normalizeOutboundPath('/c/Users/a/x.jpg', 'linux')).toBe('/c/Users/a/x.jpg')
    expect(normalizeOutboundPath('/c/Users/a/x.jpg', 'darwin')).toBe('/c/Users/a/x.jpg')
  })
})
