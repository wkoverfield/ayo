/**
 * Thin typed wrapper over the relay HTTP API. Uses global fetch (Node 20+).
 */

import type {
  AyoSound,
  CreateTeamResponse,
  DevicePollResponse,
  DeviceStartResponse,
  FeedResponse,
  HackathonResponse,
  InboxResponse,
  StartHackathonRequest,
  TimelineResponse,
  JoinTeamResponse,
  MembersResponse,
  MeResponse,
  SendAyoRequest,
  SendAyoResponse,
  SetSoundRequest,
  SetStatusRequest,
} from "@ayo-dev/core";
import { loadConfig, type Session } from "./config.js";

export class RelayError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const { relayUrl } = loadConfig();
  const res = await fetch(`${relayUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const code = data?.error?.code ?? "http_error";
    throw new RelayError(code, data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  deviceStart: (handle: string) =>
    call<DeviceStartResponse>(`/v1/auth/device?handle=${encodeURIComponent(handle)}`, { method: "POST" }),

  devicePoll: (device_code: string) =>
    call<DevicePollResponse>("/v1/auth/device/poll", { method: "POST", body: { device_code } }),

  me: (s: Session) => call<MeResponse>("/v1/me", { token: s.token }),

  createTeam: (s: Session, name: string) =>
    call<CreateTeamResponse>("/v1/teams", { method: "POST", body: { name }, token: s.token }),

  joinTeam: (s: Session, code: string) =>
    call<JoinTeamResponse>("/v1/teams/join", { method: "POST", body: { code }, token: s.token }),

  members: (s: Session, teamId: string) =>
    call<MembersResponse>(`/v1/teams/${teamId}/members`, { token: s.token }),

  feed: (s: Session, teamId: string, limit = 30) =>
    call<FeedResponse>(`/v1/teams/${teamId}/feed?limit=${limit}`, { token: s.token }),

  getHackathon: (s: Session, teamId: string) =>
    call<HackathonResponse>(`/v1/teams/${teamId}/hackathon`, { token: s.token }),
  startHackathon: (s: Session, teamId: string, body: StartHackathonRequest) =>
    call<HackathonResponse>(`/v1/teams/${teamId}/hackathon`, { method: "PUT", body, token: s.token }),
  endHackathon: (s: Session, teamId: string) =>
    call<HackathonResponse>(`/v1/teams/${teamId}/hackathon`, { method: "DELETE", token: s.token }),
  timeline: (s: Session, teamId: string) =>
    call<TimelineResponse>(`/v1/teams/${teamId}/timeline`, { token: s.token }),

  send: (s: Session, teamId: string, body: SendAyoRequest) =>
    call<SendAyoResponse>(`/v1/teams/${teamId}/ayo`, { method: "POST", body, token: s.token }),

  inbox: (s: Session, teamId: string, since?: string, unreadOnly = false) => {
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (unreadOnly) q.set("unreadOnly", "1");
    const qs = q.toString();
    return call<InboxResponse>(`/v1/teams/${teamId}/inbox${qs ? `?${qs}` : ""}`, { token: s.token });
  },

  markRead: (s: Session, ayoId: string) =>
    call<{ ok: true }>(`/v1/ayo/${ayoId}/read`, { method: "POST", token: s.token }),

  resolve: (s: Session, ayoId: string) =>
    call<{ ok: true }>(`/v1/ayo/${ayoId}/resolve`, { method: "POST", token: s.token }),

  setStatus: (s: Session, teamId: string, body: SetStatusRequest) =>
    call<{ ok: true }>(`/v1/teams/${teamId}/status`, { method: "PUT", body, token: s.token }),

  setSound: (s: Session, body: SetSoundRequest) =>
    call<{ sound: SetSoundRequest }>("/v1/me/sound", { method: "PUT", body, token: s.token }),

  // Raw WAV upload (not JSON), so it bypasses `call`.
  uploadSound: async (s: Session, wav: Uint8Array): Promise<{ sound: AyoSound }> => {
    const { relayUrl } = loadConfig();
    const res = await fetch(`${relayUrl}/v1/me/sound`, {
      method: "PUT",
      headers: { "content-type": "audio/wav", authorization: `Bearer ${s.token}` },
      body: wav,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new RelayError(data?.error?.code ?? "http_error", data?.error?.message ?? `HTTP ${res.status}`);
    return data as { sound: AyoSound };
  },
};
