#!/usr/bin/env node
/**
 * A recording registry proxy.
 *
 * Package managers are pointed at http://127.0.0.1:<port>/<registry>/ and every
 * request is forwarded to that registry's real upstream with the client's own
 * headers, so the registry negotiates content type and encoding with the real
 * package manager. The proxy records the size of every response as it came
 * over the wire, and appends one JSON line per request to the log file.
 *
 * Packument responses are the one thing the proxy modifies: after recording the
 * upstream bytes, `dist.tarball` URLs are rewritten to point back at the proxy
 * so tarball downloads are recorded too (and so a registry that needs auth for
 * tarballs works without configuring every package manager with a token).
 *
 *   node src/proxy.ts --log results/x/requests.ndjson [--port 0]
 *
 * Prints `READY http://127.0.0.1:<port>` once it is listening.
 */
import { createServer, request as httpRequest, Agent as HttpAgent } from 'node:http'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { parseArgs } from 'node:util'
import { appendNdjson, decodeBody } from './lib.ts'
import { REGISTRIES, isRegistryId, type RegistryDef } from './registries.ts'
import type { RequestKind, RequestRecord } from './types.ts'

const MAX_REDIRECTS = 5
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

const httpAgent = new HttpAgent({ keepAlive: true })
const httpsAgent = new HttpsAgent({ keepAlive: true })

export interface Classification {
  kind: RequestKind
  name?: string
}

/** What a registry path is asking for. Paths are relative to the registry root. */
export function classify(path: string): Classification {
  const pathname = path.split('?')[0]!.replace(/^\/+/, '')
  if (!pathname || pathname.startsWith('-/')) return { kind: 'other' }
  const segments = pathname.split('/').map((s) => decodeURIComponent(s))
  let name = segments.shift()!
  if (name.startsWith('@') && !name.includes('/')) {
    const rest = segments.shift()
    if (!rest) return { kind: 'other' }
    name = `${name}/${rest}`
  }
  if (segments.length === 0) return { kind: 'packument', name }
  if (segments[0] === '-') {
    const file = segments[1] ?? ''
    if (segments.length === 2 && /\.(tgz|tar\.br)$/.test(file)) return { kind: 'tarball', name }
    return { kind: 'other', name }
  }
  if (segments.length === 1) return { kind: 'manifest', name }
  return { kind: 'other', name }
}

/** Rewrite absolute tarball URLs under `upstream` to live under `proxyBase`. Returns the count. */
export function rewriteTarballs(packument: unknown, upstream: string, proxyBase: string): number {
  if (!packument || typeof packument !== 'object') return 0
  const versions = (packument as { versions?: Record<string, unknown> }).versions
  if (!versions || typeof versions !== 'object') return 0
  let rewritten = 0
  const rewrite = (url: unknown): string | undefined => {
    if (typeof url !== 'string' || !url.startsWith(upstream)) return undefined
    rewritten++
    return proxyBase + url.slice(upstream.length)
  }
  for (const manifest of Object.values(versions)) {
    const dist = (manifest as { dist?: Record<string, unknown> })?.dist
    if (!dist || typeof dist !== 'object') continue
    const tarball = rewrite(dist.tarball)
    if (tarball) dist.tarball = tarball
    if (Array.isArray(dist.alternates)) {
      for (const alt of dist.alternates as { tarball?: unknown }[]) {
        const altUrl = rewrite(alt?.tarball)
        if (altUrl) alt.tarball = altUrl
      }
    }
  }
  return rewritten
}

interface Upstream {
  res: IncomingMessage
  redirects: number
}

/** Issue the request upstream, following redirects, without touching the body. */
function fetchUpstream(
  url: URL,
  method: string,
  headers: OutgoingHttpHeaders,
  registry: RegistryDef,
  redirects = 0,
): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const sameOrigin = url.origin === new URL(registry.upstream).origin
    const auth = sameOrigin && !headers.authorization ? registry.authorization?.() : undefined
    const req = request(
      url,
      {
        method,
        headers: { ...headers, host: url.host, ...(auth ? { authorization: auth } : {}) },
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location && redirects < MAX_REDIRECTS) {
          res.resume()
          resolve(fetchUpstream(new URL(location, url), method, headers, registry, redirects + 1))
          return
        }
        resolve({ res, redirects })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  proxyOrigin: string,
  log: string,
  quiet: boolean,
): Promise<void> {
  const started = performance.now()
  const url = new URL(req.url ?? '/', proxyOrigin)
  const [, registryId, ...rest] = url.pathname.split('/')
  if (url.pathname === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  if (!registryId || !isRegistryId(registryId)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown registry prefix: /${registryId}/` }))
    return
  }
  const registry = REGISTRIES[registryId]
  const path = `/${rest.join('/')}${url.search}`
  const upstreamUrl = new URL(rest.join('/') + url.search, registry.upstream)
  const { kind, name } = classify(path)
  const proxyBase = `${proxyOrigin}/${registryId}/`

  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key) && value !== undefined) headers[key] = value
  }

  const record: RequestRecord = {
    ts: new Date().toISOString(),
    registry: registryId,
    kind,
    ...(name ? { name } : {}),
    method: req.method ?? 'GET',
    path,
    status: 0,
    redirects: 0,
    reqAccept: header(req.headers.accept),
    reqAcceptEncoding: header(req.headers['accept-encoding']),
    reqUserAgent: header(req.headers['user-agent']),
    wireBytes: 0,
    ms: 0,
  }
  const finish = () => {
    record.ms = Math.round(performance.now() - started)
    appendNdjson(log, record)
    if (!quiet) {
      console.error(
        `${record.status} ${record.kind.padEnd(9)} ${registryId} ${path} ${record.wireBytes}B ${record.ms}ms`,
      )
    }
  }

  let upstream: Upstream
  try {
    upstream = await fetchUpstream(upstreamUrl, record.method, headers, registry)
  } catch (err) {
    record.status = 502
    record.error = String((err as Error).message ?? err)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: record.error }))
    finish()
    return
  }
  const { res: up, redirects } = upstream
  record.status = up.statusCode ?? 0
  record.redirects = redirects
  record.resContentType = header(up.headers['content-type'])
  record.resContentEncoding = header(up.headers['content-encoding'])

  const responseHeaders: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(up.headers)) {
    if (!HOP_BY_HOP.has(key) && value !== undefined) responseHeaders[key] = value
  }

  const chunks: Buffer[] = []
  const rewrite = kind === 'packument' && record.status === 200 && record.method === 'GET'
  if (!rewrite) {
    // Stream everything else through untouched, counting bytes.
    if (up.headers['content-length'])
      responseHeaders['content-length'] = up.headers['content-length']
    res.writeHead(record.status, responseHeaders)
    up.on('data', (chunk: Buffer) => {
      record.wireBytes += chunk.length
      res.write(chunk)
    })
    up.on('end', () => {
      res.end()
      finish()
    })
    up.on('error', (err) => {
      record.error = String(err.message)
      res.destroy()
      finish()
    })
    return
  }

  up.on('data', (chunk: Buffer) => {
    record.wireBytes += chunk.length
    chunks.push(chunk)
  })
  up.on('error', (err) => {
    record.error = String(err.message)
    res.destroy()
    finish()
  })
  up.on('end', () => {
    const wire = Buffer.concat(chunks)
    let body: Buffer
    try {
      body = decodeBody(wire, record.resContentEncoding)
      record.bodyBytes = body.length
      const packument = JSON.parse(body.toString('utf8')) as unknown
      record.rewrittenTarballs = rewriteTarballs(packument, registry.upstream, proxyBase)
      body = Buffer.from(JSON.stringify(packument))
    } catch (err) {
      // Not JSON we understand: pass the original bytes through as-is.
      record.error = `passthrough: ${String((err as Error).message ?? err)}`
      res.writeHead(record.status, { ...responseHeaders, 'content-length': wire.length })
      res.end(wire)
      finish()
      return
    }
    delete responseHeaders['content-encoding']
    delete responseHeaders['content-length']
    // The body changed, so a strong validator would be a lie; keep it weak.
    const etag = header(up.headers.etag)
    if (etag && !etag.startsWith('W/')) responseHeaders.etag = `W/${etag}`
    res.writeHead(record.status, { ...responseHeaders, 'content-length': body.length })
    res.end(body)
    finish()
  })
}

export function startProxy(options: { port: number; log: string; quiet?: boolean }): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    let origin = ''
    const server = createServer((req, res) => {
      handle(req, res, origin, options.log, options.quiet ?? false).catch((err: Error) => {
        console.error('proxy error', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    server.keepAliveTimeout = 60_000
    server.on('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : options.port
      origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      log: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
  })
  if (!values.log) {
    console.error('usage: node src/proxy.ts --log <file.ndjson> [--port <n>] [--quiet]')
    process.exit(1)
  }
  const { origin } = await startProxy({
    port: Number(values.port),
    log: values.log,
    quiet: values.quiet,
  })
  console.log(`READY ${origin}`)
}
