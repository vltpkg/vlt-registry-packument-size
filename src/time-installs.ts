#!/usr/bin/env node
/**
 * Times clean installs straight against each registry (no proxy), in a fresh
 * sandbox every run, and reports median and minimum wall time per package
 * manager, scenario, fixture and registry.
 *
 *   node src/time-installs.ts [--run-id <id>] [--runs 5] [--pm npm,vlt] [--fixture next-app]
 *                             [--scenario default] [--registry npm,vlt] [--timeout <minutes>]
 *
 * Wall time depends on the machine, its network and the registries' caches at
 * the moment of the run, so unlike the byte counts these numbers are not
 * reproducible across machines. They are still useful as a relative measure:
 * each run installs from both registries back to back so drift hits both.
 * Results go to results/<run-id>/timings.json; re-running with the same id
 * skips combinations that already have enough runs.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import {
  FIXTURES_DIR,
  RESULTS_DIR,
  ROOT,
  WORK_DIR,
  ensureDir,
  newRunId,
  readJson,
  median,
  readVersions,
  sandboxEnv,
  writeJson,
} from './lib.ts'
import { REGISTRIES, REGISTRY_IDS, isRegistryId, type RegistryId } from './registries.ts'
import { buildSetup, scenariosFor, type Scenario } from './scenarios.ts'
import { PACKAGE_MANAGERS, isPackageManager, toolCommand, toolInstalled } from './tools.ts'
import type { PackageManager, Timing, TimingsFile } from './types.ts'

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    runs: { type: 'string', default: '5' },
    pm: { type: 'string' },
    fixture: { type: 'string' },
    scenario: { type: 'string', default: 'default' },
    registry: { type: 'string' },
    timeout: { type: 'string', default: '20' },
  },
})
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)

const versions = readVersions()
const pms = (list(values.pm) ?? PACKAGE_MANAGERS).map((pm) => {
  if (!isPackageManager(pm)) throw new Error(`Unknown package manager: ${pm}`)
  if (!toolInstalled(pm, versions[pm]!)) throw new Error(`${pm}@${versions[pm]} is not installed; run: node src/toolcache.ts`)
  return pm
})
const registries = (list(values.registry) ?? REGISTRY_IDS).map((id) => {
  if (!isRegistryId(id)) throw new Error(`Unknown registry: ${id}`)
  return id
})
const fixtures = list(values.fixture) ?? readdirSync(FIXTURES_DIR).filter((f) => existsSync(join(FIXTURES_DIR, f, 'package.json'))).sort()
const scenarioFilter = list(values.scenario)
const wantedRuns = Number(values.runs)
const timeoutMs = Number(values.timeout) * 60_000

const runId = values['run-id'] ?? newRunId()
const runDir = ensureDir(join(RESULTS_DIR, runId))
const file = join(runDir, 'timings.json')
const timings: TimingsFile = existsSync(file)
  ? readJson<TimingsFile>(file)
  : { runId, startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, versions, timings: [] }

const tokens: Partial<Record<RegistryId, string>> = {}
for (const id of registries) {
  const auth = REGISTRIES[id].authorization?.()
  if (auth) tokens[id] = auth.replace(/^bearer /i, '')
}

console.log(`run ${runId}: ${wantedRuns} runs of ${pms.join(',')} x ${fixtures.join(',')} x ${registries.join(',')}, straight at the registries`)

for (const pm of pms) {
  for (const scenario of scenariosFor(pm)) {
    if (scenarioFilter && !scenarioFilter.includes(scenario.id)) continue
    for (const fixture of fixtures) {
      const entries = registries.map((registry) => entryFor(pm, scenario, fixture, registry))
      // Interleave registries: run i of every registry before run i+1 of any.
      for (let i = 0; i < wantedRuns; i++) {
        for (const entry of entries) {
          if (entry.runs.length + entry.failed >= wantedRuns) continue
          const ms = await timeOne(pm, scenario, fixture, entry.registry, i)
          if (ms === null) entry.failed++
          else entry.runs.push(ms)
          writeJson(file, timings)
        }
      }
      for (const entry of entries) console.log(describe(entry))
    }
  }
}
console.log(`wrote ${relative(ROOT, file)}`)

function entryFor(pm: PackageManager, scenario: Scenario, fixture: string, registry: RegistryId): Timing {
  let entry = timings.timings.find((t) => t.pm === pm && t.scenario === scenario.id && t.fixture === fixture && t.registry === registry)
  if (!entry) {
    entry = { pm, version: versions[pm]!, scenario: scenario.id, scenarioLabel: scenario.label, fixture, registry, runs: [], failed: 0 }
    timings.timings.push(entry)
  }
  return entry
}

async function timeOne(pm: PackageManager, scenario: Scenario, fixture: string, registry: RegistryId, i: number): Promise<number | null> {
  const id = `${pm}.${scenario.id}.${fixture}.${registry}.${i}`
  const workDir = join(WORK_DIR, runId, 'timing', id)
  rmSync(workDir, { recursive: true, force: true })
  const projectDir = ensureDir(join(workDir, 'project'))
  const homeDir = ensureDir(join(workDir, 'home'))
  const cacheDir = ensureDir(join(workDir, 'cache'))
  const tmpDir = ensureDir(join(workDir, 'tmp'))
  cpSync(join(FIXTURES_DIR, fixture, 'package.json'), join(projectDir, 'package.json'))

  const setup = buildSetup(scenario, {
    registryUrl: REGISTRIES[registry].upstream,
    registryToken: tokens[registry],
    projectDir,
    homeDir,
    cacheDir,
  })
  for (const [path, contents] of Object.entries(setup.files)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const tool = toolCommand(pm, versions[pm]!)
  const env = sandboxEnv(homeDir, tmpDir, setup.env)
  const logFile = join(runDir, 'logs', 'timing', `${id}.log`)
  ensureDir(dirname(logFile))

  const started = performance.now()
  const code = await new Promise<number | null>((resolve) => {
    const output: Buffer[] = []
    const child = spawn(tool.command, [...tool.args, ...setup.args], { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c: Buffer) => output.push(c))
    child.stderr.on('data', (c: Buffer) => output.push(c))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      writeFileSync(logFile, Buffer.concat(output))
      resolve(exitCode)
    })
  })
  const ms = Math.round(performance.now() - started)
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch {
    // leave it; the next run uses a fresh directory anyway
  }
  if (code !== 0) {
    console.log(`  ${id}: exit ${code} after ${(ms / 1000).toFixed(1)}s (see ${relative(ROOT, logFile)})`)
    return null
  }
  return ms
}

function describe(t: Timing): string {
  if (t.runs.length === 0) return `${t.pm} ${t.scenarioLabel} ${t.fixture} ${t.registry}: no successful runs`
  const s = (ms: number) => (ms / 1000).toFixed(1) + 's'
  return `${t.pm} ${t.scenarioLabel} ${t.fixture} ${t.registry}: median ${s(median(t.runs))} min ${s(Math.min(...t.runs))} max ${s(Math.max(...t.runs))} (${t.runs.length} runs${t.failed ? `, ${t.failed} failed` : ''})`
}
