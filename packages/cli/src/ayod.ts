#!/usr/bin/env node
/**
 * ayod — the Ayo daemon. Holds one WebSocket PER TEAM you belong to (an Ayo
 * from any of your teams reaches this machine — "route attention to you
 * wherever you are" can't mean "for one team at a time"), pops a native
 * notification the instant an Ayo arrives, and acks machine-level receipt
 * (delivered -> notified). This is the receive path (see docs/protocol.md). It never marks
 * anything `read` — that requires explicit human action over HTTP.
 *
 * Built to run as a long-lived OS service (launchd/systemd, see service.ts):
 *  - refuses to start if another ayod is already alive (no double-notify);
 *  - owns its pidfile (removed on a clean stop) and a size-bounded, rotated log;
 *  - a supervisor re-reads config AND re-fetches the team roster (me()) so
 *    login changes, team switches, joins, and new teams are picked up live,
 *    and waits+retries when not yet set up (no crash-loop before login).
 */

import {
  writeFileSync,
  appendFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import WebSocket from "ws";
import type { ServerFrame, AckFrame } from "@ayo-dev/core";
import { PROTOCOL_VERSION } from "@ayo-dev/core";
import { AYO_DIR, DAEMON_LOG_PATH, DAEMON_META_PATH, DAEMON_PID_PATH, loadConfig, loadSession } from "./config.js";
import { api } from "./client.js";
import { loadInbox, upsertInbox } from "./inbox-store.js";
import { notifyAyo } from "./notify.js";

const MAX_LOG_BYTES = 1_000_000;
const RETRY_MS = 10_000; // re-check when not logged in / no team
const SUPERVISE_MS = 30_000; // re-check config for team/login changes while connected

// ── Logging (bounded, with in-flight rotation) ───────────────────────────────

let logBytes = 0;

function initLog(): void {
  try {
    logBytes = existsSync(DAEMON_LOG_PATH) ? statSync(DAEMON_LOG_PATH).size : 0;
  } catch {
    logBytes = 0;
  }
}

function log(msg: string): void {
  const line = `[ayod ${new Date().toISOString()}] ${msg}\n`;
  try {
    if (logBytes > MAX_LOG_BYTES) {
      renameSync(DAEMON_LOG_PATH, `${DAEMON_LOG_PATH}.1`); // keep one previous generation
      logBytes = 0;
    }
    appendFileSync(DAEMON_LOG_PATH, line);
    logBytes += Buffer.byteLength(line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line); // discarded by the service (StandardOutPath); shown in foreground
}

let ownsPidfile = false;

function removePid(): void {
  // Only ever remove a pidfile THIS process wrote — never another (live) ayod's,
  // e.g. if a rejected second instance exits (guardSingleInstance).
  if (!ownsPidfile) return;
  try {
    rmSync(DAEMON_PID_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

// ── Connection supervisor ────────────────────────────────────────────────────

interface TeamSocket {
  ws: WebSocket;
  token: string;
  backoff: number;
}

const sockets = new Map<string, TeamSocket>(); // teamId -> live socket
/** teamId -> team name, refreshed from me() — used to badge multi-team toasts. */
const teamNames = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Infinity; // when the pending tick fires — earliest wakeup wins
let supervising = false; // supervise() is async now; never let two ticks overlap

function schedule(ms: number): void {
  // Earliest-wins: a 30s steady-state tick must never CLOBBER a 1s reconnect
  // wakeup another socket just asked for (and vice versa an early wakeup may
  // replace a later one).
  const at = Date.now() + ms;
  if (timer && at >= timerAt) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    timerAt = Infinity;
    void supervise();
  }, ms);
}

function wsUrl(relayUrl: string, teamId: string): string {
  const base = relayUrl.replace(/^http/, "ws");
  return `${base}/v1/teams/${teamId}/stream`;
}

function closeSocket(teamId: string): void {
  const s = sockets.get(teamId);
  if (!s) return;
  s.ws.removeAllListeners("close"); // don't let the old socket trigger a reconnect
  try {
    s.ws.close();
  } catch {
    /* ignore */
  }
  sockets.delete(teamId);
}

function teardownAll(): void {
  for (const teamId of [...sockets.keys()]) closeSocket(teamId);
}

function openSocket(token: string, relayUrl: string, teamId: string, handle: string): void {
  const prevBackoff = sockets.get(teamId)?.backoff ?? 1000;
  const sock = new WebSocket(wsUrl(relayUrl, teamId), {
    headers: { authorization: `Bearer ${token}` },
  });
  sockets.set(teamId, { ws: sock, token, backoff: prevBackoff });

  sock.on("open", () => {
    const s = sockets.get(teamId);
    if (s && s.ws === sock) s.backoff = 1000; // a replaced socket must not reset the new one's backoff
    log(`connected to ${teamNames.get(teamId) ?? teamId} as ${handle}`);
  });
  sock.on("message", (data) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data.toString()) as ServerFrame;
    } catch {
      return;
    }
    handleFrame(sock, teamId, frame);
  });
  sock.on("close", () => {
    const s = sockets.get(teamId);
    // Only act if the entry is still OURS (a switch/reconcile may have already
    // replaced it). Remember the grown backoff so retries actually back off.
    if (s && s.ws === sock) {
      sockets.delete(teamId);
      backoffMemory.set(teamId, { delay: Math.min(s.backoff * 2, 30_000), nextAt: Date.now() + s.backoff });
      log(`${teamNames.get(teamId) ?? teamId}: disconnected; reconnecting in ${s.backoff}ms`);
      schedule(s.backoff); // supervise reconciles everything with the latest config
    }
  });
  sock.on("error", (err) => log(`${teamId}: socket error: ${err.message}`));
}

/** Per-team reconnect state that survives the socket's Map entry: the grown
 *  delay AND when the next attempt is allowed — so one team's 1s retry can't
 *  make supervise hammer another team that's meant to be waiting 30s. */
const backoffMemory = new Map<string, { delay: number; nextAt: number }>();

/**
 * Single control loop: reconcile the live sockets with the current identity and
 * team roster. The roster comes from me() (best-effort — on failure we fall
 * back to the teams we already know plus the active one, so a relay blip never
 * tears down working connections).
 */
async function supervise(): Promise<void> {
  if (supervising) return;
  supervising = true;
  try {
    const session = loadSession();
    const cfg = loadConfig();

    if (!session) {
      teardownAll();
      log("not logged in — waiting; run `ayo login`");
      schedule(RETRY_MS);
      return;
    }

    // Identity changed under us (re-login)? Drop everything and rebuild.
    for (const [teamId, s] of sockets) {
      if (s.token !== session.token) closeSocket(teamId);
    }

    // Which teams should we stream? Every team you belong to.
    let teamIds: string[] = [];
    try {
      const me = await api.me(session);
      teamNames.clear();
      for (const t of me.teams) teamNames.set(t.id, t.name);
      teamIds = me.teams.map((t) => t.id);
    } catch {
      // Relay unreachable — keep what we have, make sure the active team is tried.
      teamIds = [...new Set([...sockets.keys(), ...(cfg.activeTeamId ? [cfg.activeTeamId] : [])])];
    }

    if (teamIds.length === 0) {
      teardownAll();
      log("no teams yet — waiting; run `ayo team create` or `ayo join`");
      schedule(RETRY_MS);
      return;
    }

    const want = new Set(teamIds);
    for (const teamId of [...sockets.keys()]) {
      if (!want.has(teamId)) {
        log(`left ${teamNames.get(teamId) ?? teamId} — closing its stream`);
        closeSocket(teamId);
      }
    }
    const now = Date.now();
    for (const teamId of want) {
      if (sockets.has(teamId)) continue;
      const memo = backoffMemory.get(teamId);
      if (memo && memo.nextAt > now) {
        schedule(memo.nextAt - now); // not yet — wake up when ITS backoff matures
        continue;
      }
      openSocket(session.token, cfg.relayUrl, teamId, session.handle);
      if (memo) {
        const s = sockets.get(teamId);
        if (s) s.backoff = memo.delay;
        backoffMemory.delete(teamId);
      }
    }
    // Prune memory for teams we no longer belong to (bounded, but be tidy).
    for (const teamId of [...backoffMemory.keys()]) if (!want.has(teamId)) backoffMemory.delete(teamId);
    schedule(SUPERVISE_MS); // keep watching for config/roster changes
  } catch (err) {
    // A torn config read (switch/join writes while we parse) or a sync socket
    // throw must not kill the daemon — log, retry soon.
    log(`supervise error: ${(err as Error).message}`);
    schedule(RETRY_MS);
  } finally {
    supervising = false;
  }
}

// ── Frame handling ───────────────────────────────────────────────────────────

function ack(sock: WebSocket, ayoId: string, state: AckFrame["state"]): void {
  const frame: AckFrame = { t: "ack", ayoId: ayoId as never, state };
  sock.send(JSON.stringify(frame));
}

function handleFrame(sock: WebSocket, teamId: string, frame: ServerFrame): void {
  switch (frame.t) {
    case "ready":
      log(`${teamNames.get(teamId) ?? teamId}: ready — ${frame.unread} unread, ${frame.members.filter((m) => m.online).length} online`);
      // No negotiation yet — just surface a mismatch so a stale CLI vs a redeployed
      // relay is diagnosable instead of silently misbehaving.
      if (typeof frame.protocol === "number" && frame.protocol !== PROTOCOL_VERSION) {
        log(`⚠ protocol mismatch: relay v${frame.protocol}, this ayod v${PROTOCOL_VERSION} — consider \`npm i -g @ayo-dev/cli\``);
      }
      break;
    case "ayo": {
      const ayo = frame.ayo;
      // Already seen (e.g. replayed on reconnect)? Re-ack delivery, but don't
      // re-notify — that would double-buzz on every reconnect.
      const known = loadInbox().ayos.some((a) => a.id === ayo.id);
      upsertInbox(ayo);
      ack(sock, ayo.id, "delivered"); // machine has it
      if (!known) {
        try {
          // Badge the toast with the team only when you're in more than one.
          notifyAyo(ayo, teamNames.size > 1 ? { teamName: teamNames.get(teamId) } : {});
          ack(sock, ayo.id, "notified"); // the human's machine buzzed (NOT read)
        } catch (err) {
          // Notification failed — do NOT ack `notified` and do NOT crash.
          log(`notify failed: ${(err as Error).message}`);
        }
      }
      log(`ayo ${ayo.id} from ${ayo.from.handle}${known ? " (replayed)" : ""}`);
      break;
    }
    case "ayo:update":
      log(`ayo ${frame.ayoId} -> ${frame.state} by ${frame.by}`);
      break;
    case "presence":
      log(`presence: ${frame.handle} ${frame.online ? "online" : "offline"} (${frame.status})`);
      break;
    case "team":
      log(`team: ${frame.handle} ${frame.event}`);
      break;
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Refuse to start if another ayod is already alive — two daemons = double-buzz. */
function guardSingleInstance(): void {
  if (!existsSync(DAEMON_PID_PATH)) return;
  try {
    const pid = Number(readFileSync(DAEMON_PID_PATH, "utf8").trim());
    if (Number.isInteger(pid) && pid !== process.pid) {
      process.kill(pid, 0); // throws if not alive
      log(`another ayod is already running (pid ${pid}) — exiting`);
      process.exit(1);
    }
  } catch {
    /* stale pidfile — fall through and take over */
  }
}

function ayodVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

mkdirSync(AYO_DIR, { recursive: true }); // a fresh service launch may predate it
initLog();
guardSingleInstance();
writeFileSync(DAEMON_PID_PATH, String(process.pid));
// Version breadcrumb for `ayo doctor`: after an npm upgrade the SERVICE keeps
// running the old ayod until restarted — doctor can now see the skew.
try {
  writeFileSync(DAEMON_META_PATH, JSON.stringify({ pid: process.pid, version: ayodVersion() }));
} catch {
  /* cosmetic — never block startup on it */
}
ownsPidfile = true; // from here on, removePid may delete it

// Clean stop (service stop sends SIGTERM): remove the pidfile and exit 0 so the
// service manager doesn't treat it as a crash and restart us.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    removePid();
    process.exit(0);
  });
}
process.on("exit", removePid);

log(`ayod up (pid ${process.pid})`);
supervise();
