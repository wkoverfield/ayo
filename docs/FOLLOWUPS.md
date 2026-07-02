# Follow-ups

Known limitations and deferred items, with their source. Things here were
consciously deferred (not bugs blocking the current milestone) during the
independent code review of the scaffold + Layer 1.

## macOS notification icon

The Ayo mark ships at `packages/cli/assets/ayo.png` and brands the Windows/Linux
path (`notify.ts` → node-notifier `icon`).

**Phase 2a — DONE (the icon shows on a machine with the helper installed).** osascript
can't set a notification icon (it renders the posting app's icon — Script Editor),
so we ship a tiny signed `Ayo.app` helper whose AppIcon *is* the Ayo mark and post
through it. Source: `packages/cli/native/macos/AyoNotifier/` (Swift +
`UNUserNotificationCenter`); built/signed via `build-notifier.sh`. `notify.ts`
launches it with `open -g <Ayo.app> --args <title> <body>` (Launch Services launch
is required — `UNUserNotificationCenter` rejects a bare-exec'd binary) and falls
back to osascript if it isn't installed. First run prompts for notification
permission; the first toast right after granting can drop (system settling) — fine
for the daemon, which is long-authorized by the time it notifies.

**Phase 2b — TODO (distribute to everyone).** 2a signs with an *Apple Development*
cert (local machines only). To ship the helper on npm it must be signed with a
**Developer ID Application** cert and **notarized** (`build-notifier.sh NOTARIZE=1`
already does this given the cert + a stored `ayo-notary` keychain profile). Then a
darwin-only postinstall (or an `ayo notifier install` command) downloads the
notarized `Ayo.app` from a GitHub release into `$AYO_DIR`. Needs: Wilson to create
the Developer ID cert + `notarytool store-credentials`.

Also unverified: the Windows toast path has never run on a real box, and app
identity there ideally wants a registered AppUserModelID (node-notifier `appID` +
a Start Menu shortcut), not just `icon`.

## Custom sound cache growth

The daemon caches custom signature clips at `$AYO_DIR/sounds/<hash>.wav`, keyed by
content hash — so a sender changing their clip leaves the old file behind. Bounded
in practice (one ~1 MB clip per sender, rarely changed), but add LRU/size-cap
pruning if it ever matters.

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

## Invite loop / teams (from the C1 invite-loop review)

- **Surface the inviter to the joiner** — highest conversion ROI. Today a joiner
  runs `ayo join <code>` and lands on a roster of dots with no anchor to the
  human who recruited them (the shared code is team-level, not per-invite). The
  clean fix is per-invite tokens that encode inviter + team, so join can greet
  "joined — say hi to <inviter>" and pre-target the first-ping at them.
- **Join-code rotation + expiry** — the code is permanent, member-readable, and
  non-rotating. A departed teammate (or a code pasted into a public channel)
  keeps a working invite forever, with no revocation path. Add creator-only
  rotate/regenerate + optional expiry before public volume.
- **Team-size cap** — `addMember` is unbounded. A leaked permanent code + no cap
  = a team can be flooded. Cheapest of these three; arguably the most urgent
  given the relay already has abuse caps elsewhere.

## Handoff share links — reply-without-install (S1b)

**Shipped (S1):** `ayo handoff` / `create_handoff` mint a public, expiring URL
(`/h/<token>`) that renders the handoff's context to a non-user, with an
install→join CTA (embeds the team join code by default; opt out with
`--no-link` is for the whole link, `includeJoinCode:false` for the code). The
snapshot is self-contained in KV (`share:<token>`), so the render path never
touches the team DO. Strict CSP + full HTML escaping on the public page.

**Shipped (S1b, PR #44) — anonymous reply-back.** A non-user replies right
from the page (no-JS form POST to `/h/<token>/reply`); it lands in the sender's
inbox threaded to the handoff, from a guest identity that never touches the
roster (blank `x-ayo` identity → `rememberMember` no-ops). Reply-first,
install-second; branded error pages on every human-reachable failure; honest
410 when the sender is no longer reachable. Per-link join codes carry the
inviter (`JoinTeamResponse.invitedBy`).

Remaining edges (deliberate, low-severity): the per-IP reply cap still returns
JSON (fires pre-KV, mirrors the other public routes; a shared-NAT human could
see it); a malformed DO response would render the 410 page rather than the 502
(unreachable today — the DO only emits a fixed shape).

## Inbound webhooks (S3) — deferred hardening

**Shipped (S3):** `ayo hook create|list|revoke` mint a revocable, unguessable
`POST /v1/hooks/<token>` URL. One curl (`{"text":"..."}`) fires an Ayo into the
team, attributed to the creating member with the hook's `[label]` prefixed.
Suppression is first-class: it routes through the normal DO send, so
heads-down/dnd recipients get `held`, and `urgency` is capped at `normal`
(inbound automation never breaks focus). Rate-limited per-token (30/min, 6/min
for broadcasts) + per-IP; scope-locked (a pinned hook can't be widened to `*`);
tokens are creator-only in `list`; fires only while the creator is still a member.

Deferred:
- **Synthetic bot identity.** Inbound pings show as *from the creator*, not a
  distinct "github"/"ci" bot member. A real bot identity (own roster entry,
  presence-exempt) is cleaner but needs a bot-user model — left out of v1.
- **Urgent opt-in.** Urgent is coerced to normal. A hook created with an
  explicit `--allow-urgent` capability could break through for true alerts
  (prod down). Needs a per-hook capability flag + UI.
- **Revoke on leave / team delete (KV cleanup).** Firing a hook now checks the
  creator is still a member and 404s otherwise (no re-roster, no ping), so an
  ex-member's hook is inert — but the KV rows linger and still show in `list`.
  Proactively delete a member's hooks when they leave, and a team's on delete.
- **Signed payloads.** For S4 (GitHub), verify the `X-Hub-Signature-256` HMAC
  rather than relying only on the secret token in the URL.

## GitHub → Ayo (S4)

**Shipped (S4):** `ayo hook create --github` mints an HMAC-verified webhook
(`POST /v1/gh/<token>`, secret shown once). It routes three high-signal events
to the matching Ayo handle (= GitHub login): **review_requested** → reviewer,
**@mentions** in issue / PR-review comments → the mentioned people,
**pull_request_review submitted** → the PR author. Bots + self-directed events
dropped; `ping` ACKed; unhandled events 200-no-op (no GitHub retries). Signature
verified over the raw body with a constant-time compare.

Deferred:
- **Handle ≠ login.** Routing assumes the Ayo handle equals the GitHub login
  (the default). Once handles are aliasable, map GitHub login → handle via the
  team roster instead of passing the login straight through.
- **Team review requests.** `requested_team` (vs `requested_reviewer`) isn't
  expanded to members yet — only individual review requests route.
- **More events.** assigned, PR closed/merged (notify author), check_run failures.
- **Delivery report.** The gh route returns the DO send result but nothing
  surfaces unknownRecipients back to the repo admin (a mention of someone not on
  the team is a silent no-op — arguably fine, but worth a debug surface).

## Toast-click → open the handoff page (Apple-gated)

Clicking an Ayo notification could open its handoff share page in the browser.
Not wired, and blocked on two things:
1. The share URL isn't in the delivered Ayo — `ayo handoff` mints the link for
   the SENDER only; the recipient's payload has no URL. Attach the link to the
   handoff Ayo first.
2. Open-on-click is helper-gated on macOS: the plain `osascript` toast has no
   click action, so only the signed `Ayo.app` helper can do it (add an "Open"
   action alongside → My agent / Reply / Copy / Resolve). Lights up only where
   the notarized helper is installed — same Apple Developer gate as the
   clickable-toast work. (Linux/Windows node-notifier can open a URL on click
   without a signed helper.)

Lower priority: a team member already gets full context in their inbox/agent —
the page is the non-user conversion surface, so toast→page is mostly redundant
for members. Revisit once the Apple Developer ID / notarization is sorted.

## Guest-reply threading in the CLI (copy-vs-capability)

Guest replies from a handoff page carry `replyTo` (the handoff's ayoId) and
agents see it via `read_inbox` (raw JSON), but the CLI inbox renders replies as
flat pings — no visual tie back to the handoff. Surface the thread in `ayo
inbox` (e.g. "↳ re: your handoff 'oauth is cooked…'") so the confirmation
page's "threaded" claim is visible to humans, not just agents.
