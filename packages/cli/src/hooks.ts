/**
 * Install/inspect/remove the agent hooks.
 *
 *  - Claude Code: SessionStart + UserPromptSubmit run `ayo agent-context`, whose
 *    stdout Claude injects into the model. (Stop is NOT used — its stdout goes
 *    to the debug log, not the model.)
 *  - Codex: `notify` runs `ayo notify-check` on agent-turn-complete. Codex can't
 *    inject into its closed UI, so this is the toast fallback only.
 *
 * Everything is idempotent and non-destructive: we never clobber a user's other
 * hooks or an existing Codex `notify`.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

/** Absolute path to the installed `ayo` entry, so hooks work without PATH. */
function ayoBin(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ayo.js");
}

function claudeCommand(): string {
  return `"${process.execPath}" "${ayoBin()}" agent-context`;
}

function isAyoClaudeHook(cmd: unknown): boolean {
  return typeof cmd === "string" && cmd.includes("agent-context");
}

// ── Claude ───────────────────────────────────────────────────────────────────

interface HookEntry {
  hooks: { type: string; command: string; timeout?: number }[];
  matcher?: string;
}
interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function installClaude(): "installed" | "already" | "error" {
  try {
    // Distinguish absent (safe to create) from present-but-malformed (must NOT
    // overwrite — that would clobber the user's whole settings file).
    if (existsSync(CLAUDE_SETTINGS) && readJson<ClaudeSettings>(CLAUDE_SETTINGS) === null) {
      return "error";
    }
    const settings: ClaudeSettings = readJson<ClaudeSettings>(CLAUDE_SETTINGS) ?? {};
    settings.hooks ??= {};
    let changed = false;
    for (const event of CLAUDE_EVENTS) {
      const groups = (settings.hooks[event] ??= []);
      const present = groups.some((g) => g.hooks?.some((h) => isAyoClaudeHook(h.command)));
      if (!present) {
        groups.push({ hooks: [{ type: "command", command: claudeCommand(), timeout: 10 }] });
        changed = true;
      }
    }
    if (!changed) return "already";
    mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    return "installed";
  } catch {
    return "error";
  }
}

function uninstallClaude(): "removed" | "absent" {
  const settings = readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  if (!settings?.hooks) return "absent";
  let changed = false;
  for (const event of CLAUDE_EVENTS) {
    const groups = settings.hooks[event];
    if (!groups) continue;
    const filtered = groups
      .map((g) => ({ ...g, hooks: g.hooks?.filter((h) => !isAyoClaudeHook(h.command)) ?? [] }))
      .filter((g) => g.hooks.length > 0);
    if (filtered.length !== groups.length) changed = true;
    if (filtered.length > 0) settings.hooks[event] = filtered;
    else delete settings.hooks[event];
  }
  if (!changed) return "absent";
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return "removed";
}

function claudeInstalled(): boolean {
  const settings = readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  return CLAUDE_EVENTS.every((e) =>
    settings?.hooks?.[e]?.some((g) => g.hooks?.some((h) => isAyoClaudeHook(h.command))),
  );
}

// ── Codex ────────────────────────────────────────────────────────────────────

/** A TOML basic (double-quoted) string with backslashes/quotes escaped. Single-
 *  quoted TOML literals can't represent a `'` in a path or Windows backslashes,
 *  so we must use basic strings here. */
function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function codexNotifyLine(): string {
  return `notify = [${tomlString(process.execPath)}, ${tomlString(ayoBin())}, "notify-check"]`;
}

function codexHasOurNotify(text: string): boolean {
  return /^\s*notify\s*=.*notify-check/m.test(text);
}
function codexHasAnyNotify(text: string): boolean {
  return /^\s*notify\s*=/m.test(text);
}

function installCodex(): "installed" | "already" | "conflict" {
  const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
  if (codexHasOurNotify(text)) return "already";
  if (codexHasAnyNotify(text)) return "conflict"; // someone else owns notify — don't clobber
  // Prepend so it's a top-level key (never captured by a [table] section).
  const block = `# Ayo: surface unread pings on turn completion\n${codexNotifyLine()}\n\n`;
  mkdirSync(dirname(CODEX_CONFIG), { recursive: true });
  writeFileSync(CODEX_CONFIG, block + text);
  return "installed";
}

function uninstallCodex(): "removed" | "absent" {
  if (!existsSync(CODEX_CONFIG)) return "absent";
  const text = readFileSync(CODEX_CONFIG, "utf8");
  if (!codexHasOurNotify(text)) return "absent";
  const cleaned = text
    .split("\n")
    .filter((l) => !/^\s*notify\s*=.*notify-check/.test(l) && l.trim() !== "# Ayo: surface unread pings on turn completion")
    .join("\n")
    .replace(/^\n+/, ""); // drop the leading blank line(s) our block left behind
  writeFileSync(CODEX_CONFIG, cleaned);
  return "removed";
}

function codexInstalled(): boolean {
  return existsSync(CODEX_CONFIG) && codexHasOurNotify(readFileSync(CODEX_CONFIG, "utf8"));
}

// ── Public commands ──────────────────────────────────────────────────────────

export function hooksInstall(which: { claude: boolean; codex: boolean }): void {
  if (which.claude) {
    const r = installClaude();
    const msg = {
      installed: pc.green(`✓ Claude Code hooks installed`) + pc.dim(" (SessionStart, UserPromptSubmit)"),
      already: pc.dim("• Claude Code hooks already present"),
      error: pc.red("✗ ~/.claude/settings.json is malformed — fix it and re-run (left untouched)"),
    }[r];
    console.log(msg);
  }
  if (which.codex) {
    const r = installCodex();
    const msg = {
      installed: pc.green(`✓ Codex notify installed`) + pc.dim(" (toast fallback on turn-complete)"),
      already: pc.dim("• Codex notify already points at Ayo"),
      conflict:
        pc.yellow("! Codex already has a `notify` set — left untouched.\n") +
        pc.dim(`  To use Ayo's, set it manually:\n  ${codexNotifyLine()}`),
    }[r];
    console.log(msg);
  }
  console.log(pc.dim("\nRestart your agent session for hooks to take effect."));
}

export function hooksStatus(): void {
  console.log(`Claude Code: ${claudeInstalled() ? pc.green("● wired") : pc.dim("○ not wired")}  ${pc.dim(CLAUDE_SETTINGS)}`);
  console.log(`Codex:       ${codexInstalled() ? pc.green("● wired") : pc.dim("○ not wired")}  ${pc.dim(CODEX_CONFIG)}`);
}

export function hooksUninstall(which: { claude: boolean; codex: boolean }): void {
  if (which.claude) console.log(uninstallClaude() === "removed" ? pc.green("✓ Claude hooks removed") : pc.dim("• no Claude hooks to remove"));
  if (which.codex) console.log(uninstallCodex() === "removed" ? pc.green("✓ Codex notify removed") : pc.dim("• no Codex notify to remove"));
}
