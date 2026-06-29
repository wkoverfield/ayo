/**
 * Hackathon mode — a shared deadline with ⏰ milestone nudges (the relay fires
 * them via a Durable Object alarm) and a markdown timeline export of the event.
 */

import pc from "picocolors";
import type { Ayo, HackathonState } from "@ayo-dev/core";
import { loadConfig, requireSession } from "./config.js";
import { api, RelayError } from "./client.js";

function oops(err: unknown): void {
  if (err instanceof RelayError) console.error(pc.red(`✗ ${err.message}`));
  else console.error(pc.red(`✗ ${(err as Error).message}`));
  process.exitCode = 1;
}

/** Parse a duration like `18h`, `90m`, `1h30m` into milliseconds (null if bad). */
export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i);
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}

/** "4h 12m left", "12m left", or "time's up". Shared with the board header. */
export function fmtCountdown(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "time's up";
  const total = Math.floor(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

export async function hackathonStart(name: string, ends: string): Promise<void> {
  try {
    const s = requireSession();
    const cfg = loadConfig();
    if (!cfg.activeTeamId) return void console.log("No active team. `ayo team create` or `ayo join` first.");
    const ms = parseDuration(ends);
    if (ms == null) return void console.log("Invalid --ends. Use e.g. 18h, 90m, 1h30m.");
    const endsAt = new Date(Date.now() + ms).toISOString();
    const { hackathon } = await api.startHackathon(s, cfg.activeTeamId, { name, endsAt });
    console.log(pc.green(`✓ ${pc.bold(name)} started`) + pc.dim(` — ${fmtCountdown(hackathon!.endsAt)}`));
    console.log(pc.dim("  the team gets ⏰ nudges at T-minus 1h / 30m / 10m / 0. `ayo board` to watch."));
  } catch (err) {
    oops(err);
  }
}

export async function hackathonStatus(): Promise<void> {
  try {
    const s = requireSession();
    const cfg = loadConfig();
    if (!cfg.activeTeamId) return void console.log("No active team.");
    const { hackathon } = await api.getHackathon(s, cfg.activeTeamId);
    if (!hackathon) return void console.log(pc.dim("No hackathon running. `ayo hackathon start <name> --ends 18h`"));
    console.log(`${pc.bold(pc.yellow(`⚡ ${hackathon.name}`))}  ${pc.dim(fmtCountdown(hackathon.endsAt))}`);
  } catch (err) {
    oops(err);
  }
}

export async function hackathonEnd(): Promise<void> {
  try {
    const s = requireSession();
    const cfg = loadConfig();
    if (!cfg.activeTeamId) return void console.log("No active team.");
    await api.endHackathon(s, cfg.activeTeamId);
    console.log(pc.green("✓ hackathon ended"));
  } catch (err) {
    oops(err);
  }
}

/** Print the event as markdown to stdout (so `ayo hackathon export > story.md` works). */
export async function hackathonExport(): Promise<void> {
  try {
    const s = requireSession();
    const cfg = loadConfig();
    if (!cfg.activeTeamId) return void console.log("No active team.");
    const { hackathon, events } = await api.timeline(s, cfg.activeTeamId);
    process.stdout.write(renderTimeline(hackathon, events));
  } catch (err) {
    oops(err);
  }
}

function clock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderTimeline(h: HackathonState | null, events: Ayo[]): string {
  const lines: string[] = [];
  lines.push(`# ${h?.name ?? "Team"} — timeline`);
  if (h) lines.push("", `_${clock(h.startedAt)} → ${clock(h.endsAt)}_`);
  lines.push("");
  if (events.length === 0) {
    lines.push("_(no team activity recorded yet)_");
  }
  for (const e of events) {
    const icon = e.kind === "handoff" ? "🤝" : e.from.handle === "ayo" ? "⏰" : e.urgency === "urgent" ? "🚨" : "📣";
    const to = e.kind === "handoff" ? ` → ${e.to.includes("*") ? "team" : e.to.join(", ")}` : "";
    const where = e.context?.branch ? ` _(${e.context.repo}@${e.context.branch})_` : "";
    lines.push(`- **${clock(e.createdAt)}** ${icon} **${e.from.handle}**${to}: ${e.body}${where}`);
  }
  lines.push("");
  return lines.join("\n");
}
