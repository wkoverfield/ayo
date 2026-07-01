/**
 * HTTP API request/response shapes for the `/v1` relay. See ADR 0002.
 * HTTP is the command channel; every mutation has an endpoint here so any
 * one-shot process (CLI, MCP) can perform it without the daemon's socket.
 */

import type { Ayo, AyoContext, AyoKind, AyoSound, Handle, Recipients, Urgency } from "./message.js";
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
  | "not_found"
  | "not_a_member"
  | "forbidden"
  | "unknown_recipient"
  | "bad_request"
  | "rate_limited"
  | "team_full"
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
  /** The sender's chosen notification sound; the relay stamps it onto each Ayo. */
  sound?: AyoSound | null;
}

/** Body of `PUT /v1/me/sound` — set your signature sound (or `null` to clear). */
export type SetSoundRequest = AyoSound | null;

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
  /** Lets a fresh joiner re-invite without a round-trip. Optional for safe API
   *  evolution (an older relay won't send it; callers use `ayo invite` anyway). */
  joinCode?: string;
}

/** `GET /v1/teams/:id/invite` — the active team's shareable invite (members only). */
export interface InviteResponse {
  name: string;
  joinCode: string;
  /** ISO timestamp the code expires, or null if it never does. Lets `ayo invite`
   *  warn instead of pasting a dead code. Optional for backward-compat with an
   *  older relay that doesn't send it. */
  codeExpiresAt?: string | null;
}

/** `POST /v1/teams/:id/rotate-code` — owner rotates the join code (revokes the old
 *  one); optional expiry. Members cap is server-enforced (see MAX_TEAM_SIZE). */
export interface RotateCodeRequest {
  /** Optional: auto-expire the new code after N hours (omit = no expiry). */
  expiresInHours?: number;
}
export interface RotateCodeResponse {
  joinCode: string;
  /** ISO timestamp, or null if the code doesn't expire. */
  expiresAt: string | null;
}

/** Max members per team — a leaked, non-rotating code + no cap = a floodable team. */
export const MAX_TEAM_SIZE = 50;

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
  /**
   * Requested handles that match no current team member (a typo or a teammate
   * who hasn't joined yet). Lets the sender learn a directed ping went nowhere
   * instead of seeing a silent success. Empty for broadcasts (`["*"]`).
   */
  unknownRecipients: Handle[];
  /**
   * Recipients who are heads-down / dnd, so this (non-urgent) Ayo was held for
   * their inbox instead of popping a real-time toast. Lets the sender see "Maya's
   * focusing — she'll get it later" rather than expecting an instant buzz.
   */
  heldFor: Handle[];
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

// ── Hackathon mode ───────────────────────────────────────────────────────────

export interface HackathonState {
  name: string;
  /** ISO timestamp the sprint ends. */
  endsAt: string;
  /** ISO timestamp the sprint started. */
  startedAt: string;
}

export interface StartHackathonRequest {
  name: string;
  endsAt: string;
}

export interface HackathonResponse {
  hackathon: HackathonState | null;
}

/** Full team-relevant event log for `ayo hackathon export`, oldest-first. */
export interface TimelineResponse {
  hackathon: HackathonState | null;
  events: Ayo[];
}
