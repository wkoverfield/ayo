#!/usr/bin/env node
/**
 * ayod — the Ayo daemon. Holds one WebSocket to the team DO, pops a native
 * notification the instant an Ayo arrives, and acks machine-level receipt
 * (delivered -> notified). This is the receive path (ADR 0001). It never marks
 * anything `read` — that requires explicit human action over HTTP.
 *
 * Built to run as a long-lived OS service (launchd/systemd, see service.ts):
 *  - owns its pidfile (so the controller + agent hooks can detect it under any
 *    launch method) and removes it on a clean stop;
 *  - owns a size-bounded log file (no stdout-redirection needed by the service);
 *  - if not logged in / no active team, waits and retries instead of exiting,
 *    so the service doesn't crash-loop before the user has set things up.
 */

import { writeFileSync, appendFileSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import WebSocket from "ws";
import type { ServerFrame, AckFrame } from "@ayo-dev/core";
import { AYO_DIR, DAEMON_LOG_PATH, DAEMON_PID_PATH, loadConfig, loadSession } from "./config.js";
import { loadInbox, upsertInbox } from "./inbox-store.js";
import { notifyAyo } from "./notify.js";

const MAX_LOG_BYTES = 1_000_000;
const RETRY_MS = 10_000;

function initLog(): void {
  // Keep the log bounded across restarts: truncate only once it's large.
  try {
    if (existsSync(DAEMON_LOG_PATH) && statSync(DAEMON_LOG_PATH).size > MAX_LOG_BYTES) {
      writeFileSync(DAEMON_LOG_PATH, "");
    }
  } catch {
    /* ignore */
  }
}

function log(msg: string): void {
  const line = `[ayod ${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(DAEMON_LOG_PATH, line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line);
}

function removePid(): void {
  try {
    rmSync(DAEMON_PID_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

function wsUrl(relayUrl: string, teamId: string): string {
  const base = relayUrl.replace(/^http/, "ws");
  return `${base}/v1/teams/${teamId}/stream`;
}

/** (Re)connect with backoff, indefinitely, for one team. */
function connect(token: string, relayUrl: string, teamId: string, handle: string): void {
  let backoff = 1000;
  const open = () => {
    const ws = new WebSocket(wsUrl(relayUrl, teamId), {
      headers: { authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      backoff = 1000;
      log(`connected to ${teamId} as ${handle}`);
    });

    ws.on("message", (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      handleFrame(ws, frame);
    });

    ws.on("close", () => {
      log(`disconnected; reconnecting in ${backoff}ms`);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });

    ws.on("error", (err) => log(`socket error: ${err.message}`));
  };
  open();
}

/** Wait for login + an active team, then connect. Retries so the service can be
 *  installed before the user has logged in. */
function startWhenReady(): void {
  const session = loadSession();
  const cfg = loadConfig();
  if (!session) {
    log("not logged in — waiting; run `ayo login`");
    setTimeout(startWhenReady, RETRY_MS);
    return;
  }
  if (!cfg.activeTeamId) {
    log("no active team — waiting; run `ayo team create` or `ayo join`");
    setTimeout(startWhenReady, RETRY_MS);
    return;
  }
  connect(session.token, cfg.relayUrl, cfg.activeTeamId, session.handle);
}

function ack(ws: WebSocket, ayoId: string, state: AckFrame["state"]): void {
  const frame: AckFrame = { t: "ack", ayoId: ayoId as never, state };
  ws.send(JSON.stringify(frame));
}

function handleFrame(ws: WebSocket, frame: ServerFrame): void {
  switch (frame.t) {
    case "ready":
      log(`ready — ${frame.unread} unread, ${frame.members.filter((m) => m.online).length} online`);
      break;
    case "ayo": {
      const ayo = frame.ayo;
      // Already seen (e.g. replayed on reconnect)? Re-ack delivery, but don't
      // re-notify — that would double-buzz on every reconnect.
      const known = loadInbox().ayos.some((a) => a.id === ayo.id);
      upsertInbox(ayo);
      ack(ws, ayo.id, "delivered"); // machine has it
      if (!known) {
        try {
          notifyAyo(ayo);
          ack(ws, ayo.id, "notified"); // the human's machine buzzed (NOT read)
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

mkdirSync(AYO_DIR, { recursive: true }); // a fresh service launch may predate it
initLog();
writeFileSync(DAEMON_PID_PATH, String(process.pid));
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
startWhenReady();
