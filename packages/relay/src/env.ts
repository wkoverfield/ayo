import type { ApiErrorBody, ApiErrorCode } from "@ayo-dev/core";

export interface Env {
  TEAM: DurableObjectNamespace;
  AYO_KV: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Must be "1" to enable the no-GitHub dev auth stub. Never set in prod. */
  AYO_DEV_AUTH?: string;
  /** Shared secret the Worker stamps on DO sub-requests so the DO can reject
   *  any request that didn't come through the Worker. Set via wrangler secret. */
  INTERNAL_SECRET?: string;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  invalid_token: 401,
  team_not_found: 404,
  not_a_member: 403,
  unknown_recipient: 400,
  bad_request: 400,
  rate_limited: 429,
  payload_too_large: 413,
  internal_error: 500,
};

export function apiError(code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, { status: ERROR_STATUS[code] });
}
