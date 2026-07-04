/**
 * `ayo board` — a live team dashboard. Polls the roster (presence/status) and
 * the team feed (recent Ayos + open handoffs) and redraws on an interval, in the
 * terminal's alternate screen buffer so your scrollback is left untouched.
 *
 * Terminal state is restored on EVERY exit path — clean quit (q/Ctrl-C), SIGINT,
 * SIGTERM, an uncaught error in the loop, or any process.exit — so the user is
 * never left with a stuck alt screen / hidden cursor / raw mode.
 */

import pc from "picocolors";
import type { FeedItem, HackathonState, MemberPresence } from "@ayo-dev/core";
import { loadConfig, requireSession } from "./config.js";
import { api } from "./client.js";
import { fmtCountdown } from "./hackathon.js";
import { rel } from "./fmt.js";

const ENTER_ALT = "\x1b[?1049h\x1b[?25l"; // alternate screen + hide cursor
const EXIT_ALT = "\x1b[?25h\x1b[?1049l"; // show cursor + leave alternate screen
const CLEAR = "\x1b[H\x1b[2J"; // cursor home + clear
const REFRESH_MS = 3000;
const WIDTH = 66;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function truncate(s: string, n: number): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function render(team: string, members: MemberPresence[], items: FeedItem[], hackathon: HackathonState | null): string {
  const rule = `  ${pc.dim("─".repeat(WIDTH))}`;
  const online = members.filter((m) => m.online).length;
  const title = hackathon?.name ?? team;
  const countdown = hackathon ? fmtCountdown(hackathon.endsAt) : "";
  const right = countdown ? pc.yellow(`⏳ ${countdown}`) : pc.dim("● live");
  const out: string[] = ["", `  ${pc.bold(pc.yellow(`⚡ ${title}`))}    ${pc.dim(`${online}/${members.length} online`)}    ${right}`, rule];

  // Each member's latest repo@branch + last-activity time, derived from the feed.
  const ctxByHandle = new Map<string, { repo?: string; branch?: string }>();
  const lastSeen = new Map<string, string>();
  for (const it of items) {
    const h = it.ayo.from.handle;
    if (!ctxByHandle.has(h) && it.ayo.context?.repo) ctxByHandle.set(h, it.ayo.context);
    if (!lastSeen.has(h)) lastSeen.set(h, it.ayo.createdAt);
  }

  if (members.length === 0) out.push(pc.dim("  (no teammates yet — share your join code; they run `ayo join <code>`)"));
  for (const m of members) {
    const dot = m.online ? pc.green("●") : pc.dim("○");
    const handle = pc.bold(m.handle.padEnd(11));
    const ctx = ctxByHandle.get(m.handle);
    const where = ctx?.repo ? pc.blue(`${ctx.repo}@${ctx.branch ?? "?"}`) : pc.dim("—");
    // The status WORD is their availability setting (active/heads-down/…) — for
    // someone who isn't connected, showing "active" reads as a lie next to the
    // offline dot. But heads-down/dnd are set on purpose, stay true offline,
    // and actually HOLD pings — hide them and a teammate can't see the
    // do-not-disturb signal before pinging. (away doesn't gate anything and
    // reads redundant next to "offline", so it gets no suffix.) A note renders
    // alongside, never instead.
    const quiet = m.status === "heads-down" || m.status === "dnd";
    const word = m.online ? m.status : quiet ? `offline · ${m.status}` : "offline";
    const status = pc.dim(word) + (m.statusText ? ` ${pc.cyan(`"${truncate(m.statusText, 24)}"`)}` : "");
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
    const icon = a.kind === "handoff" ? pc.magenta("⤷") : a.urgency === "urgent" ? pc.red("!") : pc.dim("▸");
    out.push(`    ${pc.dim(rel(a.createdAt).padStart(4))}  ${pc.cyan(a.from.handle)} ${icon} ${truncate(a.body, 42)}`);
  }

  // The board shows TEAM activity only (broadcasts + handoffs) — say so, or a
  // person who just received a DM/reply stares at the board wondering where it
  // went (it's in their inbox, on purpose).
  out.push("", `  ${pc.dim("1:1 pings & replies stay private — they're in `ayo inbox`")}`);
  out.push(`  ${pc.dim(`↻ every ${REFRESH_MS / 1000}s · q or Ctrl-C to quit`)}`);
  return out.join("\n");
}

async function fetchBoard(s: Parameters<typeof api.members>[0], teamId: string) {
  const [members, items, hackathon] = await Promise.all([
    api.members(s, teamId).then((r) => r.members),
    api.feed(s, teamId, 30).then((r) => r.items),
    // Best-effort: the hackathon is cosmetic header data — a failure here must
    // NOT blank the whole board (which members + feed drive).
    api.getHackathon(s, teamId).then((r) => r.hackathon).catch(() => null),
  ]);
  return { members, items, hackathon };
}

export async function board(opts: { once?: boolean } = {}): Promise<void> {
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

  // One-shot frame: no alt screen / raw mode / loop. Works when piped.
  if (opts.once) {
    const { members, items, hackathon } = await fetchBoard(s, teamId);
    console.log(render(team, members, items, hackathon));
    return;
  }

  if (!process.stdout.isTTY) {
    console.error("ayo board needs an interactive terminal (or use `ayo board --once`).");
    process.exit(1);
  }

  let running = true;
  // Synchronous terminal restore — safe to call from the "exit" event.
  const restore = () => {
    process.stdout.write(EXIT_ALT);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not a TTY */
    }
  };
  const cleanup = () => {
    if (!running) return;
    running = false;
    restore();
    process.stdin.pause();
  };
  const quit = () => {
    cleanup();
    process.exit(0);
  };
  // Cover every exit path so the terminal is never left broken.
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", () => {
    if (running) restore(); // uncaught error / explicit process.exit backstop
  });
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
  try {
    while (running) {
      let members: MemberPresence[] = [];
      let items: FeedItem[] = [];
      let hackathon: HackathonState | null = null;
      let err = "";
      try {
        ({ members, items, hackathon } = await fetchBoard(s, teamId));
      } catch (e) {
        err = (e as Error).message;
      }
      const body = err ? `\n  ${pc.yellow(`reconnecting… (${err})`)}` : render(team, members, items, hackathon);
      process.stdout.write(CLEAR + body);
      await sleep(REFRESH_MS);
    }
  } finally {
    cleanup(); // restore on an uncaught error in the loop too
  }
}
