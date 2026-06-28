#!/usr/bin/env node
/**
 * ayod — the Ayo daemon. Holds one WebSocket to the team DO, pops a native
 * notification the instant an Ayo arrives, and acks machine-level receipt
 * (delivered -> notified). This is the receive path (ADR 0001). It never marks
 * anything `read` — that requires explicit human action over HTTP.
 */

import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";
import type { Ayo, ServerFrame, AckFrame } from "@ayo-dev/core";
import { AYO_DIR, loadConfig, requireSession } from "./config.js";
import { notifyAyo } from "./notify.js";

const INBOX_PATH = join(AYO_DIR, "inbox.json");

interface InboxFile {
  ayos: Ayo[];
  updatedAt: string;
}

function loadInbox(): InboxFile {
  if (!existsSync(INBOX_PATH)) return { ayos: [], updatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(INBOX_PATH, "utf8")) as InboxFile;
  } catch {
    return { ayos: [], updatedAt: new Date(0).toISOString() };
  }
}

function upsertInbox(ayo: Ayo): void {
  const inbox = loadInbox();
  if (!inbox.ayos.some((a) => a.id === ayo.id)) inbox.ayos.push(ayo);
  inbox.updatedAt = new Date().toISOString();
  writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2));
}

function wsUrl(relayUrl: string, teamId: string, token: string): string {
  const base = relayUrl.replace(/^http/, "ws");
  return `${base}/v1/teams/${teamId}/stream?token=${encodeURIComponent(token)}`;
}

function log(msg: string): void {
  console.log(`[ayod ${new Date().toISOString()}] ${msg}`);
}

function connect(): void {
  const session = requireSession();
  const cfg = loadConfig();
  const teamId = cfg.activeTeamId;
  if (!teamId) {
    console.error("No active team. Run `ayo team create` or `ayo join <code>` first.");
    process.exit(1);
  }

  let backoff = 1000;
  const open = () => {
    const ws = new WebSocket(wsUrl(cfg.relayUrl, teamId, session.token));

    ws.on("open", () => {
      backoff = 1000;
      log(`connected to ${teamId} as ${session.handle}`);
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
      upsertInbox(ayo);
      ack(ws, ayo.id, "delivered"); // machine has it
      notifyAyo(ayo);
      ack(ws, ayo.id, "notified"); // the human's machine buzzed (NOT read)
      log(`ayo ${ayo.id} from ${ayo.from.handle}`);
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

connect();
