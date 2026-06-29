/**
 * Minimal relay client for the MCP server. Reads the same ~/.ayo/session.json
 * and config.json the CLI writes (AYO_DIR-aware), so MCP and CLI share one
 * identity. Auth is loaded ONCE per tool call and threaded through, so a
 * concurrent `ayo login` can't swap identity mid-request.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  DEFAULT_RELAY_URL,
  type InboxResponse,
  type MembersResponse,
  type SendAyoRequest,
  type SendAyoResponse,
  type SetStatusRequest,
} from "@ayo-dev/core";

const AYO_DIR = process.env.AYO_DIR ? resolve(process.env.AYO_DIR) : join(homedir(), ".ayo");

interface Session {
  token: string;
  handle: string;
}
interface Config {
  relayUrl?: string;
  activeTeamId?: string;
}

export interface Auth {
  token: string;
  relayUrl: string;
  teamId: string;
}

function read<T>(file: string): T | null {
  const p = join(AYO_DIR, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function loadAuth(): Auth {
  const session = read<Session>("session.json");
  const config = read<Config>("config.json") ?? {};
  if (!session) throw new Error("Not logged in — run `ayo login` in a terminal first.");
  if (!config.activeTeamId) throw new Error("No active team — run `ayo team create` or `ayo join`.");
  const relayUrl = process.env.AYO_RELAY_URL ?? config.relayUrl ?? DEFAULT_RELAY_URL;
  return { token: session.token, relayUrl, teamId: config.activeTeamId };
}

async function call<T>(auth: Auth, path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${auth.relayUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const raw = await res.text();
    // Prefer the relay's structured { error: { code, message } }; fall back to
    // raw text. Redact the token defensively in case anything reflects it.
    let msg = raw;
    try {
      const j = JSON.parse(raw) as { error?: { code?: string; message?: string } };
      if (j.error?.message) msg = j.error.code ? `${j.error.code}: ${j.error.message}` : j.error.message;
    } catch {
      /* not JSON — use raw */
    }
    throw new Error(msg.replaceAll(auth.token, "[redacted]").slice(0, 500));
  }
  return (await res.json()) as T;
}

export const relay = {
  send: (auth: Auth, body: SendAyoRequest) =>
    call<SendAyoResponse>(auth, `/v1/teams/${auth.teamId}/ayo`, { method: "POST", body }),
  inbox: (auth: Auth, unreadOnly: boolean) =>
    call<InboxResponse>(auth, `/v1/teams/${auth.teamId}/inbox${unreadOnly ? "?unreadOnly=1" : ""}`),
  resolve: (auth: Auth, ayoId: string) =>
    call<{ ok: true }>(auth, `/v1/ayo/${ayoId}/resolve`, { method: "POST" }),
  members: (auth: Auth) => call<MembersResponse>(auth, `/v1/teams/${auth.teamId}/members`),
  setStatus: (auth: Auth, body: SetStatusRequest) =>
    call<{ ok: true }>(auth, `/v1/teams/${auth.teamId}/status`, { method: "PUT", body }),
};
