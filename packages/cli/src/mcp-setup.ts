/**
 * Register the Ayo MCP server with the user's agents so the tools (send_ayo,
 * share_context, create_handoff, team_status, set_status, resolve_ayo,
 * read_inbox) are callable from inside the agent.
 *
 *  - Claude Code: via the official `claude mcp` CLI (it owns its config format).
 *  - Codex: a `[mcp_servers.ayo]` table in ~/.codex/config.toml.
 *  - Cursor (+ future JSON hosts): an `mcpServers.ayo` entry in the host's
 *    config (~/.cursor/mcp.json). Add more in JSON_HOSTS.
 *
 * The daemon is the universal receiver (toast + sound fire regardless of tool),
 * so adding a host is cheap and unlocks that whole tool's users. Idempotent and
 * non-destructive, mirroring `ayo hooks install`.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import pc from "picocolors";

const SERVER_NAME = "ayo";
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

/** How to launch the Ayo MCP server. Uses the sibling build in dev; falls back
 *  to the published package once installed from npm.
 *  NOTE: in dev the absolute dist path is baked into the agent config — re-run
 *  `ayo mcp install` if you move the repo or wipe packages/mcp/dist. */
function serverCommand(): { command: string; args: string[] } {
  // cli runs from packages/cli/dist/<this>.js; the mcp server is a sibling pkg.
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "dist", "index.js");
  // Only bake an absolute path for a DEV checkout (local source, so `ayo mcp
  // install` picks up local changes). For a published install (under
  // node_modules), use `npx @ayo-dev/mcp` — never pin a machine-specific path
  // into the user's agent config that would break on reinstall / version bump.
  const isDevCheckout = !import.meta.url.includes("node_modules");
  if (isDevCheckout && existsSync(entry)) return { command: process.execPath, args: [entry] };
  return { command: "npx", args: ["-y", "@ayo-dev/mcp"] };
}

/** A TOML basic-string literal with backslash, quote, and control chars escaped. */
function tomlStr(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/** Write a config file atomically (temp + rename) so a crash mid-write can't
 *  leave it half-written. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.ayo-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ── Claude Code (official CLI) ───────────────────────────────────────────────

function claudeAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function claudeInstalled(): boolean {
  try {
    execFileSync("claude", ["mcp", "get", SERVER_NAME], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installClaude(): "installed" | "already" | "unavailable" | "error" {
  if (!claudeAvailable()) return "unavailable";
  if (claudeInstalled()) return "already";
  const { command, args } = serverCommand();
  try {
    execFileSync("claude", ["mcp", "add", "-s", "user", SERVER_NAME, "--", command, ...args], { stdio: "ignore" });
    return "installed";
  } catch {
    return "error";
  }
}

function uninstallClaude(): "removed" | "absent" | "unavailable" | "error" {
  if (!claudeAvailable()) return "unavailable";
  if (!claudeInstalled()) return "absent";
  try {
    execFileSync("claude", ["mcp", "remove", "-s", "user", SERVER_NAME], { stdio: "ignore" });
    return "removed";
  } catch {
    return "error"; // e.g. scope mismatch — don't crash the CLI
  }
}

// ── Codex (TOML) ─────────────────────────────────────────────────────────────

const codexHeader = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, "m");

function codexBlock(): string {
  const { command, args } = serverCommand();
  const argList = args.map(tomlStr).join(", ");
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlStr(command)}\nargs = [${argList}]\n`;
}

function codexInstalled(): boolean {
  return existsSync(CODEX_CONFIG) && codexHeader.test(readFileSync(CODEX_CONFIG, "utf8"));
}

function installCodex(): "installed" | "already" | "error" {
  try {
    const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
    if (codexHeader.test(text)) return "already";
    mkdirSync(dirname(CODEX_CONFIG), { recursive: true });
    // A [table] block is self-contained, so appending at EOF is safe (unlike a
    // bare top-level key, which a preceding table would capture).
    const sep = text.trim() ? `${text.replace(/\s*$/, "")}\n\n` : "";
    writeAtomic(CODEX_CONFIG, sep + codexBlock());
    return "installed";
  } catch {
    return "error";
  }
}

function uninstallCodex(): "removed" | "absent" | "error" {
  if (!codexInstalled()) return "absent";
  try {
    const lines = readFileSync(CODEX_CONFIG, "utf8").split("\n");
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`).test(line)) {
        skipping = true; // drop the header + its keys
        continue;
      }
      if (skipping && /^\s*\[/.test(line)) skipping = false; // next table begins
      if (!skipping) out.push(line);
    }
    // Tidy only the seam: collapse runs of 3+ blank lines and trim trailing
    // whitespace to a single newline. Leave leading content untouched.
    const cleaned = `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
    writeAtomic(CODEX_CONFIG, cleaned);
    return "removed";
  } catch {
    return "error";
  }
}

// ── JSON hosts (Cursor, and easily Windsurf/VS Code/Zed later) ───────────────
// These all store MCP servers the same way: a top-level `mcpServers` object keyed
// by server name. Adding another is a one-liner in JSON_HOSTS.

interface JsonHost {
  key: string;
  label: string;
  path: string;
}

const JSON_HOSTS: readonly JsonHost[] = [
  { key: "cursor", label: "Cursor", path: join(homedir(), ".cursor", "mcp.json") },
  // Same `mcpServers` shape, so a one-line add: Windsurf
  // (~/.codeium/windsurf/mcp_config.json). NOTE: VS Code (`servers` key) and Zed
  // (`context_servers`, JSONC) use a DIFFERENT shape — they'd need their own
  // factory, not this one.
] as const;

/** A plain JSON object (not null, not an array, not a primitive). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a config file into a plain object. null = unreadable/unparseable/not a
 *  plain object — callers must NOT clobber it (we'd lose the user's data). */
function readConfigObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonHostInstalled(path: string): boolean {
  const cfg = readConfigObject(path);
  const servers = cfg?.mcpServers;
  return isPlainObject(servers) && Boolean(servers[SERVER_NAME]);
}

function installJsonHost(path: string): "installed" | "already" | "absent" | "error" {
  // Only register if the host is actually present — don't create its config dir
  // for someone who doesn't use it.
  if (!existsSync(dirname(path))) return "absent";
  try {
    // null = unparseable OR not a plain object (array / primitive). Either way,
    // bail rather than clobber — overwriting would wipe the user's other servers
    // (JSON.stringify silently drops non-index props of an array, etc.).
    const cfg = readConfigObject(path);
    if (cfg === null) return "error";
    // Same guard one level down: an mcpServers that isn't a plain object would be
    // silently replaced by the spread below, losing its contents.
    const existing = cfg.mcpServers;
    if (existing !== undefined && !isPlainObject(existing)) return "error";
    if (isPlainObject(existing) && existing[SERVER_NAME]) return "already";
    const { command, args } = serverCommand();
    cfg.mcpServers = { ...(existing ?? {}), [SERVER_NAME]: { command, args } };
    writeAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
    return "installed";
  } catch {
    return "error";
  }
}

function uninstallJsonHost(path: string): "removed" | "absent" | "error" {
  // jsonHostInstalled already guarantees a plain-object cfg with a plain-object
  // mcpServers containing our key, but re-read defensively rather than clobber.
  if (!jsonHostInstalled(path)) return "absent";
  try {
    const cfg = readConfigObject(path);
    if (cfg === null || !isPlainObject(cfg.mcpServers)) return "error";
    delete cfg.mcpServers[SERVER_NAME];
    if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
    writeAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
    return "removed";
  } catch {
    return "error";
  }
}

// ── Public commands ──────────────────────────────────────────────────────────

/** All hosts `ayo mcp install` knows about (used to build the default "all" set). */
export const MCP_HOSTS: readonly string[] = ["claude", "codex", ...JSON_HOSTS.map((h) => h.key)];

/** `hosts` is a set of keys from MCP_HOSTS. */
export function mcpInstall(hosts: Set<string>): void {
  let errored = false;
  if (hosts.has("claude")) {
    const r = installClaude();
    if (r === "error") errored = true;
    console.log(
      {
        installed: pc.green("✓ registered with Claude Code") + pc.dim(" (user scope)"),
        already: pc.dim("• already registered with Claude Code"),
        unavailable: pc.yellow("! `claude` CLI not found — skipping Claude Code"),
        error: pc.red("✗ `claude mcp add` failed"),
      }[r],
    );
  }
  if (hosts.has("codex")) {
    const r = installCodex();
    if (r === "error") errored = true;
    console.log(
      {
        installed: pc.green("✓ added [mcp_servers.ayo] to ~/.codex/config.toml"),
        already: pc.dim("• already in ~/.codex/config.toml"),
        error: pc.red("✗ could not write ~/.codex/config.toml"),
      }[r],
    );
  }
  for (const h of JSON_HOSTS) {
    if (!hosts.has(h.key)) continue;
    const r = installJsonHost(h.path);
    if (r === "error") errored = true;
    console.log(
      {
        installed: pc.green(`✓ added ayo to ${h.label}`) + pc.dim(` (${h.path})`),
        already: pc.dim(`• already in ${h.label}'s config`),
        absent: pc.yellow(`! ${h.label} not found — skipping`),
        error: pc.red(`✗ could not write ${h.label}'s config (${h.path})`),
      }[r],
    );
  }
  if (errored) {
    console.log(pc.yellow("\n! Some steps failed. Run `ayo mcp uninstall` to roll back, then retry."));
  } else {
    console.log(pc.dim("\nRestart your agent for the Ayo tools to appear."));
  }
}

export function mcpStatus(): void {
  const claude = claudeAvailable() ? (claudeInstalled() ? pc.green("● registered") : pc.dim("○ not registered")) : pc.dim("— claude CLI not found");
  console.log(`Claude Code: ${claude}`);
  console.log(`Codex:       ${codexInstalled() ? pc.green("● registered") : pc.dim("○ not registered")}  ${pc.dim(CODEX_CONFIG)}`);
  for (const h of JSON_HOSTS) {
    const present = existsSync(dirname(h.path));
    const state = !present
      ? pc.dim("— not found")
      : jsonHostInstalled(h.path)
        ? pc.green("● registered")
        : pc.dim("○ not registered");
    console.log(`${h.label}:${" ".repeat(Math.max(1, 12 - h.label.length))}${state}  ${pc.dim(h.path)}`);
  }
}

/** `hosts` is a set of keys from MCP_HOSTS. */
export function mcpUninstall(hosts: Set<string>): void {
  if (hosts.has("claude")) {
    console.log(
      {
        removed: pc.green("✓ removed from Claude Code"),
        absent: pc.dim("• Claude Code: not registered"),
        unavailable: pc.dim("• `claude` CLI not found"),
        error: pc.red("✗ `claude mcp remove` failed"),
      }[uninstallClaude()],
    );
  }
  if (hosts.has("codex")) {
    console.log(
      {
        removed: pc.green("✓ removed from ~/.codex/config.toml"),
        absent: pc.dim("• Codex: nothing to remove"),
        error: pc.red("✗ could not write ~/.codex/config.toml"),
      }[uninstallCodex()],
    );
  }
  for (const h of JSON_HOSTS) {
    if (!hosts.has(h.key)) continue;
    console.log(
      {
        removed: pc.green(`✓ removed from ${h.label}`),
        absent: pc.dim(`• ${h.label}: nothing to remove`),
        error: pc.red(`✗ could not write ${h.label}'s config (${h.path})`),
      }[uninstallJsonHost(h.path)],
    );
  }
}
