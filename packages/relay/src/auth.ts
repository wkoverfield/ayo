/**
 * Session auth. A session token is opaque and identifies one user across all
 * their teams (ADR 0002). Tokens are stored in KV: `session:<token>` -> userId.
 *
 * GitHub device flow is the production path: the relay starts a device code and
 * polls GitHub's OAuth device endpoint, issuing a session on success (see
 * github.ts). The no-GitHub dev stub is gated on AYO_DEV_AUTH==="1" (see
 * devStubEnabled) — NOT merely a missing client id — so a prod deploy that
 * forgets to set GITHUB_CLIENT_ID fails closed instead of silently stubbing.
 */

import type { PublicUser, UserId } from "@ayo-dev/core";
import { newUserId } from "@ayo-dev/core";
import type { GithubUser } from "./github.js";
import type { Env } from "./env.js";

export interface Session {
  userId: UserId;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice("Bearer ".length).trim();
  // Fallback for WebSocket clients that can't set headers.
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

export async function authenticate(req: Request, env: Env): Promise<Session | null> {
  const token = bearer(req);
  if (!token) return null;
  const userId = await env.AYO_KV.get(`session:${token}`);
  return userId ? { userId: userId as UserId } : null;
}

export async function getUser(env: Env, userId: UserId): Promise<PublicUser | null> {
  const raw = await env.AYO_KV.get(`user:${userId}`);
  return raw ? (JSON.parse(raw) as PublicUser) : null;
}

export async function putUser(env: Env, user: PublicUser): Promise<void> {
  await env.AYO_KV.put(`user:${user.id}`, JSON.stringify(user));
}

/** Map a GitHub identity to a stable Ayo user (keyed by GitHub numeric id, so a
 *  handle rename doesn't create a new account). On first login the handle
 *  defaults to the GitHub login; on later logins we preserve the existing
 *  handle (so a future `ayo alias` isn't clobbered) and only refresh the name. */
export async function findOrCreateGithubUser(env: Env, gh: GithubUser): Promise<PublicUser> {
  const key = `ghuser:${gh.id}`;
  const existingId = await env.AYO_KV.get(key);
  if (existingId) {
    const existing = await getUser(env, existingId as UserId);
    if (existing) {
      const refreshed: PublicUser = { ...existing, name: gh.name ?? existing.name };
      await putUser(env, refreshed);
      return refreshed;
    }
    // Pointer exists but the user record is gone (KV eviction / partial write):
    // reconstruct under the SAME userId so team memberships aren't orphaned.
    const recovered: PublicUser = { id: existingId as UserId, handle: gh.login, name: gh.name ?? gh.login };
    await putUser(env, recovered);
    return recovered;
  }
  const userId = newUserId() as UserId;
  const user: PublicUser = { id: userId, handle: gh.login, name: gh.name ?? gh.login };
  await putUser(env, user);
  await env.AYO_KV.put(key, userId);
  return user;
}

export async function issueSession(env: Env, userId: UserId): Promise<string> {
  const token = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
  // Sessions expire server-side after 90 days — a laptop that stops being
  // used must not hold a working token forever. (Pre-existing sessions from
  // before this landed have no TTL; `ayo logout` revokes any session.)
  await env.AYO_KV.put(`session:${token}`, userId, { expirationTtl: 60 * 60 * 24 * 90 });
  return token;
}

/**
 * The no-GitHub dev auth stub is enabled ONLY when AYO_DEV_AUTH === "1" (set via
 * `.dev.vars` locally). It must never be gated on the mere ABSENCE of a secret —
 * a prod deploy that forgets `wrangler secret put GITHUB_CLIENT_ID` must fail
 * closed, not silently become a zero-auth instance.
 */
export function devStubEnabled(env: Env): boolean {
  return env.AYO_DEV_AUTH === "1";
}

/** Revoke a session token (logout). Idempotent — deleting a missing key is fine. */
export async function revokeSession(env: Env, token: string): Promise<void> {
  await env.AYO_KV.delete(`session:${token}`);
}
