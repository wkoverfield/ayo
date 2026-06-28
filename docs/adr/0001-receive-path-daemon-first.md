# ADR 0001 — Receive path is daemon-first, not MCP-first

**Status:** Accepted
**Date:** 2026-06-28

## Context

Ayo's whole value is "an attention ping with work context" delivered without a
context switch. Sending is easy on every surface (CLI, MCP). **Receiving** is the
hard part and the make-or-break: how does a teammate find out an Ayo arrived
without babysitting a `watch` pane?

The original PRD leaned on `ayo watch` and MCP tools as the receive path. Two
problems:

1. **A human polling a `watch` pane is exactly the friction that kills the
   product.** It degrades to "Slack, but you have to remember to check it."
2. **You cannot reliably push into a closed agent UI mid-work.** Neither Codex
   nor Claude Code guarantees displaying an unsolicited server-initiated event
   in the middle of a turn. MCP server push exists (Streamable HTTP + SSE) but
   client surfacing is not guaranteed, so it cannot be the backbone.

## Decision

**Receiving an Ayo is a machine event, not an agent event.** Decouple delivery
from the agent entirely, then let the agent *surface* what already arrived at
its natural breakpoints. Three layers, defense-in-depth — no single layer has
to be perfect:

```
Relay  ->  local Ayo daemon (ayod)  ->  OS notification + ~/.ayo/inbox.json   [real-time, always works]
                                    ->  agent hooks surface unread at turn/session boundaries  [agent-native]
                                    ->  MCP / CLI read + reply on demand        [pull]
```

### Layer 0 — Local daemon (`ayod`) — CORE MVP
- `ayo login` offers to install a tiny background process (`launchd` on macOS,
  `systemd --user` on Linux; Windows Startup task later — fail gracefully, don't
  silently no-op).
- Holds **one persistent connection** (WebSocket/SSE) to the relay.
- On arrival: fires a **native OS toast** (`node-notifier` / `terminal-notifier`),
  writes unread state to `~/.ayo/inbox.json`, optional terminal bell.
- Works regardless of focused app — Codex, Claude, terminal, browser, whatever.
- `ayo watch` is demoted to a **debug/manual fallback**, not the product.

### Layer 1 — Agent hooks — THE MAGIC LAYER (surface, don't re-notify)
- Claude Code `SessionStart` (stdout is injected as model context) and `Stop`.
- Codex `notify` in `config.toml` (fires on `agent-turn-complete`).
- Each runs `ayo inbox --agent-context` (a.k.a. `surface-unread`), which
  **silently injects unread state into the model** and dedupes against a
  last-seen marker.
- **Ownership rule: the daemon owns notification; hooks own context injection.**
  Hooks MUST NOT pop their own toast on every turn (Codex/Claude fire every
  turn — that's spam). Hooks only toast as a self-healing fallback when the
  daemon is detected dead.

### Layer 2 — MCP / CLI pull
- `read_inbox` MCP tool and `ayo inbox` for "check my Ayos."
- MCP's real strength is **send + handoff** (`send_ayo`, `create_handoff`,
  `share_context`), not receive.

## Relay implication

The relay can no longer be pure request/response CRUD — it must hold long-lived
fanout connections. **Chosen infra: Cloudflare Workers + Durable Objects**
(taste/cost fit for a devtool; cheap WebSockets).

- **Topology: one Durable Object per team**, acting as the fanout hub holding
  every online member's WebSocket. Presence/status lives in the same DO.
- **WebSocket hibernation** lets an idle team's DO evict from memory while
  keeping sockets alive, waking on the next Ayo — idle teams cost ~nothing,
  delivery stays instant.
- (Supabase Realtime was the alternative; rejected on taste, not capability.)

## Trust requirement

A background daemon reads as sketchy unless it's transparent and boring. The CLI
must ship inspectability from day one:

```
ayo doctor          # environment + connectivity check
ayo daemon status   # is ayod running, connected, last heartbeat
ayo daemon logs     # what it has done
ayo daemon stop
ayo uninstall       # removes daemon + config cleanly
```

## First lovable slice (don't over-index on "zero user action")

Zero-action is the *second* demo, not the first. Prove the spine first:

```
ayo login
ayo daemon start
ayo kenny "demo is cooked"
```

Receiver gets a native toast, then says in Codex/Claude: "check my Ayos."
That alone proves the whole architecture. Hooks (Layer 1) make it feel magical
afterward.

## Consequences

- Ayo is **local infra that makes agent communication ambient** — install once,
  receive anywhere — not "a CLI/MCP package." The daemon is the moat; the
  agent/MCP adapters are a commodity bonus layer.
- Build order shifts: daemon + realtime relay are MVP, not later phases.
- We must own a cross-platform notification + background-process install story.
- We accept we cannot interrupt mid-turn inside closed UIs; OS toast covers
  real-time urgency, and the agent refreshes context within one turn.
