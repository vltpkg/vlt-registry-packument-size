import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLCACHE_DIR } from './lib.ts'
import type { PackageManager } from './types.ts'

export const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'bun', 'vlt']

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as string[]).includes(value)
}

export function toolDir(pm: PackageManager, version: string): string {
  return join(TOOLCACHE_DIR, pm, version)
}

export interface ToolCommand {
  command: string
  args: string[]
}

/**
 * How to invoke a package manager from the tool cache. Each one is installed
 * with the system npm into its own prefix, and invoked by an absolute path so
 * whatever is on the user's PATH is never used.
 */
export function toolCommand(pm: PackageManager, version: string): ToolCommand {
  const dir = toolDir(pm, version)
  const modules = join(dir, 'node_modules')
  switch (pm) {
    case 'npm':
      return { command: process.execPath, args: [join(modules, 'npm', 'bin', 'npm-cli.js')] }
    case 'vlt':
      return { command: process.execPath, args: [join(modules, 'vlt', 'vlt.js')] }
    case 'pnpm':
      return { command: join(modules, '.bin', 'pnpm'), args: [] }
    case 'bun': {
      const oven = join(modules, '@oven')
      const platform = existsSync(oven)
        ? readdirSync(oven).find((d) => d.startsWith('bun-'))
        : undefined
      if (!platform) throw new Error(`bun binary not found under ${oven}; run the toolcache script`)
      return { command: join(oven, platform, 'bin', 'bun'), args: [] }
    }
  }
}

export function toolInstalled(pm: PackageManager, version: string): boolean {
  return existsSync(join(toolDir(pm, version), '.ok'))
}
