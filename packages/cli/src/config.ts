/**
 * Local config + session at ~/.ayo/. The daemon and the one-shot CLI both read
 * these. `session.json` holds the opaque session token (see docs/protocol.md).
 *
 * The types and file IO live in @ayo-dev/core/node (shared with the MCP server
 * so both always read the same shapes); this module re-exports them and keeps
 * the CLI-only policy: daemon file paths and the exit-with-a-hint session gate.
 */

import { join } from "node:path";
import pc from "picocolors";
import { AYO_DIR, loadSession } from "@ayo-dev/core/node";
import type { Session } from "@ayo-dev/core/node";

export {
  AYO_DIR,
  loadConfig,
  saveConfig,
  loadSession,
  saveSession,
  resolveHandle,
  type Config,
  type Session,
} from "@ayo-dev/core/node";

/** Daemon runtime files, shared by ayod, the controller, and the OS service. */
export const DAEMON_PID_PATH = join(AYO_DIR, "daemon.pid");
export const DAEMON_LOG_PATH = join(AYO_DIR, "ayod.log");
/** {pid, version} written by ayod on boot — lets doctor spot a stale service. */
export const DAEMON_META_PATH = join(AYO_DIR, "daemon.meta.json");

export function requireSession(): Session {
  const s = loadSession();
  if (!s) {
    console.error(pc.red("✗ not logged in") + pc.dim("  — run `ayo login` first"));
    process.exit(1);
  }
  return s;
}
