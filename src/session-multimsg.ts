import type { Session } from './session'
import * as feishu from './feishu'
import { parseInboundMarker } from './inbound-markers'

export interface MultiMsgSegment {
  text: string
  files: string[]
  userOpenId: string
  msgId: string
}

/**
 * 入站多条消息缓冲状态机。返回 true 表示这条已被缓冲或已 flush 合并,
 * daemon 不应再调 onUserMessage;false 表示直通(普通单条消息)。
 *
 *   `>>>`(≥3) 开头 → 开启缓冲(已开启则丢弃旧缓冲重开),本条去标记后进缓冲
 *   `<<<`(≥3) 开头 → 把本条(去标记)作为末段,合并整批一次性 onUserMessage
 *   缓冲进行中的普通消息 → 原样追加
 *   不在缓冲时收到 `<<<` → body 有内容则当普通消息直通,空则忽略
 *
 * 缓冲期间每条打 📌 (OneSecond) 表示"已收录待合并";flush 时统一释放 📌,
 * 合并消息走正常 turn 生命周期。stop/kill/restart/clear 经
 * {@link clearMultiMsgBuffer} 丢弃缓冲并给每条打 ❌ (CrossMark)。
 *
 * 永不超时——一直等到 `<<<` 或被控制命令清掉。缓冲只活在内存里,
 * daemon 重启会丢(session.stop/restart/exit 三处都会打 ❌ 让失败可见,
 * 符合 no_fallbacks:不静默吞消息)。
 */
export async function onMultiMessageInbound(
  s: Session,
  text: string,
  files: string[],
  userOpenId: string,
  msgId: string,
): Promise<boolean> {
  const { marker, body } = parseInboundMarker(text)

  if (marker === 'start') {
    const reopening = s.multiMsgBuffer !== null
    if (reopening && s.multiMsgBuffer!.length > 0) {
      clearMultiMsgBuffer(s, 'reopen')
    }
    s.multiMsgBuffer = []
    // 不另发"收集中"文本提示 —— 每条上的 reaction 表情本身就是反馈,
    // 再发文本会跟表情重复刷屏(用户反馈 2026-07-02)。
    pushSegment(s, body, files, userOpenId, msgId)
    return true
  }

  if (marker === 'end') {
    if (s.multiMsgBuffer === null) {
      // 没在缓冲却收到收尾标记:body 有内容当普通消息直通,空则忽略
      if (body.trim() || files.length) return false
      return true
    }
    pushSegment(s, body, files, userOpenId, msgId)
    const batch = s.multiMsgBuffer
    const reactions = s.multiMsgReactions
    s.multiMsgBuffer = null
    s.multiMsgReactions = new Map()
    await flushMultiMessage(s, batch, reactions)
    return true
  }

  // marker === 'none'
  if (s.multiMsgBuffer !== null) {
    pushSegment(s, text, files, userOpenId, msgId)
    return true
  }
  return false
}

/** 把一段内容追加进缓冲;有实际内容才入列,但只要带 msgId 就打 📌
 *  (纯标记的 >>> / <<< 也要让用户看到"这条被收到了")。*/
function pushSegment(
  s: Session,
  text: string,
  files: string[],
  userOpenId: string,
  msgId: string,
): void {
  if (text.trim() || files.length) {
    s.multiMsgBuffer!.push({ text, files, userOpenId, msgId })
  }
  if (msgId) trackMultiMsgReaction(s, msgId)
}

/** 跟踪缓冲消息上的 📌 reaction。rid 回填前用 '' 占位;
 *  回填时若已 flush/clear(不在 multiMsgReactions 里了),说明是孤儿 📌,直接删。*/
function trackMultiMsgReaction(s: Session, msgId: string): void {
  s.multiMsgReactions.set(msgId, '')
  void (async () => {
    const rid = await feishu.addReaction(msgId, 'Pin')
    if (!rid) return
    if (s.multiMsgReactions.has(msgId)) {
      s.multiMsgReactions.set(msgId, rid)
    } else {
      void feishu.deleteReaction(msgId, rid)
    }
  })()
}

async function flushMultiMessage(
  s: Session,
  batch: MultiMsgSegment[],
  reactions: Map<string, string>,
): Promise<void> {
  // 释放缓冲期间的 📌;rid 还没回填的(空串)留给 trackMultiMsgReaction 的 orphan 路径删
  for (const [msgId, rid] of reactions) {
    if (rid) void feishu.deleteReaction(msgId, rid)
  }
  const segments = batch.filter(m => m.text.trim() || m.files.length)
  if (segments.length === 0) {
    await feishu.sendText(s.chatId, '⚠️ 多条消息缓冲为空,未发送(只收到标记没有正文)。')
    return
  }
  // 每段自带 file hint inline —— 跟 onUserMessage 的 wireText 拼法一致,
  // 合并后每个附件仍归属它原来那条消息,而不是全堆到开头。files 传空避免
  // onUserMessage 又把所有 file 堆一次。
  const merged = segments.map(m => {
    const prefix = m.files.length ? m.files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    return prefix + m.text
  }).join('\n\n')
  const last = segments[segments.length - 1]
  await s.onUserMessage(merged, [], last.userOpenId, last.msgId)
}

/**
 * 丢弃当前多条消息缓冲。给每条缓冲消息的 📌 换成 ❌ (CrossMark),
 * 表示"已收录但被取消"。用于 stop / kill / restart / clear 和 proc exit。
 * flush 正常完成不走这里(它自己释放 📌,不打 ❌)。no-op if 无缓冲。*/
export function clearMultiMsgBuffer(s: Session, _reason: string): void {
  if (s.multiMsgBuffer === null) return
  for (const [msgId, rid] of s.multiMsgReactions) {
    if (rid) void feishu.deleteReaction(msgId, rid)
    void feishu.addReaction(msgId, 'CrossMark')
  }
  s.multiMsgBuffer = null
  s.multiMsgReactions = new Map()
}
