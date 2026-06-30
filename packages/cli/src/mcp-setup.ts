/**
 * Register the Ayo MCP server with Codex and Claude Code so the agent tools
 * (send_ayo, share_context, create_handoff, team_status, set_status,
 * resolve_ayo, read_inbox) are callable from inside the agent.
 *
 *  - Claude Code: via the official `claude mcp` CLI (it owns its config format).
 *  - Codex: a `[mcp_servers.ayo]` table in ~/.codex/config.toml.
 *
 * Idempotent and non-destructive, mirroring `ayo hooks install`.
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

// ── Public commands ──────────────────────────────────────────────────────────

export function mcpInstall(which: { claude: boolean; codex: boolean }): void {
  let errored = false;
  if (which.claude) {
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
  if (which.codex) {
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
}

export function mcpUninstall(which: { claude: boolean; codex: boolean }): void {
  if (which.claude) {
    console.log(
      {
        removed: pc.green("✓ removed from Claude Code"),
        absent: pc.dim("• Claude Code: not registered"),
        unavailable: pc.dim("• `claude` CLI not found"),
        error: pc.red("✗ `claude mcp remove` failed"),
      }[uninstallClaude()],
    );
  }
  if (which.codex) {
    console.log(
      {
        removed: pc.green("✓ removed from ~/.codex/config.toml"),
        absent: pc.dim("• Codex: nothing to remove"),
        error: pc.red("✗ could not write ~/.codex/config.toml"),
      }[uninstallCodex()],
    );
  }
}
