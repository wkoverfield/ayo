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
  if (inbox.ayos.length > INBOX_CAP) inbox.ayos = inbox.ayos.slice(-INBOX_CAP);
  inbox.updatedAt = new Date().toISOString();
  writeInbox(inbox);
}

/** Each agent surface keeps its OWN marker, so Claude and Codex can't starve
 *  each other of context by racing on a single shared cursor. */
export type AgentSurface = "claude" | "codex";

interface AgentState {
  /** LEGACY (pre-0.4): highest Ayo id already surfaced. ULIDs are time-ordered,
   *  so with per-team sockets a delayed replay could arrive with an OLDER id
   *  than the marker and be skipped forever. Kept only to migrate. */
  markers?: Partial<Record<AgentSurface, string>>;
  /** Exact ids already surfaced, per agent surface (capped). Order-independent,
   *  so out-of-order multi-team replays can never be silently skipped. */
  seen?: Partial<Record<AgentSurface, string[]>>;
}

const SEEN_CAP = 1000;
/** Inbox cap — MUST stay below SEEN_CAP: the seen-set is pruned to its cap,
 *  and if the inbox could outgrow it, evicted seen-ids still in the inbox
 *  would resurface to the agent forever (a rotating re-inject loop). */
const INBOX_CAP = 500;

function loadAgentState(): AgentState {
  if (!existsSync(AGENT_STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AGENT_STATE_PATH, "utf8")) as AgentState;
  } catch {
    return {};
  }
}

export function getSurfaced(surface: AgentSurface): { seen: Set<string>; legacy?: string } {
  const st = loadAgentState();
  return { seen: new Set(st.seen?.[surface] ?? []), legacy: st.markers?.[surface] };
}

/** Record everything surfaced (or already in the inbox) as seen, and drop the
 *  legacy high-water marker — the seen-set covers those ids from here on. */
export function setSurfaced(surface: AgentSurface, ids: string[]): void {
  const state = loadAgentState();
  const prev = state.seen?.[surface] ?? [];
  const merged = [...new Set([...prev, ...ids])];
  state.seen = { ...state.seen, [surface]: merged.slice(-SEEN_CAP) };
  if (state.markers) delete state.markers[surface];
  writeFileSync(AGENT_STATE_PATH, JSON.stringify(state));
}
