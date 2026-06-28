/**
 * The local inbox file (`~/.ayo/inbox.json`), written by the daemon and read by
 * the agent hooks. Plus the agent "last surfaced" marker, which dedupes what
 * the hooks inject so the same Ayo isn't re-shown to the model every turn.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
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
  // Write-then-rename so a concurrent reader never sees a half-written file
  // (rename is atomic on POSIX). The daemon and the agent hook can both write.
  const tmp = `${INBOX_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, INBOX_PATH);
}

/** Add an Ayo if not already present (dedupe by id). */
export function upsertInbox(ayo: Ayo): void {
  const inbox = loadInbox();
  if (!inbox.ayos.some((a) => a.id === ayo.id)) inbox.ayos.push(ayo);
  inbox.updatedAt = new Date().toISOString();
  writeInbox(inbox);
}

/** Each agent surface keeps its OWN marker, so Claude and Codex can't starve
 *  each other of context by racing on a single shared cursor. */
export type AgentSurface = "claude" | "codex";

interface AgentState {
  /** Highest Ayo id already surfaced, per agent surface. */
  markers?: Partial<Record<AgentSurface, string>>;
}

function loadAgentState(): AgentState {
  if (!existsSync(AGENT_STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AGENT_STATE_PATH, "utf8")) as AgentState;
  } catch {
    return {};
  }
}

export function getLastSurfaced(surface: AgentSurface): string | undefined {
  return loadAgentState().markers?.[surface];
}

export function setLastSurfaced(surface: AgentSurface, id: string): void {
  const state = loadAgentState();
  state.markers = { ...state.markers, [surface]: id };
  writeFileSync(AGENT_STATE_PATH, JSON.stringify(state));
}
