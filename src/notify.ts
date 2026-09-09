/**
 * Outbound notification HTTP endpoint — any local process can POST a
 * markdown message + project name and it lands in the matching Feishu
 * group as a one-shot interactive card (non-streaming).
 *
 * Default bind: 127.0.0.1:9876. No auth — the daemon trusts loopback
 * on the assumption that anything able to hit this port is already
 * owner-equivalent (same security tier as the bot's stdin and the
 * debug.sock). Do NOT bind 0.0.0.0 without adding your own front-end
 * auth.
 *
 *   POST /notify
 *     Content-Type: application/json
 *     { "project": "feishu",
 *       "text":    "**build done** 12 files",
 *       "title":   "build",                    // optional, default = project
 *       "level":   "info" | "warn" | "error"   // optional, default "info"
 *       "images":  ["/abs/a.png", ...],        // optional, uploaded + embedded
 *       "buttons": [                           // optional, one full-width row each
 *         {"id":"approve","text":"✅ 通过","type":"primary"},
 *         {"id":"reject", "text":"❌ 拒绝","type":"danger"}
 *       ],
 *       "callback": "http://127.0.0.1:9999/hook"  // optional loopback URL (push)
 *     }
 *   For a text-reply card, omit buttons and set "allow_reply": true.
 *   For a plain notification, omit both. All three types support text/images.
 *   → 200 { ok: true, chat_id, message_id, notify_id? }
 *   → 400 bad/empty json or missing/invalid field
 *   → 404 project not bound to any Feishu group
 *   → 502 feishu sendCard failed (network / API rejection)
 *
 *   GET /notify/result/<notify_id>
 *     → 200 {notify_id,project,message_id,resolved,button?,resolved_at?,resolved_by?}
 *     → 404 unknown notify_id
 *
 * Buttons turn the one-shot card into a two-way control that stays on
 * the host. The daemon bakes a `notify_id` into every button. Two ways
 * to read the click back, both loopback-only:
 *   • push — caller pledges a `callback` URL; on tap the daemon POSTs
 *     the choice there (see `notify-callbacks.ts`).
 *   • pull — `callback` omitted; the caller polls
 *     `GET /notify/result/<notify_id>` (or just reads the frozen card).
 *
 *   GET / → plain-text help (so a `curl` from the shell reports a
 *           live server instead of 404).
 *
 * "project" must match a Feishu group name that the daemon already
 * has a chat_id binding for — usually established by sending any
 * message in that group at least once after the daemon started. Run
 * `bun scripts/test-inject.ts "hi"` from the project root if you
 * need to seed the binding without leaving the keyboard.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { log } from './log'
import * as feishu from './feishu'
import { downgradeExternalImagesForCardKit, sanitizeMarkdownForCardKit } from './cards/elements'
import {
  buildNotifyResult,
  get as getCallback,
  register as registerCallback,
  type NotifyButton,
  type NotifyRegistration,
  type NotifyReplyState,
} from './notify-callbacks'

export type Level = 'info' | 'warn' | 'error'
const VALID_LEVELS: ReadonlySet<Level> = new Set(['info', 'warn', 'error'])

export type ButtonType = 'default' | 'primary' | 'danger'
const VALID_BUTTON_TYPES: ReadonlySet<ButtonType> = new Set(['default', 'primary', 'danger'])
/** Button id charset/length — kept tight so it survives round-tripping
 * through Feishu's `value` payload and is safe to echo in logs/toasts. */
const BUTTON_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Button label length cap. Generous (not 1-2 chars) because each button
 * owns its full-width row and may carry a short phrase; a paragraph-long
 * label is a caller mistake worth rejecting rather than rendering. */
const BUTTON_TEXT_MAX = 64
const MIXED_INTERACTION_ERROR = '"buttons" and "allow_reply":true are mutually exclusive; choose button selection or text reply'

export interface ParsedButton {
  id: string
  text: string
  type: ButtonType
}

/** Value payload baked into every notify button — routes the click back
 * to this notify's registration in `handleCardAction`. */
interface NotifyActionValue {
  kind: 'notify_callback'
  notify_id: string
  button_id: string
}

/** Post-click card state. The card transitions through these as a click
 * is processed, replacing the button row with a status marker:
 *   - `processing` (push mode only): click received, push in flight
 *   - `delivered`: push acked 2xx → final success marker
 *   - `failed`: push rejected/timeout → inline failure reason
 *   - `unknown`: external callback succeeded but durable local confirmation
 *                failed — freeze and forbid automatic retry
 *   - `done`: pull / display-only mode — no push, freeze on the verdict
 * `operatorOpenId` is carried in the callback payload for the caller's
 * audit; the card itself shows only the choice + status. */
export type NotifyResolutionStatus = 'processing' | 'delivered' | 'failed' | 'unknown' | 'done'
export interface NotifyResolution {
  status: NotifyResolutionStatus
  buttonId?: string
  kind?: 'text'
  text: string
  operatorOpenId: string
  /** Failure reason — only when `status === 'failed'`. */
  detail?: string
  /** Caller's reply (push mode, `delivered` only) — the text the caller
   * returned in its 2xx callback response. Rendered as its own line on
   * the final card so the caller can report an outcome. Feishu markdown
   * is allowed (caller can format). */
  reply?: string
}

export function buildNotifyCard(opts: {
  title: string
  text: string
  level: Level
  /** Uploaded images, in insertion order. `key==''` marks an upload
   * failure — rendered as an inline red error so the caller sees it. */
  images?: Array<{ key: string; src: string }>
  /** Interactive buttons. Rendered as an equal-weight column_set row.
   * Requires `notifyId` so each button's `value` carries the routing
   * payload back to the click handler. */
  buttons?: ParsedButton[]
  /** Text-reply mode. Mutually exclusive with nonempty buttons. */
  allowReply?: boolean
  notifyId?: string
  /** Post-click status marker — replaces the button row. See
   * {@link NotifyResolutionStatus} for the transitions. */
  resolution?: NotifyResolution
}): object {
  if (opts.allowReply && opts.buttons?.length) throw new Error(MIXED_INTERACTION_ERROR)
  const template = opts.level === 'error' ? 'red'
    : opts.level === 'warn' ? 'yellow'
    : 'blue'
  const emoji = opts.level === 'error' ? '❌'
    : opts.level === 'warn' ? '⚠️'
    : '🔔'
  const interactive = !!((opts.buttons?.length || opts.allowReply) && opts.notifyId)
  const d = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const elements: object[] = []
  for (const img of opts.images ?? []) {
    if (img.key) {
      // Card JSON 2.0 图片组件 tag 固定为 "img"(非 "image"),alt 为必填 struct。
      elements.push({ tag: 'img', img_key: img.key, alt: { tag: 'plain_text', content: 'screenshot' } })
    } else {
      // No silent fallback: surface the failed upload inline so the caller
      // knows which local image never made it onto the card.
      elements.push({ tag: 'markdown', content: `<font color='red'>📷 图片上传失败: ${img.src}</font>` })
    }
  }
  // opts.text 用只降图片、不转义 HTML 的变体:notify 调用方会主动用 <font color='...'>
  // 做彩色强调(上面图片上传失败行就是这么渲染的),全量转义会把它变成字面文本。
  elements.push({ tag: 'markdown', content: downgradeExternalImagesForCardKit(opts.text ?? '') || '_（空消息）_' })

  if (opts.resolution) {
    // Post-click status marker normally replaces the button row. A definite
    // callback failure is the one retryable terminal state, so it keeps the
    // original buttons below the marker; processing/delivered/done/unknown
    // remain non-interactive.
    const r = opts.resolution
    const choice = r.kind === 'text' ? '已回复' : `已选择:${r.text}`
    let marker: string
    if (r.status === 'processing') {
      marker = `<font color='blue'>⏳ ${choice} · 推送中…</font>`
    } else if (r.status === 'failed') {
      marker = `<font color='red'>⚠️ ${r.kind === 'text' ? choice : `已选:${r.text}`} · 回调失败:${sanitizeMarkdownForCardKit(r.detail ?? '未知')} · ${hhmm}</font>`
    } else if (r.status === 'delivered') {
      marker = `<font color='green'>✅ ${choice} · 反馈已送达 · ${hhmm}</font>`
    } else if (r.status === 'unknown') {
      marker = `<font color='red'>⚠️ ${choice} · ${r.kind === 'text' ? '送达状态未知，禁止自动重试' : '外部回调已成功，但本地确认状态未知，禁止自动重试'} · ${hhmm}</font>`
    } else {
      // 'done' — pull / display-only mode (no push to acknowledge).
      marker = `<font color='green'>✅ ${choice} · ${hhmm}</font>`
    }
    elements.push({ tag: 'markdown', content: marker })
    // Caller's reply (push mode, delivered) — its own line below the
    // marker, so the caller can surface an outcome to the group.
    if (r.status === 'delivered' && r.reply) {
      elements.push({ tag: 'markdown', content: sanitizeMarkdownForCardKit(r.reply) })
    }
  }
  const canAnswer = interactive && (!opts.resolution || opts.resolution.status === 'failed')
  if (canAnswer && opts.buttons?.length) {
    // One full-width column whose elements stack vertically ⇒ each
    // button gets its own row, however many there are. Avoids the
    // side-by-side crush when labels are long or there are >3 options.
    elements.push({
      tag: 'column_set',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: opts.buttons!.map((btn) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.text },
          type: btn.type,
          behaviors: [{
            type: 'callback',
            value: {
              kind: 'notify_callback',
              notify_id: opts.notifyId,
              button_id: btn.id,
            } as NotifyActionValue,
          }],
        })),
      }],
    })
  }

  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: `<font color='grey'>via notify · ${hhmm}</font>` })
  if (canAnswer && opts.allowReply) {
    // Text-reply cards have one fixed control at the bottom, after the footer.
    elements.push({ tag: 'column_set', columns: [{
      tag: 'column', width: 'weighted', weight: 1,
      elements: [{
        tag: 'button', text: { tag: 'plain_text', content: '回复' }, type: 'primary',
        behaviors: [{ type: 'callback', value: { kind: 'notify_reply', notify_id: opts.notifyId } }],
      }],
    }] })
  }
  return {
    schema: '2.0',
    // update_multi so the post-click resolved card propagates to every
    // member of the group, not just the clicker. Set only when the card
    // is actually interactive — plain one-shot cards keep the empty default.
    config: interactive ? { update_multi: true } : {},
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${opts.title}` },
      template,
    },
    body: { elements },
  }
}

/** A separate message owns the input conversation; the notification itself
 * remains recognizable while this card changes from waiting to a receipt. */
export function buildNotifyReplyCard(
  reg: NotifyRegistration,
  state: NotifyReplyState,
  resolution?: { status: NotifyResolutionStatus; detail?: string; reply?: string },
): object {
  const status = resolution?.status ?? state.status
  const labels: Record<string, string> = {
    waiting: '等待用户输入', sending: '正在发送回复', processing: '正在发送回复',
    delivered: '回复已送达', done: '回复已记录', failed: '回复发送失败',
    cancelled: '已取消回复', unknown: '回复送达状态未知',
  }
  const elements: object[] = [{ tag: 'markdown', content: `通知：${sanitizeMarkdownForCardKit(reg.title)}` }]
  if (state.response) elements.push({ tag: 'markdown', content: sanitizeMarkdownForCardKit(state.response.text) })
  if (status === 'waiting') {
    elements.push({ tag: 'markdown', content: `<at id=${state.openId}></at> 请在群里发送一条文字消息作为回复。\n你的下一条文字优先用于这条通知，完成后再回答 Agent 的提问。点击其他通知的「回复」会放弃本次回复；群控制命令仍然优先。` })
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '取消回复' }, type: 'default',
      behaviors: [{ type: 'callback', value: { kind: 'notify_reply_cancel', notify_id: reg.notifyId, reply_id: state.id } }],
    })
  }
  if (status === 'cancelled' && state.cancelReason === 'switched') {
    elements.push({ tag: 'markdown', content: '已切换到另一条通知，本次回复已放弃。' })
  }
  const detail = resolution?.detail ?? state.error
  if (detail) elements.push({ tag: 'markdown', content: `<font color='red'>${sanitizeMarkdownForCardKit(detail)}</font>` })
  if (status === 'failed') elements.push({ tag: 'markdown', content: '请点击原通知的「回复」按钮后重新输入。' })
  if (status === 'unknown') elements.push({ tag: 'markdown', content: '无法确认是否已送达，请联系通知发起方核实；已禁止自动重试。' })
  if (resolution?.reply) elements.push({ tag: 'markdown', content: sanitizeMarkdownForCardKit(resolution.reply) })
  return {
    schema: '2.0', config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: labels[status] },
      template: status === 'failed' || status === 'unknown' ? 'red'
        : status === 'delivered' || status === 'done' ? 'green' : 'blue',
    },
    body: { elements },
  }
}

/** Validate the `buttons` array from the request body. Returns the
 * parsed buttons or a single `{error}` — never throws, never coerces
 * bad input into a "safe" default. Empty array ⇒ no buttons (caller
 * treats as absent). */
export function parseButtons(raw: unknown): { buttons?: ParsedButton[]; error?: string } {
  if (raw === undefined || raw === null) return { buttons: [] }
  if (!Array.isArray(raw)) return { error: '"buttons" must be an array' }
  if (raw.length === 0) return { buttons: [] }
  // No count cap: each button stacks on its own row, so any number the
  // caller supplies renders. (Feishu's own element-count limit, if a
  // pathological payload ever hits it, surfaces as a sendCard 502.)
  const seen = new Set<string>()
  const out: ParsedButton[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'each button must be an object' }
    const id = String((entry as any).id ?? '').trim()
    const text = String((entry as any).text ?? '').trim()
    if (!BUTTON_ID_RE.test(id)) {
      return { error: `button id "${id.slice(0, 32)}" invalid (need ^[A-Za-z0-9_-]{1,64}$)` }
    }
    if (!text) return { error: `button "${id}" missing text` }
    if (text.length > BUTTON_TEXT_MAX) {
      return { error: `button "${id}" text > ${BUTTON_TEXT_MAX} chars` }
    }
    if (seen.has(id)) return { error: `button id "${id}" duplicated` }
    seen.add(id)
    const typeRaw = String((entry as any).type ?? 'default').toLowerCase()
    const type: ButtonType = VALID_BUTTON_TYPES.has(typeRaw as ButtonType)
      ? (typeRaw as ButtonType)
      : 'default'
    out.push({ id, text, type })
  }
  return { buttons: out }
}

/** Validate the `callback` URL — must be loopback HTTP, matching the
 * "本机内的 http" contract. Non-loopback / https / garbage ⇒ `{error}`
 * with the actual reason; never silently widened. */
export function parseCallbackUrl(raw: unknown): { url?: string; error?: string } {
  if (raw === undefined || raw === null) return {}  // absent — caller decides if that's allowed
  const s = String(raw).trim()
  if (!s) return {}
  let u: URL
  try { u = new URL(s) } catch { return { error: `"callback" bad URL: "${s.slice(0, 64)}"` } }
  if (u.protocol !== 'http:') {
    return { error: `"callback" must be http (本机内), got "${u.protocol}"` }
  }
  // `URL.hostname` keeps the brackets for IPv6 ("[::1]"); strip them so
  // the loopback set matches the bare address.
  const h = u.hostname.replace(/^\[|]$/g, '')
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') {
    return { error: `"callback" must be loopback (本机内), got "${u.hostname}"` }
  }
  return { url: s }
}

export interface NotifyOptions {
  bind: string
  port: number
  extraHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
}

export function startNotifyServer(opts: NotifyOptions): void {
  // node:http instead of Bun.serve so the same source runs on both
  // Bun (dev: `bun daemon.ts`) and Node (prod: `npm i -g @leviyuan/lodestar`).
  // Bun has full node:http compat so dev behavior is byte-for-byte preserved.
  try {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const work = opts.extraHandler
        ? opts.extraHandler(req, res, url).then(handled => handled ? undefined : handleNotifyRequest(req, res))
        : handleNotifyRequest(req, res)
      work.catch((err: any) => {
        log(`notify: handler crash: ${err?.message ?? err}`)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('internal error')
        } else {
          try { res.end() } catch {}
        }
      })
    })
    server.on('error', (err: Error) => {
      log(`notify: server bind failed (${opts.bind}:${opts.port}): ${err.message}`)
    })
    server.listen(opts.port, opts.bind, () => {
      log(`notify: HTTP listening at http://${opts.bind}:${opts.port}/notify`)
    })
  } catch (e) {
    log(`notify: server bind failed (${opts.bind}:${opts.port}): ${e}`)
  }
}

export async function handleNotifyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: Pick<typeof feishu, 'sanitizeSessionName' | 'chatIdForSession' | 'uploadImageKey' | 'sendCard'> = feishu,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  const sendText = (status: number, body: string): void => {
    res.statusCode = status
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(body)
  }
  const sendJson = (status: number, obj: object): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(obj))
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendText(200,
      'lodestar notify\n' +
      'POST /notify        body={project,text,title?,level?,images?,buttons?,allow_reply?,callback?}  → push card to group\n' +
      'GET  /notify/result/<notify_id>  → poll a button choice or text reply (pull mode, no callback server)\n' +
      'GET  /agents/identities; POST/GET/DELETE /agents/runs[/<id>]  → capability-protected delegated Agents\n' +
      'levels: info|warn|error (default info); images=[/abs/*.png] uploaded + embedded\n' +
      'card types: plain (neither field), selection (buttons), text reply (allow_reply:true); do not combine buttons and allow_reply:true\n' +
      'all types support text + images; callback=http://127.0.0.1:PORT/path optional for selection/reply (push) — omit to poll\n')
  }
  // Pull mode: stateless callers retrieve a button card's verdict
  // without running a callback server. Returns resolved:false while
  // pending; the chosen button + operator once a click froze the card.
  if (req.method === 'GET' && url.pathname.startsWith('/notify/result/')) {
    const id = decodeURIComponent(url.pathname.slice('/notify/result/'.length)).trim()
    if (!id) return sendText(400, 'missing notify_id in path')
    const reg = getCallback(id)
    if (!reg) return sendJson(404, { error: 'unknown notify_id', notify_id: id })
    return sendJson(200, buildNotifyResult(reg))
  }
  if (req.method !== 'POST' || url.pathname !== '/notify') {
    return sendText(405, 'use POST /notify')
  }

  let raw = ''
  for await (const chunk of req) raw += chunk.toString()
  let body: any = {}
  try { body = JSON.parse(raw) } catch { return sendText(400, 'bad json') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendText(400, 'body must be an object')
  if (body.allow_reply !== undefined && typeof body.allow_reply !== 'boolean') {
    return sendText(400, '"allow_reply" must be a boolean')
  }
  const allowReply = body.allow_reply === true

  const project = String(body.project ?? '').trim()
  const text = String(body.text ?? '')
  const titleRaw = String(body.title ?? '').trim()
  const levelRaw = String(body.level ?? 'info').toLowerCase()
  if (!project) return sendText(400, 'missing "project"')
  if (!text)    return sendText(400, 'missing "text"')

  const { buttons, error: buttonsError } = parseButtons(body.buttons)
  if (buttonsError) return sendText(400, buttonsError)
  const { url: callbackUrl, error: callbackError } = parseCallbackUrl(body.callback)
  if (callbackError) return sendText(400, callbackError)
  // Buttons + callback is the push model (daemon POSTs the click).
  // Buttons without callback is the pull / display-only model: the
  // caller polls GET /notify/result/<id>, or just reads the frozen card.
  // Either way the card must be registered so the click can freeze it.
  const hasButtons = !!(buttons && buttons.length)
  if (hasButtons && allowReply) return sendText(400, MIXED_INTERACTION_ERROR)
  const interactive = hasButtons || allowReply
  const callbackUrlOrDefault = callbackUrl ?? ''

  const level: Level = (VALID_LEVELS.has(levelRaw as Level) ? levelRaw : 'info') as Level
  const title = titleRaw || project

  const sessionName = transport.sanitizeSessionName(project)
  const chatId = transport.chatIdForSession(sessionName)
  if (!chatId) {
    log(`notify: project "${project}" (sanitized "${sessionName}") has no chat binding → 404`)
    return sendText(404,
      `project "${project}" not bound — send any message in that Feishu group at least once after the daemon started, then retry`)
  }

  const imageInputs = Array.isArray(body.images) ? body.images : []
  const images: Array<{ key: string; src: string }> = []
  for (const entry of imageInputs) {
    const src = String(entry ?? '').trim()
    if (!src) continue
    const key = await transport.uploadImageKey(src)
    images.push({ key: key ?? '', src })
  }

  // notify_id is generated up-front so it can be baked into every
  // button's `value` payload BEFORE sendCard. The registration (which
  // needs message_id) is filled in after the card is accepted.
  const notifyId = interactive ? `nf_${randomUUID()}` : ''
  const card = buildNotifyCard({ title, text, level, images, buttons, allowReply, notifyId })
  const messageId = await transport.sendCard(chatId, card)
  if (!messageId) {
    log(`notify: sendCard failed → 502 (project="${project}" chat=${chatId.slice(0, 8)}…)`)
    return sendText(502, 'feishu sendCard failed (see daemon log)')
  }

  if (interactive && notifyId) {
    const reg: NotifyRegistration = {
      notifyId,
      callbackUrl: callbackUrlOrDefault,
      chatId,
      messageId,
      project,
      title,
      text,
      level,
      imageKeys: images,
      buttons: buttons as NotifyButton[],
      allowReply,
      createdAt: Date.now(),
    }
    registerCallback(reg)
  }

  log(`notify: → ${project} (${chatId.slice(0, 8)}…) level=${level} bytes=${text.length} images=${images.length} buttons=${buttons?.length ?? 0} allowReply=${allowReply} push=${interactive && !!callbackUrlOrDefault ? 1 : 0} msg=${messageId}`)
  sendJson(200, {
    ok: true,
    chat_id: chatId,
    message_id: messageId,
    ...(notifyId ? { notify_id: notifyId } : {}),
  })
}

// Daemon-side handle to rebuild a post-click card from a stored
// registration without re-deriving the param shape.
export function buildNotifyCardFromReg(
  reg: NotifyRegistration,
  resolution: NotifyResolution,
): object {
  return buildNotifyCard({
    title: reg.title,
    text: reg.text,
    level: reg.level,
    images: reg.imageKeys,
    buttons: reg.buttons,
    allowReply: reg.allowReply,
    notifyId: reg.notifyId,
    resolution,
  })
}
