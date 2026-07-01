/**
 * Handoff share links — the "Loom mechanic". A handoff can mint a public,
 * expiring URL that renders its work context to a NON-user (see handoff-page.ts).
 *
 * The snapshot is self-contained in KV (`share:<token>`), so the public render
 * path never touches the team DO or any session. The token is the only secret:
 * unguessable (128 bits) and URL-safe. Links always carry a TTL — a public URL
 * should not outlive the handoff it represents.
 */

import type { HandoffShare } from "@ayo-dev/core";
import type { Env } from "./env.js";
import { urlSafeToken } from "./token.js";

/** 128-bit URL-safe token — a bearer capability for a public page. */
export function newShareToken(): string {
  return urlSafeToken(16);
}

export async function putHandoffShare(
  env: Env,
  share: HandoffShare,
  ttlSeconds: number,
): Promise<string> {
  const token = newShareToken();
  // KV auto-evicts at the TTL, which IS the expiry — so an expired link simply
  // 404s (getHandoffShare -> null), no sweep needed. Caller clamps ttl >= 60.
  await env.AYO_KV.put(`share:${token}`, JSON.stringify(share), { expirationTtl: ttlSeconds });
  return token;
}

export async function getHandoffShare(env: Env, token: string): Promise<HandoffShare | null> {
  const raw = await env.AYO_KV.get(`share:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HandoffShare;
  } catch {
    return null;
  }
}
