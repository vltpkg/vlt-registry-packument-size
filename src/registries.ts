import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RegistryId = 'npm' | 'vlt'

export interface RegistryDef {
  id: RegistryId
  label: string
  /** Upstream base URL, always with a trailing slash. */
  upstream: string
  /** Returns an Authorization header value for upstream requests, if one is needed. */
  authorization?: () => string | undefined
}

export const REGISTRIES: Record<RegistryId, RegistryDef> = {
  npm: {
    id: 'npm',
    label: 'registry.npmjs.org',
    upstream: withSlash(process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org/'),
  },
  vlt: {
    id: 'vlt',
    label: 'registry.vlt.io',
    upstream: withSlash(process.env.VLT_REGISTRY ?? 'https://registry.vlt.io/vltpkg/npm/'),
    authorization: () => vltAuthorization(REGISTRIES.vlt.upstream),
  },
}

export const REGISTRY_IDS = Object.keys(REGISTRIES) as RegistryId[]

export function isRegistryId(value: string): value is RegistryId {
  return value in REGISTRIES
}

/**
 * The Authorization header for the vlt registry. `VLT_TOKEN` wins; otherwise
 * the token `vlt login` stored in the vlt CLI keychain for this registry is
 * used, so a machine that can run `vlt install` against the registry can run
 * the experiment without any extra setup.
 */
function vltAuthorization(upstream: string): string | undefined {
  if (process.env.VLT_TOKEN) return bearer(process.env.VLT_TOKEN)
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const keychainFile = join(dataHome, 'vlt', 'auth', 'keychain.json')
  if (!existsSync(keychainFile)) return undefined
  const keychain = JSON.parse(readFileSync(keychainFile, 'utf8')) as Record<string, unknown>
  const token = keychain[upstream.replace(/\/+$/, '')]
  return typeof token === 'string' && token ? bearer(token) : undefined
}

function bearer(token: string): string {
  return /^(bearer|basic) /i.test(token) ? token : `Bearer ${token}`
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}
