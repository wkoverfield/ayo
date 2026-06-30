/**
 * Agent-session registry + clicked-ping routing (the "→ My agent" target).
 *
 * Each agent session self-registers via its hook: `~/.ayo/sessions/<id>.json` =
 * { sessionId, cwd, repo, pid, lastActive }, written on SessionStart and
 * refreshed on UserPromptSubmit. The macOS toast helper drops a clicked ping as
 * a file in `~/.ayo/pending/`. When a session's hook runs it CLAIMS the pending
 * pings that belong to it:
 *
 *   route-by-repo  — a ping about repo X goes to the live session in repo X
 *   recency guard  — a "live" match must be recently active (else it's a ghost tab)
 *   next-prompt    — no live+recent match → the next session to take a prompt wins
 *
 * Invariant: a ping is NEVER auto-injected into a non-matching repo without the
 * user acting in that session (a UserPromptSubmit). No implicit cross-repo spread.
 * See docs/specs/sounds-and-actionable-toasts.md and the routing debate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AYO_DIR } from "./config.js";

const SESSIONS_DIR = join(AYO_DIR, "sessions");
const PENDING_DIR = join(AYO_DIR, "pending");
const RECENCY_MS = 4 * 60 * 60 * 1000; // a match older than this is treated as a ghost tab

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  repo: string | null; // basename of the git toplevel
  pid: number; // the agent process (hook's parent); liveness via kill -0
  agent: string;
  startedAt: string;
  lastActive: number;
}

export interface PendingPing {
  ayoId?: string;
  from?: string;
  context?: string;
  repo?: string;
  at?: string;
}

/** Git toplevel basename for a cwd, or null if it isn't a repo. */
export function repoOf(cwd: string): string | null {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
    return root ? basename(root) : null;
  } catch {
    return null;
  }
}

/** Register/refresh this session. Best-effort; never throws. */
export function registerSession(sessionId: string, cwd: string, agent: string, repo: string | null): void {
  if (!sessionId) return;
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const path = join(SESSIONS_DIR, `${sessionId}.json`);
    let startedAt = new Date().toISOString();
    if (existsSync(path)) {
      try {
        startedAt = (JSON.parse(readFileSync(path, "utf8")) as SessionInfo).startedAt ?? startedAt;
      } catch {
        /* ignore */
      }
    }
    // pid = the agent process: the hook runs as its direct child, so process.ppid
    // is the Claude/Codex session we liveness-check via kill -0.
    const info: SessionInfo = { sessionId, cwd, repo, pid: process.ppid, agent, startedAt, lastActive: Date.now() };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSync(tmp, path); // atomic
  } catch {
    /* best-effort */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live sessions; prunes dead-pid files as a side effect. */
export function liveSessions(): SessionInfo[] {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(SESSIONS_DIR, f);
        try {
          const info = JSON.parse(readFileSync(p, "utf8")) as SessionInfo;
          if (!alive(info.pid)) {
            try {
              unlinkSync(p);
            } catch {
              /* ignore */
            }
            return null;
          }
          return info;
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionInfo => s !== null);
  } catch {
    return [];
  }
}

const GRACE_MS = 4000; // a repo-tagged ping waits this long for its matching session before another may fallback-claim it
const MAX_PENDING_MS = 7 * 24 * 60 * 60 * 1000; // GC cap (e.g. a Codex-only user never claims, so old pings are swept)

function pingAge(ping: PendingPing): number {
  const t = ping.at ? Date.parse(ping.at) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/** Recover pings whose claimer crashed between the rename and the unlink (a
 *  dead-pid `.claimed.<pid>` file) — rename them back so the ping isn't lost. */
function recoverOrphans(): void {
  let files: string[];
  try {
    files = readdirSync(PENDING_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    const m = f.match(/^(.+\.json)\.claimed\.(\d+)$/);
    if (!m) continue;
    let dead = false;
    try {
      process.kill(Number(m[2]), 0);
    } catch {
      dead = true;
    }
    if (dead) {
      try {
        renameSync(join(PENDING_DIR, f), join(PENDING_DIR, m[1]!));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Claim the pending clicked-pings this session should consume, per the policy.
 * Atomic per-file rename so two sessions can't double-claim.
 */
export function claimPending(myRepo: string | null, event: string): PendingPing[] {
  recoverOrphans();
  let files: string[];
  try {
    files = readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions = liveSessions(); // one snapshot for the whole pass
  const now = Date.now();
  const hasLiveRecent = (repo: string) => sessions.some((s) => s.repo === repo && now - s.lastActive < RECENCY_MS);

  const claimed: PendingPing[] = [];
  for (const f of files) {
    const path = join(PENDING_DIR, f);
    let ping: PendingPing;
    try {
      ping = JSON.parse(readFileSync(path, "utf8")) as PendingPing;
    } catch {
      continue;
    }
    // GC stragglers — only the printing (Claude) surface claims, so a Codex-only
    // user would otherwise let pending/ grow forever. Only GC pings with a real
    // timestamp (a missing `at` must not be treated as infinitely old + swept).
    if (ping.at && pingAge(ping) > MAX_PENDING_MS) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      continue;
    }
    let take: boolean;
    if (ping.repo && myRepo && ping.repo === myRepo) {
      take = true; // route-by-repo: I'm the matching session
    } else if (ping.repo && hasLiveRecent(ping.repo)) {
      take = false; // a live+recent session in that repo exists — let it claim
    } else if (ping.repo) {
      // repo-tagged but no live+recent match visible: give the matching session a
      // grace window to fire its hook and claim before another session grabs it on
      // next-prompt (closes a tight race where the match's write isn't visible yet).
      take = event === "UserPromptSubmit" && pingAge(ping) > GRACE_MS;
    } else {
      take = event === "UserPromptSubmit"; // no repo → next-prompt (the user IS acting here)
    }
    if (!take) continue;
    // Atomic claim: whoever renames first wins (the loser gets ENOENT, skips).
    const mine = `${path}.claimed.${process.pid}`;
    try {
      renameSync(path, mine);
    } catch {
      continue; // lost the race
    }
    claimed.push(ping);
    try {
      unlinkSync(mine);
    } catch {
      /* if we die here, recoverOrphans re-offers it next pass */
    }
  }
  return claimed;
}
