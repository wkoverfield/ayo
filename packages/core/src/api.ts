/**
 * HTTP API request/response shapes for the `/v1` relay. See docs/protocol.md.
 * HTTP is the command channel; every mutation has an endpoint here so any
 * one-shot process (CLI, MCP) can perform it without the daemon's socket.
 */

import type { AskAnswer, AskMeta, Ayo, AyoContext, AyoKind, AyoSound, Handle, Recipients, Urgency } from "./message.js";
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
  /** Set when the code came from a handoff link — the joiner lands in a
   *  relationship, not an empty room ("Maya invited you"). */
  invitedBy?: Handle;
}

/** Bounds for an anonymous reply from a handoff share page. */
export const MAX_LINK_REPLY_LENGTH = 2000;
export const MAX_LINK_REPLY_NAME_LENGTH = 40;

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

// ── Handoff share links ("Loom mechanic": a public, expiring URL that renders a
//    handoff's context to a NON-user and converts them) ───────────────────────

/** Default lifetime of a handoff share link. Links are ephemeral by design — a
 *  handoff is a "pick this up now" artifact, not a permanent document. */
export const HANDOFF_LINK_TTL_HOURS = 7 * 24;
/** Hard cap so a caller can't mint a near-permanent public URL. */
export const HANDOFF_LINK_MAX_TTL_HOURS = 30 * 24;
/** Cap on a serialized share snapshot (guards KV + the public render path). The
 *  diff alone is already capped at MAX_DIFF_BYTES; this bounds the whole packet. */
export const MAX_HANDOFF_SHARE_BYTES = 128 * 1024;

/** `POST /v1/teams/:id/handoff-link` — mint a shareable link for a handoff. */
export interface CreateHandoffLinkRequest {
  /** What the recipient needs to pick up (the handoff body). */
  blocker: string;
  /** Optional summary / next steps. */
  note?: string;
  /** Curated work context; the caller decides what to include (diff is opt-in). */
  context?: AyoContext;
  /** Auto-expire after N hours; clamped to [~1 min, HANDOFF_LINK_MAX_TTL_HOURS]. */
  expiresInHours?: number;
  /** Embed a join code so a non-user installs → joins in one step. Default true.
   *  The embedded code is PER-LINK (minted fresh, expires with the link, carries
   *  the inviter) — rotating the team code never kills a live handoff link. */
  includeJoinCode?: boolean;
  /** The handoff Ayo this link renders — replies from the page thread to it. */
  ayoId?: AyoId;
}

export interface CreateHandoffLinkResponse {
  token: string;
  /** Absolute URL to share. */
  url: string;
  /** ISO timestamp the link expires. */
  expiresAt: string;
}

/** The self-contained snapshot a share link renders. Everything the public page
 *  needs, so the render path never touches the team DO. `v` guards the shape.
 *  teamId/fromId/ayoId are ROUTING fields for the reply flow — stored, never
 *  rendered on the public page. */
export interface HandoffShare {
  v: 1;
  from: { handle: Handle; name: string };
  /** Routing (reply → the sender's inbox); never rendered. */
  teamId: TeamId;
  fromId: UserId;
  /** The handoff Ayo this link renders; replies thread to it. */
  ayoId?: AyoId;
  teamName: string;
  blocker: string;
  note?: string;
  context?: AyoContext;
  /** Present iff the sender opted to embed it — enables the 1-step join CTA. */
  joinCode?: string;
  /** The embedded join code's own expiry (codes rotate/expire independently of
   *  the link) — lets the page flag a stale code instead of a dead command.
   *  null = the code doesn't expire; absent = no code embedded. */
  joinCodeExpiresAt?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface MembersResponse {
  members: MemberPresence[];
}

// ── Inbound webhooks ("one curl → Ayo") ──────────────────────────────────────

/** `POST /v1/teams/:id/hooks` — mint a revocable inbound webhook (member only). */
export interface CreateWebhookRequest {
  /** Source name shown on inbound pings, e.g. "ci", "github". */
  label: string;
  /** Default recipient handle; omit to broadcast to the team. */
  to?: Handle;
  /** Mint a GitHub webhook: HMAC-verified, POSTed to /v1/gh/<token>, and routed
   *  by event (review requests, @mentions, review submissions) rather than `to`.
   *  The response carries a one-time `secret` to paste into GitHub. */
  github?: boolean;
}

/** A minted/listed webhook. `token` is a bearer secret. On CREATE the creator
 *  always gets it. On LIST, only the creator sees the token/url of their own
 *  hooks — for others' hooks `token`/`url` are empty strings (metadata only), so
 *  a member can't lift a teammate's URL and spoof pings as them. */
export interface WebhookInfo {
  token: string;
  /** The full curl-able URL: `<relay>/v1/hooks/<token>` (empty if not yours). */
  url: string;
  label: string;
  to?: Handle;
  createdAt: string;
  /** Handle of the member who created the hook (present on LIST). */
  createdBy?: Handle;
  /** "github" for a GitHub webhook (routes by event); absent = generic. */
  kind?: "github";
  /** The HMAC secret to paste into GitHub — returned ONCE on create for a github
   *  hook, never on list. */
  secret?: string;
}

export type CreateWebhookResponse = WebhookInfo;
export interface ListWebhooksResponse {
  hooks: WebhookInfo[];
}

/** Body a caller POSTs to `/v1/hooks/:token`. Only `text` is required (one curl).
 *  `urgency` is capped at "normal" server-side — inbound automation never breaks
 *  through a recipient's heads-down/dnd focus (suppression is first-class). */
export interface WebhookPingRequest {
  text: string;
  /** Override the hook's default recipient(s); `["*"]` broadcasts. */
  to?: Recipients;
  /** "low" | "normal" only; "urgent" is coerced to "normal". */
  urgency?: Urgency;
  /** Optional headline shown above the text. */
  title?: string;
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
  /** Required semantics when kind === "ask" (options optional). */
  ask?: AskMeta;
  expiresAt?: string | null;
}

// ── Asks (blocking agent questions; see AskMeta/AskAnswer in message.ts) ─────

/** Bounds for an ask's suggested options (rendered as ready-made commands). */
export const MAX_ASK_OPTIONS = 8;
export const MAX_ASK_OPTION_LENGTH = 80;

/** `POST /v1/ayo/:id/answer` — answer an ask addressed to you. */
export interface AnswerAskRequest {
  answer: string;
}

/** `GET /v1/ayo/:id/answer` — poll an ask's state (the asking agent long-polls
 *  this until answered or its own deadline passes). */
export interface AskStateResponse {
  answered: boolean;
  /** Present iff answered. */
  answer?: AskAnswer;
  /** True once the ask's expiresAt has passed unanswered. */
  expired: boolean;
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
