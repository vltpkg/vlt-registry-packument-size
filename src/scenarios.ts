import { join } from 'node:path'
import type { PackageManager } from './types.ts'

export interface InstallContext {
  /** The registry URL the package manager is pointed at: the proxy, or the registry itself. */
  registryUrl: string
  /** Bearer token for `registryUrl`, when the package manager talks to it directly. */
  registryToken?: string
  projectDir: string
  homeDir: string
  cacheDir: string
}

export type Settings = Record<string, string | number | boolean>

export interface Scenario {
  pm: PackageManager
  id: string
  /** Short label for tables, e.g. "--min-release-age=7". */
  label: string
  description: string
  /** Extra CLI flags appended to the install command. */
  args?: string[]
  /** Extra settings merged into the package manager's config file. */
  settings?: Settings
}

export interface Setup {
  args: string[]
  env: Record<string, string>
  /** Absolute file path -> contents, written before the install runs. */
  files: Record<string, string>
}

/**
 * The scenarios we measure. Every package manager is measured with its
 * defaults, plus whichever options change which packument representation it
 * asks the registry for. Verified in each package manager's source at the
 * pinned version:
 *
 * - npm: `@npmcli/arborist/lib/arborist/build-ideal-tree.js` passes
 *   `fullMetadata: true` in `#fetchManifest`; `pacote/lib/fetcher.js` sets
 *   `fullMetadata = before ? true : opts.fullMetadata`; the Accept values are
 *   `corgiDoc` / `fullDoc` in `pacote/lib/registry.js`.
 * - pnpm: `pnpm/crates/resolving-npm-resolver/src/fetch_full_metadata.rs`,
 *   `pick_package/options.rs` (`optional` forces full),
 *   `pick_package/release_age_upgrade.rs`, `pnpm/crates/config/src/settings.rs`
 *   (`minimum_release_age` default `Some(24 * 60)`), and
 *   `pnpm/crates/config/src/lib.rs` (`full_metadata_policy`).
 * - bun: `src/install/NetworkTask.rs` (`ACCEPT_HEADER_VALUE` /
 *   `ACCEPT_HEADER_VALUE_EXTENDED`) and
 *   `src/install/PackageManager/PackageManagerEnqueue.rs`
 *   (`needs_extended_manifest = minimum_release_age_ms.is_some()`).
 * - vlt: `src/package-info/src/index.ts` (`PACKUMENT_ACCEPT`,
 *   `#fetchPackument`, `#stable`).
 */
export const SCENARIOS: Scenario[] = [
  {
    pm: 'npm',
    id: 'default',
    label: 'default',
    description:
      'npm install. Arborist always asks for the full packument when resolving new dependencies.',
  },
  {
    pm: 'npm',
    id: 'min-release-age',
    label: '--min-release-age=7',
    description:
      'A 7 day release age window. pacote forces full metadata whenever `before` is set.',
    args: ['--min-release-age=7'],
  },
  {
    pm: 'pnpm',
    id: 'default',
    label: 'default (minimumReleaseAge=1440)',
    description:
      'pnpm install with its built-in 24 hour minimumReleaseAge. Abbreviated packuments, upgraded to full for any package modified inside the window.',
  },
  {
    pm: 'pnpm',
    id: 'release-age-0',
    label: 'minimumReleaseAge=0',
    description: 'Release age check disabled: abbreviated packuments only.',
    settings: { minimumReleaseAge: 0 },
  },
  {
    pm: 'pnpm',
    id: 'release-age-7d',
    label: 'minimumReleaseAge=10080',
    description:
      'A 7 day window: more packages were modified inside it, so more are upgraded to full.',
    settings: { minimumReleaseAge: 10080 },
  },
  {
    pm: 'pnpm',
    id: 'time-based',
    label: 'resolutionMode=time-based',
    description:
      'Time-based resolution needs per-version `time` for every package, so pnpm requests full packuments for everything (registrySupportsTimeField is false by default).',
    settings: { resolutionMode: 'time-based' },
  },
  {
    pm: 'bun',
    id: 'default',
    label: 'default',
    description: 'bun install: abbreviated packuments.',
  },
  {
    pm: 'bun',
    id: 'min-release-age',
    label: '--minimum-release-age=604800',
    description:
      'A 7 day window. bun switches to `Accept: application/json` (full packuments) whenever minimumReleaseAge is set.',
    args: ['--minimum-release-age', '604800'],
  },
  {
    pm: 'vlt',
    id: 'default',
    label: 'default',
    description: 'vlt install: asks for the vlt packument type first, then application/json.',
  },
]

export function scenariosFor(pm: PackageManager): Scenario[] {
  return SCENARIOS.filter((s) => s.pm === pm)
}

/**
 * Everything needed to run one scenario in a fresh, isolated environment.
 * Config files point at the proxy registry and at caches under the run's
 * work dir; HOME is also swapped by the runner so nothing from the real
 * user config or caches can leak in.
 */
export function buildSetup(scenario: Scenario, ctx: InstallContext): Setup {
  const settings = scenario.settings ?? {}
  const args = scenario.args ?? []
  switch (scenario.pm) {
    case 'npm':
      return {
        args: ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...args],
        env: {},
        files: {
          [join(ctx.homeDir, '.npmrc')]:
            ini({
              registry: ctx.registryUrl,
              cache: ctx.cacheDir,
              'update-notifier': false,
              progress: false,
              ...settings,
            }) + npmrcAuth(ctx),
        },
      }
    case 'pnpm':
      return {
        args: ['install', '--ignore-scripts', ...args],
        env: {
          npm_config_registry: ctx.registryUrl,
          npm_config_store_dir: join(ctx.cacheDir, 'store'),
          npm_config_cache_dir: join(ctx.cacheDir, 'cache'),
        },
        files: {
          [join(ctx.homeDir, '.npmrc')]: ini({ registry: ctx.registryUrl }) + npmrcAuth(ctx),
          [join(ctx.projectDir, 'pnpm-workspace.yaml')]: yaml({
            registry: ctx.registryUrl,
            storeDir: join(ctx.cacheDir, 'store'),
            cacheDir: join(ctx.cacheDir, 'cache'),
            ...settings,
          }),
        },
      }
    case 'bun':
      return {
        args: ['install', '--ignore-scripts', ...args],
        env: {
          BUN_INSTALL: join(ctx.homeDir, '.bun'),
          BUN_INSTALL_CACHE_DIR: ctx.cacheDir,
          BUN_CONFIG_REGISTRY: ctx.registryUrl,
        },
        files: {
          [join(ctx.projectDir, 'bunfig.toml')]: [
            '[install]',
            ctx.registryToken
              ? `registry = { url = ${JSON.stringify(ctx.registryUrl)}, token = ${JSON.stringify(ctx.registryToken)} }`
              : `registry = ${JSON.stringify(ctx.registryUrl)}`,
            ...Object.entries(settings).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
            '',
            '[install.cache]',
            `dir = ${JSON.stringify(ctx.cacheDir)}`,
            '',
          ].join('\n'),
        },
      }
    case 'vlt':
      return {
        args: ['install', ...args],
        env: {},
        files: {
          // vlt reads its tokens from the keychain under XDG_DATA_HOME, keyed by
          // registry URL, and stores them with their scheme ("Bearer ...").
          ...(ctx.registryToken
            ? {
                [join(ctx.homeDir, '.local', 'share', 'vlt', 'auth', 'keychain.json')]: JSON.stringify({
                  [ctx.registryUrl.replace(/\/+$/, '')]: `Bearer ${ctx.registryToken}`,
                }),
              }
            : {}),
          [join(ctx.projectDir, 'vlt.json')]: JSON.stringify(
            {
              config: {
                registry: ctx.registryUrl,
                registries: { npm: ctx.registryUrl },
                cache: ctx.cacheDir,
                telemetry: false,
                ...settings,
              },
            },
            null,
            2,
          ),
        },
      }
  }
}

/** An `.npmrc` `_authToken` line for the registry, if the context carries a token. */
function npmrcAuth(ctx: InstallContext): string {
  if (!ctx.registryToken) return ''
  const url = new URL(ctx.registryUrl)
  return `//${url.host}${url.pathname}:_authToken=${ctx.registryToken}\n`
}

function ini(settings: Settings): string {
  return (
    Object.entries(settings)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  )
}

function yaml(settings: Settings): string {
  return (
    Object.entries(settings)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
      .join('\n') + '\n'
  )
}
