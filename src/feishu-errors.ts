export interface FeishuErrorDetails {
  code?: number | string
  message: string
  logId?: string
  status?: number
  retryAfter?: string | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function code(value: unknown): number | string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : text(value)
}

function header(headers: unknown, name: string): string | undefined {
  const values = record(headers)
  if (!values) return undefined
  // Native Headers, node-fetch Headers and the SDK's AxiosHeaders expose get().
  if (typeof values.get === 'function') {
    const value = text(values.get.call(headers, name))
    if (value !== undefined) return value
  }
  const key = Object.keys(values).find(key => key.toLowerCase() === name)
  return key === undefined ? undefined : text(values[key])
}

function bodyLogId(body: Record<string, unknown> | undefined): string | undefined {
  return text(body?.logId) ?? text(body?.log_id) ?? text(record(body?.error)?.log_id)
}

/** Read only diagnostic fields: serializing an SDK error can expose its request
 * configuration, including Authorization headers and uploaded file contents. */
export function feishuErrorDetails(raw: unknown): FeishuErrorDetails {
  const outer = record(raw)
  const response = record(outer?.response)
  const data = record(outer?.data)
  const outerCode = code(outer?.code)
  const dataCode = code(data?.code)
  // Some SDK paths reject an HTTP response directly as { data, headers }.
  // Only unwrap diagnostic bodies; task/message business data is not an error.
  // Explicit outer API diagnostics and successful nested data must not be lost.
  const hasOuterApiDetails = typeof outerCode === 'number'
    || (typeof outerCode === 'string' && /^\d+$/.test(outerCode))
    || text(outer?.apiMessage) !== undefined || text(outer?.msg) !== undefined
  const dataIsError = dataCode !== 0 && dataCode !== '0'
    && (dataCode !== undefined || text(data?.msg) !== undefined || bodyLogId(data) !== undefined)
  const body = record(response?.data) ?? (!hasOuterApiDetails && dataIsError ? data : undefined)
  const responseHeaders = response?.headers
  const headers = outer?.headers
  const status = response?.status ?? outer?.status ?? outer?.httpStatus
  return {
    code: code(body?.code) ?? code(outer?.code),
    message: text(body?.apiMessage) ?? text(body?.msg) ?? text(body?.message)
      ?? text(outer?.apiMessage) ?? text(outer?.msg) ?? text(outer?.message) ?? text(raw) ?? 'MISS',
    logId: bodyLogId(body) ?? bodyLogId(outer)
      ?? header(responseHeaders, 'x-tt-logid') ?? header(headers, 'x-tt-logid')
      ?? header(responseHeaders, 'x-request-id') ?? header(headers, 'x-request-id')
      ?? header(responseHeaders, 'request-id') ?? header(headers, 'request-id'),
    status: typeof status === 'number' ? status : undefined,
    retryAfter: text(outer?.retryAfter)
      ?? header(responseHeaders, 'retry-after') ?? header(headers, 'retry-after')
      ?? header(responseHeaders, 'x-ogw-ratelimit-reset') ?? header(headers, 'x-ogw-ratelimit-reset'),
  }
}

/** Every displayed API failure names all three fields, even if Feishu omitted one. */
export function formatFeishuError(raw: unknown): string {
  const details = feishuErrorDetails(raw)
  return `code=${details.code ?? 'MISS'} message=${details.message} log_id=${details.logId ?? 'MISS'}`
}
