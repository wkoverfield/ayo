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
import type { Ayo } from "@ayo-dev/core";
import { AYO_DIR } from "./config.js";

// The Ayo mark, shipped in the package (dist/notify.js -> ../assets/ayo.png).
// node-notifier passes it to notify-send (Linux) / SnoreToast (Windows). macOS
// uses osascript, which can't set a custom icon (see docs/FOLLOWUPS.md).
// Guard on existence: if the asset is ever missing, fall back to no icon so the
// toast still fires (a missing -p path silently suppresses SnoreToast toasts).
const iconPath = fileURLToPath(new URL("../assets/ayo.png", import.meta.url));
const ICON_PATH: string | undefined = existsSync(iconPath) ? iconPath : undefined;

export function notifyAyo(ayo: Ayo): void {
  const ctx = ayo.context;
  const where = ctx?.repo && ctx?.branch ? ` (${ctx.repo}@${ctx.branch})` : "";
  const urgent = ayo.urgency === "urgent";
  const title = `${urgent ? "🚨 " : ""}Ayo from ${ayo.from.handle}${where}`;

  if (process.platform === "darwin") {
    macNotify(title, ayo.body, urgent);
  } else {
    notifier.notify({ title, message: ayo.body, sound: urgent, ...(ICON_PATH ? { icon: ICON_PATH } : {}) });
  }
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

function macNotify(title: string, message: string, sound: boolean): void {
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
  execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
}
