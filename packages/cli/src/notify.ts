/**
 * Native OS notification. The daemon owns notification (ADR 0001) — this is how
 * an arriving Ayo reaches the human in real time, independent of any agent.
 *
 * macOS: node-notifier's bundled terminal-notifier is unsigned and silently
 * dropped by recent macOS, so we shell out to `osascript` (which actually shows
 * and lands in Notification Center). Linux/Windows: node-notifier.
 *
 * Note: "notified" means the machine *attempted* the toast (osascript exited 0);
 * the OS may still suppress it (Focus/DND). That matches ADR 0002's intent —
 * notified is not a guarantee the human saw it.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import { newAyoId } from "@ayo-dev/core";
import type { Ayo, AyoSound } from "@ayo-dev/core";
import { AYO_DIR, loadConfig } from "./config.js";
import { cachedCustomPath, ensureCustomSound, playSound, presetPath } from "./sound.js";

// The Ayo mark, shipped in the package (dist/notify.js -> ../assets/ayo.png).
// node-notifier passes it to notify-send (Linux) / SnoreToast (Windows). macOS
// uses osascript, which can't set a custom icon (see docs/FOLLOWUPS.md).
// Guard on existence: if the asset is ever missing, fall back to no icon so the
// toast still fires (a missing -p path silently suppresses SnoreToast toasts).
const iconPath = fileURLToPath(new URL("../assets/ayo.png", import.meta.url));
const ICON_PATH: string | undefined = existsSync(iconPath) ? iconPath : undefined;

export function notifyAyo(ayo: Ayo, opts: { actionable?: boolean } = {}): void {
  const ctx = ayo.context;
  const where = ctx?.repo && ctx?.branch ? ` (${ctx.repo}@${ctx.branch})` : "";
  const urgent = ayo.urgency === "urgent";
  const title = `${urgent ? "🚨 " : ""}Ayo from ${ayo.from.handle}${where}`;

  // Signature sound: play the sender's chosen sound (unless the recipient muted
  // it). When one is being handled, keep the toast itself silent so they don't
  // double up.
  const willSound = playSignatureSound(ayo);
  const toastSound = urgent && !willSound;

  if (process.platform === "darwin") {
    // A non-actionable toast (e.g. `ayo doctor`'s test) gets no ctx, so it has no
    // Reply/Resolve/→agent buttons — clicking it can't fire relay calls or route
    // phantom work against the user's real team.
    const ctxJSON = opts.actionable === false ? undefined : buildCtx(ayo);
    macNotify(title, ayo.body, toastSound, ctxJSON);
  } else {
    notifier.notify({ title, message: ayo.body, sound: toastSound, ...(ICON_PATH ? { icon: ICON_PATH } : {}) });
  }
}

/**
 * Fire a test toast through the exact path a real Ayo takes (notifyAyo → the OS
 * toast + signature sound), so `ayo doctor` / `ayo init` can prove the
 * notification pipeline works on THIS machine — the link that fails silently
 * under denied permission, Focus, or DND. Non-actionable (no clickable buttons)
 * so it can never act on the user's real team. Pass the sound the user just
 * picked (init) to also hear what teammates will hear; omit it (doctor) for a
 * plain visual check.
 */
export function fireTestToast(handle: string, sound?: AyoSound | null): void {
  notifyAyo(
    {
      id: newAyoId(),
      teamId: "team_self",
      from: { id: "user_self", handle, name: handle },
      to: [handle],
      kind: "ping",
      body: "Test Ayo — if you can see this, notifications are working. 🎉",
      urgency: "normal",
      sound: sound ?? null,
      createdAt: new Date().toISOString(),
    },
    { actionable: false },
  );
}

/** The actionable-toast payload: what a click can copy / pipe to the agent /
 *  reply to / resolve. relayUrl + teamId are non-secret; the helper reads the
 *  token from ~/.ayo/session.json itself (so it never rides in argv). */
function buildCtx(ayo: Ayo): string {
  const cfg = loadConfig();
  return JSON.stringify({
    ayoId: ayo.id,
    from: ayo.from.handle,
    context: formatContext(ayo),
    repo: ayo.context?.repo, // for route-by-repo to the right agent session
    relayUrl: cfg.relayUrl,
    teamId: cfg.activeTeamId,
  });
}

/** A readable work-context blob for Copy / pipe-to-agent. */
function formatContext(ayo: Ayo): string {
  const c = ayo.context;
  const lines = [`Ayo from ${ayo.from.handle}: ${ayo.body}`];
  if (c?.repo && c?.branch) lines.push(`${c.repo}@${c.branch}`);
  else if (c?.repo) lines.push(c.repo);
  if (c?.note) lines.push(`note: ${c.note}`);
  if (c?.changedFiles?.length) lines.push(`changed: ${c.changedFiles.slice(0, 12).join(", ")}`);
  if (c?.diffStat) lines.push(c.diffStat);
  if (c?.links?.length) lines.push(...c.links.slice(0, 10));
  return lines.join("\n");
}

/**
 * Play the sender's signature sound, honoring the recipient's local mute prefs.
 * Returns true if a sound is being handled (so the toast stays silent). A custom
 * clip plays from cache, or is fetched+verified on first receipt then played.
 */
function playSignatureSound(ayo: Ayo): boolean {
  const cfg = loadConfig();
  if (cfg.muteSounds || cfg.mutedSenders?.includes(ayo.from.handle)) return false;
  const sound = ayo.sound;
  if (!sound) return false;
  if (sound.kind === "preset") {
    const p = presetPath(sound.id);
    if (p) playSound(p);
    return p !== null;
  }
  // custom: play from cache, or fetch+verify on first receipt then play.
  const cached = cachedCustomPath(sound.hash);
  if (cached) {
    playSound(cached);
    return true;
  }
  // Not cached yet: fetch it for next time. We'd normally return true (silence the
  // toast's own sound) and accept one silent ping — fine for a normal ping, but an
  // URGENT one must never be silent. So for urgent, return false so the toast keeps
  // its own sound this once, and DON'T also play the late-arriving custom clip
  // (that would double-buzz the same urgent toast) — it still caches for next time.
  const isUrgent = ayo.urgency === "urgent";
  ensureCustomSound(sound).then((p) => {
    if (p && !isUrgent) playSound(p);
  });
  return !isUrgent;
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
function osaEscape(s: string): string {
  return (s ?? "") // body/handle come over the wire; tolerate a null
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // Strip CR and LF — a bare \r could otherwise close the AppleScript string
    // literal and inject a statement.
    .replace(/[\r\n]/g, " ");
}

function macNotify(title: string, message: string, sound: boolean, ctxJSON?: string): void {
  // Prefer the signed Ayo.app helper: its AppIcon IS the Ayo mark, so the toast
  // is branded. `open -g` launches it via Launch Services (which
  // UNUserNotificationCenter requires to recognize the bundle) in the background
  // so it doesn't steal focus. Args go through argv (no shell), so a teammate's
  // text can't inject.
  // NOTE: `open` returns once Launch Services accepts the launch, BEFORE the toast
  // is delivered, so this is fire-and-forget. The catch only covers a failed
  // launch (helper missing/corrupt) -> fall back to osascript; it can't observe a
  // failed post (the helper's exit code isn't visible through `open`).
  const app = join(AYO_DIR, "Ayo.app");
  if (existsSync(app)) {
    try {
      const args = ["-g", app, "--args", title, message];
      if (sound) args.push("--sound");
      if (ctxJSON) args.push("--ctx", ctxJSON, "--ayo-dir", AYO_DIR);
      execFileSync("open", args, { stdio: "ignore", timeout: 5000 });
      return;
    } catch {
      /* fall through to osascript */
    }
  }
  // osascript shows (with the Script Editor icon) but lands in Notification
  // Center; AppleScript-escaped args + no shell. timeout so a hung osascript
  // can't freeze the daemon's event loop.
  const script =
    `display notification "${osaEscape(message)}" with title "${osaEscape(title)}"` +
    (sound ? ` sound name "Ping"` : "");
  try {
    execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
  } catch {
    /* best-effort: osascript can fail (locked screen / Focus / permissions) —
       don't throw out of notifyAyo, which would skip the daemon's notified ack. */
  }
}
