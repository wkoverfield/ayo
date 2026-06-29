/**
 * Minimal relay client for the MCP server. Reads the same ~/.ayo/session.json
 * and config.json the CLI writes, so MCP and CLI share one identity. MCP's
 * strength is send + handoff, not receive (ADR 0001).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type {
  InboxResponse,
  MembersResponse,
  SendAyoRequest,
  SendAyoResponse,
  SetStatusRequest,
} from "@ayo-dev/core";

const AYO_DIR = process.env.AYO_DIR ? resolve(process.env.AYO_DIR) : join(homedir(), ".ayo");

interface Session {
  token: string;
  handle: string;
}
interface Config {
  relayUrl: string;
  activeTeamId?: string;
}

function read<T>(file: string): T | null {
  const p = join(AYO_DIR, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function loadAuth(): { session: Session; config: Config; teamId: string } {
  const session = read<Session>("session.json");
  const config = read<Config>("config.json") ?? { relayUrl: "http://127.0.0.1:8787" };
  if (!session) throw new Error("Not logged in — run `ayo login` in a terminal first.");
  if (!config.activeTeamId) throw new Error("No active team — run `ayo team create` or `ayo join`.");
  return { session, config, teamId: config.activeTeamId };
}

async function call<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const { session, config } = loadAuth();
  const res = await fetch(`${config.relayUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`relay ${res.status}: ${t}`);
  }
  return (await res.json()) as T;
}

export const relay = {
  send: (teamId: string, body: SendAyoRequest) =>
    call<SendAyoResponse>(`/v1/teams/${teamId}/ayo`, { method: "POST", body }),
  inbox: (teamId: string, unreadOnly: boolean) =>
    call<InboxResponse>(`/v1/teams/${teamId}/inbox${unreadOnly ? "?unreadOnly=1" : ""}`),
  markRead: (ayoId: string) => call<{ ok: true }>(`/v1/ayo/${ayoId}/read`, { method: "POST" }),
  resolve: (ayoId: string) => call<{ ok: true }>(`/v1/ayo/${ayoId}/resolve`, { method: "POST" }),
  members: (teamId: string) => call<MembersResponse>(`/v1/teams/${teamId}/members`),
  setStatus: (teamId: string, body: SetStatusRequest) =>
    call<{ ok: true }>(`/v1/teams/${teamId}/status`, { method: "PUT", body }),
};
