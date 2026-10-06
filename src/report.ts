#!/usr/bin/env node
/**
 * Turns results/<run-id>/installs.json and packuments.json into a Markdown
 * report, printed to stdout and written to results/<run-id>/REPORT.md.
 *
 *   node src/report.ts [--run-id <id>]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { RESULTS_DIR, ROOT, fmtBytes, latestRunId, median, pctChange, readJson, sum } from './lib.ts'
import { REGISTRIES } from './registries.ts'
import { SCENARIOS } from './scenarios.ts'
import { PACKAGE_MANAGERS } from './tools.ts'
import type { InstallsFile, TimingsFile } from './types.ts'
import type { Encoding, PackumentsSummary } from './fetch-packuments.ts'

const { values } = parseArgs({ options: { 'run-id': { type: 'string' } } })
const runId = values['run-id'] ?? latestRunId()
if (!runId) throw new Error('No results found; run the installs or packuments script first')
const runDir = join(RESULTS_DIR, runId)
const installsFile = join(runDir, 'installs.json')
const packumentsFile = join(runDir, 'packuments.json')
const installs = existsSync(installsFile) ? readJson<InstallsFile>(installsFile) : undefined
const packuments = existsSync(packumentsFile)
  ? readJson<PackumentsSummary>(packumentsFile)
  : undefined
const timingsFile = join(runDir, 'timings.json')
const timings = existsSync(timingsFile) ? readJson<TimingsFile>(timingsFile) : undefined

const out: string[] = []
const line = (s = '') => out.push(s)
const table = (header: string[], rows: string[][]) => {
  line(`| ${header.join(' | ')} |`)
  line(`| ${header.map(() => '---').join(' | ')} |`)
  for (const row of rows) line(`| ${row.join(' | ')} |`)
  line()
}

line(`# Packument transfer report: ${runId}`)
line()
if (installs) {
  line(
    `Clean installs run ${installs.startedAt.slice(0, 10)} with Node ${installs.node} on ${installs.platform}. ` +
      `Package managers: ${PACKAGE_MANAGERS.map((pm) => `${pm} ${installs.versions[pm]}`).join(', ')}.`,
  )
  line()
}
line(
  `Registries: ${Object.values(REGISTRIES)
    .map((r) => `${r.id} = ${r.upstream}`)
    .join(', ')}.`,
)
line()

if (installs) {
  const results = installs.results
  const ok = results.filter((r) => r.ok)
  const fixtures = [...new Set(results.map((r) => r.fixture))].sort()

  line('## Clean installs: packument bytes on the wire')
  line()
  line(
    'Every install starts with an empty cache and a bare package.json, so every packument comes from the registry. Bytes are as received from the registry, before decompression.',
  )
  line()
  const rows: string[][] = []
  for (const scenario of SCENARIOS) {
    const perFixture = fixtures
      .map((fixture) => ({
        fixture,
        npm: ok.find(
          (r) =>
            r.pm === scenario.pm &&
            r.scenario === scenario.id &&
            r.fixture === fixture &&
            r.registry === 'npm',
        ),
        vlt: ok.find(
          (r) =>
            r.pm === scenario.pm &&
            r.scenario === scenario.id &&
            r.fixture === fixture &&
            r.registry === 'vlt',
        ),
      }))
      .filter((f) => f.npm && f.vlt)
    if (perFixture.length === 0) continue
    for (const f of perFixture) {
      rows.push([
        scenario.pm,
        scenario.label,
        f.fixture,
        `${fmtBytes(f.npm!.packuments.wireBytes)} (${f.npm!.packuments.count})`,
        `${fmtBytes(f.vlt!.packuments.wireBytes)} (${f.vlt!.packuments.count})`,
        pctChange(f.npm!.packuments.wireBytes, f.vlt!.packuments.wireBytes),
      ])
    }
    if (perFixture.length > 1) {
      const npmTotal = sum(perFixture.map((f) => f.npm!.packuments.wireBytes))
      const vltTotal = sum(perFixture.map((f) => f.vlt!.packuments.wireBytes))
      rows.push([
        `**${scenario.pm}**`,
        `**${scenario.label}**`,
        '**all fixtures**',
        `**${fmtBytes(npmTotal)}** (${sum(perFixture.map((f) => f.npm!.packuments.count))})`,
        `**${fmtBytes(vltTotal)}** (${sum(perFixture.map((f) => f.vlt!.packuments.count))})`,
        `**${pctChange(npmTotal, vltTotal)}**`,
      ])
    }
  }
  table(
    [
      'Package manager',
      'Scenario',
      'Fixture',
      'registry.npmjs.org (requests)',
      'registry.vlt.io (requests)',
      'Change',
    ],
    rows,
  )

  line('## What each package manager asks for')
  line()
  line(
    'Packument requests grouped by the `Accept` header the package manager sent, summed over all fixtures, with the encodings the registry answered with.',
  )
  line()
  const acceptRows: string[][] = []
  for (const scenario of SCENARIOS) {
    for (const registry of ['npm', 'vlt'] as const) {
      const matching = ok.filter(
        (r) => r.pm === scenario.pm && r.scenario === scenario.id && r.registry === registry,
      )
      if (matching.length === 0) continue
      const byAccept: Record<string, { count: number; wireBytes: number }> = {}
      for (const r of matching) {
        for (const [accept, v] of Object.entries(r.packuments.byAccept ?? {})) {
          byAccept[accept] ??= { count: 0, wireBytes: 0 }
          byAccept[accept].count += v.count
          byAccept[accept].wireBytes += v.wireBytes
        }
      }
      const encodings = [...new Set(matching.flatMap((r) => r.packuments.contentEncoding))].join(
        ', ',
      )
      const types = [
        ...new Set(matching.flatMap((r) => r.packuments.contentType.map((t) => t.split(';')[0]!))),
      ].join(', ')
      for (const [accept, v] of Object.entries(byAccept)) {
        acceptRows.push([
          scenario.pm,
          scenario.label,
          registry,
          `\`${accept}\``,
          String(v.count),
          fmtBytes(v.wireBytes),
          types,
          encodings,
        ])
      }
    }
  }
  table(
    [
      'Package manager',
      'Scenario',
      'Registry',
      'Accept',
      'Requests',
      'Wire bytes',
      'Content-Type received',
      'Content-Encoding received',
    ],
    acceptRows,
  )

  line('## By representation asked for')
  line()
  line(
    'The same installs split by the `Accept` header each request carried: `full` is `application/json`, `abbreviated` is `application/vnd.npm.install-v1+json`, `vlt` is `application/vnd.vlt.packument-v1+json` (which registry.npmjs.org does not know, so it answers those with the full packument). Some scenarios mix representations; this is what each representation costs on its own.',
  )
  line()
  const representation = (accept: string) =>
    accept.startsWith('application/json')
      ? 'full'
      : accept.startsWith('application/vnd.vlt')
        ? 'vlt'
        : 'abbreviated'
  const REPRESENTATIONS = ['full', 'abbreviated', 'vlt'] as const
  const totals: Record<string, number> = {}
  const repRows: string[][] = []
  const cell = (npmBytes: number | undefined, vltBytes: number | undefined) =>
    npmBytes && vltBytes
      ? `${fmtBytes(npmBytes)} -> ${fmtBytes(vltBytes)} (${pctChange(npmBytes, vltBytes)})`
      : ''
  for (const scenario of SCENARIOS) {
    const bytes: Record<string, number> = {}
    let any = false
    for (const r of ok.filter((r) => r.pm === scenario.pm && r.scenario === scenario.id)) {
      for (const [accept, v] of Object.entries(r.packuments.byAccept ?? {})) {
        const key = `${representation(accept)}:${r.registry}`
        bytes[key] = (bytes[key] ?? 0) + v.wireBytes
        totals[key] = (totals[key] ?? 0) + v.wireBytes
        any = true
      }
    }
    if (!any) continue
    repRows.push([
      scenario.pm,
      scenario.label,
      ...REPRESENTATIONS.map((rep) => cell(bytes[`${rep}:npm`], bytes[`${rep}:vlt`])),
    ])
  }
  repRows.push([
    '**all**',
    '**all scenarios**',
    ...REPRESENTATIONS.map((rep) => `**${cell(totals[`${rep}:npm`], totals[`${rep}:vlt`])}**`),
  ])
  table(
    [
      'Package manager',
      'Scenario',
      'full: npmjs -> vlt.io',
      'abbreviated: npmjs -> vlt.io',
      'vlt type: npmjs -> vlt.io',
    ],
    repRows,
  )

  line('## Packuments as a share of the whole install')
  line()
  line(
    'Tarball bytes are the same packages from the same registries, so this shows how much of a clean install is metadata.',
  )
  line()
  const shareRows: string[][] = []
  for (const scenario of SCENARIOS) {
    for (const registry of ['npm', 'vlt'] as const) {
      const matching = ok.filter(
        (r) => r.pm === scenario.pm && r.scenario === scenario.id && r.registry === registry,
      )
      if (matching.length === 0) continue
      const p = sum(matching.map((r) => r.packuments.wireBytes))
      const t = sum(matching.map((r) => r.tarballs.wireBytes))
      shareRows.push([
        scenario.pm,
        scenario.label,
        registry,
        fmtBytes(p),
        fmtBytes(t),
        `${((p / (p + t)) * 100).toFixed(1)}%`,
      ])
    }
  }
  table(
    ['Package manager', 'Scenario', 'Registry', 'Packuments', 'Tarballs', 'Packument share'],
    shareRows,
  )

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    line('## Failed installs')
    line()
    for (const r of failed)
      line(
        `- ${r.pm} ${r.scenarioLabel} ${r.registry} ${r.fixture}: exit ${r.exitCode} (see ${r.logFile})`,
      )
    line()
  }
}

if (packuments) {
  const n = packuments.lists.top?.length ?? 0
  line(`## Top ${n} packages fetched directly`)
  line()
  line(
    'Each package fetched once per representation and encoding, straight from the registry. `gzip` is what every package manager in this experiment accepts; `br` is what a client that also accepts Brotli gets.',
  )
  line()
  const byId = new Map(packuments.endpoints.map((e) => [e.id, e]))
  const rows: string[][] = []
  for (const s of packuments.top) {
    const e = byId.get(s.endpoint)
    rows.push([
      s.endpoint,
      e?.description ?? '',
      s.acceptEncoding,
      `${s.packages}${s.failed ? ` (${s.failed} failed)` : ''}`,
      fmtBytes(s.wireBytes),
      Object.entries(s.contentEncodings)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', '),
      s.endpoint === 'npm-full'
        ? ''
        : compareTo(packuments, 'npm-full', s.endpoint, s.acceptEncoding),
      s.endpoint === 'npm-corgi'
        ? ''
        : compareTo(packuments, 'npm-corgi', s.endpoint, s.acceptEncoding),
      fmtBytes(s.bodyBytes),
      fmtBytes(s.localGzipBytes),
    ])
  }
  table(
    [
      'Endpoint',
      'What it is',
      'Accept-Encoding',
      'Packages',
      'Wire',
      'Encodings received',
      'vs npm-full',
      'vs npm-corgi',
      'Decoded',
      'Decoded, gzipped locally',
    ],
    rows,
  )
  line(
    '"Decoded, gzipped locally" is the decoded body re-compressed with Node\'s default gzip level: what an uncompressed response would cost if the registry compressed it.',
  )
  line()

  line('### Largest packuments (npm-full, gzip)')
  line()
  table(
    ['Package', 'Wire'],
    packuments.largest.map((l) => [l.name, fmtBytes(l.wireBytes)]),
  )

  for (const [name, records] of Object.entries(packuments.extra)) {
    line(`### ${name}`)
    line()
    table(
      [
        'Endpoint',
        'Accept-Encoding',
        'Status',
        'Wire',
        'Encoding received',
        'Decoded',
        'Decoded, gzipped locally',
        'Versions',
      ],
      records.map((r) => [
        r.endpoint,
        r.acceptEncoding,
        String(r.status),
        fmtBytes(r.wireBytes),
        r.contentEncoding ?? 'identity',
        fmtBytes(r.bodyBytes),
        fmtBytes(r.localGzipBytes ?? 0),
        String(r.versions ?? ''),
      ]),
    )
  }
}

if (timings) {
  line('## Clean install wall time, straight at the registries')
  line()
  line(
    `Measured on ${timings.platform} with Node ${timings.node} on ${timings.startedAt.slice(0, 10)}: a fresh sandbox per run, no proxy, registries interleaved run by run. Wall time depends on this machine and its network, so only the comparison within a row travels; the byte counts above are the reproducible numbers.`,
  )
  line()
  const rows: string[][] = []
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  for (const scenario of SCENARIOS) {
    const fixtures = [
      ...new Set(
        timings.timings.filter((t) => t.pm === scenario.pm && t.scenario === scenario.id).map((t) => t.fixture),
      ),
    ].sort()
    for (const fixture of fixtures) {
      const find = (registry: string) =>
        timings.timings.find(
          (t) => t.pm === scenario.pm && t.scenario === scenario.id && t.fixture === fixture && t.registry === registry,
        )
      const a = find('npm')
      const b = find('vlt')
      if (!a?.runs.length || !b?.runs.length) continue
      const ma = median(a.runs)
      const mb = median(b.runs)
      rows.push([
        scenario.pm,
        scenario.label,
        fixture,
        `${s(ma)} (min ${s(Math.min(...a.runs))}, n=${a.runs.length})`,
        `${s(mb)} (min ${s(Math.min(...b.runs))}, n=${b.runs.length})`,
        pctChange(ma, mb),
      ])
    }
  }
  table(
    ['Package manager', 'Scenario', 'Fixture', 'registry.npmjs.org median', 'registry.vlt.io median', 'Change (median)'],
    rows,
  )
}

const report = out.join('\n')
writeFileSync(join(runDir, 'REPORT.md'), report + '\n')
console.log(report)
console.error(`\nwrote ${relative(ROOT, join(runDir, 'REPORT.md'))}`)

function compareTo(
  summary: PackumentsSummary,
  from: string,
  to: string,
  acceptEncoding: Encoding,
): string {
  const a = summary.top.find((s) => s.endpoint === from && s.acceptEncoding === acceptEncoding)
  const b = summary.top.find((s) => s.endpoint === to && s.acceptEncoding === acceptEncoding)
  return a && b ? pctChange(a.wireBytes, b.wireBytes) : 'n/a'
}
