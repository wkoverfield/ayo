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
- **Windows atomic writes** — `writeInbox` uses temp-file + `renameSync`, which
  is atomic on POSIX but can fail with `EPERM`/`EEXIST` on Windows when the
  destination exists. Revisit (e.g. retry, or a write-lock) if Windows is
  promoted from "fail gracefully" to supported.
