/**
 * Local config + session at ~/.ayo/. The daemon and the one-shot CLI both read
 * these. `session.json` holds the opaque session token (ADR 0002).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const AYO_DIR = join(homedir(), ".ayo");
const CONFIG_PATH = join(AYO_DIR, "config.json");
const SESSION_PATH = join(AYO_DIR, "session.json");

export interface Config {
  /** Relay base URL. Defaults to local dev. */
  relayUrl: string;
  /** The team `ayo <handle> ...` sends to by default. */
  activeTeamId?: string;
  /** Optional local aliases: alias -> handle. */
  aliases?: Record<string, string>;
}

export interface Session {
  token: string;
  userId: string;
  handle: string;
}

const DEFAULT_CONFIG: Config = {
  relayUrl: process.env.AYO_RELAY_URL ?? "http://127.0.0.1:8787",
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

export function requireSession(): Session {
  const s = loadSession();
  if (!s) {
    console.error("Not logged in. Run `ayo login` first.");
    process.exit(1);
  }
  return s;
}

/** Resolve an alias to a handle, falling back to the input. */
export function resolveHandle(cfg: Config, name: string): string {
  return cfg.aliases?.[name] ?? name;
}
