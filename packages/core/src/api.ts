/**
 * HTTP API request/response shapes for the `/v1` relay. See ADR 0002.
 * HTTP is the command channel; every mutation has an endpoint here so any
 * one-shot process (CLI, MCP) can perform it without the daemon's socket.
 */

import type { Ayo, AyoContext, AyoKind, Handle, Recipients, Urgency } from "./message.js";
import type { AyoId, TeamId, UserId } from "./ids.js";
import type { MemberPresence, PresenceStatus } from "./wire.js";

export const API_VERSION = "v1";

/** The hosted Ayo relay. CLI and MCP fall back to this; override with
 *  AYO_RELAY_URL (local dev) or `relayUrl` in ~/.ayo/config.json (self-host). */
export const DEFAULT_RELAY_URL = "https://ayo-relay.wkoverfield.workers.dev";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_token"
  | "team_not_found"
  | "not_a_member"
  | "unknown_recipient"
  | "bad_request"
  | "rate_limited"
  | "payload_too_large"
  | "internal_error";

// ── Auth: GitHub device flow ───────────────────────────────────────────────

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  /** Seconds until the device/user codes expire. */
  expires_in: number;
}

export interface DevicePollRequest {
  device_code: string;
}

export interface PublicUser {
  id: UserId;
  handle: Handle;
  name: string;
}

/** Poll is long-running: the CLI calls it on an interval until `complete`. */
export type DevicePollResponse =
  | { status: "complete"; session_token: string; user: PublicUser }
  | { status: "pending" }
  | { status: "slow_down"; interval: number };

// ── Teams ──────────────────────────────────────────────────────────────────

export interface MeResponse {
  user: PublicUser;
  teams: { id: TeamId; name: string; handle: Handle }[];
}

export interface CreateTeamRequest {
  name: string;
}

export interface CreateTeamResponse {
  id: TeamId;
  name: string;
  joinCode: string;
}

export interface JoinTeamRequest {
  code: string;
}

export interface JoinTeamResponse {
  id: TeamId;
  name: string;
}

export interface MembersResponse {
  members: MemberPresence[];
}

// ── Send ───────────────────────────────────────────────────────────────────

/** Body of `POST /v1/teams/:id/ayo` — the server fills id/from/createdAt. */
export interface SendAyoRequest {
  to: Recipients;
  body: string;
  kind?: AyoKind;
  urgency?: Urgency;
  context?: AyoContext;
  replyTo?: AyoId | null;
  expiresAt?: string | null;
}

export interface SendAyoResponse {
  id: AyoId;
  deliveredTo: Handle[];
  queuedFor: Handle[];
}

// ── Inbox / state ──────────────────────────────────────────────────────────

export interface InboxResponse {
  ayos: Ayo[];
  cursor: AyoId | null;
}

/** Recent TEAM-VISIBLE activity for the live board (newest first): broadcasts +
 *  handoffs only — direct 1:1 pings stay private to the recipient's inbox.
 *  `resolved` = every recipient resolved it (used to surface OPEN handoffs).
 *  Note: the relay scans a bounded recent window, so a very DM-heavy team can
 *  under-return (older team activity beyond the window won't appear). */
export interface FeedItem {
  ayo: Ayo;
  resolved: boolean;
}
export interface FeedResponse {
  items: FeedItem[];
}

export interface SetStatusRequest {
  status: PresenceStatus;
  statusText?: string | null;
  /** Seconds until the status auto-clears; omit for no expiry. */
  ttl?: number;
}
