#!/usr/bin/env node
/**
 * Runs clean installs of every fixture with every package manager and
 * scenario against both registries, through the recording proxy, and writes
 * results/<run-id>/installs.json plus one request log per install.
 *
 *   node src/run-installs.ts [--run-id <id>] [--pm npm,vlt] [--registry npm,vlt]
 *                            [--fixture next-app] [--scenario default] [--keep]
 *                            [--timeout <minutes>]
 *
 * Re-running with the same --run-id skips installs that already succeeded.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import {
  FIXTURES_DIR,
  RESULTS_DIR,
  ROOT,
  WORK_DIR,
  ensureDir,
  fmtBytes,
  newRunId,
  readJson,
  readNdjson,
  readVersions,
  sandboxEnv,
  writeJson,
} from './lib.ts'
import { REGISTRY_IDS, isRegistryId, type RegistryId } from './registries.ts'
import { buildSetup, scenariosFor, type Scenario } from './scenarios.ts'
import { PACKAGE_MANAGERS, isPackageManager, toolCommand, toolInstalled } from './tools.ts'
import type {
  InstallResult,
  InstallsFile,
  KindSummary,
  PackageManager,
  RequestKind,
  RequestRecord,
} from './types.ts'

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    pm: { type: 'string' },
    registry: { type: 'string' },
    fixture: { type: 'string' },
    scenario: { type: 'string' },
    keep: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '20' },
  },
})

const list = (value: string | undefined): string[] | undefined =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined

const versions = readVersions()
const pms = (list(values.pm) ?? PACKAGE_MANAGERS).map((pm) => {
  if (!isPackageManager(pm)) throw new Error(`Unknown package manager: ${pm}`)
  if (!toolInstalled(pm, versions[pm]!))
    throw new Error(`${pm}@${versions[pm]} is not installed; run: node src/toolcache.ts`)
  return pm
})
const registries = (list(values.registry) ?? REGISTRY_IDS).map((id) => {
  if (!isRegistryId(id)) throw new Error(`Unknown registry: ${id}`)
  return id
})
const fixtures =
  list(values.fixture) ??
  readdirSync(FIXTURES_DIR)
    .filter((f) => existsSync(join(FIXTURES_DIR, f, 'package.json')))
    .sort()
const scenarioFilter = list(values.scenario)
const timeoutMs = Number(values.timeout) * 60_000

const runId = values['run-id'] ?? newRunId()
const runDir = ensureDir(join(RESULTS_DIR, runId))
const installsFile = join(runDir, 'installs.json')
const installs: InstallsFile = existsSync(installsFile)
  ? readJson<InstallsFile>(installsFile)
  : {
      runId,
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      versions,
      results: [],
    }

console.log(`run ${runId}: ${pms.join(',')} x ${registries.join(',')} x ${fixtures.join(',')}`)

for (const pm of pms) {
  for (const scenario of scenariosFor(pm)) {
    if (scenarioFilter && !scenarioFilter.includes(scenario.id)) continue
    for (const fixture of fixtures) {
      for (const registry of registries) {
        const id = `${pm}.${scenario.id}.${registry}.${fixture}`
        const existing = installs.results.find((r) => resultId(r) === id)
        if (existing?.ok) {
          console.log(`${id}: already done, skipping`)
          continue
        }
        const result = await runOne(pm, scenario, registry, fixture)
        installs.results = installs.results.filter((r) => resultId(r) !== id)
        installs.results.push(result)
        writeJson(installsFile, installs)
        console.log(
          `${id}: ${result.ok ? 'ok' : `FAILED (exit ${result.exitCode})`} in ${(result.durationMs / 1000).toFixed(1)}s` +
            ` | packuments ${result.packuments.count} = ${fmtBytes(result.packuments.wireBytes)} on the wire` +
            ` | tarballs ${result.tarballs.count} = ${fmtBytes(result.tarballs.wireBytes)}` +
            ` | accept ${result.packuments.accept.join(' | ') || '-'} | encoding ${result.packuments.contentEncoding.join(',') || '-'}`,
        )
      }
    }
  }
}
console.log(`wrote ${relative(ROOT, installsFile)}`)

function resultId(r: InstallResult): string {
  return `${r.pm}.${r.scenario}.${r.registry}.${r.fixture}`
}

async function runOne(
  pm: PackageManager,
  scenario: Scenario,
  registry: RegistryId,
  fixture: string,
): Promise<InstallResult> {
  const id = `${pm}.${scenario.id}.${registry}.${fixture}`
  const workDir = join(WORK_DIR, runId, id)
  rmSync(workDir, { recursive: true, force: true })
  const projectDir = ensureDir(join(workDir, 'project'))
  const homeDir = ensureDir(join(workDir, 'home'))
  const cacheDir = ensureDir(join(workDir, 'cache'))
  const tmpDir = ensureDir(join(workDir, 'tmp'))
  cpSync(join(FIXTURES_DIR, fixture, 'package.json'), join(projectDir, 'package.json'))

  const requestsFile = join(runDir, 'requests', `${id}.ndjson`)
  const logFile = join(runDir, 'logs', `${id}.log`)
  rmSync(requestsFile, { force: true })
  ensureDir(dirname(requestsFile))
  ensureDir(dirname(logFile))

  const proxy = await startProxy(requestsFile)
  const registryUrl = `${proxy.origin}/${registry}/`
  const setup = buildSetup(scenario, { registryUrl, projectDir, homeDir, cacheDir })
  for (const [file, contents] of Object.entries(setup.files)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  const tool = toolCommand(pm, versions[pm]!)
  const args = [...tool.args, ...setup.args]
  const env = sandboxEnv(homeDir, tmpDir, setup.env)

  const startedAt = new Date().toISOString()
  const started = performance.now()
  const exitCode = await new Promise<number | null>((resolve) => {
    const out = createWriteStream(logFile)
    out.write(`$ ${[tool.command, ...args].join(' ')}\n\n`)
    const child = spawn(tool.command, args, {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(out, { end: false })
    child.stderr.pipe(out, { end: false })
    const timer = setTimeout(() => {
      out.write(`\n[timed out after ${timeoutMs}ms]\n`)
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      out.end(`\n[exit ${code}]\n`)
      resolve(code)
    })
  })
  const durationMs = Math.round(performance.now() - started)
  await proxy.stop()

  const records = readNdjson<RequestRecord>(requestsFile)
  const userAgent = records.find((r) => r.reqUserAgent)?.reqUserAgent
  const result: InstallResult = {
    pm,
    version: versions[pm]!,
    scenario: scenario.id,
    scenarioLabel: scenario.label,
    registry,
    fixture,
    startedAt,
    durationMs,
    exitCode,
    ok: exitCode === 0 && records.some((r) => r.kind === 'packument' && r.status === 200),
    command: [pm, ...setup.args].join(' '),
    ...(userAgent ? { userAgent } : {}),
    packuments: summarize(records, 'packument'),
    manifests: summarize(records, 'manifest'),
    tarballs: summarize(records, 'tarball'),
    other: summarize(records, 'other'),
    requestsFile: relative(ROOT, requestsFile),
    logFile: relative(ROOT, logFile),
  }
  if (!values.keep) {
    // A package manager may still be flushing a cache write when it exits; retry, and never let cleanup fail a run.
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (err) {
      console.warn(`could not remove ${workDir}: ${String((err as Error).message)}`)
    }
  }
  return result
}

function summarize(records: RequestRecord[], kind: RequestKind): KindSummary {
  const matching = records.filter((r) => r.kind === kind)
  const statuses: Record<string, number> = {}
  for (const r of matching) statuses[r.status] = (statuses[r.status] ?? 0) + 1
  const unique = (values: (string | undefined)[]) =>
    [...new Set(values.filter((v): v is string => !!v))].sort()
  const byAccept: Record<string, { count: number; wireBytes: number }> = {}
  for (const r of matching) {
    const accept = r.reqAccept ?? '(none)'
    byAccept[accept] ??= { count: 0, wireBytes: 0 }
    byAccept[accept].count++
    byAccept[accept].wireBytes += r.wireBytes
  }
  return {
    count: matching.length,
    wireBytes: matching.reduce((n, r) => n + r.wireBytes, 0),
    bodyBytes: matching.reduce((n, r) => n + (r.bodyBytes ?? 0), 0),
    statuses,
    accept: unique(matching.map((r) => r.reqAccept)),
    contentType: unique(matching.map((r) => r.resContentType)),
    contentEncoding: unique(
      matching.map((r) => r.resContentEncoding ?? (r.status === 200 ? 'identity' : undefined)),
    ),
    redirects: matching.reduce((n, r) => n + r.redirects, 0),
    byAccept,
  }
}

/** The proxy runs as its own process so the request log survives whatever the install does. */
function startProxy(log: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [join(ROOT, 'src', 'proxy.ts'), '--log', log, '--quiet'],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    let buffered = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const match = buffered.match(/READY (http:\/\/[^\s]+)/)
      if (match) {
        resolve({
          origin: match[1]!,
          stop: () =>
            new Promise((done) => {
              child.once('exit', () => done())
              child.kill('SIGTERM')
            }),
        })
      }
    })
    child.on('exit', (code) => reject(new Error(`proxy exited early with code ${code}`)))
  })
}
