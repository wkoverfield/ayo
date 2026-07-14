# The Ayo protocol

The wire contract that the daemon, the relay, the CLI, and the MCP server all
code against. It is versioned at `/v1`.

## Transport split

**Send is stateless HTTP. Receive is the daemon's WebSocket.**

`ayo kenny "..."` is a short-lived CLI process. It does an authenticated `POST`
and exits, and it must not depend on the daemon's socket being up. The team
Durable Object persists the Ayo, fans it out over the live member sockets, and
queues it for offline members. The daemon's WebSocket is a near-pure
server-to-client push channel.

**HTTP is the command channel; the WebSocket is the event channel.** Every
mutation (send, read, resolve, set-status) has an HTTP endpoint, so any one-shot
process (CLI, MCP) can perform it. The socket carries only server-pushed events
plus connection-level heartbeat and machine-level receipt acks. There is exactly
one code path per mutation.

**Online/offline is implicit from the socket; manual status is explicit.** The
team DO knows a member is online because their socket is open. The free-text
status ("locked in on demo") is a separate explicit field.

**One Durable Object per team.** The daemon opens one WebSocket per team it
belongs to. The Worker routes by `idFromName(teamId)`.

**Context is an opaque, client-captured blob.** The relay never inspects it and
never requires it. The CLI captures git context; the relay stores and forwards
it. Context packets are explicit, never full session transcripts.

### Why the daemon owns the receive path

A property of the agent ecosystem, not a configuration choice: **you cannot
reliably push into a closed agent UI mid-work.** Neither Codex nor Claude Code
guarantees surfacing an unsolicited, server-initiated event in the middle of a
turn. MCP server push exists (Streamable HTTP + SSE), but client surfacing is
not guaranteed, so it cannot be the delivery backbone. Delivery therefore
terminates at the local daemon (OS notification + local inbox), and the agent
surfaces what already arrived at its own breakpoints (hooks, or an MCP/CLI
read).

## Identity and addressing

- **Auth:** GitHub device flow. The relay exchanges the GitHub identity for an
  opaque **Ayo session token**, stored in `~/.ayo/session.json`. One session
  token identifies one user across all their teams. The token abstraction is
  provider-agnostic.
- **Handles are per-team.** The default handle is the GitHub login. `to`
  addresses are handles, resolved to userIds *within the active team*. Numeric
  quick-pick and cycling are CLI concerns and are not part of the wire.
- **Team membership** is by short join code (`ayo team create` mints one,
  `ayo join <code>` uses it).

## IDs and cursors

IDs are ULID-based and type-prefixed: `user_<ulid>`, `team_<ulid>`, `ayo_<ulid>`.

ULIDs are lexicographically sortable, so a cursor is just the last `ayo_` id
seen. `?since=<ayoId>` returns everything after it.

## The message object (an Ayo)

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

Fields:

- `to`: array of handles. `["*"]` is a team broadcast.
- `kind`: `ping` | `handoff`. Drives client rendering.
- `urgency`: `low` | `normal` | `urgent`. `urgent` can override do-not-disturb.
- `context`: entirely optional and opaque to the relay. `diff` is `null` unless
  the sender passed `--with-diff`, and is **capped at 64 KB** (the CLI truncates)
  so a relay payload stays small.
- `replyTo`: an `ayo_` id. Single-level threading only; there are no nested
  threads.
- `expiresAt`: ISO timestamp, or `null` for never.

### Per-recipient delivery state

Delivery state is tracked server-side, per recipient, and is **not** embedded in
the message, so a broadcast can be read by some recipients and not others:

```json
{ "ayoId": "ayo_01J9Z3...", "userId": "user_01J7...", "state": "read", "at": "2026-06-28T20:01:11Z" }
```

`sent`, `delivered`, `notified`, and `read` are four different facts. The state
machine is a monotonic chain: state only advances.

| `state` | Meaning | Set by |
|---|---|---|
| `sent` | The relay accepted it. The recipient's machine may be offline. | DO on `POST .../ayo` |
| `delivered` | It reached the recipient's **daemon** (live socket, or queued and replayed on reconnect). The machine has it. | daemon `ack {delivered}` over WS |
| `notified` | The daemon **fired an OS notification** (or a terminal bell). The machine told the human, who may not have looked. | daemon `ack {notified}` over WS |
| `read` | A **human explicitly viewed it**: opened in `ayo inbox`, clicked the toast, or ran `ayo open <id>`. | `POST /v1/ayo/:id/read` |
| `resolved` | The loop is closed. | `POST /v1/ayo/:id/resolve` |

Two hard rules keep `read` honest:

- **A toast firing is `notified`, never `read`.** Only an explicit human action
  advances state to `read`.
- **Agent context-injection does not mark `read`.** Silently surfacing unread
  state into a model does not mean the human registered it.

Who reports what: **the socket reports machine-level facts** (`delivered`,
`notified`, via `ack` frames) and **HTTP reports human intent** (`read`,
`resolve`). A machine receipt can never masquerade as a human read.

## HTTP API (`/v1`)

Auth is `Authorization: Bearer <session-token>` on everything except the device
flow. All bodies and responses are JSON, and the CLI's `--json` mode returns them
verbatim.

| Method and path | Purpose |
|---|---|
| `POST /v1/auth/device` | Start the GitHub device flow. Returns `{ user_code, verification_uri, device_code, interval }` |
| `POST /v1/auth/device/poll` | `{ device_code }` returns `{ session_token, user }` once authorized |
| `GET  /v1/me` | Current user and teams |
| `POST /v1/teams` | `{ name }` returns team plus join code |
| `POST /v1/teams/join` | `{ code }` returns team |
| `GET  /v1/teams/:id/members` | Members plus a presence snapshot |
| `POST /v1/teams/:id/ayo` | **Send.** Body is an Ayo minus server-assigned fields. Returns `{ id, deliveredTo, queuedFor }` |
| `GET  /v1/teams/:id/inbox` | `?since=<ayoId>&unreadOnly=1` returns `{ ayos, cursor }` |
| `POST /v1/ayo/:id/read` | Mark read for the current user |
| `POST /v1/ayo/:id/resolve` | Resolve, which closes the loop for the sender |
| `PUT  /v1/teams/:id/status` | `{ status, statusText, ttl }`, sets manual status |
| `GET  /v1/teams/:id/stream` | WebSocket upgrade (below) |

### Send flow

`POST /v1/teams/:id/ayo` goes to the Worker, which authenticates and routes to
the team DO. The DO assigns `id` and `createdAt`, persists the message plus the
per-recipient `delivered` rows, pushes an `ayo` frame to each recipient's live
sockets, and returns
`{ id, deliveredTo: [...handles online], queuedFor: [...handles offline] }`.

## Signature sounds

A sound is a **profile setting**, not a per-message argument. `SendAyoRequest`
does not carry it: the Worker injects the sender's stored sound as `x-ayo-sound`
and the DO stamps it onto the outgoing Ayo, exactly like `from` and `createdAt`.
The semantics are therefore a snapshot: changing your sound does not rewrite
Ayos you already sent, and recipients get the sound inline with no extra lookup.

```ts
export type AyoSound =
  | { kind: "preset"; id: string }                  // bundled client asset
  | { kind: "custom"; url: string; hash: string };  // R2-backed; hash = cache-bust + integrity

interface Ayo { /* ... */ sound?: AyoSound | null }  // null or absent = recipient default
```

| Method and path | Purpose |
|---|---|
| `PUT /v1/me/sound` | JSON body sets a preset (validated against an allowlist) or `null` to clear. A raw `audio/wav` body uploads a custom clip. |
| `GET /v1/sounds/:userId` | Worker-proxied clip fetch. Hash-addressed, so responses are immutable and cacheable. |

Custom clips are capped at **1 MB** and **~2.5 seconds**, must be RIFF/WAVE, and
are content-hashed with SHA-256. The hash rides in the URL to cache-bust, and the
recipient verifies it before caching to `$AYO_DIR/sounds/<hash>.wav` and playing.
One object per user (uploads overwrite).

The recipient always wins: a local mute (all, per-sender, or do-not-disturb)
short-circuits before any fetch or playback. `urgency: "urgent"` may still pierce
do-not-disturb for the notification itself; the sound remains suppressible.

## WebSocket protocol (daemon to team DO)

- **Auth at upgrade:** the token goes in the `Authorization` header, with a
  `?token=` fallback for clients that cannot set WebSocket headers. The Worker
  validates it and passes a verified `userId` into the DO. **The DO never trusts
  a client-supplied identity.**
- **Heartbeat:** native WebSocket ping/pong. The DO uses hibernation, so idle
  teams cost close to nothing while sockets stay alive.
- **Direction:** almost entirely server to client. Client to server is limited to
  heartbeat and receipt acks.

### Client to server frames

These are the only ones.

```jsonc
// the daemon confirms machine-level receipt
{ "t": "ack", "ayoId": "ayo_01J...", "state": "delivered" }
{ "t": "ack", "ayoId": "ayo_01J...", "state": "notified" }
```

`read` and `resolve` are deliberately absent here. They require explicit human
action and go over HTTP.

### Server to client frames

```jsonc
// sent once on (re)connect
{ "t": "ready", "cursor": "ayo_01J...", "unread": 3,
  "members": [ { "handle": "kenny", "online": true, "status": "active", "statusText": null } ] }

// a new Ayo addressed to (or broadcast including) this user
{ "t": "ayo", "ayo": { /* full message object */ } }

// a delivery-state change relevant to this user
// (for example, the sender learns their Ayo was read)
{ "t": "ayo:update", "ayoId": "ayo_01J...", "state": "read", "by": "kenny", "at": "..." }

// presence or status change of a teammate
{ "t": "presence", "handle": "kenny", "online": true, "status": "heads-down", "statusText": "locked in on demo" }

// membership change
{ "t": "team", "event": "member_joined", "handle": "maya" }
```

### Reconnect and delivery semantics

- On connect the daemon sends its last-known cursor via `?since=`. The DO replays
  unread Ayos since then, then emits `ready`.
- Delivery is **at-least-once**. Clients dedupe by `ayo.id`. The DO is the source
  of truth; offline recipients have their unread set queued and replayed on their
  next connect.
- Read receipts: `POST /v1/ayo/:id/read` updates state in the DO, which pushes an
  `ayo:update` frame to the sender if they are online.

## Storage (team Durable Object)

- `messages(id, from_user, to_json, kind, body, urgency, context_json, reply_to, expires_at, created_at)`
- `deliveries(ayo_id, user_id, state, updated_at)`, the per-recipient state
- `members(user_id, handle, name, status, status_text, status_expires_at)`
- Expiry and resolve sweeps run from the DO's `alarm()`.

The target is SQLite-in-DO. The current implementation uses the DO key-value
store (see [FOLLOWUPS.md](FOLLOWUPS.md)).

## Error model

A JSON error envelope with a conventional HTTP status:

```json
{ "error": { "code": "team_not_found", "message": "No team with that id." } }
```

Codes: `unauthorized`, `invalid_token`, `team_not_found`, `not_a_member`,
`unknown_recipient`, `rate_limited`, `payload_too_large`.

## Versioning

The HTTP API is path-versioned (`/v1`). WebSocket frames carry a short `t` (type)
tag. New frame types are additive, and unknown types are ignored by clients. New
message fields are optional and additive, which keeps already-published clients
wire-compatible.

## Out of scope for this contract

- Nested threads. Only single-level `replyTo`.
- Cross-team routing, or a user-level fanout router. One WebSocket per team is
  enough.
- Push to mobile or web. The daemon plus an OS toast is the whole receive path.
- Server-side context inspection or search. The relay treats `context` as opaque.
