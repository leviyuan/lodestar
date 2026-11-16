import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the real feishu.ts lookups behind the 1:1 panel without credentials or network:
// the SDK methods they use are replaced in a child process, only requests answered by an
// in-process adapter may pass the real SDK transport, and any other request fails.
async function runIsolated(script: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-p2p-feishu-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "cli_p2p_test"\napp_secret = "secret"\n')
  try {
    const child = Bun.spawn([process.execPath, '--eval', `
      import assert from 'node:assert/strict'
      const lark = await import('@larksuiteoapi/node-sdk')
      const transport = lark.defaultHttpInstance.request.bind(lark.defaultHttpInstance)
      lark.defaultHttpInstance.request = async options => {
        if (typeof options?.adapter !== 'function') throw new Error('unexpected SDK network request')
        return await transport(options)
      }
      globalThis.fetch = async () => { throw new Error('unexpected network request') }
      const feishu = await import('./src/feishu')
      ${script}
    `], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LODESTAR_CONFIG: configFile,
        LODESTAR_DATA_DIR: dataDir,
        HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
        NO_PROXY: '*', no_proxy: '*',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('listChatOwners pages through chat.list with open_id owners and keeps nothing', async () => {
  await runIsolated(`
    const calls = []
    feishu.client.im.chat.list = async args => {
      calls.push(args.params)
      if (!args.params.page_token) return { code: 0, data: { page_token: 'next', items: [
        { chat_id: 'oc_user', name: 'foo', owner_id: 'ou_owner', owner_id_type: 'open_id' },
        { chat_id: 'oc_bot', name: 'bar', owner_id: 'cli_bot', owner_id_type: 'app_id' },
        { chat_id: 'oc_gone', name: 'gone', owner_id: 'ou_owner', chat_status: 'dissolved' },
        { chat_id: 'oc_unnamed', name: '', owner_id: 'ou_owner' },
      ] } }
      return { code: 0, data: { items: [{ chat_id: 'oc_page2', name: 'baz', owner_id: 'ou_other' }] } }
    }

    assert.deepEqual(await feishu.listChatOwners(), [
      { chatId: 'oc_user', name: 'foo', ownerOpenId: 'ou_owner' },
      { chatId: 'oc_bot', name: 'bar', ownerOpenId: null },
      { chatId: 'oc_page2', name: 'baz', ownerOpenId: 'ou_other' },
    ])
    assert.deepEqual(calls, [
      { user_id_type: 'open_id', page_size: 100 },
      { user_id_type: 'open_id', page_size: 100, page_token: 'next' },
    ])
    // The read leaves the chat-name cache alone.
    assert.equal(feishu.chatNameCache.size, 0)

    // A permanent rejection is not retried.
    let attempts = 0
    feishu.client.im.chat.list = async () => { attempts++; return { code: 232025, msg: 'Bot ability is not activated.' } }
    await assert.rejects(feishu.listChatOwners(), /feishu chat\\.list failed code=232025/)
    assert.equal(attempts, 1)
  `)
})

test('lookups stop at the caller deadline: a stalled page is aborted and no further page is requested', async () => {
  await runIsolated(`
    // Pages go through the real SDK transport; a stalled page only ends when its request is aborted.
    const respond = body => config => Promise.resolve({ data: body, status: 200, statusText: 'OK', headers: {}, config })
    const stall = config => new Promise((_, reject) => config.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const viaTransport = adapter => feishu.client.httpInstance.request({ url: 'https://example.invalid/lookup', method: 'GET', adapter })
    const outcome = promise => promise.then(() => null, error => error)

    let pages = 0
    feishu.client.im.chat.list = async () => {
      pages++
      return viaTransport(pages === 1
        ? respond({ code: 0, data: { page_token: 'next', items: [{ chat_id: 'oc_a', name: 'a', owner_id: 'ou_x' }] } })
        : stall)
    }
    let started = Date.now()
    let error = await outcome(feishu.listChatOwners(Date.now() + 300))
    assert.equal(error?.name, 'TimeoutError')
    assert.ok(Date.now() - started < 3_000, 'the stalled page is aborted at the deadline')
    assert.equal(pages, 2)

    // A deadline that has already passed issues no request at all.
    pages = 0
    error = await outcome(feishu.listChatOwners(Date.now() - 1))
    assert.equal(error?.name, 'TimeoutError')
    assert.equal(pages, 0)

    let memberPages = 0
    feishu.client.im.chatMembers.get = async () => {
      memberPages++
      return viaTransport(memberPages === 1
        ? respond({ code: 0, data: { page_token: 'p2', items: [{ member_id: 'ou_other', tenant_key: 't' }] } })
        : stall)
    }
    started = Date.now()
    error = await outcome(feishu.isChatMember('oc_group', 'ou_me', Date.now() + 300))
    assert.equal(error?.name, 'TimeoutError')
    assert.ok(Date.now() - started < 3_000, 'the stalled member page is aborted at the deadline')
    assert.equal(memberPages, 2)
  `)
})

test('isChatMember follows member pages and only compares', async () => {
  await runIsolated(`
    const calls = []
    feishu.client.im.chatMembers.get = async args => {
      calls.push([args.path.chat_id, args.params])
      if (!args.params.page_token) return { code: 0, data: { page_token: 'p2', items: [{ member_id: 'ou_a', tenant_key: 't' }] } }
      return { code: 0, data: { items: [{ member_id: 'ou_b', tenant_key: 't' }] } }
    }

    assert.equal(await feishu.isChatMember('oc_group', 'ou_b'), true)
    assert.equal(await feishu.isChatMember('oc_group', 'ou_missing'), false)
    assert.deepEqual(calls.slice(0, 2), [
      ['oc_group', { member_id_type: 'open_id', page_size: 100 }],
      ['oc_group', { member_id_type: 'open_id', page_size: 100, page_token: 'p2' }],
    ])
    await assert.rejects(feishu.isChatMember('', 'ou_b'), /without chat_id/)
    await assert.rejects(feishu.isChatMember('oc_group', ''), /without open_id/)

    feishu.client.im.chatMembers.get = async () => ({ code: 232011, msg: 'no permission' })
    await assert.rejects(feishu.isChatMember('oc_group', 'ou_b'), /feishu chatMembers\\.get failed code=232011/)
  `)
})

test('after a rename, a same-named cached group cannot borrow the old project name', async () => {
  await runIsolated(`
    const { buildP2pPanelCard } = await import('./src/p2p-panel')
    const REQ = 'ou_' + '1a2b3c4d'.repeat(4)
    const session = (name, chatId) => ({
      sessionName: name, chatId,
      peerSnapshot: () => ({ name, status: 'idle', uptimeMs: 60_000 }),
      workload: async () => ({ background: 0, subagents: 0 }),
    })
    // Project "foo" was renamed away, so its old name has no persisted binding; the requester's own
    // group named "foo" is the only cached chat with that name.
    const running = [session('foo', 'oc_real_foo'), session('foo*fix', 'oc_real_foo_tmp'), session('foo[b]', 'oc_real_foo_wt')]
    feishu.chatNameCache.set('oc_my_foo', 'foo')
    assert.equal(feishu.boundChatIdForSession('foo'), null)
    // The general lookup guesses from the cache; the panel must not.
    assert.equal(feishu.chatIdForSession('foo'), 'oc_my_foo')

    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [
      { chat_id: 'oc_my_foo', name: 'foo', owner_id: REQ, owner_id_type: 'open_id' },
    ] } })
    feishu.client.im.chatMembers.get = async () => ({ code: 0, data: { items: [] } })
    const deps = bound => ({
      runningSessions: () => running,
      listChatOwners: feishu.listChatOwners,
      isChatMember: feishu.isChatMember,
      boundChatIdForSession: bound,
      readAllAccountUsage: async () => [],
      readSysInfo: async () => ({ cpu: null, mem: null, disks: [], services: [], servicesError: null }),
      sendCard: async () => { throw new Error('the builder never sends') },
      sendTextRaw: async () => { throw new Error('the builder never sends') },
    })
    const projects = card => card.body.elements.find(element => element.element_id === 'console_projects').elements[0].content

    assert.equal(projects(await buildP2pPanelCard(REQ, false, deps(feishu.boundChatIdForSession))), '_无_')
    // With the cache guess the requester's group would anchor and expose the old project's groups.
    assert.match(projects(await buildP2pPanelCard(REQ, false, deps(feishu.chatIdForSession))), /foo\\*fix/)

    // Bound again to the real group, the requester's same-named group still does not count.
    feishu.bindSessionToChat('foo', 'oc_real_foo')
    assert.equal(feishu.boundChatIdForSession('foo'), 'oc_real_foo')
    assert.equal(projects(await buildP2pPanelCard(REQ, false, deps(feishu.boundChatIdForSession))), '_无_')
  `)
})
