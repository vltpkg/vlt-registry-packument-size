import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const RESULTS_DIR = join(ROOT, 'results')
export const TOOLCACHE_DIR = join(ROOT, '.toolcache')
export const WORK_DIR = join(ROOT, '.work')
export const FIXTURES_DIR = join(ROOT, 'fixtures')
export const PACKAGES_DIR = join(ROOT, 'packages')

export type Versions = Record<string, string>

export function readVersions(): Versions {
  return JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8')) as Versions
}

/** A run id that sorts chronologically: 2026-09-29T0215Z */
export function newRunId(): string {
  return new Date()
    .toISOString()
    .replace(/:\d\d\.\d+Z$/, 'Z')
    .replace(/:/g, '')
}

/** The most recent run directory under results/, or undefined. */
export function latestRunId(): string | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined
  return readdirSync(RESULTS_DIR)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .at(-1)
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file))
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export function appendNdjson(file: string, value: unknown): void {
  ensureDir(dirname(file))
  appendFileSync(file, JSON.stringify(value) + '\n')
}

export function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T)
}

/** Decode a response body according to its Content-Encoding header. */
export function decodeBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  const encoding = (contentEncoding ?? '').trim().toLowerCase()
  switch (encoding) {
    case '':
    case 'identity':
      return body
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body)
    case 'br':
      return brotliDecompressSync(body)
    case 'zstd':
      return zstdDecompressSync(body)
    case 'deflate':
      try {
        return inflateSync(body)
      } catch {
        return inflateRawSync(body)
      }
    default:
      throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`)
  }
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Percent change going from `from` to `to`, e.g. "-72.4%". */
export function pctChange(from: number, to: number): string {
  if (!from) return 'n/a'
  const diff = ((to - from) / from) * 100
  return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * A minimal environment for a package manager sandbox: no user config,
 * caches or tokens can leak in, and every XDG directory lives under `homeDir`.
 */
export function sandboxEnv(homeDir: string, tmpDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_CACHE_HOME: join(homeDir, '.cache'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    TMPDIR: tmpDir,
    USER: process.env.USER ?? 'bench',
    LANG: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
