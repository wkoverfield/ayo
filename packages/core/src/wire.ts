/**
 * WebSocket wire frames between the daemon (`ayod`) and a team Durable Object.
 *
 * Direction is almost entirely server→client. Client→server is limited to
 * heartbeat + receipt acks (machine-level facts). Semantic mutations
 * (read/resolve/status) go over HTTP. See docs/protocol.md.
 */

import type { AckState, Ayo, DeliveryState, Handle } from "./message.js";
import type { AyoId } from "./ids.js";

/**
 * Wire protocol version. Bumped on a breaking change to the frames below. The
 * server stamps it on the ready frame so a client can warn on mismatch; there's
 * no negotiation yet (the field is cheap insurance for when old CLIs are in the
 * wild after a relay redeploy — graceful handling can come later).
 */
export const PROTOCOL_VERSION = 1;

export type PresenceStatus = "active" | "heads-down" | "away" | "dnd";

export interface MemberPresence {
  handle: Handle;
  online: boolean;
  status: PresenceStatus;
  statusText: string | null;
}

// ── Server → client ───────────────────────────────────────────────────────

export interface ReadyFrame {
  t: "ready";
  /** Wire protocol the relay is speaking (see PROTOCOL_VERSION). */
  protocol: number;
  /** Last ayo id the server knows this client has; null if none. */
  cursor: AyoId | null;
  unread: number;
  members: MemberPresence[];
}

export interface AyoFrame {
  t: "ayo";
  ayo: Ayo;
}

export interface AyoUpdateFrame {
  t: "ayo:update";
  ayoId: AyoId;
  state: DeliveryState;
  /** Handle of whoever caused the change (e.g. the reader). */
  by: Handle;
  at: string;
}

export interface PresenceFrame {
  t: "presence";
  handle: Handle;
  online: boolean;
  status: PresenceStatus;
  statusText: string | null;
}

export interface TeamFrame {
  t: "team";
  event: "member_joined" | "member_left";
  handle: Handle;
}

export type ServerFrame =
  | ReadyFrame
  | AyoFrame
  | AyoUpdateFrame
  | PresenceFrame
  | TeamFrame;

// ── Client → server (the only ones) ────────────────────────────────────────

/** Daemon confirms machine-level receipt. Advances delivered → notified. */
export interface AckFrame {
  t: "ack";
  ayoId: AyoId;
  state: AckState;
}

export type ClientFrame = AckFrame;
