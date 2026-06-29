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
  MeResponse,
  PublicUser,
} from "@ayo-dev/core";
import { newUserId, SOUND_PRESETS } from "@ayo-dev/core";
import { apiError, json, type Env } from "./env.js";
import {
  authenticate,
  devStubEnabled,
  findOrCreateGithubUser,
  issueSession,
  putUser,
} from "./auth.js";
import { githubDeviceStart, githubDevicePoll, githubGetUser } from "./github.js";
import {
  addMember,
  createTeam,
  getMembership,
  getTeam,
  teamByJoinCode,
  teamForAyo,
  teamsForUser,
} from "./directory.js";

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
        return await handleDeviceStart(req, env);
      }
      if (path === "/v1/auth/device/poll" && req.method === "POST") {
        return await handleDevicePoll(req, env);
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
      if (path === "/v1/me/sound" && req.method === "PUT") {
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        const sound = validateSound(await req.json().catch(() => undefined));
        if (sound === undefined) return apiError("bad_request", "Unknown sound.");
        await putUser(env, { ...user, sound });
        return json({ sound });
      }

      if (path === "/v1/teams" && req.method === "POST") {
        const { name } = (await req.json()) as CreateTeamRequest;
        if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
          return apiError("bad_request", "Team name must be 1–100 characters.");
        }
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        const team = await createTeam(env, name);
        await addMember(env, { teamId: team.id, userId, handle: user.handle });
        // Best-effort, off the response path: seed the DO roster so the creator
        // shows on the board immediately (self-heals on first interaction anyway).
        ctx.waitUntil(registerInRoster(env, team.id, userId, user.handle));
        const body: CreateTeamResponse = { id: team.id, name: team.name, joinCode: team.joinCode };
        return json(body, { status: 201 });
      }

      if (path === "/v1/teams/join" && req.method === "POST") {
        const { code } = (await req.json()) as JoinTeamRequest;
        const team = await teamByJoinCode(env, code);
        if (!team) return apiError("team_not_found", "No team with that join code.");
        const user = await loadUser(env, userId);
        if (!user) return apiError("invalid_token", "Session user not found.");
        // Idempotent: a repeat join (same valid code) is a no-op, so it can't be
        // used to hammer the team DO with register calls.
        if (!(await getMembership(env, team.id, userId))) {
          await addMember(env, { teamId: team.id, userId, handle: user.handle });
          ctx.waitUntil(registerInRoster(env, team.id, userId, user.handle));
        }
        const body: JoinTeamResponse = { id: team.id, name: team.name };
        return json(body);
      }

      // ── Flat ayo read/resolve -> resolve team, then forward ─────────────
      const flatAyo = path.match(/^\/v1\/ayo\/(ayo_[^/]+)\/(read|resolve)$/);
      if (flatAyo && req.method === "POST") {
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
