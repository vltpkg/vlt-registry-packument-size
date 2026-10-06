#!/usr/bin/env node
/**
 * Installs the pinned package manager versions from versions.json into
 * .toolcache/<pm>/<version>/ using the system npm as a bootstrapper.
 * Nothing in the tool cache is ever on PATH; run-installs invokes each tool
 * by absolute path.
 *
 *   node src/toolcache.ts [--force]
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureDir, readVersions, TOOLCACHE_DIR } from './lib.ts'
import { PACKAGE_MANAGERS, toolCommand, toolDir, toolInstalled } from './tools.ts'

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } })
const versions = readVersions()
const npmCache = ensureDir(join(TOOLCACHE_DIR, '.npm-cache'))
const npmrc = join(TOOLCACHE_DIR, '.npmrc')
writeFileSync(npmrc, 'registry=https://registry.npmjs.org/\n')

for (const pm of PACKAGE_MANAGERS) {
  const version = versions[pm]
  if (!version) throw new Error(`versions.json has no entry for ${pm}`)
  const dir = toolDir(pm, version)
  if (!values.force && toolInstalled(pm, version)) {
    console.log(`${pm}@${version} already in ${dir}`)
    continue
  }
  rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `toolcache-${pm}`, private: true }),
  )
  console.log(`installing ${pm}@${version} into ${dir}`)
  const install = spawnSync(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--no-package-lock',
      '--loglevel=error',
      `${pm}@${version}`,
    ],
    {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_cache: npmCache, npm_config_userconfig: npmrc },
    },
  )
  if (install.status !== 0) throw new Error(`npm install ${pm}@${version} failed`)

  const { command, args } = toolCommand(pm, version)
  const check = spawnSync(command, [...args, '--version'], { encoding: 'utf8' })
  const reported = check.stdout.trim().split('\n').at(-1)?.trim()
  if (check.status !== 0 || reported !== version) {
    throw new Error(
      `${pm} --version reported "${reported}" (exit ${check.status}), expected ${version}\n${check.stderr}`,
    )
  }
  writeFileSync(join(dir, '.ok'), version + '\n')
  console.log(`${pm}@${version} ok (${command})`)
}

console.log('toolcache ready')
