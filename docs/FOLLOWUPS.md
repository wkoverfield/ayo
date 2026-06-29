# Follow-ups

Known limitations and deferred items, with their source. Things here were
consciously deferred (not bugs blocking the current milestone) during the
independent code review of the scaffold + Layer 1.

## macOS notification icon

The Ayo mark now ships at `packages/cli/assets/ayo.png` and is wired into the
Windows/Linux notification path (`notify.ts` → node-notifier `icon`). **macOS does
not show it:** the mac path uses `osascript … display notification`, which always
renders the icon of the posting app (Script Editor) and has no parameter for a
custom image. To brand the macOS toast, either (a) ship a code-signed + notarized
`Ayo.app` helper that posts via `UNUserNotificationCenter` (macOS shows that
bundle's AppIcon), or (b) shell out to a user-installed, signed `terminal-notifier`
with `-appIcon`/`-contentImage` (adds an install dependency + reliability risk —
the reason we left it). Also unverified: the Windows toast path has never run on a
real Windows box, and app identity there ideally wants a registered AppUserModelID
(node-notifier `appID` + a Start Menu shortcut), not just the `icon`.

## Relay hardening (deferred from pre-public security review, 2026-06-29)

The cheap items from that review are DONE on the relay (INTERNAL_SECRET now fails
closed; send body capped at 4 KB + context at 64 KB; team/hackathon name + status
validated; generic error messages). Still deferred:

- **Rate limiting** — no limits on `POST /v1/auth/device(/poll)` (unauth, also
  proxies to GitHub), `POST /v1/teams/join` (join-code brute force — 31^6 space,
  but unthrottled), or `POST /v1/teams/:id/ayo` (send flood → DO writes + fanout).
  Add a KV-counter or Cloudflare Rate Limiting binding, prioritizing the unauth
  device endpoints and per-token send caps.
- **Session token expiry** — `session:<token>` is written with no `expirationTtl`
  and there's no logout. Add a rolling TTL (e.g. 90d) + `POST /v1/auth/logout`.
- **`handleInbox` full scan** — lists all `msg:` with no limit/cursor (unlike the
  feed/timeline which are bounded). Use the existing `?since=` cursor as a storage
  `start` key + a limit.
- **`ulid()` uses `Math.random()`** for the random component (core/src/ids.ts) —
  fine for message ids, but switch to `crypto.getRandomValues()` so `team_`/`user_`
  ids aren't predictable.
- **`DEFAULT_RELAY_URL` is a personal subdomain** (`ayo-relay.wkoverfield.workers.dev`)
  baked into the published `@ayo-dev/core`. Move to a stable product domain before
  wider adoption so the relay can move without breaking installed CLIs.

## Deferred from review (2026-06-28)

- **Addressing by handle, not userId** — `Ayo.to` stores handles (per ADR 0002).
  If a member re-aliases their handle, older messages addressed to the old
  handle stop matching them in inbox/unread filtering. Revisit when aliasing
  ships; likely store recipients as `userId[]` and render handles at read time.
- **KV `list` 1000-key pagination** — `teamsForUser` and the DO's `storage.list`
  calls don't paginate. Fine at MVP volume; add cursor pagination before a
  team/user can exceed 1000 of anything.
- **`unread` count vs cursor semantics** — the `ready` frame's `unread` is the
  global unread count, not "unread since your cursor." Acceptable per ADR, but
  clarify if the daemon ever surfaces the number to the user.
- **ULID uses `Math.random()`** — documented in `core/src/ids.ts`. IDs double as
  sortable cursors and don't need to be unguessable, but a production relay
  should use a monotonic, CSPRNG-backed factory before launch.
- **DO storage is KV-style, not SQLite** — ADR 0002 targets SQLite-in-DO
  (messages/deliveries/members tables) for production; the scaffold uses the DO
  key-value store.

## MCP tools (deferred from review)

- **Agent broadcast rate-limiting** — an agent could loop `send_ayo`/`create_handoff`
  with `["*"]` + `urgent`. The relay has a `rate_limited` code, but there's no
  client-side cooldown. Add a per-tool throttle (e.g. one urgent broadcast / N min).
- **Context repo = MCP server's cwd** — `captureContext()` reads `process.cwd()`,
  which is the dir the agent started the server in. The tool response now echoes
  the captured `repo@branch` so a mismatch is visible; a future `repoPath` arg
  could let the agent target a specific repo explicitly.
- **Staged + unstaged** — `git diff HEAD` covers both (working tree vs HEAD), which
  is intended; documented in the share_context/create_handoff tool descriptions.

## Board / feed (deferred from review)

- **DO roster is lazily populated** — a member only enters the team DO's roster
  when they first hit a DO endpoint (daemon connect, send, status, board). So a
  broadcast (`ayo team "…"`) to a teammate who joined but has never connected and
  is offline creates no delivery row for them — they still SEE it in their inbox
  (the `to:["*"]` filter), but the send reports them as neither live nor queued,
  and they get no live push. Fix: register members into the DO roster on join
  (Worker → DO) so broadcasts and the board reflect all members immediately.

- **Feed message fetch is bounded** (`reverse:true, limit`), but it still does one
  `delivery:` list per returned item (N extra reads, N ≤ 100) to compute
  `resolved`. And the older inbox/unread/countUnread methods still do an unbounded
  `msg:` scan — fine at hackathon volume, but page/index them before scale.
- **Board polling, not realtime** — `ayo board` polls every 3s. Could subscribe
  to the daemon's WebSocket stream for instant updates instead.
- **Board backoff** — on repeated relay errors the board retries on the fixed 3s
  tick (no exponential backoff). Acceptable; revisit if it gets chatty.

## Hackathon mode (deferred from review)

- **One DO alarm, two would-be uses** — hackathon milestone nudges now use the
  team DO's single `alarm()`. ADR 0002 earmarked `alarm()` for expiry/resolve
  sweeps (not implemented). When expiry sweeps land, `alarm()` needs a dispatch
  table (which job is due) — otherwise whichever `setAlarm()` ran last wins and
  silently cancels the other.
- **Timeline bounded scan** — `handleTimeline` scans the newest 1000 messages
  (same bounded-window caveat as the feed); a very long, busy sprint could
  exceed it. Page it before that matters.

## Still open from the build plan

- **Real GitHub device flow** (#2) — ✅ implemented (`packages/relay/src/github.ts`
  + the device handlers in `index.ts`, real poll loop in `cli/src/ayo.ts`).
  Pending: register the OAuth App, set `GITHUB_CLIENT_ID`, and run one real
  browser-authorized login end to end (see `docs/auth-setup.md`). The dev stub
  (`AYO_DEV_AUTH=1`) remains for local testing.
- **Real daemon install** (#3) — ✅ `ayo daemon install` registers a launchd
  (macOS) / systemd --user (Linux) service; `start`/`stop`/`status` route through
  it when installed, else the pidfile fallback. launchd path verified end to end
  on macOS. **systemd path is implemented but NOT yet tested on a real Linux box**
  — verify install/enable/stop/uninstall there before relying on it.
- **Windows daemon** — `getService()` returns null on Windows, so install fails
  gracefully with a message and `ayo daemon start` (foreground) still works.
  A real Windows service (Startup task / nssm) is future work.
- **systemd lingering** — `WantedBy=default.target` starts ayod on user login.
  On headless Linux / servers without a login session, `loginctl enable-linger
  $USER` is needed for boot-time start; the installer could offer this.
- **Notification branding (macOS)** — macOS notifications go through `osascript`
  (node-notifier's bundled `terminal-notifier` is unsigned and silently dropped
  by modern macOS — verified on Darwin 25). They show under **"Script Editor"**,
  not "Ayo". For a branded toast (and click-to-open), ship a signed Ayo helper
  app or a notarized `terminal-notifier`. Linux/Windows still use node-notifier
  and are **untested** on those platforms.
- **Daemon log I/O** — `ayod` logs via synchronous `appendFileSync` per line.
  Fine at hackathon message rates; if a future high-frequency stream lands,
  switch to a buffered/async writer. (In-flight rotation at ~1MB is implemented.)
- **Windows atomic writes** — `writeInbox` uses temp-file + `renameSync`, which
  is atomic on POSIX but can fail with `EPERM`/`EEXIST` on Windows when the
  destination exists. Revisit (e.g. retry, or a write-lock) if Windows is
  promoted from "fail gracefully" to supported.
