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
  Delivery,
  DeliveryState,
  Handle,
  InboxResponse,
  MemberPresence,
  MembersResponse,
  PresenceStatus,
  SendAyoRequest,
  SendAyoResponse,
  ServerFrame,
  SetStatusRequest,
  UserId,
} from "@ayo-dev/core";
import { canAdvance, newAyoId } from "@ayo-dev/core";
import { apiError, type Env } from "./env.js";

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

export class TeamHub implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    // Reject anything that didn't come through the Worker (the only identity
    // verifier). The `x-ayo-*` identity headers are trusted ONLY because of this.
    if (this.env.INTERNAL_SECRET && req.headers.get("x-ayo-internal") !== this.env.INTERNAL_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const userId = req.headers.get("x-ayo-user") as UserId;
    const handle = req.headers.get("x-ayo-handle") ?? "";
    await this.rememberMember(userId, handle);

    if (path === "/internal/stream") return this.handleStream(userId, handle);
    if (path === "/internal/ayo" && req.method === "POST") return this.handleSend(req, userId, handle);
    if (path === "/internal/inbox" && req.method === "GET") return this.handleInbox(url, userId, handle);
    if (path === "/internal/members" && req.method === "GET") return this.handleMembers();
    if (path === "/internal/status" && req.method === "PUT") return this.handleStatus(req, userId, handle);

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

    // Catch-up: replay still-unread Ayos this user may have missed while their
    // daemon was offline. At-least-once — the daemon dedupes by id and won't
    // re-notify ids already in its local inbox. (ADR 0002 reconnect flow.)
    const missed = await this.unreadFor(userId, handle);
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
    if (!Array.isArray(input.to) || input.to.length === 0) {
      return apiError("unknown_recipient", "An Ayo needs at least one recipient.");
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
      if (!this.addressedTo(ayo, handle)) continue;
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

  private async handleStatus(req: Request, userId: UserId, handle: Handle): Promise<Response> {
    const input = (await req.json()) as SetStatusRequest;
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
    if (!userId) return;
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

  /** Still-unread Ayos addressed to this user, sorted oldest-first. */
  private async unreadFor(userId: UserId, handle: Handle): Promise<Ayo[]> {
    const all = await this.ctx.storage.list<Ayo>({ prefix: "msg:" });
    const out: Ayo[] = [];
    for (const ayo of all.values()) {
      if (!this.addressedTo(ayo, handle) || ayo.from.id === userId) continue;
      const d = await this.getDelivery(ayo.id, userId);
      if (!d || (d.state !== "read" && d.state !== "resolved")) out.push(ayo);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  private async countUnread(userId: UserId, handle: Handle): Promise<number> {
    return (await this.unreadFor(userId, handle)).length;
  }
}
