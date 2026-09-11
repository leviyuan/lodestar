import { expect, test } from 'bun:test'

test('outbound image upload accepts exactly 30 MB and rejects larger files before any network call', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const { MAX_UPLOAD_BYTES, uploadImageKey } = await import('./src/feishu')
    const root = mkdtempSync(join(tmpdir(), 'lodestar-upload-limit-'))
    const path = join(root, 'boundary.png')
    const fd = openSync(path, 'w')
    let calls = 0
    globalThis.fetch = async (url, init) => {
      calls++
      if (String(url).includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 'test-token' })
      assert.ok(String(url).endsWith('/im/v1/images'))
      assert.equal(init.body.get('image').size, MAX_UPLOAD_BYTES)
      return Response.json({ code: 0, data: { image_key: 'img_boundary' } })
    }
    try {
      assert.equal(MAX_UPLOAD_BYTES, 30 * 1024 * 1024)
      ftruncateSync(fd, MAX_UPLOAD_BYTES + 1)
      assert.equal(await uploadImageKey(path), null)
      assert.equal(calls, 0)
      ftruncateSync(fd, MAX_UPLOAD_BYTES)
      assert.equal(await uploadImageKey(path), 'img_boundary')
      assert.equal(calls, 2)
      console.log('size boundary passed')
    } finally { closeSync(fd); rmSync(root, { recursive: true }) }
  `
  const child = Bun.spawn([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain('size boundary passed')
})
