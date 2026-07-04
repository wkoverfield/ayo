/**
 * Ayo relay Worker. Authenticates requests, handles directory CRUD, and
 * forwards team-scoped traffic to the per-team TeamHub Durable Object.
 *
 * The Worker is the only place identity is verified. It injects the verified
 * userId/handle into forwarded requests via `x-ayo-*` headers; the DO never
 * trusts a client-supplied identity (ADR 0002).
 */

import type {
  AyoSound,
  CreateTeamRequest,
  CreateTeamResponse,
  DevicePollResponse,
  DeviceStartResponse,
  JoinTeamRequest,
  JoinTeamResponse,
  InviteResponse,
  RotateCodeRequest,
  RotateCodeResponse,
  CreateHandoffLinkRequest,
  CreateHandoffLinkResponse,
  HandoffShare,
  CreateWebhookRequest,
  CreateWebhookResponse,
  ListWebhooksResponse,
  WebhookInfo,
  WebhookPingRequest,
  SendAyoRequest,
  Recipients,
  MeResponse,
  PublicUser,
} from "@ayo-dev/core";
import {
  newUserId,
  SOUND_PRESETS,
  MAX_TEAM_SIZE,
  HANDOFF_LINK_TTL_HOURS,
  HANDOFF_LINK_MAX_TTL_HOURS,
  MAX_HANDOFF_SHARE_BYTES,
  MAX_LINK_REPLY_LENGTH,
  MAX_LINK_REPLY_NAME_LENGTH,
} from "@ayo-dev/core";
import { apiError, json, type Env } from "./env.js";
import { overRateLimit, clientIp } from "./rate-limit.js";
import {
  authenticate,
  devStubEnabled,
  findOrCreateGithubUser,
  issueSession,
  putUser,
} from "./auth.js";
import { githubDeviceStart, githubDevicePoll, githubGetUser } from "./github.js";
import { validateWav } from "./sounds.js";
import {
  addMember,
  countMembers,
  createTeam,
  freshJoinCode,
  getMembership,
  getTeam,
  rotateJoinCode,
  teamByJoinCode,
  teamForAyo,
  teamsForUser,
} from "./directory.js";
import { getHandoffShare, putHandoffShare } from "./handoff.js";
import { renderHandoffPage, renderExpiredPage, renderReplySentPage, renderReplyErrorPage } from "./handoff-page.js";
import { createWebhook, deleteWebhook, getWebhook, listWebhooks } from "./hooks.js";
import { verifyGithubSignature, mapGithubEvent } from "./github-webhook.js";
import { urlSafeToken } from "./token.js";

export { TeamHub } from "./team-do.js";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── Auth (no session required) ──────────────────────────────────────
      // NOTE: `await` so a handler rejection is caught by the catch below
      // (returning a bare promise would let it escape to a raw 500).
      if (path === "/v1/auth/device" && req.method === "POST") {
        // Starting a device flow writes KV; cap per IP so it can't be spammed.
        if (await overRateLimit(env, `dev-start:${clientIp(req)}`, 10, 60)) {
          return apiError("rate_limited", "Too many login attempts — wait a minute and try again.");
        }
        return await handleDeviceStart(req, env);
      }
      if (path === "/v1/auth/device/poll" && req.method === "POST") {
        // A legit client polls ~12×/min; this is just a runaway cap (NAT-friendly).
        if (await overRateLimit(env, `dev-poll:${clientIp(req)}`, 120, 60)) {
          return apiError("rate_limited", "Polling too fast — wait a minute.");
        }
        return await handleDevicePoll(req, env);
      }

      // ── Public handoff share page (no session — the "Loom mechanic") ────
      // Renders a handoff's context to a non-user, with an install→join CTA.
      const shareMatch = path.match(/^\/h\/([A-Za-z0-9_-]{16,64})$/);
      if (shareMatch && req.method === "GET") {
        const share = await getHandoffShare(env, shareMatch[1]!);
        const html = share ? renderHandoffPage(share, shareMatch[1]!) : renderExpiredPage();
        return sharePage(html, share ? 200 : 404, !!share);
      }

      // ── Anonymous reply from a handoff page (no session — the conversion
      //    moment: they reply FIRST, the install ask comes after) ───────────
      const replyMatch = path.match(/^\/h\/([A-Za-z0-9_-]{16,64})\/reply$/);
      if (replyMatch && req.method === "POST") {
        // Public write: IP cap FIRST (pre-KV), then per-token.
        if (await overRateLimit(env, `reply-ip:${clientIp(req)}`, 10, 60)) {
          return apiError("rate_limited", "Too many replies from this address — give it a minute.");
        }
        const token = replyMatch[1]!;
        const share = await getHandoffShare(env, token);
        if (!share) return sharePage(renderExpiredPage(), 404, false);
        const form = await req.formData().catch(() => null);
        const message = (form?.get("message") ?? "").toString().trim();
        const name = (form?.get("name") ?? "").toString().trim().slice(0, MAX_LINK_REPLY_NAME_LENGTH) || "someone";
        // Honeypot: a hidden field humans never see. Bots that fill it get a
        // convincing success page and nothing is sent.
        const honeypot = (form?.get("website") ?? "").toString();
        // Echo caps: the form's maxlength is client-side only, so a crafted
        // POST can carry an arbitrarily large message. Never render more than
        // the legit maximum back into a page (real browser users can't exceed
        // it, so nothing is lost).
        const echo = message.slice(0, MAX_LINK_REPLY_LENGTH);
        if (honeypot) return sharePage(renderReplySentPage(share, name, echo), 200, false);
        // A browser is on the other end of this form — every failure renders a
        // branded page with a way back (echoing their draft so the failure
        // can't eat it), never the API's JSON contract.
        if (!message || message.length > MAX_LINK_REPLY_LENGTH) {
          return sharePage(renderReplyErrorPage(token, `A reply needs 1–${MAX_LINK_REPLY_LENGTH} characters.`, echo || undefined), 400, false);
        }
        if (await overRateLimit(env, `reply:${token}`, 5, 60)) {
          return sharePage(renderReplyErrorPage(token, "This handoff is getting a lot of replies — wait a minute and try again.", message), 429, false);
        }
        const res = await sendGuestReply(env, share, name, message);
        if (!res.ok) {
          return sharePage(renderReplyErrorPage(token, "Something went wrong on our side — try again in a moment.", message), 502, false);
        }
        // Truthful to the GUEST too: a reply that resolved to no recipient (the
        // sender left the team / renamed) must not show a fake "Sent ✓".
        if (res.delivered === 0) {
          console.warn(`guest reply undeliverable: share sender ${share.from.handle} not on roster (team ${share.teamId})`);
          return sharePage(renderReplyErrorPage(token, `${share.from.name || share.from.handle} doesn't seem to be reachable on this team anymore.`, message), 410, false);
        }
        return sharePage(renderReplySentPage(share, name, message), 200, false);
      }

      // ── Inbound webhook (no session — "one curl → Ayo") ─────────────────
      const hookMatch = path.match(/^\/v1\/hooks\/([A-Za-z0-9_-]{16,64})$/);
      if (hookMatch && req.method === "POST") {
        // Unauthenticated public write: throttle by IP FIRST, before we touch KV,
        // so token-guessing can't amplify KV reads (each miss is a getWebhook).
        if (await overRateLimit(env, `hook-probe:${clientIp(req)}`, 60, 60)) {
          return apiError("rate_limited", "Too many webhook requests from this IP.");
        }
        const token = hookMatch[1]!;
        const hook = await getWebhook(env, token);
        if (!hook) return apiError("not_found", "Unknown or revoked webhook.");
        if (hook.kind === "github") {
          return apiError("bad_request", "This is a GitHub webhook — point GitHub at /v1/gh/<token>.");
        }
        // A hook is the creator's capability. If they've left the team it dies —
        // and firing it must NOT re-add them to the roster (sendAsMember would).
        // Tradeoff: KV membership is eventually consistent, so a hook fired within
        // ~a minute of the creator JOINING (across colos) can 404 transiently. The
        // hook is durable and a retry succeeds; we accept that over the re-roster bug.
        if (!(await getMembership(env, hook.teamId, hook.userId as never))) {
          return apiError("not_found", "Unknown or revoked webhook.");
        }
        const input = (await req.json().catch(() => ({}))) as WebhookPingRequest;
        if (typeof input.text !== "string" || input.text.trim() === "") {
          return apiError("bad_request", "A webhook ping needs a non-empty `text`.");
        }
        // Scope-lock: a hook pinned to a recipient can't be widened by the caller;
        // only an unpinned (broadcast) hook honors a caller-supplied `to`.
        let to: Recipients;
        if (hook.to) {
          to = [hook.to];
        } else if (input.to !== undefined) {
          if (
            !Array.isArray(input.to) ||
            input.to.length === 0 ||
            !input.to.every((h) => typeof h === "string" && h.trim() !== "")
          ) {
            return apiError("bad_request", '`to` must be a non-empty array of handle strings, e.g. ["wilson"] or ["*"].');
          }
          to = input.to;
        } else {
          to = ["*"];
        }
        // Public write credential — cap firing per hook, tighter for team-wide
        // broadcasts (up to team-size fanout each).
        const isBroadcast = to.includes("*");
        if (await overRateLimit(env, `hook:${token}`, isBroadcast ? 6 : 30, 60)) {
          return apiError("rate_limited", "This webhook is firing too fast — slow down.");
        }
        // Suppression is first-class: inbound automation NEVER breaks through a
        // recipient's focus. Cap urgency at "normal" (urgent → normal).
        const urgency = input.urgency === "low" ? "low" : "normal";
        // Cap each field before composing so a huge title/text can't force a big
        // intermediate allocation ahead of the final 4 KB clamp.
        const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
        const headline = title ? `${title}\n\n` : "";
        const text = input.text.trim().slice(0, 4096);
        const body = `[${hook.label}] ${headline}${text}`.slice(0, 4096);
        const send: SendAyoRequest = { to, body, kind: "ping", urgency };
        return await sendAsMember(env, hook.teamId, hook.userId, hook.handle, send);
      }

      // ── GitHub webhook (no session — HMAC-verified) → Ayo ───────────────
      const ghMatch = path.match(/^\/v1\/gh\/([A-Za-z0-9_-]{16,64})$/);
      if (ghMatch && req.method === "POST") {
        if (await overRateLimit(env, `gh-probe:${clientIp(req)}`, 120, 60)) {
          return apiError("rate_limited", "Too many webhook requests from this IP.");
        }
        const token = ghMatch[1]!;
        const hook = await getWebhook(env, token);
        if (!hook || hook.kind !== "github" || !hook.secret) {
          return apiError("not_found", "Unknown or revoked webhook.");
        }
        // HMAC-verify over the RAW body before trusting anything in it.
        const raw = await req.text();
        if (!(await verifyGithubSignature(hook.secret, raw, req.headers.get("x-hub-signature-256")))) {
          return apiError("unauthorized", "Bad or missing signature.");
        }
        // GitHub's setup ping — ACK so the webhook shows green.
        const event = req.headers.get("x-github-event") ?? "";
        if (event === "ping") return json({ ok: true });
        // Per-token cap BEFORE the membership KV read (so a valid-HMAC caller
        // can't probe membership at the full rate).
        if (await overRateLimit(env, `hook:${token}`, 60, 60)) {
          return apiError("rate_limited", "This webhook is firing too fast — slow down.");
        }
        // Creator must still be a member (mirrors the generic hook; no re-roster).
        if (!(await getMembership(env, hook.teamId, hook.userId as never))) {
          return apiError("not_found", "Unknown or revoked webhook.");
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return apiError("bad_request", "Body is not valid JSON.");
        }
        const mapped = mapGithubEvent(event, payload);
        // Not an event we route (or self-directed) — ACK 200 so GitHub won't retry.
        if (!mapped) return json({ ok: true, routed: false });
        // Defense in depth at the trust boundary: recipients come from the payload,
        // so keep only real GitHub-login shapes (no "*", no broadcast) and cap the
        // fanout, regardless of what mapGithubEvent returns.
        const recipients = mapped.to.filter((h) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(h)).slice(0, 20);
        if (recipients.length === 0) return json({ ok: true, routed: false });
        const body = `[${hook.label}] ${mapped.body}`.slice(0, 4096);
        const send: SendAyoRequest = { to: recipients, body, kind: "ping", urgency: "normal" };
        return await sendAsMember(env, hook.teamId, hook.userId, hook.handle, send);
      }

      // ── Everything below requires a session ─────────────────────────────
      const session = await authenticate(req, env);
      if (!session) return apiError("unauthorized", "Missing or invalid session token.");
      const userId = session.userId;

      if (path === "/v1/me" && req.method === "GET") {
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        const teams = await teamsForUser(env, userId);
        const body: MeResponse = { user, teams };
        return json(body);
      }

      // Set your signature sound (relay stamps it onto each Ayo you send).
      // audio/wav body = custom upload; JSON body = preset id or null (clear).
      if (path === "/v1/me/sound" && req.method === "PUT") {
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        const ct = req.headers.get("content-type")?.split(";")[0]?.trim();
        if (ct === "audio/wav") {
          // R2 writes + WAV validation cost money; cap uploads per user.
          if (await overRateLimit(env, `sound:${userId}`, 5, 60)) {
            return apiError("rate_limited", "Too many sound uploads — wait a minute.");
          }
          const buf = await req.arrayBuffer();
          const v = await validateWav(buf);
          if (!v.ok) return apiError(v.code, v.message);
          await env.AYO_SOUNDS.put(`sound/${userId}.wav`, buf, {
            httpMetadata: { contentType: "audio/wav", cacheControl: "public, max-age=31536000, immutable" },
            sha256: v.hash,
          });
          // Hash in the URL → each upload is a new URL, cache-busting the CDN + daemon.
          const sound: AyoSound = { kind: "custom", url: `/v1/sounds/${userId}?h=${v.hash}`, hash: v.hash };
          await putUser(env, { ...user, sound });
          return json({ sound });
        }
        const sound = validateSound(await req.json().catch(() => undefined));
        if (sound === undefined) return apiError("bad_request", "Unknown sound.");
        await putUser(env, { ...user, sound });
        return json({ sound });
      }

      // Serve a user's custom sound from R2 (immutable, hash-addressed).
      const soundGet = path.match(/^\/v1\/sounds\/(user_[^/]+)$/);
      if (soundGet && req.method === "GET") {
        const obj = await env.AYO_SOUNDS.get(`sound/${soundGet[1]}.wav`);
        if (!obj) return apiError("not_found", "No sound for that user.");
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("etag", obj.httpEtag);
        // Don't let a browser MIME-sniff user-uploaded bytes away from audio/wav.
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(obj.body, { headers });
      }

      if (path === "/v1/teams" && req.method === "POST") {
        const { name } = (await req.json()) as CreateTeamRequest;
        if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
          return apiError("bad_request", "Team name must be 1–100 characters.");
        }
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        const team = await createTeam(env, name, userId);
        await addMember(env, { teamId: team.id, userId, handle: user.handle });
        // Best-effort, off the response path: seed the DO roster so the creator
        // shows on the board immediately (self-heals on first interaction anyway).
        ctx.waitUntil(registerInRoster(env, team.id, userId, user.handle));
        const body: CreateTeamResponse = { id: team.id, name: team.name, joinCode: team.joinCode };
        return json(body, { status: 201 });
      }

      if (path === "/v1/teams/join" && req.method === "POST") {
        // The only otherwise-unthrottled write path — cap join attempts per user
        // so a valid session can't be used to brute-force codes or churn the DO.
        if (await overRateLimit(env, `join:${userId}`, 20, 60)) {
          return apiError("rate_limited", "Too many join attempts — give it a moment.");
        }
        const { code } = (await req.json()) as JoinTeamRequest;
        const team = await teamByJoinCode(env, code);
        if (!team) return apiError("team_not_found", "No team with that join code.");
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        // A code minted for a handoff link carries its inviter — the joiner
        // lands in a relationship, not an empty room.
        const invitedBy =
          typeof code === "string" ? ((await env.AYO_KV.get(`codeinviter:${code.toUpperCase()}`)) ?? undefined) : undefined;
        // Idempotent: a repeat join (same valid code) is a no-op, so it can't be
        // used to hammer the team DO with register calls.
        if (!(await getMembership(env, team.id, userId))) {
          // Size cap: a leaked/permanent code can't be used to flood a team.
          if ((await countMembers(env, team.id)) >= MAX_TEAM_SIZE) {
            return apiError("team_full", `This team is full (max ${MAX_TEAM_SIZE}).`);
          }
          await addMember(env, { teamId: team.id, userId, handle: user.handle });
          ctx.waitUntil(registerInRoster(env, team.id, userId, user.handle));
        }
        const body: JoinTeamResponse = { id: team.id, name: team.name, joinCode: team.joinCode, invitedBy };
        return json(body);
      }

      // ── Rotate join code (owner only) — revokes the old code ────────────
      const rotateMatch = path.match(/^\/v1\/teams\/(team_[^/]+)\/rotate-code$/);
      if (rotateMatch && req.method === "POST") {
        const teamId = rotateMatch[1] as never;
        const team = await getTeam(env, teamId);
        if (!team) return apiError("team_not_found", "No team with that id.");
        if (!(await getMembership(env, teamId, userId))) {
          return apiError("not_a_member", "You are not a member of this team.");
        }
        // Owner-gated. Legacy teams (no ownerId) fall back to any-member so they
        // aren't permanently un-rotatable.
        // TODO: backfill ownerId on legacy teams, then retire the any-member fallback.
        if (team.ownerId && team.ownerId !== userId) {
          return apiError("forbidden", "Only the team's creator can rotate the join code.");
        }
        const input = (await req.json().catch(() => ({}))) as RotateCodeRequest;
        const hrs = Number(input.expiresInHours);
        // KV rejects an expirationTtl under 60s (→ 500), so clamp the floor. A tiny
        // `--expires` (e.g. 0.01h) becomes a 60s code rather than an error.
        const ttl = Number.isFinite(hrs) && hrs > 0 ? Math.max(Math.round(hrs * 3600), 60) : undefined;
        const { joinCode, expiresAt } = await rotateJoinCode(env, team, ttl);
        return json({ joinCode, expiresAt } satisfies RotateCodeResponse);
      }

      // ── Invite: the active team's shareable join code (members only) ────
      const inviteMatch = path.match(/^\/v1\/teams\/(team_[^/]+)\/invite$/);
      if (inviteMatch && req.method === "GET") {
        const teamId = inviteMatch[1] as never;
        const team = await getTeam(env, teamId);
        if (!team) return apiError("team_not_found", "No team with that id.");
        if (!(await getMembership(env, teamId, userId))) {
          return apiError("not_a_member", "You are not a member of this team.");
        }
        const body: InviteResponse = {
          name: team.name,
          joinCode: team.joinCode,
          codeExpiresAt: team.codeExpiresAt ?? null,
        };
        return json(body);
      }

      // ── Mint a handoff share link (member only) — the "Loom mechanic" ───
      const hlMatch = path.match(/^\/v1\/teams\/(team_[^/]+)\/handoff-link$/);
      if (hlMatch && req.method === "POST") {
        const teamId = hlMatch[1] as never;
        const team = await getTeam(env, teamId);
        if (!team) return apiError("team_not_found", "No team with that id.");
        const membership = await getMembership(env, teamId, userId);
        if (!membership) return apiError("not_a_member", "You are not a member of this team.");
        // Minting writes KV; cap per user.
        if (await overRateLimit(env, `handoff-link:${userId}`, 20, 60)) {
          return apiError("rate_limited", "Too many handoff links — give it a moment.");
        }
        const input = (await req.json().catch(() => ({}))) as CreateHandoffLinkRequest;
        if (typeof input.blocker !== "string" || input.blocker.trim() === "") {
          return apiError("bad_request", "A handoff link needs a blocker/body.");
        }
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        // A public URL always carries an expiry: default TTL, clamped to
        // [60s (KV floor), max]. `expiresAt` derives from the same clamped ttl.
        const hrs = Number(input.expiresInHours);
        const wantHrs =
          Number.isFinite(hrs) && hrs > 0 ? Math.min(hrs, HANDOFF_LINK_MAX_TTL_HOURS) : HANDOFF_LINK_TTL_HOURS;
        const ttl = Math.max(Math.round(wantHrs * 3600), 60);
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        const embedCode = input.includeJoinCode !== false;
        // Per-LINK join code: minted fresh, expires with the link (KV TTL), and
        // carries the inviter — so rotating the team code never kills a live
        // link, and the joiner learns who invited them.
        let linkCode: string | undefined;
        if (embedCode) {
          linkCode = await freshJoinCode(env);
          await env.AYO_KV.put(`joincode:${linkCode}`, team.id, { expirationTtl: ttl });
          await env.AYO_KV.put(`codeinviter:${linkCode}`, membership.handle, { expirationTtl: ttl });
        }
        // Strip cwd: it's an absolute local path (username, filesystem layout) that
        // the public page never renders — keep it off the public artifact entirely.
        const context = input.context ? { ...input.context, cwd: undefined } : undefined;
        const share: HandoffShare = {
          v: 1,
          from: { handle: membership.handle, name: user.name },
          // Routing for the reply flow — stored, never rendered.
          teamId,
          fromId: userId as never,
          ayoId: typeof input.ayoId === "string" && input.ayoId.startsWith("ayo_") ? input.ayoId : undefined,
          teamName: team.name,
          blocker: input.blocker,
          note: input.note,
          context,
          joinCode: linkCode,
          // The link code lives exactly as long as the link.
          joinCodeExpiresAt: embedCode ? expiresAt : undefined,
          createdAt: new Date().toISOString(),
          expiresAt,
        };
        if (JSON.stringify(share).length > MAX_HANDOFF_SHARE_BYTES) {
          return apiError("payload_too_large", "Handoff context too large to share.");
        }
        const token = await putHandoffShare(env, share, ttl);
        const resBody: CreateHandoffLinkResponse = { token, url: `${url.origin}/h/${token}`, expiresAt };
        return json(resBody, { status: 201 });
      }

      // ── Inbound webhooks: mint / list / revoke (member only) ────────────
      const hooksMatch = path.match(/^\/v1\/teams\/(team_[^/]+)\/hooks$/);
      if (hooksMatch) {
        const teamId = hooksMatch[1] as never;
        const membership = await getMembership(env, teamId, userId);
        if (!membership) return apiError("not_a_member", "You are not a member of this team.");
        if (req.method === "POST") {
          const input = (await req.json().catch(() => ({}))) as CreateWebhookRequest;
          const label = typeof input.label === "string" ? input.label.trim() : "";
          if (!label || label.length > 40) {
            return apiError("bad_request", "A webhook needs a label of 1–40 characters.");
          }
          const isGithub = input.github === true;
          // GitHub signs payloads with a shared secret; the URL token alone isn't
          // the auth for a github hook (the HMAC is), so mint a strong secret.
          const secret = isGithub ? urlSafeToken(24) : undefined;
          const meta = {
            teamId,
            userId: userId as never,
            handle: membership.handle,
            label,
            // A github hook routes by event, so a pinned `to` doesn't apply.
            to: !isGithub && typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined,
            kind: isGithub ? ("github" as const) : undefined,
            secret,
            createdAt: new Date().toISOString(),
          };
          const token = await createWebhook(env, meta);
          const info: CreateWebhookResponse = {
            token,
            url: `${url.origin}${isGithub ? "/v1/gh/" : "/v1/hooks/"}${token}`,
            label: meta.label,
            to: meta.to,
            createdAt: meta.createdAt,
            createdBy: meta.handle,
            kind: meta.kind,
            // The secret is returned ONCE, here — never on list.
            secret,
          };
          return json(info, { status: 201 });
        }
        if (req.method === "GET") {
          const rows = await listWebhooks(env, teamId);
          // A token is a bearer secret: only its creator gets the token/url back.
          // Others see metadata only, so a member can't lift a teammate's URL.
          const hooks: WebhookInfo[] = rows.map((r) => {
            const owned = r.createdBy === membership.handle;
            const base = r.kind === "github" ? "/v1/gh/" : "/v1/hooks/";
            return {
              token: owned ? r.token : "",
              url: owned ? `${url.origin}${base}${r.token}` : "",
              label: r.label,
              to: r.to,
              createdAt: r.createdAt,
              createdBy: r.createdBy,
              kind: r.kind,
            };
          });
          return json({ hooks } satisfies ListWebhooksResponse);
        }
      }

      const hookRevoke = path.match(/^\/v1\/teams\/(team_[^/]+)\/hooks\/([A-Za-z0-9_-]{16,64})$/);
      if (hookRevoke && req.method === "DELETE") {
        const teamId = hookRevoke[1] as never;
        const token = hookRevoke[2]!;
        if (!(await getMembership(env, teamId, userId))) {
          return apiError("not_a_member", "You are not a member of this team.");
        }
        const hook = await getWebhook(env, token);
        // Scope the delete to THIS team — a token from another team must not be
        // revocable here (and a missing one is a no-op 404, not a leak).
        if (!hook || hook.teamId !== teamId) return apiError("not_found", "No such webhook on this team.");
        await deleteWebhook(env, token);
        return json({ ok: true });
      }

      // ── Flat ayo read/resolve/answer -> resolve team, then forward ──────
      // read/resolve are POST; answer is POST (answer it) or GET (poll state —
      // the asking agent short-polls until answered or its deadline passes).
      const flatAyo = path.match(/^\/v1\/ayo\/(ayo_[^/]+)\/(read|resolve|answer)$/);
      if (flatAyo && (req.method === "POST" || (req.method === "GET" && flatAyo[2] === "answer"))) {
        const ayoId = flatAyo[1]!;
        const teamId = await teamForAyo(env, ayoId as never);
        if (!teamId) return apiError("team_not_found", "Unknown ayo.");
        // Authz: the caller must be a member of the resolved team. Without this,
        // any authenticated user could read/resolve an Ayo by guessing its id.
        const membership = await getMembership(env, teamId, userId);
        if (!membership) return apiError("not_a_member", "You are not a member of this team.");
        return await forwardToTeam(req, env, userId, teamId, `/internal/ayo/${ayoId}/${flatAyo[2]}`, membership.handle);
      }

      // ── Team-scoped routes -> forward to the team DO ────────────────────
      const teamMatch = path.match(/^\/v1\/teams\/(team_[^/]+)(\/.*)?$/);
      if (teamMatch) {
        const teamId = teamMatch[1]!;
        const rest = teamMatch[2] ?? "";
        const team = await getTeam(env, teamId as never);
        if (!team) return apiError("team_not_found", "No team with that id.");
        const membership = await getMembership(env, teamId as never, userId);
        if (!membership) return apiError("not_a_member", "You are not a member of this team.");
        // On send, stamp the sender's signature sound from their profile so the
        // recipient gets it inline (snapshot at send time, like `from`).
        let soundHeader: string | undefined;
        if (req.method === "POST" && rest === "/ayo") {
          // Per-sender cap: generous for humans (Ayos are low-volume, high-signal),
          // but stops a script from blasting the team.
          if (await overRateLimit(env, `send:${userId}`, 60, 60)) {
            return apiError("rate_limited", "You're sending Ayos too fast — give it a moment.");
          }
          const sender = await loadUser(env, userId);
          if (sender?.sound) soundHeader = JSON.stringify(sender.sound);
        }
        return await forwardToTeam(req, env, userId, teamId as never, `/internal${rest || ""}`, membership.handle, soundHeader);
      }

      return apiError("team_not_found", "Unknown route.");
    } catch (err) {
      // Log the detail for observability; return a generic message so internal
      // implementation details don't leak to callers.
      console.error("relay error:", (err as Error)?.stack ?? err);
      return apiError("internal_error", "An unexpected error occurred.");
    }
  },
} satisfies ExportedHandler<Env>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Response wrapper for every public /h/* page: consistent cache + CSP headers.
 *  form-action 'self' (not 'none') so the no-JS reply form can POST back;
 *  scripts remain fully blocked via default-src 'none'. */
function sharePage(html: string, status: number, cacheable: boolean): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `private` so no shared/CDN cache serves past the KV expiry (min TTL 60s);
      // POST results are never cached.
      "cache-control": cacheable ? "private, max-age=30" : "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Deliver an anonymous handoff-page reply into the sender's inbox. The guest is
 * NOT a member: x-ayo-user/handle are deliberately EMPTY (the DO's
 * rememberMember no-ops on blank identity, so the roster is never polluted) and
 * the synthetic `from` is unmistakably a guest. Routing comes from the share
 * snapshot the SENDER minted — the guest controls only the text and their name.
 */
async function sendGuestReply(
  env: Env,
  share: HandoffShare,
  guestName: string,
  message: string,
): Promise<{ ok: boolean; delivered: number }> {
  try {
    const stub = env.TEAM.get(env.TEAM.idFromName(share.teamId));
    const headers = new Headers({ "content-type": "application/json", "x-ayo-team": share.teamId });
    if (env.INTERNAL_SECRET) headers.set("x-ayo-internal", env.INTERNAL_SECRET);
    const res = await stub.fetch(
      new Request("https://team/internal/guest-reply", {
        method: "POST",
        headers,
        body: JSON.stringify({
          to: share.from.handle,
          guestName,
          message,
          replyTo: share.ayoId ?? null,
        }),
      }),
    );
    if (!res.ok) return { ok: false, delivered: 0 };
    const body = (await res.json().catch(() => ({}))) as { delivered?: number };
    return { ok: true, delivered: typeof body.delivered === "number" ? body.delivered : 0 };
  } catch {
    return { ok: false, delivered: 0 };
  }
}

/**
 * Send an Ayo into a team DO under a member's identity, from a body the Worker
 * built itself (not forwarded from the client) — used by the inbound webhook,
 * where there's no session to forward. Injects the trusted x-ayo-* headers the
 * DO requires; the DO applies suppression (held) like any other send.
 */
async function sendAsMember(
  env: Env,
  teamId: string,
  userId: string,
  handle: string,
  body: SendAyoRequest,
): Promise<Response> {
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  const headers = new Headers({
    "content-type": "application/json",
    "x-ayo-user": userId,
    "x-ayo-handle": handle,
    "x-ayo-team": teamId,
  });
  if (env.INTERNAL_SECRET) headers.set("x-ayo-internal", env.INTERNAL_SECRET);
  return stub.fetch(
    new Request("https://team/internal/ayo", { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

async function loadUser(env: Env, userId: string): Promise<PublicUser | null> {
  const raw = await env.AYO_KV.get(`user:${userId}`);
  return raw ? (JSON.parse(raw) as PublicUser) : null;
}

/**
 * Register a member into the team DO's roster up front (on create/join), so
 * broadcasts, the board, and milestone nudges see them immediately — not only
 * after their first DO interaction (daemon connect / send). Best-effort: the
 * roster is also self-healing on first real interaction.
 */
async function registerInRoster(env: Env, teamId: string, userId: string, handle: string): Promise<void> {
  try {
    const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
    const headers = new Headers({ "x-ayo-user": userId, "x-ayo-handle": handle, "x-ayo-team": teamId });
    if (env.INTERNAL_SECRET) headers.set("x-ayo-internal", env.INTERNAL_SECRET);
    const res = await stub.fetch(new Request("https://team/internal/register", { method: "POST", headers }));
    // A 403 here (Response, not a throw) means the DO rejected the internal call
    // — log it so a secret misconfig is diagnosable (roster still self-heals).
    if (!res.ok) console.warn("registerInRoster: DO returned", res.status, "for team", teamId);
  } catch {
    /* ignore — self-healing on first interaction */
  }
}

/**
 * Forward a request to a team's DO, stripping the public prefix and injecting
 * verified identity. The original URL's query string is preserved.
 */
/** Validate a `PUT /v1/me/sound` body: `null` clears; a known preset id is
 *  accepted; anything else is rejected (custom clips arrive in Phase A2).
 *  Returns `undefined` for an invalid body. */
function validateSound(body: unknown): AyoSound | null | undefined {
  if (body === null) return null;
  if (body && typeof body === "object" && (body as { kind?: unknown }).kind === "preset") {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && (SOUND_PRESETS as readonly string[]).includes(id)) {
      return { kind: "preset", id };
    }
  }
  return undefined;
}

async function forwardToTeam(
  req: Request,
  env: Env,
  userId: string,
  teamId: string,
  internalPath: string,
  handle = "",
  soundHeader?: string,
): Promise<Response> {
  const id = env.TEAM.idFromName(teamId);
  const stub = env.TEAM.get(id);
  const original = new URL(req.url);
  const target = new URL(`https://team${internalPath}`);
  target.search = original.search;

  const headers = new Headers(req.headers);
  // Strip any client-supplied x-ayo-* — these are identity/trust headers only the
  // Worker may set. Without this, a client with no profile sound could forge
  // x-ayo-sound on a send (or attempt x-ayo-internal). The DO trusts these.
  for (const h of ["x-ayo-user", "x-ayo-handle", "x-ayo-team", "x-ayo-sound", "x-ayo-internal"]) headers.delete(h);
  headers.set("x-ayo-user", userId);
  headers.set("x-ayo-handle", handle);
  headers.set("x-ayo-team", teamId);
  if (soundHeader) headers.set("x-ayo-sound", soundHeader);
  // Prove to the DO this request came through the Worker (the only identity
  // verifier). The DO rejects any request missing this when the secret is set.
  if (env.INTERNAL_SECRET) headers.set("x-ayo-internal", env.INTERNAL_SECRET);

  return stub.fetch(new Request(target, { method: req.method, headers, body: req.body }));
}

/** Human-friendly text for GitHub's terminal device-flow error codes. */
function githubErrorMessage(error: string): string {
  switch (error) {
    case "expired_token":
      return "The login code expired — run `ayo login` again.";
    case "access_denied":
      return "Authorization was denied.";
    case "device_flow_disabled":
      return "Device flow is not enabled on the relay's GitHub app.";
    case "incorrect_client_credentials":
      return "The relay's GitHub client ID is misconfigured.";
    default:
      return `GitHub device flow error: ${error}`;
  }
}

// ── Auth: GitHub device flow (dev stub when GitHub is unconfigured) ───────────

async function handleDeviceStart(req: Request, env: Env): Promise<Response> {
  if (devStubEnabled(env)) {
    // Dev: the CLI passes the desired handle so the local slice can run without
    // a real GitHub app. Poll auto-approves immediately.
    const url = new URL(req.url);
    const handle = url.searchParams.get("handle") ?? "dev";
    const deviceCode = `dev_${crypto.randomUUID()}`;
    await env.AYO_KV.put(`device:${deviceCode}`, handle, { expirationTtl: 600 });
    const body: DeviceStartResponse = {
      device_code: deviceCode,
      user_code: handle.toUpperCase().slice(0, 6).padEnd(4, "X"),
      verification_uri: "https://ayo.dev/device (dev stub: auto-approved)",
      interval: 1,
      expires_in: 600,
    };
    return json(body);
  }
  if (!env.GITHUB_CLIENT_ID) return apiError("unauthorized", "Auth is not configured on this relay.");

  const gh = await githubDeviceStart(env.GITHUB_CLIENT_ID);
  const body: DeviceStartResponse = {
    device_code: gh.device_code,
    user_code: gh.user_code,
    verification_uri: gh.verification_uri,
    interval: gh.interval,
    expires_in: gh.expires_in,
  };
  return json(body);
}

async function handleDevicePoll(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { device_code?: string } | null;
  if (!body || typeof body.device_code !== "string" || !body.device_code) {
    return apiError("bad_request", "device_code is required.");
  }
  const device_code = body.device_code;

  if (devStubEnabled(env)) {
    const handle = await env.AYO_KV.get(`device:${device_code}`);
    if (!handle) return apiError("invalid_token", "Unknown or expired device code.");
    // Reuse an existing dev user with this handle, else mint one.
    const existing = await env.AYO_KV.get(`devhandle:${handle}`);
    const userId = existing ?? newUserId();
    const user: PublicUser = { id: userId as never, handle, name: handle };
    await putUser(env, user);
    if (!existing) await env.AYO_KV.put(`devhandle:${handle}`, userId);
    const session_token = await issueSession(env, userId as never);
    await env.AYO_KV.delete(`device:${device_code}`);
    return json({ status: "complete", session_token, user } satisfies DevicePollResponse);
  }

  if (!env.GITHUB_CLIENT_ID) return apiError("unauthorized", "Auth is not configured on this relay.");

  const poll = await githubDevicePoll(env.GITHUB_CLIENT_ID, device_code);
  if (!poll.ok) {
    // Still waiting / told to back off — the CLI keeps polling.
    if (poll.error === "authorization_pending") return json({ status: "pending" } satisfies DevicePollResponse);
    if (poll.error === "slow_down") {
      return json({ status: "slow_down", interval: poll.interval ?? 5 } satisfies DevicePollResponse);
    }
    // Terminal: expired_token, access_denied, device_flow_disabled, ...
    return apiError("unauthorized", githubErrorMessage(poll.error));
  }

  const gh = await githubGetUser(poll.accessToken);
  const user = await findOrCreateGithubUser(env, gh);
  const session_token = await issueSession(env, user.id);
  return json({ status: "complete", session_token, user } satisfies DevicePollResponse);
}
