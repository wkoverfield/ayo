# Follow-ups

Known limitations and deferred items, with their source. Things here were
consciously deferred (not bugs blocking the current milestone) during the
independent code review of the scaffold + Layer 1.

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

- **Feed does a full message scan** — `handleFeed` lists ALL `msg:` keys then
  sorts/slices to the latest N, and does one `delivery:` list per returned item.
  Fine at hackathon volume; for a long-lived team this is unbounded memory +
  latency. Bound it (store a recent-id index, or page the scan) before scale.
- **Board polling, not realtime** — `ayo board` polls every 3s. Could subscribe
  to the daemon's WebSocket stream for instant updates instead.
- **Board backoff** — on repeated relay errors the board retries on the fixed 3s
  tick (no exponential backoff). Acceptable; revisit if it gets chatty.

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
