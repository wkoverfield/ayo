/**
 * Inbound webhooks — "one curl → Ayo". A team member mints a revocable,
 * unguessable URL; any external system POSTs to it to fire an Ayo into the team.
 *
 * The inbound Ayo is attributed to the CREATING member's identity (no synthetic
 * bot user — that stays a follow-up), with the hook's label prefixed so the
 * recipient sees the source. Suppression is free: the ping goes through the
 * normal DO send path, so heads-down/dnd recipients get the "held" state.
 */

import type { Handle, TeamId, UserId } from "@ayo-dev/core";
import type { Env } from "./env.js";
import { urlSafeToken } from "./token.js";

export interface WebhookMeta {
  teamId: TeamId;
  /** The creator — inbound Ayos are attributed to them (they must be a member). */
  userId: UserId;
  handle: Handle;
  /** Human source name shown in the ping, e.g. "ci", "github", "cron". */
  label: string;
  /** Default recipient handle; absent = broadcast to the team. */
  to?: Handle;
  createdAt: string;
}

/** The listable view of a hook — never re-derives the URL here (the route does).
 *  `createdBy` gates who may see the raw token (only the creator; see the list
 *  route). Internal to this module — callers use core's WebhookInfo. */
interface WebhookRow {
  token: string;
  label: string;
  to?: Handle;
  createdAt: string;
  createdBy: Handle;
}

export async function createWebhook(env: Env, meta: WebhookMeta): Promise<string> {
  const token = urlSafeToken(16);
  const row: WebhookRow = {
    token,
    label: meta.label,
    to: meta.to,
    createdAt: meta.createdAt,
    createdBy: meta.handle,
  };
  // Write the reverse index FIRST: KV has no transactions, so if we crash between
  // the two puts, a listable-but-not-yet-fireable hook (revocable, fires 404) is
  // the safe failure — the reverse order would leave a LIVE, unlistable, hence
  // unrevocable hook.
  await env.AYO_KV.put(`teamhook:${meta.teamId}:${token}`, JSON.stringify(row));
  await env.AYO_KV.put(`hook:${token}`, JSON.stringify(meta));
  return token;
}

export async function getWebhook(env: Env, token: string): Promise<WebhookMeta | null> {
  const raw = await env.AYO_KV.get(`hook:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WebhookMeta;
  } catch {
    return null;
  }
}

/** Delete a hook. Returns the removed meta (or null if it didn't exist). */
export async function deleteWebhook(env: Env, token: string): Promise<WebhookMeta | null> {
  const meta = await getWebhook(env, token);
  if (!meta) return null;
  await env.AYO_KV.delete(`hook:${token}`);
  await env.AYO_KV.delete(`teamhook:${meta.teamId}:${token}`);
  return meta;
}

export async function listWebhooks(env: Env, teamId: TeamId): Promise<WebhookRow[]> {
  const list = await env.AYO_KV.list({ prefix: `teamhook:${teamId}:` });
  const rows: WebhookRow[] = [];
  for (const key of list.keys) {
    const raw = await env.AYO_KV.get(key.name);
    if (raw) {
      try {
        rows.push(JSON.parse(raw) as WebhookRow);
      } catch {
        /* skip a corrupt row */
      }
    }
  }
  return rows;
}
