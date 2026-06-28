/**
 * The local inbox file (`~/.ayo/inbox.json`), written by the daemon and read by
 * the agent hooks. Plus the agent "last surfaced" marker, which dedupes what
 * the hooks inject so the same Ayo isn't re-shown to the model every turn.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Ayo } from "@ayo-dev/core";
import { AYO_DIR } from "./config.js";

const INBOX_PATH = join(AYO_DIR, "inbox.json");
const AGENT_STATE_PATH = join(AYO_DIR, "agent-state.json");

export interface InboxFile {
  ayos: Ayo[];
  updatedAt: string;
}

export function loadInbox(): InboxFile {
  if (!existsSync(INBOX_PATH)) return { ayos: [], updatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(INBOX_PATH, "utf8")) as InboxFile;
  } catch {
    return { ayos: [], updatedAt: new Date(0).toISOString() };
  }
}

export function writeInbox(file: InboxFile): void {
  writeFileSync(INBOX_PATH, JSON.stringify(file, null, 2));
}

/** Add an Ayo if not already present (dedupe by id). */
export function upsertInbox(ayo: Ayo): void {
  const inbox = loadInbox();
  if (!inbox.ayos.some((a) => a.id === ayo.id)) inbox.ayos.push(ayo);
  inbox.updatedAt = new Date().toISOString();
  writeInbox(inbox);
}

interface AgentState {
  /** Highest Ayo id already surfaced to an agent. */
  lastSurfacedAyoId?: string;
}

export function getLastSurfaced(): string | undefined {
  if (!existsSync(AGENT_STATE_PATH)) return undefined;
  try {
    return (JSON.parse(readFileSync(AGENT_STATE_PATH, "utf8")) as AgentState).lastSurfacedAyoId;
  } catch {
    return undefined;
  }
}

export function setLastSurfaced(id: string): void {
  writeFileSync(AGENT_STATE_PATH, JSON.stringify({ lastSurfacedAyoId: id } satisfies AgentState));
}
