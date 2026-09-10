import { request } from 'node:http'
import { DEBUG_SOCK_FILE } from '../src/paths'

/** 向 debug context 指定的真实群发送消息，再由 daemon 处理。 */
export function injectDebugMessage(text: string, expectedChatId?: string, waitForHandling = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text, ...(expectedChatId ? { chat_id: expectedChatId } : {}),
      ...(waitForHandling ? { wait_for_handling: true } : {}) })
    const req = request({
      socketPath: DEBUG_SOCK_FILE,
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('error', reject)
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) resolve(body)
        else reject(new Error(`debug inject HTTP ${status}: ${body}`))
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
