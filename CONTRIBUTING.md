# Contributing to Ayo

Thanks for your interest. Ayo is early and contributions are welcome — a bug
report, a fix, a notification path on a platform I got wrong, a new agent host
for the MCP server, or a docs improvement.

Ayo is also opinionated. It has a small set of load-bearing properties (below);
the most useful contributions keep those intact. If you're unsure whether an
idea fits, open an issue first — especially for anything touching the relay or
the wire protocol.

## Getting set up

Ayo is a pnpm monorepo (`packages/{cli,mcp,core,relay}`). You need Node 20+,
[pnpm](https://pnpm.io), and `git` on the PATH.

```bash
git clone https://github.com/wkoverfield/ayo && cd ayo
pnpm install
pnpm -r build        # tsc across all packages (core first)
pnpm -r typecheck
```

Run the CLI from source against a **local relay** — you don't need the hosted
one, or a GitHub app, to develop:

```bash
# 1. enable the no-GitHub dev auth stub (NEVER use this in production)
cp packages/relay/.dev.vars.example packages/relay/.dev.vars

# 2. boot the local Worker + Durable Object (defaults to http://127.0.0.1:8787)
pnpm dev:relay

# 3. in another shell, point the built CLI at it. AYO_DIR lets you run several
#    personas side by side on one machine — handy for testing a real exchange.
export AYO_RELAY_URL=http://127.0.0.1:8787
AYO_DIR=/tmp/ayo-you  node packages/cli/dist/ayo.js login --handle you
AYO_DIR=/tmp/ayo-maya node packages/cli/dist/ayo.js login --handle maya
```

`scripts/demo.sh` boots a whole 3-person team against a local relay if you want
a scripted scene to poke at (`scripts/record-demo.sh` renders a terminal gif).

## Load-bearing properties (please keep them intact)

- **The output is truthful.** Ayo never prints a green ✓ for a message that
  reached no one, and exit codes match reality (a directed send that lands
  nowhere is a failure). If you change a send/receive path, keep it honest.
- **The relay is the only place identity is verified.** The Worker injects the
  authenticated `x-ayo-*` identity into the Durable Object; the DO never trusts
  a client-supplied identity (see [ADR 0002](docs/adr/0002-relay-contract-and-message-schema.md)).
  Don't route around that boundary.
- **No LLM calls, ever.** Ayo moves messages and context; it does not summarize,
  rewrite, or generate. The user runs and pays for the agents.
- **It's a sidechannel, not a second inbox.** Ayo forgets your 1:1 pings on
  purpose. Don't add persistence or surfaces that turn it into another thing to
  keep up with.
- **Vendor-neutral and flow-preserving.** New agent hosts are welcome; don't
  couple the core to one vendor, and don't add anything that makes someone leave
  their terminal or agent to use it.

## Where contributions fit best

Great, low-friction targets (many are scoped in [docs/FOLLOWUPS.md](docs/FOLLOWUPS.md)):

- CLI ergonomics, output, and help.
- Platform notification paths (Windows action buttons, Linux best-effort).
- New MCP hosts (Windsurf, Zed, VS Code) via the host registry in `mcp-setup`.
- Docs, examples, and the local-dev experience.

Please **open an issue before a PR** for changes to the **relay** or the **core
wire protocol** — that's the identity/security boundary, and the schema is a
compatibility contract across published packages.

## Sending a pull request

1. Fork and branch: `fix/…`, `feat/…`, `perf/…`, `docs/…`, or `chore/…`.
2. Keep it focused, and describe what it does and why in the PR.
3. `pnpm -r build` and `pnpm -r typecheck` should be clean. If your change has
   observable behavior, exercise it against a local relay and say how in the PR.
4. For anything touching a send/receive path, presence, or the handoff page, a
   short note on the failure mode you're guarding against helps a lot.

CI runs build + typecheck across Linux/macOS/Windows on Node 20 and 22, plus a
Swift compile of the macOS notifier.

## Reporting bugs

Open an issue with the smallest repro you can, and include `ayo doctor` output
(it redacts nothing sensitive). Found a security issue? Please **don't** open a
public issue — see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
