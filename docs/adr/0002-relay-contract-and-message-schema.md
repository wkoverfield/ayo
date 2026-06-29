# ADR 0002 — Relay contract, message schema, and wire protocol

**Status:** Accepted
**Date:** 2026-06-28
**Builds on:** [ADR 0001](0001-receive-path-daemon-first.md)

## Why this exists

This is the one thing the daemon, the relay, the CLI, and the MCP server all
code against. Getting it wrong is the highest-regret mistake, so it's pinned
before any of them are built. Two people can build the daemon and the relay in
parallel once they agree on this.

## Core design decisions

1. **Send is stateless HTTP. Receive is the daemon's WebSocket.**
   `ayo kenny "..."` is a short-lived process — it must not depend on the
   daemon's socket. It does an authenticated `POST`. The team Durable Object
   persists the Ayo and fans it out over the live member sockets (and queues it
   for offline members). The daemon's WebSocket is a near-pure **server→client
   push channel**.

2. **HTTP is the command channel; WebSocket is the event channel.** All
   mutations (send, read, resolve, set-status) have an HTTP endpoint so any
   one-shot process (CLI, MCP) can perform them. The WS only carries
   server-pushed events plus connection-level heartbeat. This avoids two code
   paths for the same mutation.

3. **Online/offline is implicit from the socket; manual status is explicit.**
   The team DO knows you're online because your socket is open. The "locked in
   on demo" text status is a separate explicit field.

4. **One DO per team. The daemon opens one WS per team it belongs to.** Routed
   by the Worker via `idFromName(teamId)`. Hackathon case is N=1.

5. **Context is an opaque, client-captured blob.** The relay never inspects or
   requires it. Privacy boundary from the PRD holds: explicit context packets,
   never full session transcripts. The CLI captures git context; the relay
   stores and forwards it.

## Identity & addressing

- **Auth:** GitHub OAuth **device flow** for MVP (canonical CLI auth — print a
  code, authorize in browser, no callback server). The relay exchanges the
  GitHub identity for an opaque **Ayo session token**, stored in
  `~/.ayo/session.json`. The token abstraction is provider-agnostic so
  magic-link can slot in later. A session token identifies one user across all
  their teams.
- **Handles are per-team.** Default handle = GitHub login; aliasable
  (`ayo alias kenny ...`). `to` addresses are handles resolved to userIds
  *within the active team*. Numeric quick-pick / cycling is a CLI concern, not
  part of the wire.
- **Team membership** via short join code (`ayo team create` → code;
  `ayo invite` shares it; `ayo join <code>`). GitHub-org-gated join is a later
  option, not MVP.

## IDs & cursors

- ULID-based, type-prefixed: `user_<ulid>`, `team_<ulid>`, `ayo_<ulid>`.
- ULIDs are lexicographically sortable → a cursor is just the last `ayo_` id
  seen. `?since=<ayoId>` returns everything after it.

## Message object (the Ayo)

```json
{
  "id": "ayo_01J9Z3...",
  "teamId": "team_01J8...",
  "from": { "id": "user_01J7...", "handle": "wilson", "name": "Wilson" },
  "to": ["kenny"],
  "kind": "ping",
  "body": "demo is cooked, can you tap in?",
  "urgency": "normal",
  "context": {
    "repo": "ayo",
    "branch": "feat/auth",
    "cwd": "/Users/wilson/ayo",
    "commit": "a1b2c3d",
    "changedFiles": ["src/auth.ts"],
    "diffStat": "3 files changed, 120 insertions(+), 22 deletions(-)",
    "diff": null,
    "links": [],
    "note": "optional agent-generated handoff summary"
  },
  "replyTo": null,
  "expiresAt": null,
  "createdAt": "2026-06-28T20:00:00Z"
}
```

Field notes:
- `to`: array of handles. `["*"]` = team broadcast.
- `kind`: `ping` | `handoff`. Drives client rendering.
- `urgency`: `low` | `normal` | `urgent`. `urgent` can override do-not-disturb.
- `context`: entirely optional, opaque to the relay. `diff` is `null` unless the
  sender passed `--with-diff`; **capped at 64 KB** (CLI truncates with a
  `diffTruncated: true` marker — TBD field) so a relay payload stays small.
- `replyTo`: an `ayo_` id, for minimal threading. No nested threads in MVP.
- `expiresAt`: ISO timestamp; `null` = never. Used by hackathon message expiry.

### Per-recipient delivery state (server-side, NOT embedded)

Tracked separately so a broadcast can be read by some recipients and not others:

```json
{ "ayoId": "ayo_01J9Z3...", "userId": "user_01J7...", "state": "read", "at": "2026-06-28T20:01:11Z" }
```

**Sent ≠ delivered ≠ notified ≠ read.** In a daemon-first model these are
genuinely different facts, and conflating them lies to the sender. The state
machine is a monotonic chain — state only advances:

| `state` | Meaning | Set by |
|---|---|---|
| `sent` | Relay accepted it. Recipient's machine may be offline. | DO on `POST .../ayo` |
| `delivered` | Reached the recipient's **daemon** (live socket, or queued+replayed on reconnect). The machine has it. | daemon `ack {delivered}` over WS |
| `notified` | The daemon actually **fired an OS notification** (or terminal bell). The machine told the human — but the human may not have looked. | daemon `ack {notified}` over WS |
| `read` | A **human explicitly viewed it**: opened in `ayo inbox`, clicked the toast, or `ayo open <id>`. | `POST /v1/ayo/:id/read` |
| `resolved` | Loop closed. | `POST /v1/ayo/:id/resolve` |

Rules that keep `read` honest:
- **A toast firing is `notified`, never `read`.** Only an explicit human action
  advances to `read`.
- **Agent context-injection (Layer 1 hooks) does NOT mark `read`.** Silently
  surfacing unread state into the model doesn't mean the human registered it.
  At most it could set a separate `surfaced` flag later — out of scope now.
- The split is also a feature: the sender can see *"delivered to Kenny's machine,
  his Mac buzzed, but he hasn't opened it"* — which tells them whether to bump to
  `urgent`, exactly the signal you want mid-hackathon.

Who reports what: **the socket reports machine-level facts** (`delivered`,
`notified` via `ack` frames), **HTTP reports human intent** (`read`, `resolve`).

## HTTP API (`/v1`)

Auth: `Authorization: Bearer <session-token>` on everything except the device
flow. All bodies/responses JSON. `--json` CLI mode returns these verbatim.

| Method & path | Purpose |
|---|---|
| `POST /v1/auth/device` | Start GitHub device flow → `{ user_code, verification_uri, device_code, interval }` |
| `POST /v1/auth/device/poll` | `{ device_code }` → `{ session_token, user }` once authorized |
| `GET  /v1/me` | Current user + teams |
| `POST /v1/teams` | `{ name }` → team + join code |
| `POST /v1/teams/join` | `{ code }` → team |
| `GET  /v1/teams/:id/members` | Members + presence snapshot |
| `POST /v1/teams/:id/ayo` | **Send.** Body = Ayo (minus server fields) → `{ id, deliveredTo, queuedFor }` |
| `GET  /v1/teams/:id/inbox` | `?since=<ayoId>&unreadOnly=1` → `{ ayos, cursor }` |
| `POST /v1/ayo/:id/read` | Mark read for current user |
| `POST /v1/ayo/:id/resolve` | Resolve (closes the loop for the sender) |
| `PUT  /v1/teams/:id/status` | `{ status, statusText, ttl }` set manual status |
| `GET  /v1/teams/:id/stream` | **WebSocket upgrade** (see below) |

### Send flow
`POST /v1/teams/:id/ayo` → Worker authenticates → routes to team DO →
DO assigns `id`/`createdAt`, persists message + per-recipient `delivered`
rows → pushes `ayo` frame to each recipient's live sockets → returns
`{ id, deliveredTo: [...handles online], queuedFor: [...handles offline] }`.

## WebSocket protocol (daemon ↔ team DO)

- **Auth at upgrade:** token in `Authorization` header (or `?token=` fallback for
  clients that can't set WS headers). The Worker validates and passes a verified
  `userId` into the DO; the DO never trusts a client-supplied identity.
- **Heartbeat:** native WS ping/pong; DO uses **hibernation** so idle teams cost
  ~nothing while sockets stay alive.
- **Direction:** almost entirely server→client. Client→server is limited to
  **heartbeat + receipt acks** — the socket reports machine-level facts only.
  Semantic mutations (`read`, `resolve`, `status`) go over HTTP (decision #2).

### Client → server frames (the only ones)

```jsonc
// daemon confirms machine-level receipt — advances delivered → notified
{ "t": "ack", "ayoId": "ayo_01J...", "state": "delivered" }
{ "t": "ack", "ayoId": "ayo_01J...", "state": "notified" }
```

`read`/`resolve` are deliberately NOT here — they require explicit human action
and go over HTTP, so a machine receipt can never masquerade as a human read.

### Server → client frames

```jsonc
// sent once on (re)connect
{ "t": "ready", "cursor": "ayo_01J...", "unread": 3,
  "members": [ { "handle": "kenny", "online": true, "status": "active", "statusText": null } ] }

// a new Ayo addressed to (or broadcast including) this user
{ "t": "ayo", "ayo": { /* full Message object */ } }

// delivery-state change relevant to this user
// (e.g. sender learns their Ayo was read)
{ "t": "ayo:update", "ayoId": "ayo_01J...", "state": "read", "by": "kenny", "at": "..." }

// presence / status change of a teammate
{ "t": "presence", "handle": "kenny", "online": true, "status": "heads-down", "statusText": "locked in on demo" }

// membership change
{ "t": "team", "event": "member_joined", "handle": "maya" }
```

### Reconnect & delivery semantics
- On connect, daemon sends its last-known cursor via `?since=`; DO replays
  unread Ayos since then, then emits `ready`.
- **At-least-once delivery.** Clients dedupe by `ayo.id`. The DO is the source of
  truth (SQLite-in-DO storage); offline recipients have their unread set queued
  and replayed on next connect.
- Read receipts: `POST /v1/ayo/:id/read` → DO updates state → pushes
  `ayo:update` to the sender if online.

## Storage (in the team Durable Object, SQLite)

- `messages(id, from_user, to_json, kind, body, urgency, context_json, reply_to, expires_at, created_at)`
- `deliveries(ayo_id, user_id, state, updated_at)`  ← per-recipient state
- `members(user_id, handle, name, status, status_text, status_expires_at)`
- Expiry/resolve sweeps run via DO `alarm()`.

## Error model

JSON error envelope, conventional HTTP status:

```json
{ "error": { "code": "team_not_found", "message": "No team with that id." } }
```

Codes: `unauthorized`, `invalid_token`, `team_not_found`, `not_a_member`,
`unknown_recipient`, `rate_limited`, `payload_too_large`.

## Versioning

- Path-versioned (`/v1`). WS frames carry a short `t` (type) tag; new frame
  types are additive and unknown types are ignored by clients.

## Explicitly out of scope for this contract

- Nested threads (only `replyTo` single-level).
- Cross-team routing / a user-level fanout router (one WS per team is enough).
- Push to mobile / web. Daemon + OS toast only.
- Server-side context inspection or search (the relay treats `context` as
  opaque). Searchable coordination logs are a later, separate concern.
