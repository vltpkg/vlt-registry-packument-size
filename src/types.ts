import type { RegistryId } from './registries.ts'

export type RequestKind = 'packument' | 'manifest' | 'tarball' | 'other'

/** One line of the proxy's NDJSON request log. */
export interface RequestRecord {
  ts: string
  registry: RegistryId
  kind: RequestKind
  /** Package name for packument, manifest and tarball requests. */
  name?: string
  method: string
  /** Path and query as the client requested it, relative to the registry root. */
  path: string
  status: number
  /** Redirects the proxy followed upstream before the final response. */
  redirects: number
  reqAccept?: string
  reqAcceptEncoding?: string
  reqUserAgent?: string
  resContentType?: string
  resContentEncoding?: string
  /** Bytes of response body received from upstream, as sent on the wire (compressed). */
  wireBytes: number
  /** Bytes of the decoded response body. Only computed for packuments. */
  bodyBytes?: number
  /** Number of dist.tarball URLs rewritten to point at the proxy. */
  rewrittenTarballs?: number
  ms: number
  error?: string
}

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'vlt'

export interface KindSummary {
  count: number
  wireBytes: number
  bodyBytes: number
  statuses: Record<string, number>
  accept: string[]
  contentType: string[]
  contentEncoding: string[]
  redirects: number
  /** Requests and wire bytes broken down by the Accept header the client sent. */
  byAccept: Record<string, { count: number; wireBytes: number }>
}

export interface InstallResult {
  pm: PackageManager
  version: string
  scenario: string
  scenarioLabel: string
  registry: RegistryId
  fixture: string
  startedAt: string
  durationMs: number
  exitCode: number | null
  ok: boolean
  command: string
  userAgent?: string
  packuments: KindSummary
  manifests: KindSummary
  tarballs: KindSummary
  other: KindSummary
  requestsFile: string
  logFile: string
}

export interface InstallsFile {
  runId: string
  startedAt: string
  node: string
  platform: string
  versions: Record<string, string>
  results: InstallResult[]
}

export interface Timing {
  pm: PackageManager
  version: string
  scenario: string
  scenarioLabel: string
  fixture: string
  registry: RegistryId
  /** Wall time of each successful run, in milliseconds. */
  runs: number[]
  failed: number
}

export interface TimingsFile {
  runId: string
  startedAt: string
  node: string
  platform: string
  versions: Record<string, string>
  timings: Timing[]
}
