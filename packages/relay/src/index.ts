/**
 * Ayo relay Worker. Authenticates requests, handles directory CRUD, and
 * forwards team-scoped traffic to the per-team TeamHub Durable Object.
 *
 * The Worker is the only place identity is verified. It injects the verified
 * userId/handle into forwarded requests via `x-ayo-*` headers; the DO never
 * trusts a client-supplied identity (ADR 0002).
 */

import type {
  CreateTeamRequest,
  CreateTeamResponse,
  DevicePollResponse,
  JoinTeamRequest,
  JoinTeamResponse,
  MeResponse,
  PublicUser,
} from "@ayo-dev/core";
import { newUserId } from "@ayo-dev/core";
import { apiError, json, type Env } from "./env.js";
import {
  authenticate,
  devStubEnabled,
  issueSession,
  putUser,
} from "./auth.js";
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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── Auth (no session required) ──────────────────────────────────────
      if (path === "/v1/auth/device" && req.method === "POST") {
        return handleDeviceStart(req, env);
      }
      if (path === "/v1/auth/device/poll" && req.method === "POST") {
        return handleDevicePoll(req, env);
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

      if (path === "/v1/teams" && req.method === "POST") {
        const { name } = (await req.json()) as CreateTeamRequest;
        const team = await createTeam(env, name);
        const user = await loadUser(env, userId);
        await addMember(env, { teamId: team.id, userId, handle: user?.handle ?? "you" });
        const body: CreateTeamResponse = { id: team.id, name: team.name, joinCode: team.joinCode };
        return json(body, { status: 201 });
      }

      if (path === "/v1/teams/join" && req.method === "POST") {
        const { code } = (await req.json()) as JoinTeamRequest;
        const team = await teamByJoinCode(env, code);
        if (!team) return apiError("team_not_found", "No team with that join code.");
        const user = await loadUser(env, userId);
        await addMember(env, { teamId: team.id, userId, handle: user?.handle ?? "you" });
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
        return forwardToTeam(req, env, userId, teamId, `/internal/ayo/${ayoId}/${flatAyo[2]}`, membership.handle);
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
        return forwardToTeam(req, env, userId, teamId as never, `/internal${rest || ""}`, membership.handle);
      }

      return apiError("team_not_found", "Unknown route.");
    } catch (err) {
      return apiError("internal_error", `Unexpected: ${(err as Error).message}`);
    }
  },
} satisfies ExportedHandler<Env>;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadUser(env: Env, userId: string): Promise<PublicUser | null> {
  const raw = await env.AYO_KV.get(`user:${userId}`);
  return raw ? (JSON.parse(raw) as PublicUser) : null;
}

/**
 * Forward a request to a team's DO, stripping the public prefix and injecting
 * verified identity. The original URL's query string is preserved.
 */
async function forwardToTeam(
  req: Request,
  env: Env,
  userId: string,
  teamId: string,
  internalPath: string,
  handle = "",
): Promise<Response> {
  const id = env.TEAM.idFromName(teamId);
  const stub = env.TEAM.get(id);
  const original = new URL(req.url);
  const target = new URL(`https://team${internalPath}`);
  target.search = original.search;

  const headers = new Headers(req.headers);
  headers.set("x-ayo-user", userId);
  headers.set("x-ayo-handle", handle);
  headers.set("x-ayo-team", teamId);
  // Prove to the DO this request came through the Worker (the only identity
  // verifier). The DO rejects any request missing this when the secret is set.
  if (env.INTERNAL_SECRET) headers.set("x-ayo-internal", env.INTERNAL_SECRET);

  return stub.fetch(new Request(target, { method: req.method, headers, body: req.body }));
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
    return json({
      device_code: deviceCode,
      user_code: handle.toUpperCase().slice(0, 6).padEnd(4, "X"),
      verification_uri: "https://ayo.dev/device (dev stub: auto-approved)",
      interval: 1,
    });
  }
  // TODO: real GitHub device flow via https://github.com/login/device/code
  return apiError("unauthorized", "GitHub device flow not yet implemented.");
}

async function handleDevicePoll(req: Request, env: Env): Promise<Response> {
  // TODO: real GitHub device flow. Until then only the explicit dev stub works.
  if (!devStubEnabled(env)) return apiError("unauthorized", "GitHub device flow not yet implemented.");

  const { device_code } = (await req.json()) as { device_code: string };
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
  const body: DevicePollResponse = { session_token, user };
  return json(body);
}
