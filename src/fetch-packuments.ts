#!/usr/bin/env node
/**
 * Fetches the packument of every package in packages/*.txt directly from each
 * registry, in every representation a package manager might ask for, and
 * records the size on the wire. Results go to results/<run-id>/packuments.ndjson
 * (one line per package x endpoint x encoding; re-running resumes) and a
 * summary to results/<run-id>/packuments.json.
 *
 *   node src/fetch-packuments.ts [--run-id <id>] [--limit 100] [--concurrency 8]
 */
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import {
  PACKAGES_DIR,
  RESULTS_DIR,
  ROOT,
  appendNdjson,
  decodeBody,
  ensureDir,
  fmtBytes,
  latestRunId,
  mapConcurrent,
  newRunId,
  pctChange,
  readNdjson,
  sleep,
  sum,
  writeJson,
} from './lib.ts'
import { REGISTRIES, type RegistryId } from './registries.ts'

export interface Endpoint {
  id: string
  registry: RegistryId
  accept: string
  /** Query string appended to the packument URL, e.g. `stable`. */
  query?: string
  description: string
}

/** The representations package managers ask for (see README for who sends what). */
export const ENDPOINTS: Endpoint[] = [
  {
    id: 'npm-full',
    registry: 'npm',
    accept: 'application/json',
    description: 'registry.npmjs.org full packument (npm)',
  },
  {
    id: 'npm-corgi',
    registry: 'npm',
    accept: 'application/vnd.npm.install-v1+json',
    description: 'registry.npmjs.org abbreviated packument (pnpm, bun)',
  },
  {
    id: 'vlt-full',
    registry: 'vlt',
    accept: 'application/json',
    description: 'registry.vlt.io install packument served for application/json (npm, vlt)',
  },
  {
    id: 'vlt-corgi',
    registry: 'vlt',
    accept: 'application/vnd.npm.install-v1+json',
    description: 'registry.vlt.io abbreviated packument (pnpm, bun)',
  },
  {
    id: 'vlt-vlt',
    registry: 'vlt',
    accept: 'application/vnd.vlt.packument-v1+json',
    description: 'registry.vlt.io abbreviated packument with time (vlt)',
  },
  {
    id: 'vlt-stable',
    registry: 'vlt',
    accept: 'application/vnd.vlt.packument-v1+json',
    query: 'stable',
    description: 'registry.vlt.io abbreviated packument without prerelease versions (vlt, ?stable)',
  },
]

export const ENCODINGS = ['gzip', 'br'] as const
export type Encoding = (typeof ENCODINGS)[number]

export interface PackumentRecord {
  name: string
  endpoint: string
  acceptEncoding: Encoding
  status: number
  contentType?: string
  contentEncoding?: string
  wireBytes: number
  bodyBytes: number
  /** gzip of the decoded body, computed locally: what the response would cost if the registry compressed it. */
  localGzipBytes?: number
  versions?: number
  hasTime?: boolean
  ms: number
  error?: string
}

export interface EndpointSummary {
  endpoint: string
  acceptEncoding: Encoding
  packages: number
  failed: number
  wireBytes: number
  bodyBytes: number
  localGzipBytes: number
  contentEncodings: Record<string, number>
}

export interface PackumentsSummary {
  runId: string
  finishedAt: string
  lists: Record<string, string[]>
  endpoints: Endpoint[]
  /** Totals across the top list only. */
  top: EndpointSummary[]
  /** Per-package sizes for the extra one-offs. */
  extra: Record<string, PackumentRecord[]>
  largest: { name: string; endpoint: string; wireBytes: number }[]
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '8' },
    },
  })
  const runId = values['run-id'] ?? latestRunId() ?? newRunId()
  const runDir = ensureDir(join(RESULTS_DIR, runId))
  const ndjson = join(runDir, 'packuments.ndjson')
  const limit = values.limit ? Number(values.limit) : undefined

  const lists = {
    top: readList('top-1000.txt').slice(0, limit),
    extra: readList('extra.txt'),
  }
  const names = [...new Set([...lists.top, ...lists.extra])]
  const done = new Set(
    readNdjson<PackumentRecord>(ndjson)
      .filter((r) => !r.error)
      .map(key),
  )
  const jobs = names
    .flatMap((name) =>
      ENDPOINTS.flatMap((endpoint) =>
        ENCODINGS.map((acceptEncoding) => ({ name, endpoint, acceptEncoding })),
      ),
    )
    .filter(
      (job) =>
        !done.has(
          key({ name: job.name, endpoint: job.endpoint.id, acceptEncoding: job.acceptEncoding }),
        ),
    )

  console.log(
    `run ${runId}: ${names.length} packages x ${ENDPOINTS.length} endpoints x ${ENCODINGS.length} encodings, ${jobs.length} to fetch`,
  )
  let completed = 0
  await mapConcurrent(jobs, Number(values.concurrency), async (job) => {
    const record = await fetchWithRetry(job.name, job.endpoint, job.acceptEncoding)
    appendNdjson(ndjson, record)
    completed++
    if (completed % 100 === 0 || completed === jobs.length)
      console.log(`${completed}/${jobs.length}`)
  })

  const records = readNdjson<PackumentRecord>(ndjson)
  const summary = summarize(runId, lists, records)
  writeJson(join(runDir, 'packuments.json'), summary)
  console.log(`wrote ${relative(ROOT, join(runDir, 'packuments.json'))}`)
  for (const s of summary.top) {
    console.log(
      `${s.endpoint.padEnd(10)} ${s.acceptEncoding.padEnd(5)} ${fmtBytes(s.wireBytes).padStart(12)} on the wire (${s.packages} packages, ${s.failed} failed)`,
    )
  }
}

function key(r: { name: string; endpoint: string; acceptEncoding: string }): string {
  return `${r.name}\t${r.endpoint}\t${r.acceptEncoding}`
}

function readList(file: string): string[] {
  const path = join(PACKAGES_DIR, file)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

async function fetchWithRetry(
  name: string,
  endpoint: Endpoint,
  acceptEncoding: Encoding,
): Promise<PackumentRecord> {
  let last: PackumentRecord | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await fetchPackument(name, endpoint, acceptEncoding)
    if (!last.error && last.status !== 429 && last.status < 500) return last
    await sleep(500 * 2 ** attempt)
  }
  return last!
}

export function fetchPackument(
  name: string,
  endpoint: Endpoint,
  acceptEncoding: Encoding,
): Promise<PackumentRecord> {
  const registry = REGISTRIES[endpoint.registry]
  const started = performance.now()
  const record: PackumentRecord = {
    name,
    endpoint: endpoint.id,
    acceptEncoding,
    status: 0,
    wireBytes: 0,
    bodyBytes: 0,
    ms: 0,
  }
  const headers: Record<string, string> = {
    accept: endpoint.accept,
    'accept-encoding': acceptEncoding,
    'user-agent': 'vlt-packument-transfer-experiment',
  }
  const auth = registry.authorization?.()
  if (auth) headers.authorization = auth
  const url = new URL(name.replace('/', '%2f') + (endpoint.query ? `?${endpoint.query}` : ''), registry.upstream)

  return new Promise((resolve) => {
    const go = (target: URL, redirects: number) => {
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request(target, { headers }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
          res.resume()
          go(new URL(res.headers.location, target), redirects + 1)
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const wire = Buffer.concat(chunks)
          record.status = status
          record.contentType = res.headers['content-type']
          record.contentEncoding = res.headers['content-encoding']
          record.wireBytes = wire.length
          record.ms = Math.round(performance.now() - started)
          try {
            const body = decodeBody(wire, record.contentEncoding)
            record.bodyBytes = body.length
            if (status === 200) {
              record.localGzipBytes = gzipSync(body).length
              const packument = JSON.parse(body.toString('utf8')) as {
                versions?: object
                time?: object
              }
              record.versions = Object.keys(packument.versions ?? {}).length
              record.hasTime = !!packument.time
            } else {
              record.error = `HTTP ${status}`
            }
          } catch (err) {
            record.error = String((err as Error).message ?? err)
          }
          resolve(record)
        })
        res.on('error', (err) => {
          record.error = err.message
          record.ms = Math.round(performance.now() - started)
          resolve(record)
        })
      })
      req.on('error', (err) => {
        record.error = err.message
        record.ms = Math.round(performance.now() - started)
        resolve(record)
      })
      req.end()
    }
    go(url, 0)
  })
}

export function summarize(
  runId: string,
  lists: Record<string, string[]>,
  records: PackumentRecord[],
): PackumentsSummary {
  const latest = new Map<string, PackumentRecord>()
  for (const r of records) latest.set(key(r), r) // last attempt wins
  const topNames = new Set(lists.top)
  const top: EndpointSummary[] = []
  for (const endpoint of ENDPOINTS) {
    for (const acceptEncoding of ENCODINGS) {
      const rows = [...latest.values()].filter(
        (r) =>
          r.endpoint === endpoint.id && r.acceptEncoding === acceptEncoding && topNames.has(r.name),
      )
      const ok = rows.filter((r) => !r.error)
      const contentEncodings: Record<string, number> = {}
      for (const r of ok) {
        const ce = r.contentEncoding ?? 'identity'
        contentEncodings[ce] = (contentEncodings[ce] ?? 0) + 1
      }
      top.push({
        endpoint: endpoint.id,
        acceptEncoding,
        packages: ok.length,
        failed: rows.length - ok.length,
        wireBytes: sum(ok.map((r) => r.wireBytes)),
        bodyBytes: sum(ok.map((r) => r.bodyBytes)),
        localGzipBytes: sum(ok.map((r) => r.localGzipBytes ?? 0)),
        contentEncodings,
      })
    }
  }
  const extra: Record<string, PackumentRecord[]> = {}
  for (const name of lists.extra ?? []) {
    extra[name] = [...latest.values()].filter((r) => r.name === name)
  }
  const largest = [...latest.values()]
    .filter((r) => r.endpoint === 'npm-full' && r.acceptEncoding === 'gzip' && !r.error)
    .sort((a, b) => b.wireBytes - a.wireBytes)
    .slice(0, 10)
    .map((r) => ({ name: r.name, endpoint: r.endpoint, wireBytes: r.wireBytes }))
  return {
    runId,
    finishedAt: new Date().toISOString(),
    lists,
    endpoints: ENDPOINTS,
    top,
    extra,
    largest,
  }
}

export function compare(
  summary: PackumentsSummary,
  from: string,
  to: string,
  acceptEncoding: Encoding,
): string {
  const a = summary.top.find((s) => s.endpoint === from && s.acceptEncoding === acceptEncoding)
  const b = summary.top.find((s) => s.endpoint === to && s.acceptEncoding === acceptEncoding)
  if (!a || !b) return 'n/a'
  return pctChange(a.wireBytes, b.wireBytes)
}
