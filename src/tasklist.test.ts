import { describe, expect, test } from 'bun:test'
import { deleteTasklistRemoteIdempotently, isTasklistAlreadyDeletedError } from './tasklist'

describe('basic tasklist lifecycle', () => {
  test('treats only Feishu not-found as an already committed deletion', async () => {
    expect(isTasklistAlreadyDeletedError({ code: 1470404 })).toBe(true)
    expect(isTasklistAlreadyDeletedError(new Error('failed code=1470404 msg=not found'))).toBe(true)
    expect(isTasklistAlreadyDeletedError({ code: 500 })).toBe(false)
    await expect(deleteTasklistRemoteIdempotently('tl', async () => { throw { code: 1470404 } }))
      .resolves.toBe('already_deleted')
  })

  test('surfaces all other remote delete failures', async () => {
    await expect(deleteTasklistRemoteIdempotently('tl', async () => { throw new Error('permission denied') }))
      .rejects.toThrow('permission denied')
  })
})

test('legacy tasklist bindings never load the owner open_id', () => {
  const script = `
    import { writeFileSync } from 'node:fs'
    import { TASKLIST_MAP_FILE } from './src/paths.ts'
    writeFileSync(TASKLIST_MAP_FILE, JSON.stringify({ project: {
      guid: 'guid', name: 'project[lodestar]', url: 'https://example/url', projectName: 'project',
      ownerOpenId: 'ou_legacy_secret', createdAt: '2026-01-01T00:00:00.000Z',
    } }))
    const { getTasklistBinding } = await import('./src/tasklist.ts')
    process.stdout.write(JSON.stringify(getTasklistBinding('project')))
  `
  const result = Bun.spawnSync([process.execPath, '--preload', './src/test-preload.ts', '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  const binding = JSON.parse(result.stdout.toString())
  expect(binding).toMatchObject({ guid: 'guid', name: 'project[lodestar]', projectName: 'project' })
  expect(binding.ownerOpenId).toBeUndefined()
})
