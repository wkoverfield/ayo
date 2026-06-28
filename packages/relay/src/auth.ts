/**
 * Session auth. A session token is opaque and identifies one user across all
 * their teams (ADR 0002). Tokens are stored in KV: `session:<token>` -> userId.
 *
 * GitHub device flow is the production path (TODO: exchange device_code via
 * GitHub's OAuth device endpoints). When GITHUB_CLIENT_ID is unset, the auth
 * routes fall back to a dev stub so the local vertical slice runs end-to-end.
 */

import type { PublicUser, UserId } from "@ayo-dev/core";
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

export async function issueSession(env: Env, userId: UserId): Promise<string> {
  const token = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.AYO_KV.put(`session:${token}`, userId);
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
