<div align="center">

# Ayo

**Ping your teammates from inside Codex and Claude.**

No Slack. No screenshots. No _"what branch are you on?"_

</div>

---

Ayo is the smallest possible sidechannel for developer attention. When the demo
breaks at 2am, you don't want to alt-tab to Slack and re-explain your whole
setup. You want to send your teammate an **attention ping with your work
context** — repo, branch, changed files, the diff, the blocker — without leaving
the tool you're already thinking in.

```bash
ayo maya "demo deploy is cooked, can you tap in?"
ayo handoff kenny --with-diff
ayo team "we're cooked"
```

Or, from inside Codex / Claude Code:

> _"Ayo Maya with my current branch, changed files, and the blocker."_

## How it works

Ayo isn't another chat app — it's **local infra that makes agent communication
ambient.** You install it once, and your machine can receive Ayos no matter
where you are: Codex, Claude Code, the terminal, the browser, whatever.

```
Relay ─▶ local Ayo daemon (ayod) ─▶ OS notification + local inbox   ← always works, real-time
                               ─▶ agent hooks surface unread at turn/session boundaries
                               ─▶ MCP / CLI read & reply on demand
```

- **The daemon receives.** A tiny background process holds one realtime
  connection to the relay and pops a native notification the instant an Ayo
  arrives. No `watch` pane to babysit.
- **The agents surface it.** Run `ayo hooks install` and Claude Code
  (`SessionStart` + `UserPromptSubmit`) quietly drops your unread Ayos into the
  model at natural breakpoints — so the ping feels native when your agent picks
  back up. Codex's `notify` gets a toast fallback. Surfacing never counts as
  "read."
- **You reply on demand.** _"Check my Ayos"_ inside the agent, or `ayo inbox` in
  the terminal.

It's honest about what it knows: **sent ≠ delivered ≠ notified ≠ read.** A toast
firing tells the sender your machine buzzed — not that you looked.

## Quickstart

> 🚧 Pre-alpha. The relay + daemon are being built. This is the target UX.

```bash
npm install -g @ayo-dev/cli

ayo login                       # GitHub device flow
ayo daemon start                # installs + starts ayod (your receiver)
ayo team create "Hack Midwest"  # get a join code
ayo invite                      # share the code

# ...your teammate runs `ayo join <code>`, then:
ayo kenny "demo is cooked"      # → native toast on Kenny's machine

ayo hooks install               # surface unread Ayos inside Codex & Claude
```

The daemon is meant to be **boring and inspectable** — never sketchy:

```bash
ayo doctor          # environment + connectivity check
ayo daemon status   # running? connected? last heartbeat?
ayo daemon logs
ayo daemon stop
ayo uninstall
```

## Packages

| Package | What it is |
|---|---|
| [`@ayo-dev/cli`](packages/cli) | The `ayo` command + the `ayod` background daemon |
| [`@ayo-dev/mcp`](packages/mcp) | MCP server exposing `send_ayo`, `read_inbox`, `create_handoff`… to Codex/Claude |
| [`@ayo-dev/core`](packages/core) | Shared message schema, wire protocol, and types |
| [`relay`](packages/relay) | Cloudflare Worker + Durable Object — realtime fanout, one DO per team |

## Design notes

The architecture is written down as ADRs:

- [ADR 0001 — Receive path is daemon-first, not MCP-first](docs/adr/0001-receive-path-daemon-first.md)
- [ADR 0002 — Relay contract, message schema, and wire protocol](docs/adr/0002-relay-contract-and-message-schema.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm dev:relay      # local Worker + Durable Object via wrangler
```

## License

MIT
