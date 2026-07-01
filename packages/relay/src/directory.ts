/**
 * The "directory" — non-realtime CRUD backed by KV. Users, teams, memberships,
 * join codes, and the ayoId -> teamId index. Realtime state (messages,
 * deliveries, presence, sockets) lives in the TeamHub Durable Object instead.
 */

import type { AyoId, Handle, TeamId, UserId } from "@ayo-dev/core";
import { newTeamId } from "@ayo-dev/core";
import type { Env } from "./env.js";

export interface TeamMeta {
  id: TeamId;
  name: string;
  joinCode: string;
  /** The creator — the only one who can rotate the join code. Optional for
   *  backward-compat with teams created before this field existed. */
  ownerId?: UserId;
  /** ISO timestamp the join code expires; absent = never. */
  codeExpiresAt?: string | null;
}

export interface Membership {
  teamId: TeamId;
  userId: UserId;
  handle: Handle;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function joinCode(): string {
  // A join code grants team membership — use CSPRNG, not Math.random().
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return s;
}

export async function createTeam(env: Env, name: string, ownerId?: UserId): Promise<TeamMeta> {
  const id = newTeamId();
  const code = joinCode();
  const meta: TeamMeta = { id, name, joinCode: code, ownerId, codeExpiresAt: null };
  await env.AYO_KV.put(`team:${id}`, JSON.stringify(meta));
  await env.AYO_KV.put(`joincode:${code}`, id);
  return meta;
}

/** Count current members of a team (for the size cap). */
export async function countMembers(env: Env, teamId: TeamId): Promise<number> {
  // list() paginates at 1000 keys; team sizes are far below the cap, so one page.
  const list = await env.AYO_KV.list({ prefix: `member:${teamId}:` });
  return list.keys.length;
}

/**
 * Rotate a team's join code: mint a new one, point it at the team, and DELETE the
 * old mapping so it stops working (revocation). Optional TTL auto-expires the new
 * code. Returns the new code + its expiry (or null).
 */
export async function rotateJoinCode(
  env: Env,
  team: TeamMeta,
  ttlSeconds?: number,
): Promise<{ joinCode: string; expiresAt: string | null }> {
  const code = joinCode();
  const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
  await env.AYO_KV.put(`joincode:${code}`, team.id, ttlSeconds ? { expirationTtl: ttlSeconds } : {});
  await env.AYO_KV.delete(`joincode:${team.joinCode}`); // revoke the old code
  const updated: TeamMeta = { ...team, joinCode: code, codeExpiresAt: expiresAt };
  await env.AYO_KV.put(`team:${team.id}`, JSON.stringify(updated));
  return { joinCode: code, expiresAt };
}

export async function getTeam(env: Env, id: TeamId): Promise<TeamMeta | null> {
  const raw = await env.AYO_KV.get(`team:${id}`);
  return raw ? (JSON.parse(raw) as TeamMeta) : null;
}

export async function teamByJoinCode(env: Env, code: string): Promise<TeamMeta | null> {
  const id = await env.AYO_KV.get(`joincode:${code.toUpperCase()}`);
  return id ? getTeam(env, id as TeamId) : null;
}

export async function addMember(env: Env, m: Membership): Promise<void> {
  await env.AYO_KV.put(`member:${m.teamId}:${m.userId}`, JSON.stringify(m));
  // Reverse index for `GET /v1/me`.
  await env.AYO_KV.put(`usermember:${m.userId}:${m.teamId}`, m.handle);
}

export async function getMembership(
  env: Env,
  teamId: TeamId,
  userId: UserId,
): Promise<Membership | null> {
  const raw = await env.AYO_KV.get(`member:${teamId}:${userId}`);
  return raw ? (JSON.parse(raw) as Membership) : null;
}

export async function teamsForUser(
  env: Env,
  userId: UserId,
): Promise<{ id: TeamId; name: string; handle: Handle }[]> {
  const list = await env.AYO_KV.list({ prefix: `usermember:${userId}:` });
  const out: { id: TeamId; name: string; handle: Handle }[] = [];
  for (const key of list.keys) {
    const teamId = key.name.split(":")[2] as TeamId;
    const team = await getTeam(env, teamId);
    const handle = (await env.AYO_KV.get(key.name)) ?? "";
    if (team) out.push({ id: team.id, name: team.name, handle });
  }
  return out;
}

/** Resolve which team an Ayo belongs to (index written by the team DO on send). */
export async function teamForAyo(env: Env, ayoId: AyoId): Promise<TeamId | null> {
  return (await env.AYO_KV.get(`ayoteam:${ayoId}`)) as TeamId | null;
}
