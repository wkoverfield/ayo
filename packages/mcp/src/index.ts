#!/usr/bin/env node
/**
 * Ayo MCP server — exposes Ayo to Codex & Claude so a developer can send pings,
 * share work context, hand off, and manage status without leaving the agent.
 * Receiving in real time is still the daemon's job (ADR 0001); these tools are
 * send + pull. Identity is shared with the CLI via ~/.ayo (see relay.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AyoContext, SendAyoResponse } from "@ayo-dev/core";
import { loadAuth, relay } from "./relay.js";
import { captureContext } from "./context.js";

const server = new McpServer({ name: "ayo", version: "0.0.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function sentSummary(res: SendAyoResponse): string {
  const live = res.deliveredTo.join(", ") || "none";
  const queued = res.queuedFor.join(", ") || "none";
  return `Sent ${res.id}. Delivered to (online): ${live}. Queued (offline): ${queued}.`;
}

/** Merge captured git context with an optional agent note. */
function withNote(ctx: AyoContext | undefined, note?: string): AyoContext | undefined {
  if (!ctx && !note) return undefined;
  return { ...(ctx ?? {}), ...(note ? { note } : {}) };
}

// ── send_ayo ─────────────────────────────────────────────────────────────────
server.tool(
  "send_ayo",
  "Ping a teammate (or the whole team) with a short message. Lightweight work " +
    "context (repo, branch, changed files) is attached automatically.",
  {
    to: z.array(z.string()).describe('Handles to ping. Use ["*"] for the whole team.'),
    body: z.string().min(1).describe("The message."),
    urgent: z.boolean().optional().describe("Mark urgent (can override do-not-disturb)."),
    note: z.string().optional().describe("Optional extra note to attach as context."),
  },
  async ({ to, body, urgent, note }) => {
    const { teamId } = loadAuth();
    const res = await relay.send(teamId, {
      to,
      body,
      urgency: urgent ? "urgent" : "normal",
      context: withNote(captureContext(), note), // auto lightweight context, no diff
    });
    return text(sentSummary(res));
  },
);

// ── read_inbox ───────────────────────────────────────────────────────────────
server.tool(
  "read_inbox",
  "Read your Ayo inbox (pings sent to you) with their work context. Surfacing " +
    "in the agent does NOT mark them read — that needs an explicit human action.",
  { unreadOnly: z.boolean().optional().describe("Only unread (default true).") },
  async ({ unreadOnly }) => {
    const { teamId } = loadAuth();
    const { ayos } = await relay.inbox(teamId, unreadOnly ?? true);
    if (ayos.length === 0) return text("Inbox zero — no Ayos.");
    return text(JSON.stringify(ayos, null, 2));
  },
);

// ── share_context ────────────────────────────────────────────────────────────
server.tool(
  "share_context",
  "Send a teammate your exact current work state — repo, branch, changed files, " +
    "diff stat, and (optionally) the full diff. For 'send me your state'.",
  {
    to: z.array(z.string()).describe('Handles. Use ["*"] for the whole team.'),
    message: z.string().optional().describe("Optional note to go with the context."),
    withDiff: z.boolean().optional().describe("Include the full git diff (default false)."),
  },
  async ({ to, message, withDiff }) => {
    const { teamId } = loadAuth();
    const ctx = captureContext({ withDiff: withDiff ?? false });
    if (!ctx) return text("Not in a git repo — nothing to share. Use send_ayo for a plain ping.");
    const res = await relay.send(teamId, {
      to,
      body: message ?? "Sharing my current context.",
      kind: "ping",
      context: ctx,
    });
    return text(sentSummary(res));
  },
);

// ── create_handoff ───────────────────────────────────────────────────────────
server.tool(
  "create_handoff",
  "Hand off your work to a teammate: packages your branch, changed files, diff, " +
    "and the blocker into one Ayo. Include a written summary for a clean handoff.",
  {
    to: z.array(z.string()).describe('Handles to hand off to. Use ["*"] for the team.'),
    blocker: z.string().min(1).describe("What you're stuck on / what they need to pick up."),
    note: z.string().optional().describe("A short summary of the state and next steps."),
    withDiff: z.boolean().optional().describe("Attach the full git diff (default true)."),
    urgent: z.boolean().optional(),
  },
  async ({ to, blocker, note, withDiff, urgent }) => {
    const { teamId } = loadAuth();
    const res = await relay.send(teamId, {
      to,
      body: blocker,
      kind: "handoff",
      urgency: urgent ? "urgent" : "normal",
      context: withNote(captureContext({ withDiff: withDiff ?? true }), note),
    });
    return text(`Handoff ${sentSummary(res)}`);
  },
);

// ── team_status ──────────────────────────────────────────────────────────────
server.tool(
  "team_status",
  "See who's on the team, who's online, and their status (e.g. 'heads-down on demo').",
  {},
  async () => {
    const { teamId } = loadAuth();
    const { members } = await relay.members(teamId);
    if (members.length === 0) return text("No members yet.");
    const lines = members.map((m) => {
      const dot = m.online ? "online" : "offline";
      const note = m.statusText ? ` — "${m.statusText}"` : "";
      return `• ${m.handle} [${dot}, ${m.status}]${note}`;
    });
    return text(lines.join("\n"));
  },
);

// ── set_status ───────────────────────────────────────────────────────────────
server.tool(
  "set_status",
  "Set your status so teammates know what you're doing, e.g. 'locked in on demo'.",
  {
    statusText: z.string().describe('Free text, e.g. "locked in on the deploy".'),
    status: z
      .enum(["active", "heads-down", "away", "dnd"])
      .optional()
      .describe("Presence state (default heads-down). dnd = do not disturb."),
  },
  async ({ statusText, status }) => {
    const { teamId } = loadAuth();
    await relay.setStatus(teamId, { status: status ?? "heads-down", statusText });
    return text(`Status set: ${status ?? "heads-down"} — "${statusText}"`);
  },
);

// ── resolve_ayo ──────────────────────────────────────────────────────────────
server.tool(
  "resolve_ayo",
  "Close the loop on an Ayo you've dealt with (marks it resolved for the sender).",
  { ayoId: z.string().describe("The Ayo id, e.g. ayo_01J… (from read_inbox).") },
  async ({ ayoId }) => {
    loadAuth();
    await relay.resolve(ayoId);
    return text(`Resolved ${ayoId}.`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
