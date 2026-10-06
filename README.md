# vlt registry packument size

How many bytes of package metadata does a clean install download from
`registry.npmjs.org` versus `registry.vlt.io`, with each of the major package
managers, and which options change that?

Everything here is reproducible: pinned package manager versions, a fresh
sandbox for every install, a recording proxy, and raw logs for every run.

## Quick start

Requires Node 24 or newer, nothing to install, and a token for
`registry.vlt.io`: `VLT_TOKEN`, or the one `vlt login` stored in the vlt CLI
keychain. `VLT_REGISTRY` and `NPM_REGISTRY` override the registry URLs.

```sh
node src/toolcache.ts            # install the versions in versions.json into .toolcache/
node src/run-installs.ts         # every package manager x scenario x fixture x registry
node src/fetch-packuments.ts     # top 1000 packages (+ packages/extra.txt), fetched directly
node src/report.ts               # results/<run-id>/REPORT.md
node src/time-installs.ts        # optional: wall time of the same installs, straight at the registries
```

`run-installs` and `fetch-packuments` take `--run-id <id>` so their results
share a directory, and both resume. `run-installs` also takes `--pm`,
`--registry`, `--fixture`, `--scenario`, `--keep` and `--timeout <minutes>`.

Each run writes `results/<run-id>/`, which git ignores:

```
installs.json               one entry per install: request counts, wire bytes, Accept and encodings seen
requests/<install>.ndjson   the proxy's log, one line per request
logs/<install>.log          the package manager's own output
packuments.ndjson / .json   direct fetches, one line per package x endpoint x encoding, and totals
timings.json                wall time per run, from time-installs
REPORT.md                   from report.ts
```

Wall times depend on the machine, its network and what the registries' CDNs
have cached at that moment. They are a relative measure between the two
registries on one machine, not a reproducible number like the byte counts.

## What is measured

A **packument** is the registry document for a package: every version's
manifest plus dist-tags and, in the full form, publish times, the readme and
more. Installers fetch one per package they resolve. Only clean installs are
measured: with a lockfile there are few or no packuments to fetch.

Every install runs through a recording proxy, and the numbers are what the
proxy saw:

- Each package manager is installed into `.toolcache/` and invoked by absolute
  path, in a fresh project directory with its own `HOME`, XDG directories,
  `TMPDIR` and cache, under a minimal environment. No user config, token or
  warm cache can leak in.
- The package manager's registry is the proxy (`http://127.0.0.1:<port>/npm/`
  or `/vlt/`). The proxy forwards each request upstream with the client's own
  headers, adds the vlt registry's auth, and rewrites `dist.tarball` URLs so
  tarballs flow through it too.
- For every request it records the kind (packument, manifest, tarball, other),
  the `Accept` and `Accept-Encoding` sent, the `Content-Type` and
  `Content-Encoding` received, and the body bytes as they crossed the wire,
  before decompression. It runs as its own process and appends to its log as
  it goes; the runner never trusts the package manager's own output.

### Fixtures

`fixtures/<name>/package.json`, four realistic starting points:

| Fixture       | What it is                                                                 |
| ------------- | -------------------------------------------------------------------------- |
| `next-app`    | `create-next-app` defaults: Next.js, React, Tailwind, ESLint, TypeScript.  |
| `vite-react`  | `npm create vite` React + TypeScript template with the flat ESLint config. |
| `express-api` | Express 5, pg, drizzle-orm, zod, helmet, morgan, dotenv, tsx, vitest.      |
| `node-cli`    | commander, chalk, ora, @inquirer/prompts, tsup, prettier, vitest.          |

### Package lists

`packages/top-1000.txt` is the 1000 most downloaded packages on npm, ranked
by the npm download counts the vlt registry syncs, as of March 2026.
`packages/extra.txt` holds one-offs reported individually: `prisma` and
`@prisma/client` for their size, and `next` for its thousands of prerelease
versions.

`fetch-packuments` requests each package from every endpoint in
`src/fetch-packuments.ts` (full, abbreviated, the vlt type, and the vlt type
with `?stable`) with `Accept-Encoding: gzip` and with `br`.

## Scenarios

Registries serve different representations by `Accept` header.
`application/vnd.npm.install-v1+json` is the abbreviated ("corgi") packument
without readmes, per-version `time` and most non-install fields;
`application/json` is the full document. registry.vlt.io also understands
`application/vnd.vlt.packument-v1+json`, an abbreviated form that keeps
`time` and `license`, and slims its `application/json` form to install fields.

What each package manager asks for, from its source at the pinned version
(references in `src/scenarios.ts`):

- **npm 12**: always the full packument.
- **pnpm 12**: abbreviated, re-fetched in full for packages modified inside
  `minimumReleaseAge` (default 1440 minutes) and for every dependency reached
  through `optionalDependencies`, since the abbreviated form lacks `libc`
  (pnpm/pnpm#9950). `resolutionMode: time-based` and
  `trustPolicy: no-downgrade` force full for everything; the latter also aborts
  installs it reads as a trust downgrade, so it is not in the matrix.
- **bun 1.4**: abbreviated; full for everything once `minimumReleaseAge` is set.
- **vlt 1.3**: `application/vnd.vlt.packument-v1+json`, falling back to
  `application/json`, so registry.npmjs.org answers with full packuments. It
  adds `?stable` when a range cannot match a prerelease and the registry
  advertises the filter. No option changes any of this.

The scenarios in `src/scenarios.ts` cover each of those switches. Every
install runs with `--ignore-scripts`.

| Package manager | Scenario                           | How                                                                 |
| --------------- | ---------------------------------- | ------------------------------------------------------------------- |
| npm             | default                            | `npm install --no-audit --no-fund --ignore-scripts`                 |
| npm             | `--min-release-age=7`              | same, plus the flag                                                 |
| pnpm            | default (`minimumReleaseAge=1440`) | `pnpm install --ignore-scripts`                                     |
| pnpm            | `minimumReleaseAge=0`              | setting in `pnpm-workspace.yaml`: release age check off             |
| pnpm            | `minimumReleaseAge=10080`          | setting in `pnpm-workspace.yaml`: 7 day window                      |
| pnpm            | `resolutionMode=time-based`        | setting in `pnpm-workspace.yaml`: full packuments for every package |
| bun             | default                            | `bun install --ignore-scripts`                                      |
| bun             | `--minimum-release-age=604800`     | same, plus the flag (7 days, in seconds)                            |
| vlt             | default                            | `vlt install`                                                       |
