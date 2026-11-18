import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the real feishu.ts primitives for external-contact temp groups without
// credentials or network: every SDK method used is replaced in the child process,
// and the SDK transport itself rejects any request that was not stubbed.
async function runIsolated(script: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-external-temp-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, '[feishu]\napp_id = "cli_external_test"\napp_secret = "secret"\n')
  try {
    const child = Bun.spawn([process.execPath, '--eval', `
      import assert from 'node:assert/strict'
      const lark = await import('@larksuiteoapi/node-sdk')
      // Only requests answered by an in-process adapter may pass the SDK transport.
      const transport = lark.defaultHttpInstance.request.bind(lark.defaultHttpInstance)
      lark.defaultHttpInstance.request = async options => {
        if (typeof options?.adapter !== 'function') throw new Error('unexpected SDK network request')
        return await transport(options)
      }
      globalThis.fetch = async () => { throw new Error('unexpected network request') }
      const feishu = await import('./src/feishu')
      const sdkFailure = (status, data, logId) => () => feishu.client.httpInstance.request({
        url: 'https://example.invalid/rejected',
        adapter: async () => { throw Object.assign(new Error('Request failed with status code ' + status), {
          response: { status, data, headers: { 'x-tt-logid': logId } },
        }) },
      })
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

// Real open_id shape: ou_ + 32 lowercase hex characters.
const IDS = `
  const guest = 'ou_' + 'a1b2c3d4'.repeat(4)
  const owner = 'ou_' + 'f0e1d2c3'.repeat(4)
  const member = 'ou_' + '0123abcd'.repeat(4)
`

test('temp chat creation names the source group owner only for an external requester', async () => {
  await runIsolated(`
    ${IDS}
    const calls = []
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [] } })
    feishu.client.im.chat.create = async args => {
      calls.push(args)
      return { code: 0, data: { chat_id: 'oc_new_' + calls.length } }
    }

    // 内部成员的请求体与改动前逐字节相同（含键顺序）。
    const internal = name => JSON.stringify({ name, user_id_list: [member], group_message_type: 'chat' })
    assert.deepEqual(await feishu.createTempChatForSession('project*0821-1200', member), { chatId: 'oc_new_1', created: true, joined: true })
    assert.equal(JSON.stringify(calls[0].data), internal('project*0821-1200'))
    assert.equal(JSON.stringify(calls[0].data), '{"name":"project*0821-1200","user_id_list":["' + member + '"],"group_message_type":"chat"}')
    assert.deepEqual(Object.keys(calls[0].params), ['user_id_type', 'uuid'])
    assert.equal(calls[0].params.user_id_type, 'open_id')

    // 指定群主即外部群：显式声明 external，不靠成员里恰好有外部联系人。
    await feishu.ensureTempChatForSession('project*0821-1201', guest, 'create', owner)
    assert.equal(JSON.stringify(calls[1].data), JSON.stringify({
      name: 'project*0821-1201', owner_id: owner, user_id_list: [guest, owner], group_message_type: 'chat', external: true,
    }))

    // 带备注的 btw：同名群不存在时同样由群主建外部群。
    await feishu.ensureTempChatForSession('project*修复登录', guest, 'reuse', owner)
    assert.deepEqual(calls[2].data, {
      name: 'project*修复登录', owner_id: owner, user_id_list: [guest, owner], group_message_type: 'chat', external: true,
    })
    await feishu.ensureTempChatForSession('project*评审', member, 'reuse')
    assert.equal(JSON.stringify(calls[3].data), internal('project*评审'))
    // wt 等其他入口仍走原请求体。
    await feishu.ensureChatForSession('project[feature]', member)
    assert.equal(JSON.stringify(calls[4].data), internal('project[feature]'))

    await feishu.createTempChatForSession('project*0821-1202', owner, owner)
    assert.deepEqual(calls[5].data.user_id_list, [owner])

    // 本企业成员在外部群里发起：自己当群主，只有自己一个初始成员，仍是外部群。
    await feishu.ensureTempChatForSession('project*0821-1203', member, 'create', member, false)
    assert.equal(JSON.stringify(calls[6].data), JSON.stringify({
      name: 'project*0821-1203', owner_id: member, user_id_list: [member], group_message_type: 'chat', external: true,
    }))
    await feishu.ensureTempChatForSession('project*外部评审', member, 'reuse', member, false)
    assert.deepEqual(calls[7].data, {
      name: 'project*外部评审', owner_id: member, user_id_list: [member], group_message_type: 'chat', external: true,
    })
  `)
})

test('external group requests explain 232033; members of the bot tenant get no external-contact hints', async () => {
  await runIsolated(`
    ${IDS}
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [] } })
    const create = (code, msg, logId) => {
      feishu.client.im.chat.create = async () => ({ code, msg, error: { log_id: logId } })
    }
    create(232033, 'The operator or invited bots does NOT have the authority to manage external chats.', 'ext-log')
    for (const [user, ownerId, external] of [[member, member, false], [guest, owner, true]]) {
      await assert.rejects(feishu.ensureTempChatForSession('project*0821-1300', user, 'create', ownerId, external), error => {
        assert.match(error.message, /code=232033.*log_id=ext-log/)
        assert.match(error.message, /机器人没有外部群权限：应用须在「对外共享」中允许机器人被添加到外部群/)
        return true
      })
    }
    // 本企业成员自己当群主时，232043 不套外部联系人的单聊确认提示。
    create(232043, 'Your request contains unavailable ids, ext=bot is invisible to user ids: [' + member + ']', 'own-log')
    await assert.rejects(feishu.ensureTempChatForSession('project*0821-1301', member, 'create', member, false), error => {
      assert.match(error.message, /code=232043.*log_id=own-log/)
      assert.doesNotMatch(error.message, /外部联系人|单聊/)
      assert.doesNotMatch(error.message, new RegExp(member))
      return true
    })
    // 内部群（不指定群主）不加任何外部群提示。
    create(232033, 'denied', 'internal-log')
    await assert.rejects(feishu.ensureTempChatForSession('project*0821-1302', member), error => {
      assert.match(error.message, /code=232033.*log_id=internal-log/)
      assert.doesNotMatch(error.message, /对外共享/)
      return true
    })
  `)
})

test('a 232043 hint names the member Feishu lists: requester, owner or both', async () => {
  await runIsolated(`
    ${IDS}
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [] } })
    const invisible = (...ids) => ({
      code: 232043,
      msg: 'Your request contains unavailable ids, ext=bot is invisible to user ids: [' + ids.join(', ') + ']',
      error: { log_id: 'create-body-log' },
    })
    const rejectWith = async (body, check) => {
      feishu.client.im.chat.create = async () => body
      await assert.rejects(feishu.createTempChatForSession('project*0821-1300', guest, owner), error => {
        assert.match(error.message, /^feishu chat\\.create failed code=232043 /)
        assert.match(error.message, /log_id=create-body-log/)
        if (/user ids/.test(body.msg)) assert.match(error.message, /user ids: \\[…\\]/)
        assert.doesNotMatch(error.message, /ou_[0-9a-f]{32}/)
        assert.doesNotMatch(String(error.apiMessage), /ou_[0-9a-f]{32}/)
        assert.equal(error.code, 232043)
        check(error.message)
        return true
      })
    }
    const requesterHint = /外部联系人须先点开机器人发起单聊并确认，应用也须在「对外共享」中开启「允许外部用户与机器人单聊」/
    const ownerHint = /群主不在应用的可用范围内：请在开发者后台的「可用范围」里加入群主后重试/
    const combinedHint = /机器人看不到请求里的成员：.*群主须在应用的「可用范围」内/

    await rejectWith(invisible(guest), message => {
      assert.match(message, requesterHint)
      assert.doesNotMatch(message, ownerHint)
    })
    await rejectWith(invisible(owner), message => {
      assert.match(message, ownerHint)
      assert.doesNotMatch(message, /须先点开机器人/)
    })
    await rejectWith(invisible(guest, owner), message => assert.match(message, combinedHint))
    await rejectWith({ code: 232043, msg: 'Your request contains unavailable ids', error: { log_id: 'create-body-log' } }, message => {
      assert.match(message, combinedHint)
      assert.match(message, /message=Your request contains unavailable ids log_id/)
    })

    // HTTP 4xx 由 SDK 抛出的同一拒绝（log_id 只在响应头里）。
    feishu.client.im.chat.create = sdkFailure(400, { code: 232043, msg: invisible(guest).msg }, 'create-http-log')
    await assert.rejects(feishu.ensureTempChatForSession('project*0821-1301', guest, 'create', owner), error => {
      assert.match(error.message, /code=232043.*log_id=create-http-log/)
      assert.match(error.message, requesterHint)
      assert.doesNotMatch(error.message, new RegExp(guest))
      return true
    })

    // 内部成员：不加外部联系人提示，但同样不回显成员 ID。
    feishu.client.im.chat.create = async () => ({ ...invisible(member), error: { log_id: 'internal-log' } })
    await assert.rejects(feishu.createTempChatForSession('project*0821-1302', member), error => {
      assert.match(error.message, /code=232043.*log_id=internal-log/)
      assert.doesNotMatch(error.message, /外部联系人|可用范围/)
      assert.doesNotMatch(error.message, new RegExp(member))
      return true
    })
  `)
})

test('an external requester joining an existing group needs no owner and still gets the join hints', async () => {
  await runIsolated(`
    ${IDS}
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [{ chat_id: 'oc_internal', name: 'project*修复登录', chat_status: 'normal' }] } })
    feishu.client.im.chatMembers.get = async () => ({ code: 0, data: { items: [{ member_id: member, tenant_key: 'tenant_app' }] } })
    feishu.client.im.chat.create = async () => { throw new Error('an existing group must be joined, not created') }
    const added = []
    feishu.client.im.chatMembers.create = async args => {
      added.push(args)
      return { code: 232028, msg: 'External members can Not be added to an internal group chat: [' + guest + ']', error: { log_id: 'join-log' } }
    }
    await assert.rejects(feishu.ensureTempChatForSession('project*修复登录', guest, 'reuse', undefined, true), error => {
      assert.match(error.message, /code=232028/)
      assert.match(error.message, /log_id=join-log/)
      assert.match(error.message, /外部联系人不能加入内部群；请换一个备注新建临时群/)
      assert.doesNotMatch(error.message, new RegExp(guest))
      return true
    })
    assert.deepEqual(added[0].data, { id_list: [guest] })

    feishu.client.im.chatMembers.create = sdkFailure(400, {
      code: 232043, msg: 'Your request contains unavailable ids, ext=bot is invisible to user ids: [' + guest + ']',
    }, 'join-http-log')
    await assert.rejects(feishu.ensureTempChatForSession('project*修复登录', guest, 'reuse', undefined, true), error => {
      assert.match(error.message, /code=232043.*log_id=join-http-log/)
      assert.match(error.message, /外部联系人须先点开机器人发起单聊并确认/)
      assert.doesNotMatch(error.message, new RegExp(guest))
      return true
    })

    // 内部成员加入时不加外部联系人提示。
    const newcomer = 'ou_' + '9876fedc'.repeat(4)
    feishu.client.im.chatMembers.create = async () => ({ code: 232028, msg: 'External members can Not be added', error: { log_id: 'internal-join' } })
    await assert.rejects(feishu.ensureTempChatForSession('project*修复登录', newcomer, 'reuse'), error => {
      assert.match(error.message, /code=232028.*log_id=internal-join/)
      assert.doesNotMatch(error.message, /外部联系人不能加入/)
      return true
    })
  `)
})

test('the temp group owner must be a person of the bot tenant other than the requester', async () => {
  await runIsolated(`
    const gets = []
    const pages = []
    let chat = { owner_id: 'ou_owner', owner_id_type: 'open_id', external: true }
    let ownerItem = { member_id: 'ou_owner', tenant_key: 'tenant_app' }
    feishu.client.im.chat.get = async args => { gets.push(args); return { code: 0, data: chat } }
    feishu.client.im.chatMembers.get = async args => {
      pages.push(args.params.page_token ?? null)
      return args.params.page_token
        ? { code: 0, data: { items: ownerItem ? [ownerItem] : [] } }
        : { code: 0, data: { items: [{ member_id: 'ou_guest', tenant_key: 'tenant_other' }], page_token: 'page-2' } }
    }

    assert.equal(await feishu.resolveTempGroupOwner('oc_source', 'ou_guest', 'tenant_app'), 'ou_owner')
    assert.deepEqual(gets[0], { path: { chat_id: 'oc_source' }, params: { user_id_type: 'open_id' } })
    assert.deepEqual(pages, [null, 'page-2'])
    assert.deepEqual(pages.length, 2)

    const rejects = async (expected) => {
      await assert.rejects(feishu.resolveTempGroupOwner('oc_source', 'ou_guest', 'tenant_app'), error => {
        assert.match(error.message, expected)
        assert.match(error.message, /本企业成员/)
        assert.doesNotMatch(error.message, /ou_/)
        return true
      })
    }
    chat = { owner_id: 'cli_bot_app', owner_id_type: 'app_id', external: false }
    pages.length = 0
    await rejects(/群主不是用户（可能是机器人）/)
    assert.deepEqual(pages, [])
    chat = { owner_id: 'ou_guest', owner_id_type: 'open_id', external: true }
    await rejects(/群主就是发起人本人/)
    chat = { owner_id: 'ou_owner', owner_id_type: 'open_id', external: true }
    ownerItem = { member_id: 'ou_owner', tenant_key: 'tenant_other' }
    await rejects(/群主不属于机器人所在企业/)
    ownerItem = { member_id: 'ou_owner' }
    await rejects(/无法确认当前群群主的所属企业/)
    ownerItem = null
    await rejects(/群主不在成员列表中/)

    feishu.client.im.chat.get = async () => ({ code: 232010, msg: 'no permission', error: { log_id: 'owner-get-log' } })
    await assert.rejects(feishu.resolveTempGroupOwner('oc_source', 'ou_guest', 'tenant_app'), /code=232010.*log_id=owner-get-log/)
    await assert.rejects(feishu.resolveTempGroupOwner('oc_source', 'ou_guest', ''), /无法确认机器人所在企业/)
  `)
})

test('an external group is left by the bot instead of deleted; internal groups are still deleted', async () => {
  await runIsolated(`
    let chat = { name: 'project*外部', chat_status: 'normal', external: true }
    feishu.client.im.chat.get = async () => ({ code: 0, data: chat })
    const deleted = []
    feishu.client.im.chat.delete = async args => { deleted.push(args); return { code: 0 } }
    const removed = []
    feishu.client.im.chatMembers.delete = async args => { removed.push(args); return { code: 0, data: { invalid_id_list: [] } } }

    assert.equal(await feishu.isExternalChat('oc_external'), true)
    assert.deepEqual(await feishu.disbandChatForSessionExact('project*外部', 'oc_external'), { chatId: 'oc_external', disbanded: false, left: true })
    assert.deepEqual(deleted, [])
    assert.deepEqual(removed, [{
      path: { chat_id: 'oc_external' }, params: { member_id_type: 'app_id' }, data: { id_list: ['cli_external_test'] },
    }])

    // 名称或状态不符时仍拒绝，不退群。
    await assert.rejects(feishu.disbandChatForSessionExact('project*别的群', 'oc_external'), /expected name/)
    assert.equal(removed.length, 1)

    chat = { name: 'project*内部', chat_status: 'normal' }
    assert.equal(await feishu.isExternalChat('oc_internal'), false)
    assert.deepEqual(await feishu.disbandChatForSessionExact('project*内部', 'oc_internal'), { chatId: 'oc_internal', disbanded: true })
    assert.deepEqual(deleted, [{ path: { chat_id: 'oc_internal' } }])
    assert.equal(removed.length, 1)

    feishu.client.im.chatMembers.delete = async () => ({ code: 0, data: { invalid_id_list: ['cli_external_test'] } })
    await assert.rejects(feishu.leaveChatAsBot('oc_external'), /机器人退群/)
    feishu.client.im.chatMembers.delete = async () => ({ code: 232033, msg: 'operation not allowed', error: { log_id: 'leave-log' } })
    await assert.rejects(feishu.leaveChatAsBot('oc_external'), /code=232033.*log_id=leave-log/)
    feishu.client.im.chat.get = async () => ({ code: 232010, msg: 'no permission', error: { log_id: 'status-log' } })
    await assert.rejects(feishu.isExternalChat('oc_unread'), /code=232010.*log_id=status-log/)
  `)
})

test('wt groups use the temp group request rule and a WT-specific join hint', async () => {
  await runIsolated(`
    ${IDS}
    const calls = []
    let existing = []
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: existing } })
    feishu.client.im.chat.create = async args => { calls.push(args); return { code: 0, data: { chat_id: 'oc_wt_' + calls.length } } }

    // 内部群里的本企业成员：请求体与改动前逐字节相同。
    await feishu.ensureWorktreeChatForSession('project[feature]', member)
    assert.equal(JSON.stringify(calls[0].data), JSON.stringify({ name: 'project[feature]', user_id_list: [member], group_message_type: 'chat' }))
    // 外部群里的本企业成员：自己当群主的外部群。
    await feishu.ensureWorktreeChatForSession('project[other]', member, member, false)
    assert.deepEqual(calls[1].data, {
      name: 'project[other]', owner_id: member, user_id_list: [member], group_message_type: 'chat', external: true,
    })

    // 外部联系人加入已存在的内部 WT 群：给 WT 的说明，不提「换备注」。
    existing = [{ chat_id: 'oc_internal_wt', name: 'project[shared]', chat_status: 'normal' }]
    feishu.client.im.chatMembers.get = async () => ({ code: 0, data: { items: [{ member_id: member, tenant_key: 'tenant_app' }] } })
    feishu.client.im.chatMembers.create = async () => ({ code: 232028, msg: 'External members can Not be added to an internal group chat: [' + guest + ']', error: { log_id: 'wt-join' } })
    await assert.rejects(feishu.ensureWorktreeChatForSession('project[shared]', guest, undefined, true), error => {
      assert.match(error.message, /code=232028.*log_id=wt-join/)
      assert.match(error.message, /这个 WT 群建成时是内部群/)
      assert.doesNotMatch(error.message, /换一个备注/)
      assert.doesNotMatch(error.message, new RegExp(guest))
      return true
    })
  `)
})

test('disbanding a WT group by name leaves an external group to its owner and deletes an internal one', async () => {
  await runIsolated(`
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [
      { chat_id: 'oc_ext_wt', name: 'project[ext]', chat_status: 'normal' },
      { chat_id: 'oc_int_wt', name: 'project[int]', chat_status: 'normal' },
    ] } })
    feishu.client.im.chat.get = async args => ({ code: 0, data: { external: args.path.chat_id === 'oc_ext_wt', chat_status: 'normal' } })
    const deleted = []
    feishu.client.im.chat.delete = async args => { deleted.push(args.path.chat_id); return { code: 0 } }
    const left = []
    feishu.client.im.chatMembers.delete = async args => { left.push(args.path.chat_id); return { code: 0, data: { invalid_id_list: [] } } }

    assert.deepEqual(await feishu.disbandChatForSession('project[ext]'), { chatId: 'oc_ext_wt', disbanded: false, left: true })
    assert.deepEqual(left, ['oc_ext_wt'])
    assert.deepEqual(deleted, [])
    assert.deepEqual(await feishu.disbandChatForSession('project[int]'), { chatId: 'oc_int_wt', disbanded: true })
    assert.deepEqual(deleted, ['oc_int_wt'])
    assert.deepEqual(left, ['oc_ext_wt'])
  `)
})

test('when a same-name group an external contact meant to join vanishes before the lock, it is not recreated internally', async () => {
  await runIsolated(`
    ${IDS}
    // Pre-check saw a group (external contact gets externalRequester:true, no owner), but it is gone now.
    feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [] } })
    feishu.client.im.chat.create = async () => { throw new Error('must not create an internal group of only the external user') }
    for (const sessionName of ['project*修复登录', 'project[feature]']) {
      await assert.rejects(
        sessionName.includes('[')
          ? feishu.ensureWorktreeChatForSession(sessionName, guest, undefined, true)
          : feishu.ensureTempChatForSession(sessionName, guest, 'reuse', undefined, true),
        /同名群已不存在，请重试/,
      )
    }
    // An internal member whose reuse group vanished still creates it (owning an internal group is fine).
    const calls = []
    feishu.client.im.chat.create = async args => { calls.push(args); return { code: 0, data: { chat_id: 'oc_new' } } }
    await feishu.ensureTempChatForSession('project*评审', member, 'reuse')
    assert.equal(calls.length, 1)
  `)
})

test('a transient failure reading the group type is retried instead of failing btw / fk / wt', async () => {
  await runIsolated(`
    let attempts = 0
    feishu.client.im.chat.get = async () => {
      attempts++
      if (attempts === 1) await sdkFailure(503, { code: 0, msg: 'service unavailable' }, 'flaky-log')()
      return { code: 0, data: { external: true } }
    }
    assert.equal(await feishu.isExternalChat('oc_flaky'), true)
    assert.equal(attempts, 2)
  `)
})

test('a group type read once is remembered, because Feishu cannot change it; a missing field is not', async () => {
  await runIsolated(`
    const gets = []
    let data = { name: 'project', chat_status: 'normal', external: true }
    feishu.client.im.chat.get = async args => { gets.push(args.path.chat_id); return { code: 0, data } }
    assert.equal(await feishu.isExternalChat('oc_source'), true)
    data = { name: 'project', chat_status: 'normal', external: false }
    assert.equal(await feishu.isExternalChat('oc_source'), true)
    assert.deepEqual(gets, ['oc_source'])

    // No field: treated as internal as before, but asked again next time.
    data = { name: 'other', chat_status: 'normal' }
    assert.equal(await feishu.isExternalChat('oc_other'), false)
    data = { name: 'other', chat_status: 'normal', external: true }
    assert.equal(await feishu.isExternalChat('oc_other'), true)
    assert.equal(await feishu.isExternalChat('oc_other'), true)
    assert.deepEqual(gets, ['oc_source', 'oc_other', 'oc_other'])
  `)
})
