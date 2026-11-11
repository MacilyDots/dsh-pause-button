/**
 * 在 webServer 上自注册一条 connection 风格的 RPC 通道。
 *
 * 为什么不直接用 connection.rpc.handle：历史版本里该 API 在登记路由时会解析 connection
 * 服务上下文里的 webServer，而那个上下文没有注入它，于是抛出 without inject。
 * 这里自行实现同样的信封语义，并复用 connection 的请求信任判定。
 */

/** 端点路径段合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 请求体上限。本插件不带附件，1 MiB 足够。 */
const MAX_BODY_BYTES = 1024 * 1024
const JSON_MIME = 'application/json'

class PayloadTooLargeError extends Error {}

/**
 * 挂载一条 RPC 通道。
 * @param ctx 插件上下文（需已注入 connection / webServer）。
 * @param channel 绝对通道前缀，例如 /dsh-pause-button。
 * @param handler 端点处理器。
 */
export function mountRpcChannel(ctx, channel, handler) {
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'prefix',
      path: channel,
      handler: (req, res) => serve(ctx.connection, channel, handler, req, res),
    })
  }, `${channel}: rpc channel`)
}

async function serve(connection, channel, handler, req, res) {
  try {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'POST') return missing(res)
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const prefix = `${channel}/`
    if (!pathname.startsWith(prefix)) return missing(res)
    const endpoint = pathname.slice(prefix.length)
    if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) return missing(res)

    if (!isJsonContentType(req)) {
      res.writeHead(415)
      res.end('unsupported media type')
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge(req, res)

    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return tooLarge(req, res)
      res.writeHead(400)
      res.end('body read failed')
      return
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(400)
      res.end('body is not JSON')
      return
    }
    const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
    if (message.type !== 'client-request' || typeof message.method !== 'string') {
      return reply(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })
    }
    if (message.method !== endpoint) {
      return reply(res, rpcId, {
        ok: false,
        error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} },
      })
    }
    const controller = new AbortController()
    const onClose = () => controller.abort(new Error('client disconnected'))
    res.on('close', onClose)
    let result
    try {
      result = await handler(endpoint, message.payload, controller.signal)
    } catch (error) {
      result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
    } finally {
      res.off('close', onClose)
    }
    reply(res, rpcId, result)
  } catch (error) {
    try {
      res.writeHead(500)
      res.end(String(error))
    } catch {
      /* 已断开 */
    }
  }
}

function missing(res) {
  res.writeHead(404)
  res.end('not found')
}

function reply(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

function tooLarge(req, res) {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

function isJsonContentType(req) {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError('request body exceeds limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
