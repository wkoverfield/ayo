/**
 * Layer 1 — the magic layer (ADR 0001). Surfaces unread Ayos to an agent at its
 * natural breakpoints.
 *
 * Ownership split: the daemon owns notification; the hooks own context
 * injection. So:
 *   - We ALWAYS print fresh Ayos to stdout (Claude injects SessionStart /
 *     UserPromptSubmit stdout into the model). Surfacing != human read, so we
 *     never mark anything read here.
 *   - We only fire a toast as a SELF-HEALING fallback when the daemon is dead
 *     (otherwise the daemon already toasted — double-buzzing is spam).
 *
 * Dedupe: a "last surfaced" marker means the same Ayo is never re-injected every
 * turn. This runs on the agent's hot path, so it must be fast and ALWAYS exit 0
 * — never break the user's agent session.
 */

import type { Ayo } from "@ayo-dev/core";
import { loadConfig, loadSession } from "./config.js";
import { isDaemonAlive } from "./daemon-ctl.js";
import {
  type AgentSurface,
  getLastSurfaced,
  loadInbox,
  setLastSurfaced,
  upsertInbox,
} from "./inbox-store.js";
import { claimPending, type PendingPing, registerSession, repoOf } from "./session-registry.js";
import { notifyAyo } from "./notify.js";

interface SurfaceOpts {
  /** Which agent is asking — each keeps its own dedup marker. */
  surface: AgentSurface;
  /** Print fresh Ayos to stdout for model injection (Claude). Off for Codex. */
  print: boolean;
  /** The hook payload Claude/Codex pass on stdin — drives session routing. */
  hook?: { sessionId?: string; cwd?: string; event?: string };
}

export async function surfaceUnread(opts: SurfaceOpts): Promise<void> {
  try {
    const session = loadSession();
    const cfg = loadConfig();
    if (!session || !cfg.activeTeamId) return; // not set up — stay silent

    // Register/refresh this session, then claim the toast-clicked pings routed to
    // it (route-by-repo, with a next-prompt fallback). Only the printing surface
    // injects, and a ping never lands in a non-matching repo without the user
    // acting in that session. See session-registry.ts.
    const repo = opts.hook?.cwd ? repoOf(opts.hook.cwd) : null;
    if (opts.hook?.sessionId) {
      registerSession(opts.hook.sessionId, opts.hook.cwd ?? "", opts.surface, repo);
    }
    if (opts.print) {
      const claimed = claimPending(repo, opts.hook?.event ?? "").filter((p) => p.context);
      if (claimed.length) process.stdout.write(formatClicked(claimed));
    }

    const daemonAlive = isDaemonAlive();
    // If the daemon is down, the local inbox may be stale — best-effort refresh
    // on a tight timeout so we never hang the agent's turn.
    if (!daemonAlive) await refreshInbox(session.token, cfg.relayUrl, cfg.activeTeamId);

    const mine = loadInbox()
      // Drop your own sends — EXCEPT self-asks: your agent sent it as you, but
      // human-you is the recipient (mirrors the DO inbox's selfAsk exception).
      .ayos.filter((a) => a.from.handle !== session.handle || a.kind === "ask")
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const last = getLastSurfaced(opts.surface);
    const fresh = last ? mine.filter((a) => a.id > last) : mine;
    if (fresh.length === 0) return;

    if (opts.print) process.stdout.write(formatForAgent(fresh));
    if (!daemonAlive) for (const a of fresh) notifyAyo(a); // self-healing fallback

    setLastSurfaced(opts.surface, mine[mine.length - 1]!.id);
  } catch {
    // Never break the agent. Swallow everything.
  }
}

function formatForAgent(fresh: Ayo[]): string {
  const lines = fresh.map((a) => {
    const ctx = a.context;
    const where = ctx?.branch
      ? ` (${ctx.repo}@${ctx.branch})`
      : ctx?.repo
        ? ` (${ctx.repo})`
        : "";
    const urgent = a.urgency === "urgent" ? " [URGENT]" : "";
    const stat = ctx?.diffStat ? ` — ${ctx.diffStat}` : "";
    return `• ${a.from.handle}${where}: "${a.body}"${urgent}${stat}`;
  });
  return [
    `📨 Ayo — ${fresh.length} new ping(s) for you:`,
    ...lines,
    `To reply, tell me to "Ayo <handle> ..." or run \`ayo inbox\`.`,
    "",
  ].join("\n");
}

/** Clicked-toast context the user explicitly pulled into this session. */
function formatClicked(clicked: PendingPing[]): string {
  const blocks = clicked.map((a) => `From ${a.from ?? "a teammate"}:\n${a.context}`);
  return [
    `📌 You pulled ${clicked.length} Ayo${clicked.length > 1 ? "s" : ""} into this session from a toast:`,
    ...blocks,
    "Use this context to help; reply with \"Ayo <handle> ...\" if needed.",
    "",
  ].join("\n\n");
}

/** Best-effort inbox refresh with a hard timeout. Failures are ignored. */
async function refreshInbox(token: string, relayUrl: string, teamId: string): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${relayUrl}/v1/teams/${teamId}/inbox?unreadOnly=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = (await res.json()) as { ayos: Ayo[] };
    for (const a of data.ayos) upsertInbox(a);
  } catch {
    // offline / daemon-only mode — fall back to whatever is on disk
  }
}
