/**
 * The Ayo message object and its delivery-state machine. See ADR 0002.
 */

import type { AyoId, TeamId, UserId } from "./ids.js";

export type Urgency = "low" | "normal" | "urgent";
export type AyoKind = "ping" | "handoff";

/** A handle is a per-team display name; defaults to GitHub login, aliasable. */
export type Handle = string;

/** `["*"]` addresses the whole team. */
export type Recipients = Handle[];

export interface Sender {
  id: UserId;
  handle: Handle;
  name: string;
}

/** Built-in preset sound ids (shipped as WAV in the CLI's assets/sounds/). */
export const SOUND_PRESETS = ["ping", "chime", "boop", "coin", "pluck", "airhorn", "knock"] as const;
export type SoundPreset = (typeof SOUND_PRESETS)[number];

/**
 * The notification sound a SENDER chose; plays on the RECIPIENT's machine — a
 * "signature sound" so you learn who's pinging by ear. The relay stamps it onto
 * each Ayo from the sender's profile (snapshot at send time).
 */
export type AyoSound =
  | { kind: "preset"; id: string } // a SOUND_PRESETS id, played from the bundled set
  | { kind: "custom"; url: string; hash: string }; // R2-backed clip (Phase A2)

/**
 * Opaque to the relay — the CLI captures it, the relay stores & forwards it.
 * Privacy boundary: explicit packets only, never full session transcripts.
 */
export interface AyoContext {
  repo?: string;
  branch?: string;
  cwd?: string;
  commit?: string;
  changedFiles?: string[];
  diffStat?: string;
  /** Full diff only when `--with-diff`. Capped at 64 KB by the CLI. */
  diff?: string | null;
  /** Set by the CLI when `diff` was truncated to fit the cap. */
  diffTruncated?: boolean;
  links?: string[];
  /** Optional agent-generated handoff summary. */
  note?: string;
}

export interface Ayo {
  id: AyoId;
  teamId: TeamId;
  from: Sender;
  to: Recipients;
  kind: AyoKind;
  body: string;
  urgency: Urgency;
  context?: AyoContext;
  /** An `ayo_` id, for minimal single-level threading. */
  replyTo?: AyoId | null;
  /** ISO timestamp; null = never expires. */
  expiresAt?: string | null;
  /** The sender's chosen sound, stamped by the relay. null/absent = recipient default. */
  sound?: AyoSound | null;
  /** ISO timestamp. */
  createdAt: string;
}

/** Max size of a serialized `context.diff`, in bytes. ADR 0002. */
export const MAX_DIFF_BYTES = 64 * 1024;

/**
 * Per-recipient delivery state. Monotonic — state only advances.
 *
 *  sent      relay accepted it; recipient may be offline
 *  delivered reached the recipient's daemon (live or replayed)
 *  notified  daemon actually fired an OS notification / bell
 *  read      a HUMAN explicitly viewed it (inbox / toast click / `ayo open`)
 *  resolved  loop closed
 *
 * Hard rule (ADR 0002): a toast firing is `notified`, never `read`. Only
 * explicit human action over HTTP advances to `read`.
 */
export type DeliveryState =
  | "sent"
  // Recipient is heads-down/dnd: accepted + in their inbox, but deliberately NOT
  // pushed as a live toast (and excluded from reconnect replay, so it never
  // ambushes them later). Distinct from "sent" (offline → buzz on reconnect) and
  // "notified" (a toast actually fired). Surfaces when they pull inbox / agent hook.
  | "held"
  | "delivered"
  | "notified"
  | "read"
  | "resolved";

export const DELIVERY_ORDER: readonly DeliveryState[] = [
  "sent",
  "held",
  "delivered",
  "notified",
  "read",
  "resolved",
] as const;

/** True if `next` is a forward (or equal) transition from `prev`. */
export function canAdvance(prev: DeliveryState, next: DeliveryState): boolean {
  return DELIVERY_ORDER.indexOf(next) >= DELIVERY_ORDER.indexOf(prev);
}

export interface Delivery {
  ayoId: AyoId;
  userId: UserId;
  state: DeliveryState;
  /** ISO timestamp of the last state change. */
  at: string;
}

/** Machine-level facts the daemon may report over the socket. */
export type AckState = Extract<DeliveryState, "delivered" | "notified">;
