/**
 * Minimal relay client for the MCP server. Reads the same ~/.ayo/session.json
 * and config.json the CLI writes (AYO_DIR-aware), so MCP and CLI share one
 * identity. Auth is loaded ONCE per tool call and threaded through, so a
 * concurrent `ayo login` can't swap identity mid-request.
 */

import type {
  AskStateResponse,
  InboxResponse,
  MembersResponse,
  SendAyoRequest,
  SendAyoResponse,
  SetStatusRequest,
  CreateHandoffLinkRequest,
  CreateHandoffLinkResponse,
} from "@ayo-dev/core";
import { loadConfig, loadSession, relayCall, RelayError } from "@ayo-dev/core/node";

export interface Auth {
  token: string;
  relayUrl: string;
  teamId: string;
  /** Your own handle — asks are self-addressed (your agent asks YOU). */
  handle: string;
}

export function loadAuth(): Auth {
  const session = loadSession();
  const config = loadConfig();
  if (!session) throw new Error("Not logged in — run `ayo login` in a terminal first.");
  if (!config.activeTeamId) throw new Error("No active team — run `ayo team create` or `ayo join`.");
  // Unlike the CLI, the MCP server lets AYO_RELAY_URL beat the config file —
  // it's spawned by agents with an env the user can't easily see, so the
  // explicit env wins. (loadConfig already folds the env in when the file has
  // no relayUrl of its own.)
  const relayUrl = process.env.AYO_RELAY_URL ?? config.relayUrl;
  return { token: session.token, relayUrl, teamId: config.activeTeamId, handle: session.handle };
}

async function call<T>(auth: Auth, path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  // Shared transport (redaction + error parsing) from @ayo-dev/core/node; keep
  // this server's historical error shape — a plain Error whose message leads
  // with the relay's code — since that string is what the agent reads.
  try {
    return await relayCall<T>(auth.relayUrl, path, { ...opts, token: auth.token });
  } catch (err) {
    if (err instanceof RelayError) {
      throw new Error(err.code !== "http_error" ? `${err.code}: ${err.message}` : err.message);
    }
    throw err;
  }
}

export const relay = {
  send: (auth: Auth, body: SendAyoRequest) =>
    call<SendAyoResponse>(auth, `/v1/teams/${auth.teamId}/ayo`, { method: "POST", body }),
  createHandoffLink: (auth: Auth, body: CreateHandoffLinkRequest) =>
    call<CreateHandoffLinkResponse>(auth, `/v1/teams/${auth.teamId}/handoff-link`, { method: "POST", body }),
  inbox: (auth: Auth, unreadOnly: boolean) =>
    call<InboxResponse>(auth, `/v1/teams/${auth.teamId}/inbox${unreadOnly ? "?unreadOnly=1" : ""}`),
  resolve: (auth: Auth, ayoId: string) =>
    call<{ ok: true }>(auth, `/v1/ayo/${ayoId}/resolve`, { method: "POST" }),
  askState: (auth: Auth, ayoId: string) => call<AskStateResponse>(auth, `/v1/ayo/${ayoId}/answer`),
  members: (auth: Auth) => call<MembersResponse>(auth, `/v1/teams/${auth.teamId}/members`),
  setStatus: (auth: Auth, body: SetStatusRequest) =>
    call<{ ok: true }>(auth, `/v1/teams/${auth.teamId}/status`, { method: "PUT", body }),
};
