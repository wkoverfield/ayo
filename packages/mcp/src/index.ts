#!/usr/bin/env node
/**
 * Ayo MCP server — exposes Ayo to Codex & Claude so a developer can send pings,
 * share work context, hand off, and manage status without leaving the agent.
 * Receiving in real time is still the daemon's job (ADR 0001); these tools are
 * send + pull. Identity is shared with the CLI via ~/.ayo (see relay.ts).
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AyoContext, SendAyoResponse } from "@ayo-dev/core";
import { loadAuth, relay } from "./relay.js";
import { captureContext } from "./context.js";

// Real version from package.json (dist/index.js → ../package.json, always packed).
function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({ name: "ayo", version: pkgVersion() });

const recipients = z.array(z.string().min(1)).min(1).describe('Handles to ping. Use ["*"] for the whole team.');

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** What was sent, plus the work context that was attached — so the agent/user
 *  can sanity-check the captured repo before trusting the handoff. */
function sentSummary(res: SendAyoResponse, ctx?: AyoContext): string {
  const live = res.deliveredTo.join(", ") || "none";
  const queued = res.queuedFor.join(", ") || "none";
  // Surface handles that matched no teammate so the agent doesn't report success
  // for a ping that reached no one (a typo'd or not-yet-joined handle).
  const unknown = res.unknownRecipients ?? [];
  const warn = unknown.length ? ` ⚠ No such teammate (reached no one): ${unknown.join(", ")}.` : "";
  const held = res.heldFor ?? [];
  const focus = held.length
    ? ` Held for focus — heads-down, no toast; they'll see it when they next check their inbox: ${held.join(", ")}.`
    : "";
  const where = ctx?.repo
    ? ` Context: ${ctx.repo}@${ctx.branch ?? "?"}, ${ctx.changedFiles?.length ?? 0} changed file(s)${ctx.diff ? ", full diff included" : ""}.`
    : "";
  return `Sent ${res.id}. Delivered (online): ${live}. Queued (offline): ${queued}.${warn}${focus}${where}`;
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
    "context (repo, branch, changed files) is attached automatically — no diff.",
  {
    to: recipients,
    body: z.string().min(1).describe("The message."),
    urgent: z.boolean().optional().describe("Mark urgent (can override do-not-disturb)."),
    note: z.string().optional().describe("Optional extra note to attach as context."),
  },
  async ({ to, body, urgent, note }) => {
    const auth = loadAuth();
    const ctx = withNote(captureContext(), note); // auto lightweight context, no diff
    const res = await relay.send(auth, { to, body, kind: "ping", urgency: urgent ? "urgent" : "normal", context: ctx });
    return text(sentSummary(res, ctx));
  },
);

// ── read_inbox ───────────────────────────────────────────────────────────────
server.tool(
  "read_inbox",
  "Read your Ayo inbox (pings sent to you) with their work context. Surfacing " +
    "in the agent does NOT mark them read — that needs an explicit human action.",
  { unreadOnly: z.boolean().optional().describe("Only unread (default true).") },
  async ({ unreadOnly }) => {
    const auth = loadAuth();
    const { ayos } = await relay.inbox(auth, unreadOnly ?? true);
    if (ayos.length === 0) return text("Inbox zero — no Ayos.");
    return text(JSON.stringify(ayos, null, 2));
  },
);

// ── share_context ────────────────────────────────────────────────────────────
server.tool(
  "share_context",
  "Send a teammate your current work state — repo, branch, changed files, diff " +
    "stat, and (only if withDiff) the full diff. The diff covers all uncommitted " +
    "changes (staged AND unstaged) and may contain secrets, so it is opt-in.",
  {
    to: recipients,
    message: z.string().optional().describe("Optional note to go with the context."),
    withDiff: z.boolean().optional().describe("Include the full git diff (default false; may contain secrets)."),
  },
  async ({ to, message, withDiff }) => {
    const auth = loadAuth();
    const ctx = captureContext({ withDiff: withDiff ?? false });
    if (!ctx) return text("Not in a git repo — nothing to share. Use send_ayo for a plain ping.");
    const res = await relay.send(auth, { to, body: message ?? "Sharing my current context.", kind: "ping", context: ctx });
    return text(sentSummary(res, ctx));
  },
);

// ── create_handoff ───────────────────────────────────────────────────────────
server.tool(
  "create_handoff",
  "When the human needs to hand work to a teammate, use this — it packages the " +
    "branch, changed files, diff stat, and the blocker into one Ayo, and returns a " +
    "shareable link that renders the context for someone not yet on Ayo (so it " +
    "works even if the teammate isn't set up). Return the link to the human — and " +
    "if they ask you to deliver it, use YOUR OWN tools (gh pr comment, Slack MCP, " +
    "etc.); Ayo mints the artifact, you carry it. Set withDiff to include the full " +
    "diff — it covers all uncommitted changes (staged AND unstaged) and may " +
    "contain secrets, so it is OFF by default; only enable it when the human " +
    "intends to share code.",
  {
    to: recipients,
    blocker: z.string().min(1).describe("What you're stuck on / what they need to pick up."),
    note: z.string().optional().describe("A short summary of the state and next steps."),
    withDiff: z.boolean().optional().describe("Attach the full git diff (default false; may contain secrets)."),
    urgent: z.boolean().optional(),
    link: z
      .boolean()
      .optional()
      .describe("Also mint a shareable web link that works for people not yet on Ayo (default true)."),
    includeJoinCode: z
      .boolean()
      .optional()
      .describe("Embed the team join code in the link so a non-user installs → joins in one step (default true). Set false to share context without granting join access."),
  },
  async ({ to, blocker, note, withDiff, urgent, link, includeJoinCode }) => {
    const auth = loadAuth();
    // rawCtx feeds the link untouched; the send gets the note folded in. Passing
    // rawCtx (not ctx) to the link avoids storing the note twice in the snapshot.
    const rawCtx = captureContext({ withDiff: withDiff ?? false });
    const ctx = withNote(rawCtx, note);
    const res = await relay.send(auth, { to, body: blocker, kind: "handoff", urgency: urgent ? "urgent" : "normal", context: ctx });
    let out = `Handoff — ${sentSummary(res, ctx)}`;
    // The Loom mechanic: a public link a non-user can open. Best-effort — the
    // handoff already sent, so a link failure must not fail the tool call.
    if (link !== false) {
      try {
        const l = await relay.createHandoffLink(auth, { blocker, note, context: rawCtx, includeJoinCode });
        out += `\nShare link (works before they're on Ayo): ${l.url}`;
      } catch (err) {
        out += `\n(couldn't mint a share link: ${err instanceof Error ? err.message : "unknown"})`;
      }
    }
    return text(out);
  },
);

// ── request_approval (the ask: block until the human answers) ────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

server.tool(
  "request_approval",
  "Ask your human a blocking question and WAIT for their answer — use before " +
    "irreversible or judgment calls (deploy, spend, delete, send, pick between " +
    "approaches). The ask lands in their Ayo inbox/toast wherever they are (it " +
    "reaches them even heads-down — it's their own work) and this call blocks " +
    "until they answer or the timeout passes. On timeout you get timedOut:true — " +
    "proceed with your best judgment AND tell the human what you chose (send_ayo).",
  {
    question: z.string().min(1).max(4096).describe("The decision you need, phrased so a one-word answer works."),
    options: z
      .array(z.string().min(1).max(80))
      .max(8)
      .optional()
      .describe("Suggested answers (rendered as ready-made commands). Free text is always allowed too."),
    note: z.string().optional().describe("Short context: what you tried, tradeoffs, your recommendation."),
    timeoutMinutes: z.number().min(1).max(240).optional().describe("How long to wait (default 30)."),
  },
  async ({ question, options, note, timeoutMinutes }) => {
    const auth = loadAuth();
    const minutes = timeoutMinutes ?? 30;
    const deadline = Date.now() + minutes * 60_000;
    const ctx = withNote(captureContext(), note);
    const res = await relay.send(auth, {
      to: [auth.handle], // self-addressed: your agent asks YOU
      body: question,
      kind: "ask",
      ask: { options },
      context: ctx,
      expiresAt: new Date(deadline).toISOString(),
    });
    // Short-poll until answered or the deadline. 3s keeps the human wait snappy
    // without hammering the relay (~20 req/min while blocked).
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        const state = await relay.askState(auth, res.id);
        if (state.answered && state.answer) {
          return text(
            `Answered by ${state.answer.by}: "${state.answer.answer}" (after ${Math.round((Date.now() - (deadline - minutes * 60_000)) / 60_000)}m). Proceed accordingly.`,
          );
        }
        if (state.expired) break;
      } catch {
        /* transient poll failure — keep waiting until the deadline */
      }
    }
    return text(
      `timedOut:true — no answer after ${minutes}m. Proceed with your best judgment, state your choice clearly, and send_ayo the human a note about what you decided and why.`,
    );
  },
);

// ── team_status ──────────────────────────────────────────────────────────────
server.tool(
  "team_status",
  "See who's on the team, who's online, and their status (e.g. 'heads-down on demo').",
  {},
  async () => {
    const auth = loadAuth();
    const { members } = await relay.members(auth);
    if (members.length === 0) return text("No members yet.");
    const lines = members.map((m) => {
      const note = m.statusText ? ` — "${m.statusText}"` : "";
      return `• ${m.handle} [${m.online ? "online" : "offline"}, ${m.status}]${note}`;
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
      .describe("Presence state — active | heads-down | away | dnd. Omit to default to heads-down. dnd suppresses normal pings."),
  },
  async ({ statusText, status }) => {
    const auth = loadAuth();
    // NOTE: deliberately differs from the `ayo status` CLI, which PRESERVES your
    // current availability when only text is given. Here the agent is acting on an
    // explicit "set my status" intent, so an omitted status defaults to heads-down
    // (the agent can pass `active` to stay reachable).
    const presence = status ?? "heads-down";
    await relay.setStatus(auth, { status: presence, statusText });
    return text(`Status set: ${presence} — "${statusText}"`);
  },
);

// ── resolve_ayo ──────────────────────────────────────────────────────────────
server.tool(
  "resolve_ayo",
  "Close the loop on an Ayo you've dealt with (marks it resolved for the sender).",
  {
    ayoId: z
      .string()
      .regex(/^ayo_[0-9A-HJKMNP-TV-Z]{26}$/, "must be an Ayo id like ayo_01J9Z3…")
      .describe("The Ayo id from read_inbox (the `id` field, not `from.id`)."),
  },
  async ({ ayoId }) => {
    const auth = loadAuth();
    await relay.resolve(auth, ayoId);
    return text(`Resolved ${ayoId}.`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
