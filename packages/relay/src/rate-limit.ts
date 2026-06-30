/**
 * Minimal fixed-window rate limiting on KV. Not exact (KV is eventually
 * consistent, so a coordinated multi-colo burst can undercount) and deliberately
 * so — a baseline deterrent against device-flow abuse and ping spam, not a
 * precise quota. Cheap: one KV read, and one write only while under the limit.
 *
 * The window is anchored by a reset timestamp stored in the value (`count:resetAt`),
 * NOT by the key's TTL — otherwise a steady `limit-1`/min trickle would reset the
 * TTL forever and never throttle. The TTL is just GC for idle keys.
 */

import type { Env } from "./env.js";

/** True if `key` is AT/OVER `limit` for the current window (→ reject).
 *  KV's minimum TTL is 60s, so pass windowSec >= 60. */
export async function overRateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  let resetAt = now + windowSec;

  const raw = await env.AYO_KV.get(k);
  if (raw) {
    const [c, r] = raw.split(":");
    const cn = Number(c);
    const rn = Number(r);
    // Reuse the live window; a missing/corrupt/expired value just starts a fresh
    // one (fail-open: never hard-fail a request on a bad counter).
    if (Number.isFinite(cn) && Number.isFinite(rn) && rn > now) {
      count = cn;
      resetAt = rn;
    }
  }

  if (count >= limit) return true;
  // Keep the key at least until the window resets (KV TTL floor is 60s).
  await env.AYO_KV.put(k, `${count + 1}:${resetAt}`, { expirationTtl: Math.max(resetAt - now, 60) });
  return false;
}

/** The caller's IP for keying unauthenticated limits. Cloudflare sets this; the
 *  fallback only applies in local dev (all callers share one bucket there). */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}
