/**
 * TeamHub — one Durable Object per team. The realtime fanout hub: holds member
 * WebSockets (with hibernation), persists messages + per-recipient delivery
 * state + presence, and fans Ayos out to live sockets. See ADR 0002.
 *
 * Identity is always taken from the `x-ayo-*` headers injected by the Worker,
 * never from the client.
 *
 * Storage is the DO key-value store for this scaffold; ADR 0002 targets
 * SQLite-in-DO for production (messages/deliveries/members tables).
 */

import type {
  AckFrame,
  Ayo,
  AyoSound,
  Delivery,
  DeliveryState,
  FeedResponse,
  HackathonResponse,
  HackathonState,
  Handle,
  InboxResponse,
  MemberPresence,
  MembersResponse,
  PresenceStatus,
  SendAyoRequest,
  SendAyoResponse,
  ServerFrame,
  SetStatusRequest,
  StartHackathonRequest,
  TimelineResponse,
  UserId,
} from "@ayo-dev/core";
import { canAdvance, newAyoId } from "@ayo-dev/core";
import { apiError, type Env } from "./env.js";

/** Parse the `x-ayo-sound` header the Worker stamps from the sender's profile.
 *  Trusted shape (the Worker validated it on set), but parse defensively. */
function parseSound(header: string | null): AyoSound | null {
  if (!header) return null;
  try {
    const s = JSON.parse(header) as AyoSound;
    if (s?.kind === "preset" && typeof s.id === "string") return s;
    if (s?.kind === "custom" && typeof s.url === "string" && typeof s.hash === "string") return s;
  } catch {
    /* ignore malformed */
  }
  return null;
}

interface Member {
  userId: UserId;
  handle: Handle;
  status: PresenceStatus;
  statusText: string | null;
}

interface SocketMeta {
  userId: UserId;
  handle: Handle;
}

/** Stored hackathon state (internal — adds teamId + fired milestones to the
 *  public HackathonState). */
interface HackathonRecord extends HackathonState {
  teamId: string;
  fired: number[]; // minutes-before-end milestones already nudged
}

/** Minutes before the deadline that fire a team nudge. 0 = time's up. */
const MILESTONES = [60, 30, 10, 0];

function publicHackathon(r: HackathonRecord): HackathonState {
  return { name: r.name, endsAt: r.endsAt, startedAt: r.startedAt };
}

function milestoneMessage(minsBefore: number): string {
  switch (minsBefore) {
    case 60:
      return "⏰ T-minus 1 hour — what's not merged yet?";
    case 30:
      return "⏰ 30 minutes left — start wrapping up.";
    case 10:
      return "⏰ 10 minutes — lock it in.";
    case 0:
      return "⏰ Time's up! Hands off keyboards 🎉";
    default:
      return `⏰ ${minsBefore} minutes left.`;
  }
}

export class TeamHub implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    // Reject anything that didn't come through the Worker (the only identity
    // verifier). The `x-ayo-*` identity headers are trusted ONLY because of this.
    // Fail CLOSED: if INTERNAL_SECRET is unset (a misconfigured deploy), reject
    // everything rather than trusting unauthenticated, spoofable identity headers.
    if (!this.env.INTERNAL_SECRET || req.headers.get("x-ayo-internal") !== this.env.INTERNAL_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const userId = req.headers.get("x-ayo-user") as UserId;
    const handle = req.headers.get("x-ayo-handle") ?? "";
    await this.rememberMember(userId, handle);

    // rememberMember (above) already added the caller to the roster — this lets
    // the Worker register a member into the DO on join, before they've otherwise
    // interacted, so broadcasts/board/nudges see them immediately.
    if (path === "/internal/register") return Response.json({ ok: true });
    if (path === "/internal/stream") return this.handleStream(userId, handle);
    if (path === "/internal/ayo" && req.method === "POST") return this.handleSend(req, userId, handle);
    if (path === "/internal/inbox" && req.method === "GET") return this.handleInbox(url, userId, handle);
    if (path === "/internal/members" && req.method === "GET") return this.handleMembers();
    if (path === "/internal/feed" && req.method === "GET") return this.handleFeed(url);
    if (path === "/internal/status" && req.method === "PUT") return this.handleStatus(req, userId, handle);
    if (path === "/internal/timeline" && req.method === "GET") return this.handleTimeline();
    if (path === "/internal/hackathon") {
      if (req.method === "GET") return this.handleHackathonGet();
      if (req.method === "PUT") return this.handleHackathonStart(req);
      if (req.method === "DELETE") return this.handleHackathonEnd();
    }

    const stateMatch = path.match(/^\/internal\/ayo\/(ayo_[^/]+)\/(read|resolve)$/);
    if (stateMatch && req.method === "POST") {
      const next: DeliveryState = stateMatch[2] === "read" ? "read" : "resolved";
      return this.handleStateChange(stateMatch[1]!, userId, handle, next);
    }

    return new Response("not found", { status: 404 });
  }

  // ── WebSocket (hibernation) ───────────────────────────────────────────────

  private async handleStream(userId: UserId, handle: Handle): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ userId, handle } satisfies SocketMeta);
    this.ctx.acceptWebSocket(server);
    await this.broadcastPresence(userId, true);

    // `ready`: cursor, unread count, and the current roster.
    const ready: ServerFrame = {
      t: "ready",
      cursor: await this.ctx.storage.get<string>(`cursor:${userId}`) as never ?? null,
      unread: await this.countUnread(userId, handle),
      members: await this.roster(),
    };
    server.send(JSON.stringify(ready));

    // Catch-up: replay only Ayos the machine hasn't confirmed buzzed yet
    // (sent/delivered, NOT notified/read/resolved) — so an already-notified
    // message isn't re-pushed on every reconnect. The daemon's id-dedup is a
    // belt-and-suspenders backstop, not load-bearing. (ADR 0002 reconnect flow.)
    const missed = await this.unbuzzedFor(userId, handle);
    for (const ayo of missed) server.send(JSON.stringify({ t: "ayo", ayo } satisfies ServerFrame));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let frame: AckFrame;
    try {
      frame = JSON.parse(raw) as AckFrame;
    } catch {
      return;
    }
    if (frame.t !== "ack") return; // socket only carries acks (ADR 0002)
    // The AckState type is compile-time only; the wire is untrusted. A socket
    // may ONLY advance machine-level state — never forge `read`/`resolved`,
    // which require an explicit human action over HTTP (ADR 0002 hard rule).
    if (frame.state !== "delivered" && frame.state !== "notified") return;
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    await this.advance(frame.ayoId, meta.userId, meta.handle, frame.state);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    // Offline only if this user has no other live sockets.
    const stillOnline = this.socketsForUser(meta.userId).some((s) => s !== ws);
    if (!stillOnline) await this.broadcastPresence(meta.userId, false);
  }

  // ── Send + fanout ─────────────────────────────────────────────────────────

  private async handleSend(req: Request, userId: UserId, handle: Handle): Promise<Response> {
    const input = (await req.json().catch(() => null)) as SendAyoRequest | null;
    if (!input || typeof input.body !== "string" || input.body.trim() === "") {
      return apiError("bad_request", "An Ayo needs a non-empty body.");
    }
    if (input.body.length > 4096) {
      return apiError("payload_too_large", "Ayo body exceeds 4 KB.");
    }
    if (!Array.isArray(input.to) || input.to.length === 0) {
      return apiError("unknown_recipient", "An Ayo needs at least one recipient.");
    }
    // Bound the attached git context so one Ayo can't bloat DO storage / fanout.
    if (input.context && JSON.stringify(input.context).length > 64 * 1024) {
      return apiError("payload_too_large", "Ayo context exceeds 64 KB.");
    }
    const teamId = req.headers.get("x-ayo-team") as Ayo["teamId"];
    const ayo: Ayo = {
      id: newAyoId(),
      teamId,
      from: { id: userId, handle, name: handle },
      to: input.to,
      kind: input.kind ?? "ping",
      body: input.body,
      urgency: input.urgency ?? "normal",
      context: input.context,
      replyTo: input.replyTo ?? null,
      sound: parseSound(req.headers.get("x-ayo-sound")), // sender's signature sound, stamped by the Worker
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(`msg:${ayo.id}`, ayo);
    // Index so the flat `POST /v1/ayo/:id/{read,resolve}` path can find the team.
    await this.env.AYO_KV.put(`ayoteam:${ayo.id}`, teamId, { expirationTtl: 60 * 60 * 24 * 30 });

    const recipients = await this.resolveRecipients(input.to, userId);
    const deliveredTo: Handle[] = [];
    const queuedFor: Handle[] = [];

    for (const m of recipients) {
      await this.setDelivery(ayo.id, m.userId, "sent");
      const sockets = this.socketsForUser(m.userId);
      if (sockets.length > 0) {
        const frame: ServerFrame = { t: "ayo", ayo };
        for (const s of sockets) s.send(JSON.stringify(frame));
        deliveredTo.push(m.handle);
      } else {
        queuedFor.push(m.handle);
      }
    }

    const res: SendAyoResponse = { id: ayo.id, deliveredTo, queuedFor };
    return Response.json(res);
  }

  /** `["*"]` = everyone but the sender; otherwise the named handles. */
  private async resolveRecipients(to: Handle[], senderId: UserId): Promise<Member[]> {
    const members = await this.allMembers();
    if (to.includes("*")) return members.filter((m) => m.userId !== senderId);
    const want = new Set(to);
    return members.filter((m) => want.has(m.handle) && m.userId !== senderId);
  }

  // ── Inbox + state changes ─────────────────────────────────────────────────

  private async handleInbox(url: URL, userId: UserId, handle: Handle): Promise<Response> {
    const since = url.searchParams.get("since");
    const unreadOnly = url.searchParams.get("unreadOnly") === "1";
    const all = await this.ctx.storage.list<Ayo>({ prefix: "msg:" });

    const ayos: Ayo[] = [];
    for (const ayo of all.values()) {
      // Your inbox is what was sent TO you, not what you sent (consistent with
      // unreadFor / the unread count).
      if (!this.addressedTo(ayo, handle) || ayo.from.id === userId) continue;
      if (since && ayo.id <= (since as Ayo["id"])) continue;
      if (unreadOnly) {
        const d = await this.getDelivery(ayo.id, userId);
        if (d && (d.state === "read" || d.state === "resolved")) continue;
      }
      ayos.push(ayo);
    }
    ayos.sort((a, b) => (a.id < b.id ? -1 : 1));
    const cursor = ayos.length ? ayos[ayos.length - 1]!.id : null;
    if (cursor) await this.ctx.storage.put(`cursor:${userId}`, cursor);

    const body: InboxResponse = { ayos, cursor };
    return Response.json(body);
  }

  private async handleStateChange(
    ayoId: string,
    userId: UserId,
    handle: Handle,
    next: DeliveryState,
  ): Promise<Response> {
    await this.advance(ayoId as Ayo["id"], userId, handle, next);
    return Response.json({ ok: true });
  }

  /** Advance a recipient's delivery state and notify the sender if relevant. */
  private async advance(
    ayoId: Ayo["id"],
    userId: UserId,
    handle: Handle,
    next: DeliveryState,
  ): Promise<void> {
    const current = (await this.getDelivery(ayoId, userId))?.state ?? "sent";
    if (!canAdvance(current, next)) return;
    await this.setDelivery(ayoId, userId, next);

    const ayo = await this.ctx.storage.get<Ayo>(`msg:${ayoId}`);
    if (!ayo) return;
    const frame: ServerFrame = { t: "ayo:update", ayoId, state: next, by: handle, at: new Date().toISOString() };
    for (const s of this.socketsForUser(ayo.from.id)) s.send(JSON.stringify(frame));
  }

  // ── Presence / members ────────────────────────────────────────────────────

  private async handleMembers(): Promise<Response> {
    const body: MembersResponse = { members: await this.roster() };
    return Response.json(body);
  }

  /** Recent team-relevant activity for the shared board (newest first). Shows
   *  broadcasts and handoffs only; direct 1:1 pings stay private to the
   *  recipient's inbox and never appear on the team board. */
  private async handleFeed(url: URL): Promise<Response> {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    // Over-fetch a bounded window (newest-first, no full-history scan / OOM) and
    // filter. Bound = a DM-heavy team can under-return (a broadcast older than
    // `scan` messages back won't surface) — acceptable; the board is "recent".
    const scan = Math.min(limit * 5, 200);
    const map = await this.ctx.storage.list<Ayo>({ prefix: "msg:", reverse: true, limit: scan });
    // Team-visible = broadcasts (to ["*"]) and ALL handoffs (a directed handoff
    // is intentionally public so any teammate can pick it up). Direct 1:1 pings
    // stay private to the recipient's inbox unless broadcast.
    const recent = [...map.values()]
      .filter((a) => a.to.includes("*") || a.kind === "handoff")
      .slice(0, limit);
    const items = await Promise.all(
      recent.map(async (ayo) => {
        // Resolved iff every recipient that got a delivery row has resolved it.
        // No delivery rows yet (e.g. a just-sent Ayo) => not resolved, which is
        // the right default: an un-acknowledged handoff shows as OPEN, not closed.
        const dels = await this.ctx.storage.list<Delivery>({ prefix: `delivery:${ayo.id}:` });
        const states = [...dels.values()].map((d) => d.state);
        const resolved = states.length > 0 && states.every((s) => s === "resolved");
        return { ayo, resolved };
      }),
    );
    return Response.json({ items } satisfies FeedResponse);
  }

  // ── Hackathon mode ─────────────────────────────────────────────────────────

  private async handleHackathonGet(): Promise<Response> {
    const rec = await this.ctx.storage.get<HackathonRecord>("hackathon");
    return Response.json({ hackathon: rec ? publicHackathon(rec) : null } satisfies HackathonResponse);
  }

  private async handleHackathonStart(req: Request): Promise<Response> {
    const input = (await req.json().catch(() => null)) as StartHackathonRequest | null;
    const endsMs = input ? new Date(input.endsAt).getTime() : NaN;
    if (!input?.name || typeof input.name !== "string" || input.name.length > 100 || !Number.isFinite(endsMs) || endsMs <= Date.now()) {
      return apiError("bad_request", "A hackathon needs a name (≤100 chars) and a future endsAt.");
    }
    if (endsMs - Date.now() > 24 * 60 * 60 * 1000) {
      return apiError("bad_request", "A hackathon can't run longer than 24 hours.");
    }
    const teamId = req.headers.get("x-ayo-team") as string;
    // Milestones already in the past at start are pre-marked fired — don't nudge
    // "1 hour left" when the sprint started with only minutes on the clock.
    const fired = MILESTONES.filter((m) => endsMs - m * 60_000 <= Date.now());
    const rec: HackathonRecord = { name: input.name, endsAt: input.endsAt, startedAt: new Date().toISOString(), teamId, fired };
    await this.ctx.storage.put("hackathon", rec);
    await this.scheduleNextMilestone(rec);
    return Response.json({ hackathon: publicHackathon(rec) } satisfies HackathonResponse);
  }

  private async handleHackathonEnd(): Promise<Response> {
    await this.ctx.storage.delete("hackathon");
    await this.ctx.storage.deleteAlarm();
    return Response.json({ hackathon: null } satisfies HackathonResponse);
  }

  /** Full team-relevant event log, oldest-first, for `ayo hackathon export`. */
  private async handleTimeline(): Promise<Response> {
    const rec = await this.ctx.storage.get<HackathonRecord>("hackathon");
    // Scope to the current hackathon's window so a prior sprint's events don't
    // bleed in; if no hackathon is running, the full team-relevant log.
    const since = rec ? new Date(rec.startedAt).getTime() : 0;
    const map = await this.ctx.storage.list<Ayo>({ prefix: "msg:", reverse: true, limit: 1000 });
    const events = [...map.values()]
      .filter((a) => (a.to.includes("*") || a.kind === "handoff") && new Date(a.createdAt).getTime() >= since)
      .reverse(); // oldest-first for a readable timeline
    return Response.json({ hackathon: rec ? publicHackathon(rec) : null, events } satisfies TimelineResponse);
  }

  /** Schedule the DO alarm for the next un-fired milestone (if any remain). */
  private async scheduleNextMilestone(rec: HackathonRecord): Promise<void> {
    const ends = new Date(rec.endsAt).getTime();
    const now = Date.now();
    const next = MILESTONES.filter((m) => !rec.fired.includes(m))
      .map((m) => ends - m * 60_000)
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (next != null) await this.ctx.storage.setAlarm(next);
  }

  /** Fired by the runtime at a scheduled milestone — broadcast the T-minus nudge. */
  async alarm(): Promise<void> {
    const rec = await this.ctx.storage.get<HackathonRecord>("hackathon");
    if (!rec) return;
    const ends = new Date(rec.endsAt).getTime();
    const now = Date.now();
    const due = MILESTONES.filter((m) => !rec.fired.includes(m) && now >= ends - m * 60_000).sort((a, b) => b - a);
    for (const m of due) {
      await this.broadcastSystem(milestoneMessage(m), rec.teamId);
      rec.fired.push(m);
      // Persist after EACH milestone: alarms are at-least-once, so a mid-loop
      // failure + retry must not re-broadcast a nudge we already sent.
      await this.ctx.storage.put("hackathon", rec);
    }
    await this.scheduleNextMilestone(rec);
  }

  /** A system Ayo from "ayo" to the whole team (milestone nudges). */
  private async broadcastSystem(body: string, teamId: string): Promise<void> {
    const ayo: Ayo = {
      id: newAyoId(),
      teamId: teamId as Ayo["teamId"],
      from: { id: "user_system" as UserId, handle: "ayo", name: "Ayo" },
      to: ["*"],
      kind: "ping",
      body,
      urgency: "urgent",
      replyTo: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(`msg:${ayo.id}`, ayo);
    await this.env.AYO_KV.put(`ayoteam:${ayo.id}`, teamId, { expirationTtl: 60 * 60 * 24 * 30 });
    for (const m of await this.allMembers()) {
      await this.setDelivery(ayo.id, m.userId, "sent");
      const frame: ServerFrame = { t: "ayo", ayo };
      for (const s of this.socketsForUser(m.userId)) s.send(JSON.stringify(frame));
    }
  }

  private async handleStatus(req: Request, userId: UserId, handle: Handle): Promise<Response> {
    const input = (await req.json().catch(() => null)) as SetStatusRequest | null;
    const VALID_STATUS = ["active", "heads-down", "away", "dnd"];
    if (!input || !VALID_STATUS.includes(input.status)) {
      return apiError("bad_request", "status must be one of: active, heads-down, away, dnd.");
    }
    if (input.statusText != null && (typeof input.statusText !== "string" || input.statusText.length > 200)) {
      return apiError("bad_request", "statusText must be a string up to 200 characters.");
    }
    const member = await this.getMember(userId);
    if (member) {
      member.status = input.status;
      member.statusText = input.statusText ?? null;
      await this.ctx.storage.put(`member:${userId}`, member);
    }
    await this.broadcast({
      t: "presence",
      handle,
      online: this.socketsForUser(userId).length > 0,
      status: input.status,
      statusText: input.statusText ?? null,
    });
    return Response.json({ ok: true });
  }

  private async broadcastPresence(userId: UserId, online: boolean): Promise<void> {
    const m = await this.getMember(userId);
    if (!m) return;
    await this.broadcast({
      t: "presence",
      handle: m.handle,
      online,
      status: m.status,
      statusText: m.statusText,
    });
  }

  private async roster(): Promise<MemberPresence[]> {
    const members = await this.allMembers();
    return members.map((m) => ({
      handle: m.handle,
      online: this.socketsForUser(m.userId).length > 0,
      status: m.status,
      statusText: m.statusText,
    }));
  }

  // ── Storage + socket helpers ──────────────────────────────────────────────

  private socketsForUser(userId: UserId): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => {
      const meta = s.deserializeAttachment() as SocketMeta | null;
      return meta?.userId === userId;
    });
  }

  private broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const s of this.ctx.getWebSockets()) s.send(payload);
  }

  private addressedTo(ayo: Ayo, handle: Handle): boolean {
    return ayo.to.includes("*") || ayo.to.includes(handle);
  }

  private async rememberMember(userId: UserId, handle: Handle): Promise<void> {
    // Never create or touch a member with a blank handle (e.g. a forwarded
    // request missing x-ayo-handle) — that would put a nameless row on the board.
    if (!userId || !handle) return;
    const existing = await this.getMember(userId);
    if (existing && existing.handle === handle) return;
    const member: Member = existing ?? { userId, handle, status: "active", statusText: null };
    member.handle = handle || member.handle;
    await this.ctx.storage.put(`member:${userId}`, member);
  }

  private async getMember(userId: UserId): Promise<Member | undefined> {
    return this.ctx.storage.get<Member>(`member:${userId}`);
  }

  private async allMembers(): Promise<Member[]> {
    const map = await this.ctx.storage.list<Member>({ prefix: "member:" });
    return [...map.values()];
  }

  private async getDelivery(ayoId: Ayo["id"], userId: UserId): Promise<Delivery | undefined> {
    return this.ctx.storage.get<Delivery>(`delivery:${ayoId}:${userId}`);
  }

  private async setDelivery(ayoId: Ayo["id"], userId: UserId, state: DeliveryState): Promise<void> {
    const d: Delivery = { ayoId, userId, state, at: new Date().toISOString() };
    await this.ctx.storage.put(`delivery:${ayoId}:${userId}`, d);
  }

  /** Ayos addressed to this user matching `keep(state)`, sorted oldest-first.
   *  Excludes the user's own sent messages (consistent with handleInbox). */
  private async filterFor(
    userId: UserId,
    handle: Handle,
    keep: (state: DeliveryState | undefined) => boolean,
  ): Promise<Ayo[]> {
    const all = await this.ctx.storage.list<Ayo>({ prefix: "msg:" });
    const out: Ayo[] = [];
    for (const ayo of all.values()) {
      if (!this.addressedTo(ayo, handle) || ayo.from.id === userId) continue;
      if (keep((await this.getDelivery(ayo.id, userId))?.state)) out.push(ayo);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Unread = not yet read/resolved. Used for the unread count. */
  private unreadFor(userId: UserId, handle: Handle): Promise<Ayo[]> {
    return this.filterFor(userId, handle, (s) => s !== "read" && s !== "resolved");
  }

  /** Not yet machine-confirmed-buzzed (sent/delivered). Used for reconnect replay. */
  private unbuzzedFor(userId: UserId, handle: Handle): Promise<Ayo[]> {
    return this.filterFor(userId, handle, (s) => s === undefined || s === "sent" || s === "delivered");
  }

  private async countUnread(userId: UserId, handle: Handle): Promise<number> {
    return (await this.unreadFor(userId, handle)).length;
  }
}
