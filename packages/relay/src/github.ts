/**
 * GitHub OAuth device flow (https://docs.github.com/en/apps/oauth-apps).
 * The device flow needs only the client_id — no client_secret — which is why
 * it's the right fit for a CLI that can't keep a secret.
 *
 * The OAuth App must have "Device Flow" enabled in its settings.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const SCOPE = "read:user";

const jsonHeaders = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "ayo-relay",
};

export interface GithubDeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function githubDeviceStart(clientId: string): Promise<GithubDeviceStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  });
  const data = (await res.json()) as Partial<GithubDeviceStart> & { error_description?: string; error?: string };
  if (!res.ok || !data.device_code) {
    throw new Error(data.error_description ?? data.error ?? `github device/code returned ${res.status}`);
  }
  return data as GithubDeviceStart;
}

/** Either an access token, or a GitHub error code (authorization_pending,
 *  slow_down, expired_token, access_denied, device_flow_disabled, ...). On
 *  `slow_down`, GitHub supplies the new minimum interval to honour. */
export type GithubPollResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string; interval?: number };

export async function githubDevicePoll(
  clientId: string,
  deviceCode: string,
): Promise<GithubPollResult> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  // The token endpoint returns HTTP 200 even for the pending/slow_down errors.
  const data = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (data.access_token) return { ok: true, accessToken: data.access_token };
  return { ok: false, error: data.error ?? "unknown_error", interval: data.interval };
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export async function githubGetUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "ayo-relay",
    },
  });
  if (!res.ok) throw new Error(`github /user returned ${res.status}`);
  const user = (await res.json()) as GithubUser;
  // `id` is the stable identity key — never trust a payload missing it (would
  // otherwise merge unrelated users under `ghuser:undefined`).
  if (typeof user.id !== "number" || typeof user.login !== "string" || !user.login) {
    throw new Error("github /user returned an unexpected shape");
  }
  return user;
}
