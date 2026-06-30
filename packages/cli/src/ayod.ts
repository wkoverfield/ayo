#!/usr/bin/env node
/**
 * ayod — the Ayo daemon. Holds one WebSocket to the team DO, pops a native
 * notification the instant an Ayo arrives, and acks machine-level receipt
 * (delivered -> notified). This is the receive path (ADR 0001). It never marks
 * anything `read` — that requires explicit human action over HTTP.
 *
 * Built to run as a long-lived OS service (launchd/systemd, see service.ts):
 *  - refuses to start if another ayod is already alive (no double-notify);
 *  - owns its pidfile (removed on a clean stop) and a size-bounded, rotated log;
 *  - a supervisor re-reads config so login / team switches are picked up live,
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
import { AYO_DIR, DAEMON_LOG_PATH, DAEMON_PID_PATH, loadConfig, loadSession } from "./config.js";
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

let ws: WebSocket | null = null;
let connectedTeam: string | null = null;
let connectedToken: string | null = null;
let backoff = 1000;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(supervise, ms);
}

function wsUrl(relayUrl: string, teamId: string): string {
  const base = relayUrl.replace(/^http/, "ws");
  return `${base}/v1/teams/${teamId}/stream`;
}

function teardown(): void {
  if (ws) {
    ws.removeAllListeners("close"); // don't let the old socket trigger a reconnect
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  connectedTeam = null;
  connectedToken = null;
}

function openSocket(token: string, relayUrl: string, teamId: string, handle: string): void {
  connectedTeam = teamId;
  connectedToken = token;
  const sock = new WebSocket(wsUrl(relayUrl, teamId), {
    headers: { authorization: `Bearer ${token}` },
  });
  ws = sock;

  sock.on("open", () => {
    backoff = 1000;
    log(`connected to ${teamId} as ${handle}`);
  });
  sock.on("message", (data) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data.toString()) as ServerFrame;
    } catch {
      return;
    }
    handleFrame(sock, frame);
  });
  sock.on("close", () => {
    ws = null;
    connectedTeam = null;
    log(`disconnected; reconnecting in ${backoff}ms`);
    schedule(backoff); // supervise re-reads config, so it reconnects with the latest team
    backoff = Math.min(backoff * 2, 30_000);
  });
  sock.on("error", (err) => log(`socket error: ${err.message}`));
}

/** Single control loop: reconcile the live socket with the current config. */
function supervise(): void {
  const session = loadSession();
  const cfg = loadConfig();
  const teamId = cfg.activeTeamId;

  if (!session || !teamId) {
    teardown();
    log("not logged in / no active team — waiting; run `ayo login` / `ayo join`");
    schedule(RETRY_MS);
    return;
  }

  // Team or identity changed under us (user switched teams / re-logged in)?
  if (ws && (connectedTeam !== teamId || connectedToken !== session.token)) {
    log(`config changed — switching to team ${teamId}`);
    teardown();
  }
  if (!ws) {
    openSocket(session.token, cfg.relayUrl, teamId, session.handle);
  }
  schedule(SUPERVISE_MS); // keep watching for config changes while connected
}

// ── Frame handling ───────────────────────────────────────────────────────────

function ack(sock: WebSocket, ayoId: string, state: AckFrame["state"]): void {
  const frame: AckFrame = { t: "ack", ayoId: ayoId as never, state };
  sock.send(JSON.stringify(frame));
}

function handleFrame(sock: WebSocket, frame: ServerFrame): void {
  switch (frame.t) {
    case "ready":
      log(`ready — ${frame.unread} unread, ${frame.members.filter((m) => m.online).length} online`);
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
          notifyAyo(ayo);
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

mkdirSync(AYO_DIR, { recursive: true }); // a fresh service launch may predate it
initLog();
guardSingleInstance();
writeFileSync(DAEMON_PID_PATH, String(process.pid));
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
