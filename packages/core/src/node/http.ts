/**
 * The shared relay JSON transport for the CLI and the MCP server. (A few
 * binary paths — WAV upload, sound-clip download — keep bespoke fetches in
 * the CLI; see docs/FOLLOWUPS.md.) Speaks the relay's
 * { error: { code, message } } contract, redacts the bearer token from
 * anything that might reflect it, and throws a typed RelayError so callers
 * can branch on `code` instead of parsing prose.
 *
 * Uses global fetch (Node 20+). Under `@ayo-dev/core/node` by policy — the
 * relay itself never calls itself, and keeping all Node-flavored code on one
 * subpath keeps the root export Workers-safe.
 */

export class RelayError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RelayCallOpts {
  method?: string;
  body?: unknown;
  token?: string;
}

export async function relayCall<T>(relayUrl: string, path: string, opts: RelayCallOpts = {}): Promise<T> {
  const res = await fetch(`${relayUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Prefer the relay's structured error; fall back to raw text (a proxy or
    // tunnel can answer with plain HTML/text that isn't JSON). code and
    // message are honored independently — a body carrying only a code still
    // yields that code with an "HTTP <status>" message.
    let code = "http_error";
    let msg = text || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (j?.error) {
        code = j.error.code ?? code;
        msg = j.error.message ?? `HTTP ${res.status}`;
      }
    } catch {
      /* not JSON — use raw */
    }
    if (opts.token) msg = msg.replaceAll(opts.token, "[redacted]");
    throw new RelayError(code, msg.slice(0, 500));
  }
  return (text ? JSON.parse(text) : {}) as T;
}
