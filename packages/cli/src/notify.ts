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
import notifier from "node-notifier";
import type { Ayo } from "@ayo-dev/core";

export function notifyAyo(ayo: Ayo): void {
  const ctx = ayo.context;
  const where = ctx?.repo && ctx?.branch ? ` (${ctx.repo}@${ctx.branch})` : "";
  const urgent = ayo.urgency === "urgent";
  const title = `${urgent ? "🚨 " : ""}Ayo from ${ayo.from.handle}${where}`;

  if (process.platform === "darwin") {
    macNotify(title, ayo.body, urgent);
  } else {
    notifier.notify({ title, message: ayo.body, sound: urgent });
    // TODO: wire `terminal-notifier -execute "ayo open <id>"` for click-to-open.
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
  const script =
    `display notification "${osaEscape(message)}" with title "${osaEscape(title)}"` +
    (sound ? ` sound name "Ping"` : "");
  // execFile (no shell) + AppleScript-escaped args → a teammate's message text
  // can't break out of the string or inject commands. timeout so a hung
  // osascript can't freeze the daemon's event loop.
  execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
}
