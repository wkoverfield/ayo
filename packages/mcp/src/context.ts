/**
 * Work-context capture — one shared implementation in @ayo-dev/core/node
 * (also used by the CLI), re-exported for this server's tools. The MCP server
 * is spawned by Codex/Claude in the user's workspace, so process.cwd() is the
 * repo the developer is working in.
 */

export { captureContext } from "@ayo-dev/core/node";
