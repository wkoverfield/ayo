# Spec: Custom sounds + actionable toasts

Status: **proposed** (2026-06-29). Two features targeted for the initial public
release, grounded in feasibility research across macOS/Windows/Linux + the relay.

Both build on the Phase 2a macOS notifier helper (`packages/cli/native/macos`)
and the daemon receive path (`ayod.ts` → `notify.ts` → inbox → agent hook).

---

## 1. Customizable notification sounds

**The idea — a "signature sound" (reverse ringtone):** each person picks the
sound that plays on *other people's* machines when they ping. You learn who's
pinging by ear. Presets **and** user-uploaded custom clips.

### 1.1 Playback — decoupled, cross-platform, WAV
The daemon plays the chosen sound itself on receipt, **separate** from the OS
notification's own sound (so any length/format works and it's uniform across
platforms). Standardize on **WAV (16-bit PCM, 44.1 kHz)** — it's the lowest common
denominator (Windows' built-in player is WAV-only).

| OS | Player (no bundled binary) |
| --- | --- |
| macOS | `afplay <file>` (always present) |
| Windows | `powershell -c "(New-Object Media.SoundPlayer '<file>').PlaySync()"` (WAV only) |
| Linux | first of `paplay` → `canberra-gtk-play -f` → `aplay` → `ffplay` (`command -v` probe) |

Spawn detached, don't await. **No runtime volume control** (no consistent
cross-platform knob; Windows has none) — loudness-normalize assets at import time
instead, or skip for v1 (the ~2s + WAV caps bound the blast radius).

### 1.2 Schema — `AyoSound`, stamped on send
Sound is a **profile setting** (set once), stamped onto each outgoing Ayo by the
relay exactly like `from`/`createdAt` — **snapshot semantics**, so changing your
sound doesn't rewrite old Ayos, and recipients get it **inline** (no lookup).

```ts
// packages/core/src/message.ts
export type AyoSound =
  | { kind: "preset"; id: string }                  // bundled client asset, e.g. "airhorn"
  | { kind: "custom"; url: string; hash: string };  // R2-backed; hash = cache-bust + integrity

export interface Ayo { /* … */ sound?: AyoSound | null }   // null/absent = recipient default
// packages/core/src/api.ts: PublicUser gains  sound?: AyoSound | null
```

`SendAyoRequest` does NOT carry it — the relay stamps from the sender's stored
profile (the Worker injects `x-ayo-sound`; the DO stamps it in `handleSend`).
Additive + optional → wire-compatible with existing clients (ADR 0002).

### 1.3 Relay — R2 for custom clips
The relay has KV + a DO but **no R2** — add a bucket (R2 free tier is effectively
unlimited here: 10 GB, egress free).

```jsonc
// wrangler.jsonc
"r2_buckets": [{ "binding": "AYO_SOUNDS", "bucket_name": "ayo-sounds" }]
```

- **`PUT /v1/me/sound`** (authed). For a preset: JSON `{kind:"preset",id}` validated
  against an allowlist. For custom: raw `audio/wav` body → validate (≤1 MB, RIFF/WAVE
  magic, ≤~2s sniffed from the WAV header) → SHA-256 → `AYO_SOUNDS.put("sound/<userId>.wav", …, {sha256})`
  → record `{kind:"custom", url:"/v1/sounds/<userId>?h=<hash>", hash}` on the user.
  One object per user (overwrite; no orphan growth); hash rides in the URL to
  cache-bust. `DELETE /v1/me/sound` reverts to default.
- **`GET /v1/sounds/:userId`** — Worker-proxied, `Cache-Control: immutable`
  (hash-addressed → CDN + client cache forever).

### 1.4 Recipient — fetch, cache, play, mute
On receipt: `null` → recipient default · `preset` → bundled `assets/sounds/<id>.wav`
(no fetch) · `custom` → `$AYO_DIR/sounds/<hash>.wav` (cache hit → play; miss →
authenticated GET, **verify SHA-256 == hash**, cache, play). **Recipient always
wins:** a local mute-all / per-sender mute / DND short-circuits before any
fetch/play. (`urgency:"urgent"` may still pierce DND per ADR 0002, but sound is
suppressible.)

### 1.5 CLI
`ayo sound list` · `set <preset>` · `upload <file.wav>` · `mute [handle|all]` · `status`.
Adds `sound` to the `Config` interface; presets ship as WAV in `assets/sounds/`.

### 1.6 Abuse — friends-tier, lean
Identity is GitHub-verified, teams are join-code-gated, recipients mute/block.
So **no moderation/transcoding/scanning** — just technical caps: ≤1 MB, ≤~2s, WAV
only, one object/user, SHA-256 both ends, recipient mute. (Per Wilson, 2026-06-29.)

---

## 2. Actionable (clickable) toasts

**The idea:** the toast is a high-intent moment — capture the instinct to click.
A click (or action button) can **copy the work-context**, **open the branch/PR/
file**, **reply**, **resolve**, or — the differentiator — **pipe the Ayo's context
straight into your coding agent**.

### 2.1 Why this matters — closing the daemon↔agent gap
Today there are two surfaces: the **daemon** notifies in real time (push), but the
**agent** only sees an Ayo at the *next* `SessionStart`/`UserPromptSubmit` (pull,
via the hook reading the inbox). A clicked toast is the bridge: it writes the
context to `~/.ayo/action-queue.json`, which the existing `agent.ts:surfaceUnread`
hook **already drains into Codex/Claude** — so clicking pulls the work-context into
your agent *now* instead of next turn. No new hook plumbing.

### 2.2 macOS architecture — post-and-block-until-handled (the key decision)
Research verdict: **feasible**, proven by `alerter` and `NotifiCLI`. The robust
pattern is **not** today's fire-and-exit (relaunch-on-click is documented but
brittle: a delegate-before-launch race + Launch Services relaunch can fail), and
**not** an always-on daemon. It's a **per-notification process that stays alive
only while its toast is on screen**:

1. On launch: set `UNUserNotificationCenter.delegate` **first**, then
   `setNotificationCategories([...])`, then post with `content.categoryIdentifier`
   + full context in `content.userInfo` (`ayoId`, `action targets`, repo/branch/PR).
2. Run an `NSApplication` loop (needs a real app bundle + run loop; `LSUIElement`
   so no Dock icon) and **block until** the user clicks/replies/dismisses or a
   timeout fires.
3. In `userNotificationCenter(_:didReceive:)`: branch on `actionIdentifier`
   (incl. `UNNotificationDefaultActionIdentifier` for body-click), read `userInfo`,
   perform the action (write `action-queue.json` / `NSPasteboard` copy /
   `open` the URL / exec `ayo resolve`), call the completion handler, exit.

This is a **moderate evolution** of `main.swift` (add `NSApplication` + delegate +
categories), not a new service. Signing/notarization unchanged. `notify.ts` keeps
launching it (fire-and-forget for the daemon); the helper self-terminates on
action or timeout. Treat documented relaunch-on-click as a *fallback* for clicks
on stale Notification-Center entries (recover context from `userInfo`).

Constraints: **banner shows 2 buttons** (extras collapse to a menu) → budget 2
primary (**Copy context**, **Open**) + **Reply** (`UNTextInputNotificationAction`)
+ **Resolve** in overflow. Categories must be registered before posting.

### 2.3 The actions
| Action | Does |
| --- | --- |
| **Copy context** | body + repo@branch + diff → clipboard |
| **Open** | the branch/PR/file (deep link via `open`) |
| **→ Pipe to agent** | write context to `action-queue.json` → hook surfaces it in Codex/Claude next keystroke |
| **Reply** | inline text → sends an Ayo back |
| **Resolve** | `api.resolve(ayoId)` |

### 2.4 Cross-platform parity (honest)
| OS | Click-actions |
| --- | --- |
| **macOS** | Full + reliable (buttons, reply, body-click) — first-class |
| **Windows** | Real action buttons via SnoreToast; click reported through node-notifier callback. **Gotcha: can't use a custom `appID` AND `actions` together** → choose the **logo** or **buttons** (lean: buttons, accept default app identity) |
| **Linux** | Best-effort: actions work on GNOME/KDE/dunst, silently drop elsewhere, and node-notifier won't surface them (must shell out to `notify-send --action` + parse stdout). Feature-detect; degrade to a plain toast |

**Sound (§1) is rock-solid on all three; click-actions are progressive
enhancement** — full macOS, good Windows, best-effort Linux.

---

## 3. Phased build plan

Scoped so each phase is independently shippable and reviewable.

- **A1 — Sound presets** (no R2): `AyoSound` schema, bundle a starter WAV set,
  daemon decoupled playback (afplay/PS/paplay), `ayo sound set/list/mute`,
  stamp-on-send from profile. Proves the "recognize people by ear" loop.
- **A2 — Custom upload**: R2 bucket, `PUT/DELETE /v1/me/sound` + `GET /v1/sounds/:id`,
  WAV validation, recipient fetch/cache/verify, `ayo sound upload`.
- **B1 — macOS clickable**: evolve the helper to block-until-handled; ship
  **Copy context** + **Open** + the **Pipe-to-agent** action (`action-queue.json`
  drained by `surfaceUnread`). The headline interaction.
- **B2 — Reply + Resolve + Windows buttons**: `UNTextInputNotificationAction`
  reply, Resolve, SnoreToast action buttons on Windows (logo-vs-buttons call),
  Linux feature-detected best-effort.

## 4. Open decisions for Wilson
1. **macOS helper → post-and-block-until-handled** (recommended) — confirm we're
   OK evolving the helper this way (vs. keeping fire-and-exit and losing clicks).
2. **Windows: logo vs. action buttons** (can't have both via node-notifier) —
   lean toward buttons.
3. **Build order** — A1 → A2 → B1 → B2, or front-load the clickable headline (B1)
   before custom-upload (A2)?
4. **Sound: bundle the preset set** — who picks/sources the ~6–8 starter WAVs.

## 5. Change inventory
**Real:** `wrangler.jsonc`+`env.ts` (R2); new `sounds.ts` (upload/serve);
`team-do.ts handleSend` (stamp `sound`) + Worker `x-ayo-sound` inject;
`main.swift`+`Info.plist`+`build-notifier.sh` (NSApplication/delegate/categories,
bundle preset WAVs, URL scheme); `notify.ts` (sound arg + category/userInfo);
`agent.ts` (drain `action-queue.json`); `ayo.ts` (`sound` group).
**Trivial/additive:** `message.ts` (`AyoSound`), `api.ts` (`PublicUser.sound`),
`config.ts` (`sound`, `sounds/` dir), `inbox-store.ts` (action-queue helpers).
