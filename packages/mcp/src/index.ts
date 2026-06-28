#!/usr/bin/env node
/**
 * Ayo MCP server. Exposes Ayo to Codex & Claude so a developer can send and
 * read pings without leaving the agent. Receiving in real time is still the
 * daemon's job (ADR 0001) — these tools are pull + send.
 *
 * Scaffold: `send_ayo` and `read_inbox` are wired; the rest are declared as the
 * tool surface from the PRD and return a not-yet-implemented notice.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAuth, relay } from "./relay.js";

const server = new McpServer({ name: "ayo", version: "0.0.0" });

server.tool(
  "send_ayo",
  "Send an attention ping with work context to a teammate (or the whole team).",
  {
    to: z.array(z.string()).describe('Handles to ping. Use ["*"] for the whole team.'),
    body: z.string().describe("The message."),
    urgent: z.boolean().optional().describe("Mark urgent (overrides do-not-disturb)."),
    note: z.string().optional().describe("Optional handoff summary to attach as context."),
  },
  async ({ to, body, urgent, note }) => {
    const { teamId } = loadAuth();
    const res = await relay.send(teamId, {
      to,
      body,
      urgency: urgent ? "urgent" : "normal",
      context: note ? { note } : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: `Sent ayo ${res.id}. Live: ${res.deliveredTo.join(", ") || "none"}. Queued: ${res.queuedFor.join(", ") || "none"}.`,
        },
      ],
    };
  },
);

server.tool(
  "read_inbox",
  "Read your Ayo inbox. Returns unread pings with their work context.",
  { unreadOnly: z.boolean().optional() },
  async ({ unreadOnly }) => {
    const { teamId } = loadAuth();
    const { ayos } = await relay.inbox(teamId, unreadOnly ?? true);
    // Surfacing in the agent is NOT a human read; we do not mark read here.
    return { content: [{ type: "text", text: JSON.stringify(ayos, null, 2) }] };
  },
);

// ── Declared tool surface (PRD) — to be implemented ──────────────────────────
const TODO = ["set_status", "team_status", "create_handoff", "share_context", "resolve_ayo", "watch_team"];
for (const name of TODO) {
  server.tool(name, `(${name}) — declared; not yet implemented in this scaffold.`, {}, async () => ({
    content: [{ type: "text", text: `${name} is not implemented yet.` }],
  }));
}

const transport = new StdioServerTransport();
await server.connect(transport);
