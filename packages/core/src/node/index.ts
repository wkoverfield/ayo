/**
 * `@ayo-dev/core/node` — Node-only shared code for relay CLIENTS (the CLI and
 * the MCP server): ~/.ayo IO, the relay HTTP transport, and git context
 * capture. The relay Worker imports the root `@ayo-dev/core` export and must
 * NEVER import this subpath (node:fs / node:child_process don't exist in
 * Workers).
 */

export * from "./files.js";
export * from "./http.js";
export * from "./git-context.js";
