/**
 * `ayo board` — a live team dashboard. Polls the roster (presence/status) and
 * the team feed (recent Ayos + open handoffs) and redraws on an interval, in the
 * terminal's alternate screen buffer so your scrollback is left untouched.
 */

import pc from "picocolors";
import type { FeedItem, MemberPresence } from "@ayo-dev/core";
import { loadConfig, requireSession } from "./config.js";
import { api } from "./client.js";

const ENTER_ALT = "\x1b[?1049h\x1b[?25l"; // alternate screen + hide cursor
const EXIT_ALT = "\x1b[?25h\x1b[?1049l"; // show cursor + leave alternate screen
const CLEAR = "\x1b[H\x1b[2J"; // cursor home + clear
const REFRESH_MS = 3000;
const WIDTH = 66;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rel(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function render(team: string, members: MemberPresence[], items: FeedItem[]): string {
  const rule = `  ${pc.dim("─".repeat(WIDTH))}`;
  const online = members.filter((m) => m.online).length;
  const out: string[] = ["", `  ${pc.bold(pc.yellow(`⚡ ${team}`))}    ${pc.dim(`${online}/${members.length} online`)}    ${pc.dim("● live")}`, rule];

  // Each member's latest repo@branch + last-activity time, derived from the feed.
  const ctxByHandle = new Map<string, { repo?: string; branch?: string }>();
  const lastSeen = new Map<string, string>();
  for (const it of items) {
    const h = it.ayo.from.handle;
    if (!ctxByHandle.has(h) && it.ayo.context?.repo) ctxByHandle.set(h, it.ayo.context);
    if (!lastSeen.has(h)) lastSeen.set(h, it.ayo.createdAt);
  }

  if (members.length === 0) out.push(pc.dim("  (no teammates yet — `ayo invite`)"));
  for (const m of members) {
    const dot = m.online ? pc.green("●") : pc.dim("○");
    const handle = pc.bold(m.handle.padEnd(11));
    const ctx = ctxByHandle.get(m.handle);
    const where = ctx?.repo ? pc.blue(`${ctx.repo}@${ctx.branch ?? "?"}`) : pc.dim("—");
    const status = m.statusText ? pc.cyan(`"${truncate(m.statusText, 28)}"`) : pc.dim(m.status);
    const when = lastSeen.has(m.handle) ? pc.dim(rel(lastSeen.get(m.handle)!).padStart(4)) : pc.dim("    ");
    out.push(`  ${dot} ${handle} ${when}  ${where}  ${status}`);
  }

  const open = items.filter((i) => i.ayo.kind === "handoff" && !i.resolved);
  if (open.length) {
    out.push(rule, `  ${pc.bold(pc.magenta("⤷ open handoffs"))}`);
    for (const i of open.slice(0, 5)) {
      const a = i.ayo;
      const to = a.to.includes("*") ? "team" : a.to.join(",");
      out.push(`    ${pc.magenta(a.from.handle)} → ${to}  ${truncate(a.body, 28)}  ${pc.dim(`unclaimed ${rel(a.createdAt)}`)}`);
    }
  }

  out.push(rule, `  ${pc.dim("recent")}`);
  if (items.length === 0) out.push(pc.dim("    (quiet so far)"));
  for (const i of items.slice(0, 6)) {
    const a = i.ayo;
    const icon = a.kind === "handoff" ? pc.magenta("⤷") : a.urgency === "urgent" ? "🚨" : pc.dim("▸");
    out.push(`    ${pc.dim(rel(a.createdAt).padStart(4))}  ${pc.cyan(a.from.handle)} ${icon} ${truncate(a.body, 42)}`);
  }

  out.push("", `  ${pc.dim(`↻ every ${REFRESH_MS / 1000}s · q or Ctrl-C to quit`)}`);
  return out.join("\n");
}

export async function board(): Promise<void> {
  const s = requireSession();
  const cfg = loadConfig();
  if (!cfg.activeTeamId) return void console.log("No active team. `ayo team create` or `ayo join` first.");
  const teamId = cfg.activeTeamId;

  let team = "your team";
  try {
    team = (await api.me(s)).teams.find((t) => t.id === teamId)?.name ?? team;
  } catch {
    /* fall back to default label */
  }

  let running = true;
  const cleanup = () => {
    if (!running) return;
    running = false;
    process.stdout.write(EXIT_ALT);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not a TTY */
    }
    process.stdin.pause();
  };
  const quit = () => {
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      // 'q'/'Q' to quit; in raw mode Ctrl-C arrives as byte 0x03, not SIGINT.
      if (d[0] === 0x71 || d[0] === 0x51 || d[0] === 0x03) quit();
    });
  } catch {
    /* not a TTY — Ctrl-C still works via SIGINT */
  }

  process.stdout.write(ENTER_ALT);
  while (running) {
    let members: MemberPresence[] = [];
    let items: FeedItem[] = [];
    let err = "";
    try {
      [members, items] = await Promise.all([
        api.members(s, teamId).then((r) => r.members),
        api.feed(s, teamId, 30).then((r) => r.items),
      ]);
    } catch (e) {
      err = (e as Error).message;
    }
    const body = err ? `\n  ${pc.yellow(`reconnecting… (${err})`)}` : render(team, members, items);
    process.stdout.write(CLEAR + body);
    await sleep(REFRESH_MS);
  }
}
