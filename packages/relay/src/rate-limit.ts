/**
 * Minimal fixed-window rate limiting on KV. Not exact (KV is eventually
 * consistent), and deliberately so — this is a baseline to blunt abuse of the
 * unauthenticated device-flow endpoints and ping spam, not a precise quota
 * system. Cheap: one KV read, and one write only while under the limit.
 */

import type { Env } from "./env.js";

/** True if `key` is AT/OVER `limit` within the last `windowSec` (→ reject).
 *  KV's minimum TTL is 60s, so pass windowSec >= 60. */
export async function overRateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const current = Number((await env.AYO_KV.get(k)) ?? 0);
  if (!Number.isFinite(current)) return false; // never hard-fail a request on a bad counter
  if (current >= limit) return true;
  // Stop writing once over the limit (above), so the TTL set on the last allowed
  // request lets the window expire after windowSec of quiet.
  await env.AYO_KV.put(k, String(current + 1), { expirationTtl: windowSec });
  return false;
}

/** The caller's IP for keying unauthenticated limits. Cloudflare sets this; the
 *  fallback only applies in local dev (all callers share one bucket there). */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}
