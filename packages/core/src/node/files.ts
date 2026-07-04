/**
 * ~/.ayo config + session IO, shared by the CLI and the MCP server so both
 * always read/write the same shapes from the same place (one identity).
 *
 * Node-only (`node:fs`/`node:os`) — lives under the `@ayo-dev/core/node`
 * subpath so the relay Worker, which imports the root export, never pulls in
 * Node builtins. Policy stays with the callers: what to do when a session is
 * missing (the CLI exits with a hint, MCP throws for the agent) and how
 * AYO_RELAY_URL ranks against the config file are caller decisions.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { DEFAULT_RELAY_URL } from "../api.js";

/**
 * Where Ayo keeps session/config/inbox/daemon files. Defaults to ~/.ayo;
 * override with AYO_DIR to run multiple personas on one machine (handy for
 * self-testing and demos: `AYO_DIR=/tmp/ayo-maya ayo ...`).
 */
export const AYO_DIR = process.env.AYO_DIR ? resolve(process.env.AYO_DIR) : join(homedir(), ".ayo");
const CONFIG_PATH = join(AYO_DIR, "config.json");
const SESSION_PATH = join(AYO_DIR, "session.json");

export interface Config {
  /** Relay base URL. Defaults to the hosted relay (AYO_RELAY_URL overrides the default). */
  relayUrl: string;
  /** The team `ayo <handle> ...` sends to by default. */
  activeTeamId?: string;
  /** Optional local aliases: alias -> handle. */
  aliases?: Record<string, string>;
  /** Mute ALL incoming signature sounds (you still get the toast). Recipient wins. */
  muteSounds?: boolean;
  /** Mute specific senders' sounds, by handle. */
  mutedSenders?: string[];
}

export interface Session {
  token: string;
  userId: string;
  handle: string;
}

const DEFAULT_CONFIG: Config = {
  // Hosted Ayo relay. Override with AYO_RELAY_URL (local dev) or `relayUrl` in
  // ~/.ayo/config.json (self-hosters point this at their own deploy).
  relayUrl: process.env.AYO_RELAY_URL ?? DEFAULT_RELAY_URL,
};

function ensureDir(): void {
  if (!existsSync(AYO_DIR)) mkdirSync(AYO_DIR, { recursive: true });
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}

export function saveConfig(cfg: Config): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function loadSession(): Session | null {
  if (!existsSync(SESSION_PATH)) return null;
  return JSON.parse(readFileSync(SESSION_PATH, "utf8")) as Session;
}

export function saveSession(s: Session): void {
  ensureDir();
  writeFileSync(SESSION_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** Resolve an alias to a handle, falling back to the input. */
export function resolveHandle(cfg: Config, name: string): string {
  return cfg.aliases?.[name] ?? name;
}
