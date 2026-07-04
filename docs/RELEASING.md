# Releasing to npm

Ayo ships three public packages from this monorepo (the relay is `private` and
deploys to Cloudflare instead — see below):

| Package | What | Install |
| --- | --- | --- |
| `@ayo-dev/cli` | the `ayo` command + `ayod` daemon | `npm i -g @ayo-dev/cli` |
| `@ayo-dev/mcp` | the MCP server for Codex & Claude | via `ayo mcp install` |
| `@ayo-dev/core` | shared types (dependency of the other two) | — |

## One-time setup

1. **Create the npm org.** The packages are scoped `@ayo-dev`, so an npm
   organization named `ayo-dev` must exist and you must be a member. Public
   packages under an org are free. (The npm org is separate from the GitHub org.)
2. **Log in:** `npm login` (or `npm whoami` to confirm).

## Cut a release

```bash
# from the repo root, on `main`, with a clean tree
git checkout main && git pull
pnpm release
```

`pnpm release` runs `pnpm -r publish --access public`, which:

- publishes in dependency order (`core` before `cli`/`mcp`),
- rebuilds each package's `dist` via its `prepack` hook right before packing, so
  the tarball is never stale (this also covers a bare `pnpm -r publish`),
- rewrites the `workspace:^` dependency on `@ayo-dev/core` to the real
  version range (`^0.1.0`) in the published tarballs,
- skips the `private` relay package.

Each `package.json` already sets `publishConfig.access = public`, so the
`--access public` flag is belt-and-suspenders.

> **Be on `main`.** `pnpm publish` refuses to publish from a non-default branch
> (override with `--no-git-checks`, but prefer just being on `main`). It also
> requires a clean working tree.

### Versioning

All three packages move in lockstep. Bump just the publishable ones, without
creating per-package git tags:

```bash
pnpm --filter @ayo-dev/core --filter @ayo-dev/cli --filter @ayo-dev/mcp \
  exec npm version patch --no-git-tag-version   # or minor / major
git commit -am "release: vX.Y.Z" && git tag vX.Y.Z
```

(pnpm publishes only versions not already on the registry, so a re-run after a
partial failure is safe. If `cli`/`mcp` can't resolve `@ayo-dev/core` right after
publish, give the registry CDN ~a minute to propagate and re-run `pnpm release`.)

> **Lockstep is load-bearing, not just tidy:** `cli`/`mcp` import
> `@ayo-dev/core/node` (added after 0.2.0), and their `workspace:^` dep lets npm
> satisfy the range with an older published core. Publishing cli/mcp without
> bumping+publishing core in the same release ships a CLI that dies at import
> with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Notes

- `pnpm publish` enforces a clean git tree and will refuse on a dirty checkout.
  Use `--no-git-checks` only if you know why you need it.
- `files` is `["dist", "README.md"]` in each package — verify the tarball with
  `npm pack --dry-run` in a package dir before a first publish.
- Shebangs (`#!/usr/bin/env node`) are present in `ayo`, `ayod`, and the MCP
  entry, so the global `bin` installs are executable.

## The relay

The relay is **not** published to npm. Deploy it to Cloudflare:

```bash
cd packages/relay && pnpm deploy   # wrangler deploy
```

Live: https://ayo-relay.wkoverfield.workers.dev (the CLI's default;
override with `AYO_RELAY_URL` or `relayUrl` in `~/.ayo/config.json`).
