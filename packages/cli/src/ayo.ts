#!/usr/bin/env node
/**
 * `ayo` — the one-shot CLI. Sends over HTTP (stateless), reads the inbox, and
 * manages the daemon. Receiving is the daemon's job (ADR 0001/0002).
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command, Help } from "commander";
import pc from "picocolors";
import {
  AYO_DIR,
  DAEMON_META_PATH,
  loadConfig,
  saveConfig,
  requireSession,
  loadSession,
  resolveHandle,
  type Session,
} from "./config.js";
import { rel } from "./fmt.js";
import { api, RelayError } from "./client.js";
import type { SendAyoResponse, PresenceStatus } from "@ayo-dev/core";
import { captureContext } from "./context.js";
import {
  daemonInstall,
  daemonUninstall,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonLogs,
  isDaemonAlive,
} from "./daemon-ctl.js";
import { fireTestToast } from "./notify.js";
import { deviceLogin, runInit, runUninstall } from "./init.js";
import { surfaceUnread } from "./agent.js";
import { board } from "./board.js";
import { hackathonEnd, hackathonExport, hackathonStart, hackathonStatus } from "./hackathon.js";
import { hooksInstall, hooksStatus, hooksUninstall } from "./hooks.js";
import { mcpInstall, mcpStatus, mcpUninstall, MCP_HOSTS } from "./mcp-setup.js";
import { soundList, soundMute, soundPreview, soundSet, soundStatus, soundUnmute, soundUpload } from "./sound-setup.js";

// Read the real version from package.json (dist/ayo.js → ../package.json, which
// npm always includes in the tarball). Fall back so `--version` can never throw.
function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();
program.name("ayo").description("Ping your teammates from inside Codex and Claude.").version(pkgVersion());
program.showSuggestionAfterError(true);

// Help lists everyday commands before plumbing — beloved CLIs teach the primary
// gesture first; registration order is code organization, not importance.
const HELP_ORDER = [
  "init", "handoff", "inbox", "agents", "answer", "board", "status", "who",
  "team", "invite", "join", "webhook", "sound", "hackathon",
  "doctor", "daemon", "hooks", "mcp", "login", "whoami", "logout", "uninstall", "help",
];
program.configureHelp({
  visibleCommands(cmd) {
    const rank = (n: string) => {
      const i = HELP_ORDER.indexOf(n);
      return i === -1 ? HELP_ORDER.length : i;
    };
    // Reuse commander's own hidden-filtering, then impose the teaching order.
    const visible = Help.prototype.visibleCommands.call(this, cmd);
    return visible.sort((a, b) => rank(a.name()) - rank(b.name()));
  },
});

// The primary gesture is a hidden default command (`ayo <handle> <message>`)
// so without this block a new user reading --help never learns the core move.
program.addHelpText(
  "after",
  `
Examples:
  ayo maya "demo deploy is cooked, can you tap in?"    ping one person
  ayo team "standup in 5"                              broadcast to everyone
  ayo handoff maya "stuck on oauth"                    hand off with git context + a share link
  ayo agents                                           which asks are waiting on you
  ayo board                                            live team dashboard
  ayo webhook create --github                          GitHub reviews/@mentions become Ayos

Docs: https://github.com/wkoverfield/ayo`,
);

function fail(err: unknown): never {
  if (err instanceof RelayError) console.error(pc.red(`✗ ${err.code}: ${err.message}`));
  else console.error(pc.red(`✗ ${(err as Error).message}`));
  process.exit(1);
}

/** Tiny edit-distance for did-you-mean on bare near-miss commands. */
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** "No active team" is a user-fixable error, not a success: say so on stderr,
 *  name the fix, and exit non-zero (scripts and agents depend on exit codes). */
function requireTeam(cfg: ReturnType<typeof loadConfig>): string {
  if (!cfg.activeTeamId) {
    console.error(pc.red("✗ no active team") + pc.dim("  — create one with `ayo team create <name>` or join with `ayo join <code>`"));
    process.exit(1);
  }
  return cfg.activeTeamId;
}

/**
 * Report a send result honestly. The relay tells us who it actually reached and
 * which requested handles match no teammate — so we never print a green ✓ for an
 * Ayo that went nowhere (a typo'd or not-yet-joined handle used to look like a
 * success). Shared by `send`, `handoff`, and `team` broadcast.
 */
async function reportSend(
  res: SendAyoResponse,
  opts: { label?: string; broadcast?: boolean; self?: boolean; lookup?: { s: Session; teamId: string } } = {},
): Promise<void> {
  const label = opts.label ?? "ayo sent";
  const live = res.deliveredTo.length;
  const queued = res.queuedFor.length;
  const unknown = res.unknownRecipients ?? [];
  const held = res.heldFor ?? [];

  if (unknown.length) {
    const names = unknown.map((h) => pc.bold(h)).join(", ");
    console.log(pc.yellow(`⚠ no such teammate: ${names}`) + pc.dim("  — run `ayo who` to see who you can ping"));
    // Did-you-mean checks the ROSTER first — `ayo mya` almost always means the
    // teammate maya, and suggesting a command for it steers at the wrong fix.
    // Best-effort extra round-trip, on the failure path only.
    let suggested = false;
    if (opts.lookup) {
      try {
        const { members } = await api.members(opts.lookup.s, opts.lookup.teamId);
        const own = opts.lookup.s.handle.toLowerCase();
        const handles = members.map((m) => m.handle).filter((h) => h.toLowerCase() !== own);
        const near = unknown
          .map((h) => handles.find((c) => levenshtein(h.toLowerCase(), c.toLowerCase()) <= 2))
          .find(Boolean);
        if (near) {
          console.log(pc.dim(`  (did you mean your teammate `) + pc.bold(near) + pc.dim(`? \`ayo ${near} …\`)`));
          suggested = true;
        }
      } catch {
        /* roster unavailable — fall through to the command hint */
      }
    }
    // `ayo answr 1 ship` lands here (near-miss WITH args skips the bare typo
    // guard) — being told "answr isn't a teammate" steers at the wrong fix.
    if (!suggested) {
      const near = unknown
        .map((h) => HELP_ORDER.find((c) => levenshtein(h.toLowerCase(), c) <= 2))
        .find(Boolean);
      if (near) console.log(pc.dim(`  (or did you mean the command \`ayo ${near}\`?)`));
    }
  }
  if (held.length) {
    const names = held.join(", ");
    console.log(pc.dim(`· ${names} ${held.length === 1 ? "is" : "are"} heads-down — no toast; they'll see it when they next check their inbox`));
  }

  if (live + queued > 0) {
    console.log(pc.green(`✓ ${label}`) + pc.dim(` (${live} live, ${queued} queued)`));
  } else if (held.length > 0) {
    // Not lost — everyone reached is just focusing; it's in their inbox.
    console.log(pc.green(`✓ ${label}`) + pc.dim(" (held for focus)"));
  } else if (unknown.length === 0) {
    // A real send that reached no one. For a DIRECTED send that's a failure
    // (exit 1 below) — mark it like one, don't whisper it. An empty-room
    // broadcast stays a gentle nudge (nothing was mis-addressed). In practice
    // the directed case means every named handle was the sender (the relay
    // skips non-ask self-pings; anything else lands in unknownRecipients) —
    // when the caller confirms that, say so instead of a wrong-trail hint.
    console.log(
      opts.broadcast
        ? pc.yellow("· nobody to reach yet — invite a teammate with a join code")
        : opts.self
          ? pc.red("✗ reached no one") + pc.dim("  — that's your own handle; self-pings are skipped (your agent's asks still come through)")
          : pc.red("✗ reached no one") + pc.dim("  — check who's on the team with `ayo who`"),
    );
  }
  // (reached 0 AND unknown.length > 0 — the warning above already explained it.)
  // A DIRECTED send that reached no one is a failure to a script or an agent,
  // even though the human got a readable warning above. Broadcasts to an empty
  // room stay exit-0 (nothing was mis-addressed).
  if (!opts.broadcast && live + queued + held.length === 0) process.exitCode = 1;
}

// ── init / login / uninstall ─────────────────────────────────────────────────
program
  .command("init")
  .description("One-command setup: login, pick a sound, wire your agents, test it")
  .option("-y, --yes", "non-interactive (accept defaults, skip prompts)", false)
  .option("--dry-run", "show what would change without changing anything", false)
  .option("--only <steps>", "comma-separated subset: login,sound,daemon,mcp,hooks,test,team")
  .action(async (opts) => {
    try {
      await runInit(opts);
    } catch (err) {
      if (err instanceof RelayError) {
        console.error(pc.red(`\n✗ ${err.message}`));
        process.exit(1);
      }
      fail(err);
    }
  });

program
  .command("login")
  .description("Authenticate with GitHub (device flow)")
  .option("--handle <handle>", "handle to use with the local dev stub", process.env.USER ?? "dev")
  .action(async (opts) => {
    try {
      await deviceLogin(opts.handle);
    } catch (err) {
      // Terminal device-flow errors carry a friendly message from the relay —
      // show it without the noisy `unauthorized:` code prefix.
      if (err instanceof RelayError) {
        console.error(pc.red(`\n✗ ${err.message}`));
        process.exit(1);
      }
      fail(err);
    }
  });

program
  .command("whoami")
  .description("Which account and teams this machine is on")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      let teams: { id: string; name: string }[] | null = [];
      try {
        teams = (await api.me(s)).teams;
      } catch {
        teams = null; // offline — unknown is not the same as none
      }
      if (opts.json) {
        return void console.log(JSON.stringify({ handle: s.handle, userId: s.userId, relayUrl: cfg.relayUrl, activeTeamId: cfg.activeTeamId ?? null, teams }, null, 2));
      }
      console.log(`${pc.bold(s.handle)} ${pc.dim(`(${s.userId})`)}`);
      console.log(pc.dim(`relay: ${cfg.relayUrl}`));
      if (teams === null) console.log(pc.yellow("⚠ relay unreachable — teams not shown"));
      for (const t of teams ?? []) {
        const active = t.id === cfg.activeTeamId;
        console.log(`${active ? pc.green("●") : pc.dim("○")} ${t.name}${active ? pc.dim("  ← active") : ""}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("logout")
  .description("Revoke this machine's session and forget it locally")
  .action(async () => {
    try {
      const s = loadSession();
      if (!s) return void console.log(pc.dim("not logged in — nothing to do"));
      // Revoke server-side FIRST (best-effort): deleting the local file alone
      // would leave a live token behind, which is the exact footgun logout exists
      // to close. A dead/unreachable relay still logs you out locally, honestly.
      let revoked = false;
      try {
        await api.logout(s);
        revoked = true;
      } catch { /* token may already be invalid, or relay unreachable */ }
      rmSync(join(AYO_DIR, "session.json"), { force: true });
      console.log(
        pc.green("✓ logged out") +
          (revoked ? "" : pc.yellow("  — couldn't reach the relay to revoke the token; it dies on its own 90 days after its last use")),
      );
      console.log(pc.dim("  your teams and config are untouched — `ayo login` to come back"));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("uninstall")
  .description("Reverse Ayo's local wiring (daemon + agent hooks/MCP)")
  .action(async () => {
    try {
      await runUninstall();
    } catch (err) {
      fail(err);
    }
  });

// ── team ───────────────────────────────────────────────────────────────────
const team = program.command("team").description("Broadcast to the team, or manage it (create/status)");
team.addHelpText("after", '\nBroadcast:\n  ayo team "<message>" [--urgent]   send to the whole team');
team
  .command("create <name>")
  .description("Create a team and get a join code")
  .action(async (name: string) => {
    try {
      const s = requireSession();
      const res = await api.createTeam(s, name);
      const cfg = loadConfig();
      saveConfig({ ...cfg, activeTeamId: res.id });
      console.log(pc.green(`✓ created ${pc.bold(name)}`));
      console.log(`  join code: ${pc.bold(pc.cyan(res.joinCode))}`);
      console.log(pc.dim("  share it:  ayo invite   (a paste-ready invitation)"));
    } catch (err) {
      fail(err);
    }
  });
team
  .command("status")
  .description("Show team roster + presence")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const { members } = await api.members(s, teamId);
      if (opts.json) return void console.log(JSON.stringify(members, null, 2));
      for (const m of members) {
        const dot = m.online ? pc.green("●") : pc.dim("○");
        const note = m.statusText ? pc.dim(` — ${m.statusText}`) : "";
        console.log(`${dot} ${pc.bold(m.handle)} ${pc.dim(`(${m.online ? m.status : "offline"})`)}${note}`);
      }
    } catch (err) {
      fail(err);
    }
  });
team
  .command("rotate-code")
  .description("Rotate your team's join code (revokes the old one) — creator only")
  .option("--expires <hours>", "auto-expire the new code after N hours")
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const hrs = opts.expires ? Number(opts.expires) : undefined;
      const res = await api.rotateCode(s, teamId, hrs);
      console.log(
        pc.green("✓ new join code: ") +
          pc.bold(pc.cyan(res.joinCode)) +
          (res.expiresAt ? pc.dim(`  (expires ${new Date(res.expiresAt).toLocaleString()})`) : ""),
      );
      console.log(pc.dim("  the old code stops working within ~a minute — share the new one with `ayo invite`."));
    } catch (err) {
      fail(err);
    }
  });

/** Resolve a team by exact id or case-insensitive name from me().teams.
 *  Exits with the list on no match or an ambiguous name. */
async function resolveTeam(s: Session, ref: string): Promise<{ id: string; name: string }> {
  const { teams } = await api.me(s);
  const exact = teams.find((t) => t.id === ref);
  if (exact) return exact;
  const named = teams.filter((t) => t.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  console.error(
    named.length
      ? pc.red(`✗ "${ref}" matches ${named.length} teams — use the id`)
      : pc.red(`✗ no team named "${ref}"`),
  );
  for (const t of teams) console.error(pc.dim(`  ${t.name}  (${t.id})`));
  process.exit(1);
}

team
  .command("leave [team]")
  .description("Leave a team (the active one by default)")
  .action(async (ref?: string) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const t = ref ? await resolveTeam(s, ref) : await resolveTeam(s, requireTeam(cfg));
      await api.leaveTeam(s, t.id);
      console.log(pc.green(`✓ left ${pc.bold(t.name)}`));
      if (cfg.activeTeamId === t.id) {
        // Don't leave sends pointed at a team you're no longer on.
        let next: { id: string; name: string } | undefined;
        try {
          next = (await api.me(s)).teams.find((x) => x.id !== t.id);
        } catch { /* offline — just clear */ }
        saveConfig({ ...loadConfig(), activeTeamId: next?.id });
        console.log(next ? pc.dim(`  active team is now ${next.name}`) : pc.dim("  no active team — `ayo team create` or `ayo join`"));
      }
    } catch (err) {
      fail(err);
    }
  });
team
  .command("remove <handle>")
  .description("Remove a member from the active team — creator only")
  .action(async (handle: string) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      await api.removeMember(s, teamId, handle);
      // Name the team — no-prompt removal on the ACTIVE team means the receipt
      // must carry the full facts (multi-team is real now).
      let tname = teamId;
      try {
        tname = (await api.me(s)).teams.find((t) => t.id === teamId)?.name ?? teamId;
      } catch { /* best-effort */ }
      console.log(pc.green(`✓ removed ${pc.bold(handle)} from ${pc.bold(tname)}`) + pc.dim("  — their live streams drop within seconds; rotate the join code if it leaked: `ayo team rotate-code`"));
    } catch (err) {
      fail(err);
    }
  });
team
  .command("list")
  .description("All teams you belong to (● = active: where sends/board/webhooks go)")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const { teams } = await api.me(s);
      if (opts.json) return void console.log(JSON.stringify(teams.map((t) => ({ ...t, active: t.id === cfg.activeTeamId })), null, 2));
      if (!teams.length) return void console.log(pc.dim("no teams yet — `ayo team create <name>` or `ayo join <code>`"));
      for (const t of teams) {
        const active = t.id === cfg.activeTeamId;
        console.log(`${active ? pc.green("●") : pc.dim("○")} ${pc.bold(t.name)} ${pc.dim(`(${t.id})`)}${active ? pc.dim("  ← active") : ""}`);
      }
      if (teams.length > 1) {
        console.log(pc.dim("  sends target the active team; you receive from every team. `ayo team switch <name>`"));
      }
    } catch (err) {
      fail(err);
    }
  });
team
  .command("switch <team>")
  .description("Make another team the active one — sends, board, and webhooks target it")
  .action(async (ref: string) => {
    try {
      const s = requireSession();
      const t = await resolveTeam(s, ref);
      saveConfig({ ...loadConfig(), activeTeamId: t.id });
      console.log(pc.green(`✓ active team: ${pc.bold(t.name)}`) + pc.dim("  — you still receive pings from every team"));
    } catch (err) {
      fail(err);
    }
  });

// `ayo team "we're cooked"` broadcasts to everyone — the default when the args
// aren't `create`/`status`. (Commander routes unmatched args to isDefault.)
team
  .command("broadcast [message...]", { isDefault: true, hidden: true })
  .option("--urgent", "urgent broadcast", false)
  .action(async (message: string[], opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const body = message.join(" ");
      if (!body) {
        console.log("Usage: ayo team <message>  ·  ayo team create <name>  ·  ayo team status");
        return;
      }
      const res = await api.send(s, teamId, {
        to: ["*"],
        body,
        urgency: opts.urgent ? "urgent" : "normal",
        context: captureContext(),
      });
      await reportSend(res, { label: "team ayo sent", broadcast: true });
    } catch (err) {
      fail(err);
    }
  });

// ── join ─────────────────────────────────────────────────────────────────────
program
  .command("join <code>")
  .description("Join a team by code")
  .action(async (code: string) => {
    try {
      const s = requireSession();
      const prevTeamId = loadConfig().activeTeamId;
      const res = await api.joinTeam(s, code);
      saveConfig({ ...loadConfig(), activeTeamId: res.id });
      console.log(pc.green(`✓ joined ${pc.bold(res.name)}`));
      // Joining a SECOND team silently retargeting your sends is a footgun —
      // say it happened and how to undo it. (Receiving covers every team.)
      if (prevTeamId && prevTeamId !== res.id) {
        console.log(pc.dim(`  sends now target ${res.name} — switch back anytime: \`ayo team switch <name>\` (\`ayo team list\`)`));
      }
      if (res.invitedBy) {
        console.log(`  ${pc.bold(res.invitedBy)} invited you — try:  ${pc.cyan(`ayo ${res.invitedBy} "picked up your handoff"`)}`);
      }
      // Land the joiner on the team — who's here + the obvious next moves —
      // instead of a bare "joined". The roster is a nicety; the join succeeded.
      try {
        const { members } = await api.members(s, res.id);
        const others = members.filter((m) => m.handle.toLowerCase() !== s.handle.toLowerCase());
        if (others.length) {
          console.log("  " + others.map((m) => `${m.online ? pc.green("●") : pc.dim("○")} ${m.handle}`).join("   "));
          console.log(pc.dim(`  try:  ayo board   ·   ayo ${others[0]!.handle} "hey, just joined"`));
        } else {
          console.log(pc.dim("  you're first here — run  ayo invite  to bring the team in."));
        }
      } catch {
        /* roster is best-effort */
      }
    } catch (err) {
      fail(err);
    }
  });

// ── invite (the growth loop: a shareable invitation) ─────────────────────────
program
  .command("invite")
  .description("Print a shareable invitation to your active team")
  .action(async () => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const { name, joinCode, codeExpiresAt } = await api.invite(s, teamId);
      // Don't hand out a dead code: if it's already expired, tell the inviter to
      // rotate instead of pasting an invitation nobody can redeem.
      if (codeExpiresAt && new Date(codeExpiresAt).getTime() < Date.now()) {
        console.log(pc.yellow("⚠ your join code has expired — nobody can use it."));
        console.log(pc.dim("  run  ayo team rotate-code  to mint a fresh one, then `ayo invite` again."));
        return;
      }
      console.log(pc.dim("\n  Send this to a teammate:\n  ───────────────────────"));
      console.log(`  ${pc.bold(s.handle)} invited you to ${pc.bold(`"${name}"`)} on Ayo — attention pings`);
      console.log("  from inside your terminal/agent (Codex, Claude, Cursor). No Slack.");
      console.log();
      console.log("    npm install -g @ayo-dev/cli");
      console.log(`    ayo join ${pc.bold(joinCode ?? "")}`);
      if (codeExpiresAt) {
        console.log(pc.dim(`    (code expires ${new Date(codeExpiresAt).toLocaleString()})`));
      }
      console.log();
      console.log("  What's Ayo? github.com/wkoverfield/ayo");
      console.log(pc.dim("  ───────────────────────"));
      console.log(pc.dim("  rotate anytime with  ayo team rotate-code  (revokes the old code)."));
    } catch (err) {
      fail(err);
    }
  });

// ── webhook (inbound webhooks: one curl → Ayo) ───────────────────────────────
// `webhook`, not `hook`: `ayo hooks` (agent wiring) already exists, and a one-
// keystroke gap between two different concepts is a footgun. `hook` stays as an
// alias (visible in help as webhook|hook — deliberate, so people who learned
// `hook` can see where it went) and keeps working.
const hook = program
  .command("webhook")
  .alias("hook")
  .description("Inbound webhooks — fire an Ayo into your team from any script or service");
hook
  .command("create")
  .description("Mint a webhook URL that turns one curl into an Ayo")
  .option("--to <handle>", "default recipient (omit to broadcast to the team)")
  .option("--label <name>", "source name shown on the ping (e.g. ci, github)")
  .option("--github", "mint a GitHub webhook (review requests, @mentions, reviews → Ayo)", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      if (opts.github && opts.to) {
        console.log(pc.yellow("⚠ --to is ignored for GitHub webhooks — recipients come from the event (reviewer, mentioned, author)."));
      }
      const info = await api.createWebhook(s, teamId, {
        label: opts.label ?? (opts.github ? "github" : "hook"),
        to: opts.github || !opts.to ? undefined : resolveHandle(cfg, opts.to),
        github: opts.github || undefined,
      });
      if (info.kind === "github") {
        console.log(pc.green("✓ GitHub webhook created") + pc.dim(`   [${info.label}]`));
        console.log(pc.dim("\n  Add it in your repo → Settings → Webhooks → Add webhook:"));
        console.log("    Payload URL:  " + pc.cyan(info.url));
        console.log("    Content type: " + pc.bold("application/json"));
        console.log("    Secret:       " + pc.bold(info.secret ?? ""));
        console.log(pc.dim("    Events:       Pull requests, Pull request reviews, Issue comments, PR review comments"));
        console.log(
          pc.dim(
            "\n  Review requests, @mentions, and review submissions become Ayos to the\n  matching handle (Ayo handle = GitHub login). Secret shown once — revoke with `ayo webhook revoke <url>`.",
          ),
        );
        return;
      }
      console.log(pc.green("✓ webhook created") + pc.dim(`   [${info.label}]${info.to ? ` → ${info.to}` : " → team"}`));
      console.log("  " + pc.cyan(info.url));
      console.log(pc.dim("\n  Fire it with one curl:"));
      console.log(pc.dim(`    curl -X POST ${info.url} \\`));
      console.log(pc.dim(`      -H 'content-type: application/json' -d '{"text":"build passed ✅"}'`));
      console.log(
        pc.dim("\n  Keep this URL secret — anyone with it can ping your team. Revoke with `ayo webhook revoke <url>`."),
      );
    } catch (err) {
      fail(err);
    }
  });
hook
  .command("list")
  .description("List your team's inbound webhooks")
  .action(async () => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const { hooks } = await api.listWebhooks(s, teamId);
      if (!hooks.length) return console.log(pc.dim("No webhooks yet. `ayo webhook create`."));
      for (const h of hooks) {
        const scope = h.kind === "github" ? pc.dim(" (github)") : h.to ? ` → ${h.to}` : " → team";
        // The relay only returns the URL for hooks YOU created (it's a secret).
        const tail = h.url ? pc.dim(h.url) : pc.dim(`(created by ${h.createdBy ?? "?"} — URL hidden)`);
        console.log(`  ${pc.bold(`[${h.label}]`)}${scope}   ${tail}`);
      }
    } catch (err) {
      fail(err);
    }
  });
hook
  .command("revoke <token>")
  .description("Revoke an inbound webhook (accepts the full URL or the bare token)")
  .action(async (token: string) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      // Accept a full URL (with any query/trailing slash) or a bare token.
      let t = token;
      if (token.includes("/")) {
        try {
          t = new URL(token).pathname.split("/").filter(Boolean).pop() ?? token;
        } catch {
          t = token.split("/").filter(Boolean).pop() ?? token;
        }
      }
      await api.revokeWebhook(s, teamId, t);
      console.log(pc.green("✓ webhook revoked"));
    } catch (err) {
      fail(err);
    }
  });

// ── agents (the control tower: asks waiting on you) ──────────────────────────
const ASK_MAP_PATH = join(AYO_DIR, "asks.json");
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

function waitingFor(createdAt: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Teams a read-side command (inbox/agents) should cover: ALL of them by
 *  default — a ping must never be invisible because it came from the
 *  non-active team — one team when the user asks, the active team as the
 *  fallback when me() is unreachable. */
async function inboxTeams(
  s: Session,
  cfg: ReturnType<typeof loadConfig>,
  only?: string,
): Promise<{ teams: { id: string; name: string }[]; teamName: Map<string, string> }> {
  let teams: { id: string; name: string }[] = [];
  try {
    teams = (await api.me(s)).teams;
  } catch {
    /* listing unavailable — fall back to the active team below */
  }
  if (!teams.length) {
    const tid = requireTeam(cfg);
    teams = [{ id: tid, name: tid }];
  }
  if (only) {
    const match = teams.filter((t) => t.id === only || t.name.toLowerCase() === only.toLowerCase());
    if (match.length !== 1) {
      console.error(pc.red(`✗ ${match.length ? "ambiguous" : "no"} team "${only}"`) + pc.dim("  — see `ayo team list`"));
      process.exit(1);
    }
    teams = match;
  }
  return { teams, teamName: new Map(teams.map((t) => [t.id, t.name])) };
}

program
  .command("agents")
  .description("Which asks are waiting on you, across every team")
  .option("--team <team>", "only this team (name or id)")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const { teams, teamName } = await inboxTeams(s, cfg, opts.team);
      // allSettled: one team's 403 (leave race / KV lag right after a join) must
      // not blank every OTHER team's asks — warn per team instead.
      const settled = await Promise.allSettled(
        teams.map((t) => api.inbox(s, t.id, undefined, false).then((r) => r.ayos)),
      );
      settled.forEach((r, i) => {
        if (r.status === "rejected") console.error(pc.yellow(`⚠ couldn't read ${teams[i]!.name}: ${(r.reason as Error).message}`));
      });
      const ayos = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const now = Date.now();
      const waiting = ayos.filter(
        (a) =>
          a.kind === "ask" &&
          a.askAnswer === null &&
          (!a.expiresAt || new Date(a.expiresAt).getTime() > now),
      );
      if (opts.json) return void console.log(JSON.stringify(waiting, null, 2));
      if (!waiting.length) return void console.log(pc.dim("nothing waiting on you"));
      waiting.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)); // longest-waiting first
      console.log(pc.bold("\n  ⧗ waiting on you") + pc.dim(`   ${waiting.length} blocked`));
      console.log(pc.dim("  " + "─".repeat(60)));
      // Snapshot id + question per number: `ayo answer 1 …` then echoes what
      // was answered, so a stale numbering can never silently mis-answer.
      const map: Record<string, { id: string; body: string; from: string }> = {};
      waiting.forEach((a, i) => {
        const n = i + 1;
        map[String(n)] = { id: a.id, body: a.body, from: a.from.id === s.userId ? "your agent" : a.from.handle };
        const mark = CIRCLED[i] ?? `${n}.`;
        const who = a.from.id === s.userId ? "your agent" : a.from.handle;
        const where = a.context?.repo ? ` · ${a.context.repo}@${a.context.branch ?? "?"}` : "";
        const tag = teams.length > 1 ? pc.dim(` [${teamName.get(a.teamId) ?? a.teamId}]`) : "";
        console.log(`  ${pc.bold(mark)}  ${pc.cyan(who)}${tag}${pc.dim(where)} · ${pc.dim(`waiting ${waitingFor(a.createdAt)}`)}`);
        console.log(`      ${pc.bold(`"${a.body}"`)}`);
        if (a.context?.note) console.log(pc.dim(`      ${a.context.note}`));
        const opts_ = a.ask?.options ?? [];
        const suggestions = opts_.length
          ? opts_.map((o) => pc.cyan(`ayo answer ${n} ${o.includes(" ") ? `"${o}"` : o}`)).join(pc.dim("  ·  "))
          : pc.cyan(`ayo answer ${n} "…"`);
        console.log(pc.dim("       answer:  ") + suggestions);
        console.log();
      });
      // Number → id map so `ayo answer 1 …` works without typing ids.
      writeFileSync(ASK_MAP_PATH, JSON.stringify(map));
    } catch (err) {
      fail(err);
    }
  });

// ── answer (close the loop on an ask) ─────────────────────────────────────────
program
  .command("answer <which> <answer...>")
  .description("Answer an ask — by number from `ayo agents`, or by ayo_ id")
  .addHelpText("after", `
Examples:
  ayo answer 1 ship                 answer ask #1 from \`ayo agents\`
  ayo answer 2 "use approach B, and add a test first"`)
  .action(async (which: string, answerParts: string[]) => {
    try {
      const s = requireSession();
      let id = which;
      let echo = "";
      if (!which.startsWith("ayo_")) {
        const map: Record<string, { id: string; body: string; from: string }> = existsSync(ASK_MAP_PATH)
          ? (JSON.parse(readFileSync(ASK_MAP_PATH, "utf8")) as Record<string, { id: string; body: string; from: string }>)
          : {};
        const mapped = map[which];
        // Also guards a stale/old-format asks.json (string values) — regenerate.
        if (!mapped || typeof mapped.id !== "string") {
          return console.log(pc.yellow(`No ask #${which} — run \`ayo agents\` to see what's waiting.`));
        }
        id = mapped.id;
        echo = ` ${pc.bold(`"${mapped.body}"`)} ${pc.dim(`(${mapped.from})`)} →`;
      }
      const answer = answerParts.join(" ");
      await api.answerAsk(s, id, answer);
      // Echo WHAT was answered — this tool gates deploys/spends; never blind.
      console.log(pc.green("✓ answered") + echo + ` ${pc.cyan(answer)}` + pc.dim("  — the agent picks it up within ~3s."));
    } catch (err) {
      fail(err);
    }
  });

// ── inbox ────────────────────────────────────────────────────────────────────
program
  .command("inbox")
  .description("Read your Ayos from every team — open asks pin to the top")
  .option("--unread", "only unread", false)
  .option("--team <team>", "only this team (name or id)")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      // Every team by default — a ping must never be invisible because it came
      // from the non-active team. Fall back to the active team if me() fails.
      const { teams, teamName } = await inboxTeams(s, cfg, opts.team);
      // allSettled: one team's 403 (leave race / KV lag right after a join) must
      // not blank every OTHER team's pings — warn per team instead.
      const settled = await Promise.allSettled(
        teams.map((t) => api.inbox(s, t.id, undefined, opts.unread).then((r) => r.ayos)),
      );
      settled.forEach((r, i) => {
        if (r.status === "rejected") console.error(pc.yellow(`⚠ couldn't read ${teams[i]!.name}: ${(r.reason as Error).message}`));
      });
      const ayos = settled
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      if (opts.json) return void console.log(JSON.stringify(ayos, null, 2));
      if (!ayos.length) return void console.log(pc.dim("inbox zero"));
      // Unanswered asks PIN to the top — each one is a blocked agent, not a
      // scrollable message. Everything else keeps chronological order.
      const isOpenAsk = (a: (typeof ayos)[number]): boolean =>
        a.kind === "ask" && a.askAnswer === null && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now());
      const pinned = ayos.filter(isOpenAsk);
      const rest = ayos.filter((a) => !isOpenAsk(a));
      if (pinned.length) {
        console.log(pc.bold(`  ⧗ ${pinned.length} waiting on you`) + pc.dim("  — `ayo agents` to answer"));
      }
      // Threading: a guest reply (from a handoff share page) carries replyTo —
      // render WHICH handoff it answers, or the "threaded" promise the share
      // page makes is invisible to the human on this side of it.
      const byId = new Map(ayos.map((a) => [a.id, a]));
      for (const a of [...pinned, ...rest]) {
        const where = a.context?.branch ? pc.dim(` ${a.context.repo}@${a.context.branch}`) : "";
        // Badge the team only when more than one is in view.
        const tag = teams.length > 1 ? pc.dim(` [${teamName.get(a.teamId) ?? a.teamId}]`) : "";
        const mark = isOpenAsk(a) ? pc.yellow("⧗ ") : a.urgency === "urgent" ? pc.red("! ") : "";
        const from = a.kind === "ask" && a.from.id === s.userId ? "your agent" : a.from.handle;
        const age = pc.dim(rel(a.createdAt).padStart(4) + "  ");
        console.log(`${age}${mark}${pc.bold(pc.cyan(from))}${tag}${where}: ${a.body}`);
        if (a.replyTo) {
          // Resolve locally when the referenced Ayo is in this inbox; otherwise
          // the relay stamps guest replies with a `re: "<blocker>"` note (the
          // handoff's sender never has their own handoff in their inbox).
          const ref = byId.get(a.replyTo);
          const clip = (t: string): string => (t.length > 54 ? `${t.slice(0, 53)}…` : t);
          // "message", not "handoff": nothing enforces that replyTo points at a
          // handoff, and the fallback must not claim more than it knows.
          const tie = ref
            ? `↳ re: ${clip(`"${ref.body}"`)}`
            : a.context?.note?.startsWith('re: "')
              ? `↳ ${clip(a.context.note)}`
              : "↳ re: an earlier message";
          console.log(pc.dim(`      ${tie}`));
        }
        if (a.context?.diffStat) console.log(pc.dim(`      ${a.context.diffStat}`));
      }
      // Viewing the inbox is an explicit human action -> mark read.
      const results = await Promise.allSettled(ayos.map((a) => api.markRead(s, a.id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) console.error(pc.yellow(`⚠ ${failed} read receipt(s) didn't reach the relay`));
    } catch (err) {
      fail(err);
    }
  });

// ── who (handles you can ping) ───────────────────────────────────────────────
program
  .command("who")
  .description("List who's on your team (the handles you can ping)")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const { members } = await api.members(s, teamId);
      if (opts.json) return void console.log(JSON.stringify(members, null, 2));
      if (!members.length) return void console.log(pc.dim("No teammates yet — run `ayo invite` for a paste-ready invitation."));
      for (const m of members) {
        const dot = m.online ? pc.green("●") : pc.dim("○");
        const you = m.handle.toLowerCase() === s.handle.toLowerCase() ? pc.dim(" (you)") : "";
        console.log(`${dot} ${pc.bold(m.handle)}${you}`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ── status ───────────────────────────────────────────────────────────────────
program
  .command("status [text]")
  .description('Set your status text and/or availability, e.g. ayo status "locked in" --heads-down')
  .option("--active", "available — pings come through", false)
  .option("--heads-down", "focusing — hold non-urgent pings for your inbox", false)
  .option("--dnd", "do not disturb — hold non-urgent pings for your inbox", false)
  .option("--away", "stepped out", false)
  .action(async (text: string | undefined, opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);

      const flagCount = [opts.active, opts.headsDown, opts.dnd, opts.away].filter(Boolean).length;
      if (flagCount > 1) {
        console.error(pc.red("✗ pass only one of --active, --heads-down, --dnd, --away"));
        process.exit(1);
      }
      const flagStatus: PresenceStatus | undefined =
        opts.dnd ? "dnd" : opts.headsDown ? "heads-down" : opts.away ? "away" : opts.active ? "active" : undefined;

      const echo = (status: PresenceStatus, statusText: string | null): void => {
        const quiet = status === "heads-down" || status === "dnd";
        console.log(
          pc.green("✓ status: ") +
            pc.bold(status) +
            (statusText ? pc.dim(` — "${statusText}"`) : "") +
            (quiet ? pc.dim("  (holding non-urgent pings)") : ""),
        );
      };

      // Fetch current presence only when we need to preserve availability/text
      // (or for a bare read). If both are supplied, no round-trip.
      let current: { status: PresenceStatus; statusText: string | null } | undefined;
      if (flagStatus === undefined || text === undefined) {
        const { members } = await api.members(s, teamId);
        const me = members.find((m) => m.handle.toLowerCase() === s.handle.toLowerCase());
        if (!me) {
          // Don't default to "active" — that would silently flip availability,
          // the exact footgun this command is fixing.
          console.error(pc.yellow("⚠ couldn't find your handle in the team roster — try again in a moment"));
          process.exit(1);
        }
        current = { status: me.status, statusText: me.statusText };
      }

      // Bare `ayo status` (no flag, no text) is a pure read — show it, don't
      // re-broadcast presence for no change.
      if (flagStatus === undefined && text === undefined) {
        echo(current!.status, current!.statusText);
        return;
      }

      const status = flagStatus ?? current!.status;
      const statusText = text ?? current?.statusText ?? null;
      // Status is about YOU, not a team — and the daemon now streams every
      // team, so heads-down must hold pings EVERYWHERE or the promise below
      // ("holding non-urgent pings") is false for all but the active team.
      let teamIds = [teamId];
      try {
        const { teams } = await api.me(s);
        if (teams.length) teamIds = teams.map((t) => t.id);
      } catch {
        /* me() unavailable — active team only, better than nothing */
      }
      const results = await Promise.allSettled(teamIds.map((id) => api.setStatus(s, id, { status, statusText })));
      const failedN = results.filter((r) => r.status === "rejected").length;
      echo(status, statusText);
      if (failedN) console.error(pc.yellow(`⚠ status didn't reach ${failedN} of ${teamIds.length} teams`));
    } catch (err) {
      fail(err);
    }
  });

// ── daemon ───────────────────────────────────────────────────────────────────
const daemon = program.command("daemon").description("Manage the ayod receiver");
daemon
  .command("install")
  .description("Install ayod as a login service (survives reboots)")
  .action(() => daemonInstall());
daemon
  .command("uninstall")
  .description("Remove the ayod login service")
  .action(() => daemonUninstall());
daemon.command("start").description("Start ayod").action(() => daemonStart());
daemon.command("status").description("Is ayod running & installed?").action(() => daemonStatus());
daemon.command("stop").description("Stop ayod").action(() => daemonStop());
daemon.command("logs").description("Tail ayod logs").action(() => daemonLogs());

// ── hooks (Layer 1: agent surfacing) ─────────────────────────────────────────
const hooks = program.command("hooks").description("Wire Ayo into Codex & Claude Code");
function targets(opts: { claude?: boolean; codex?: boolean }): { claude: boolean; codex: boolean } {
  // No flag = both.
  if (!opts.claude && !opts.codex) return { claude: true, codex: true };
  return { claude: !!opts.claude, codex: !!opts.codex };
}

/** MCP supports more hosts than hooks (Cursor, etc.). No flag = all hosts. */
function mcpTargets(opts: { claude?: boolean; codex?: boolean; cursor?: boolean }): Set<string> {
  if (!opts.claude && !opts.codex && !opts.cursor) return new Set(MCP_HOSTS);
  const sel = new Set<string>();
  if (opts.claude) sel.add("claude");
  if (opts.codex) sel.add("codex");
  if (opts.cursor) sel.add("cursor");
  return sel;
}
hooks
  .command("install")
  .description("Install agent hooks (default: both)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .action((opts) => hooksInstall(targets(opts)));
hooks.command("status").description("Show which agents are wired").action(() => hooksStatus());
hooks
  .command("uninstall")
  .description("Remove agent hooks (default: both)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .action((opts) => hooksUninstall(targets(opts)));

// ── mcp (register the Ayo MCP server with the agents) ────────────────────────
const mcp = program.command("mcp").description("Register the Ayo MCP server with your agents (Claude, Codex, Cursor)");
mcp
  .command("install")
  .description("Register the Ayo tools with your agents (default: all)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .option("--cursor", "Cursor only")
  .action((opts) => mcpInstall(mcpTargets(opts)));
mcp.command("status").description("Show where the Ayo MCP server is registered").action(() => mcpStatus());
mcp
  .command("uninstall")
  .description("Unregister the Ayo MCP server (default: all)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .option("--cursor", "Cursor only")
  .action((opts) => mcpUninstall(mcpTargets(opts)));

// ── agent surfacing entrypoints (hook targets; hidden) ───────────────────────
/** Claude/Codex pass a JSON hook payload on stdin (session_id, cwd,
 *  hook_event_name). Read it (with a timeout so a manual run never hangs). */
async function readHookStdin(): Promise<{ sessionId?: string; cwd?: string; event?: string }> {
  if (process.stdin.isTTY) return {};
  try {
    const raw = await Promise.race([
      (async () => {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString("utf8").trim();
      })(),
      new Promise<string>((r) => setTimeout(() => r(""), 800)),
    ]);
    process.stdin.destroy(); // release the handle (the timeout branch leaves the reader open)
    if (!raw) return {};
    const j = JSON.parse(raw) as { session_id?: string; cwd?: string; hook_event_name?: string };
    return { sessionId: j.session_id, cwd: j.cwd, event: j.hook_event_name };
  } catch {
    return {};
  }
}
program
  .command("agent-context", { hidden: true })
  .description("Print unread Ayos for agent context injection (Claude hooks)")
  .action(async () => {
    const hook = await readHookStdin();
    await surfaceUnread({ surface: "claude", print: true, hook });
    // Flush stdout before exit — process.exit() can truncate a piped stdout,
    // which would drop the context we inject into the Claude hook. Bounded so a
    // blocked pipe can't add more than 1s to hook latency.
    await Promise.race([
      new Promise<void>((r) => process.stdout.write("", () => r())),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
    process.exit(0); // don't let an open stdin handle keep the hook alive
  });
program
  .command("notify-check", { hidden: true })
  .description("Toast fallback for unread Ayos (Codex notify)")
  .action(() => surfaceUnread({ surface: "codex", print: false }));

// ── doctor ───────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check your setup: relay, daemon, agent wiring, and a test toast")
  .option("--no-toast", "skip the test notification")
  .action(async (opts) => {
    const cfg = loadConfig();
    // loadSession (not requireSession, which process.exit(1)s) so a logged-out
    // user still gets every other check + actionable next steps.
    const s = loadSession();

    console.log(`relay:   ${cfg.relayUrl}`);
    console.log(`session: ${s ? pc.green(`logged in as ${s.handle}`) : pc.red("not logged in — run `ayo login`")}`);

    // One me() round-trip does double duty: proves the relay is reachable AND
    // names the active team (a raw team_… id is machine junk in a human check).
    let teamName: string | undefined;
    let allTeams: { id: string; name: string }[] = [];
    let relayLine: string | null = null;
    if (s) {
      try {
        const me = await api.me(s);
        teamName = me.teams.find((t) => t.id === cfg.activeTeamId)?.name;
        allTeams = me.teams;
        relayLine = pc.green("✓ relay reachable");
      } catch (err) {
        relayLine = pc.red(`✗ relay unreachable: ${(err as Error).message}`);
      }
    }
    const teamShown = cfg.activeTeamId
      ? teamName
        ? `${pc.bold(teamName)} ${pc.dim(`(${cfg.activeTeamId})`)}`
        : cfg.activeTeamId
      : pc.dim("none — `ayo team create` or `ayo join`");
    console.log(`team:    ${teamShown}`);
    if (allTeams.length > 1) {
      const others = allTeams.filter((t) => t.id !== cfg.activeTeamId).map((t) => t.name).join(", ");
      console.log(`teams:   ${allTeams.length} ${pc.dim(`(also on: ${others} — the daemon streams every team; sends target the active one)`)}`);
    }
    if (relayLine) console.log(relayLine);

    // The daemon is the receiver — without it, Ayos never reach this machine.
    // Version matters: after an npm upgrade the SERVICE keeps running the old
    // ayod until restarted, silently missing new behavior (e.g. multi-team).
    if (isDaemonAlive()) {
      let dv: string | undefined;
      try {
        const meta = JSON.parse(readFileSync(DAEMON_META_PATH, "utf8")) as { pid?: number; version?: string };
        const livePid = Number(readFileSync(join(AYO_DIR, "daemon.pid"), "utf8").trim());
        // A stale meta (an ayod that ran once and exited) must not vouch for
        // the daemon that's actually running.
        if (meta.pid === livePid) dv = meta.version;
      } catch {
        /* older daemon wrote no meta */
      }
      const skew = dv && dv !== pkgVersion();
      console.log(pc.green(`✓ daemon running (ayod${dv ? ` v${dv}` : ""})`));
      if (skew) console.log(pc.yellow(`⚠ daemon is v${dv} but the CLI is v${pkgVersion()} — restart it: \`ayo daemon stop && ayo daemon start\``));
      else if (!dv) console.log(pc.dim("  (daemon predates version reporting — restart it once so doctor can check for skew)"));
    } else {
      console.log(pc.yellow("⚠ daemon not running — `ayo daemon install` (or `ayo daemon start`)"));
    }

    // Where Ayo is (or isn't) wired into your agents.
    console.log(pc.bold("\nagent wiring:"));
    console.log(pc.dim("  hooks (surface unread at turn boundaries):"));
    hooksStatus();
    console.log(pc.dim("  mcp (use Ayo from inside the agent):"));
    mcpStatus();
    // Be honest about the asymmetry: Claude Code can inject unread Ayos into the
    // model at turn boundaries; Codex can't, so it's toast + MCP tools only.
    console.log(pc.dim("  note: Claude Code gets in-agent context injection; Codex is toast + MCP tools only."));

    // The link that fails silently: does a toast actually render? We can't know
    // (the OS exits 0 even when it suppresses the toast under Focus/DND/denied
    // permission), so fire one and let the human be the judge.
    if (opts.toast !== false) {
      console.log(pc.bold("\nnotifications:"));
      if (process.platform === "darwin") console.log(pc.dim("  (may take a moment)…"));
      try {
        fireTestToast(s?.handle ?? "me");
        console.log("→ sent a test toast — " + pc.bold("did it appear?"));
        console.log(
          process.platform === "darwin"
            ? pc.dim("  Nothing? System Settings ▸ Notifications (allow Ayo / Script Editor), and turn off Focus/DND.")
            : pc.dim("  Nothing? Check your OS notification settings and Do Not Disturb."),
        );
      } catch (err) {
        console.log(pc.red(`✗ couldn't fire a test toast: ${(err as Error).message}`));
      }
    }
  });

// ── hackathon mode ───────────────────────────────────────────────────────────
const hack = program.command("hackathon").description("Shared deadline + milestone nudges + timeline export");
hack
  .command("start <name>")
  .description("Start a sprint with a deadline, e.g. ayo hackathon start \"Hack Midwest\" --ends 18h")
  .requiredOption("--ends <duration>", "time until the deadline, e.g. 18h, 90m, 1h30m")
  .action((name: string, opts) => hackathonStart(name, opts.ends));
hack.command("status").description("Show the deadline + countdown").action(() => hackathonStatus());
hack.command("end").description("End the hackathon (stops nudges)").action(() => hackathonEnd());
hack
  .command("export")
  .description("Print the event timeline as markdown (`> story.md`)")
  .action(() => hackathonExport());

// ── sound (your signature notification sound) ────────────────────────────────
const sound = program.command("sound").description("Your signature sound — what teammates hear when you ping");
sound.command("list").description("List the preset sounds").action(() => soundList());
sound.command("preview <id>").description("Hear a preset").action((id: string) => soundPreview(id));
sound.command("set <id>").description("Make a preset your signature sound").action((id: string) => soundSet(id));
sound.command("upload <file>").description("Upload your own WAV (≤ 1 MB, ~2s) as your signature sound").action((f: string) => soundUpload(f));
sound.command("status").description("Show your sound + mute settings").action(() => soundStatus());
sound.command("mute [handle]").description("Mute all incoming sounds, or one sender").action((h?: string) => soundMute(h));
sound.command("unmute [handle]").description("Unmute all, or one sender").action((h?: string) => soundUnmute(h));

// ── board (live team dashboard) ──────────────────────────────────────────────
program
  .command("board")
  .description("Live team dashboard — presence, status, open handoffs, recent activity")
  .option("--once", "print one frame and exit (for piping / scripts)")
  .option("--team <team>", "view another team's board without switching your active team")
  .action((opts) => board({ once: !!opts.once, team: opts.team }));

// ── handoff (the hero: hand off your work with full context) ─────────────────
program
  .command("handoff <target> [message...]")
  .description("Hand off your work to a teammate (branch, changed files, diff stat, note)")
  .option("--with-diff", "attach the full git diff (may contain uncommitted secrets)", false)
  .option("--urgent", "mark urgent", false)
  .option("--no-link", "don't also mint a shareable web link for the handoff")
  .option("--no-code", "mint the link but don't embed the team join code (share context without granting join access)")
  .option("--expires <hours>", "when the share link expires (default 7 days)")
  .addHelpText("after", `
Examples:
  ayo handoff maya "stuck on the oauth callback"     branch + files + blocker, plus a share link
  ayo handoff maya --with-diff                       include the full diff (may contain secrets)
  ayo handoff team "who can take the deploy?"        offer it to anyone`)
  .action(async (target: string, message: string[], opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const broadcast = ["all", "team", "everyone"].includes(target);
      const to = broadcast ? ["*"] : [resolveHandle(cfg, target)];
      const ctx = captureContext({ withDiff: opts.withDiff });
      const body = message.join(" ") || "Handing this off.";
      const res = await api.send(s, teamId, {
        to,
        body,
        kind: "handoff",
        urgency: opts.urgent ? "urgent" : "normal",
        context: ctx,
      });
      await reportSend(res, {
        label: "handoff sent",
        broadcast,
        self: !broadcast && to.every((h) => h.toLowerCase() === s.handle.toLowerCase()),
        lookup: { s, teamId },
      });
      if (ctx?.repo) {
        const bits = [`${ctx.repo}@${ctx.branch ?? "?"}`, `${ctx.changedFiles?.length ?? 0} changed`];
        if (ctx.diff) bits.push("full diff");
        if (ctx.diffStat) bits.push(ctx.diffStat);
        console.log(pc.dim(`  ${bits.join(" · ")}`));
      } else {
        console.log(pc.dim("  (not in a git repo — sent without code context)"));
      }
      // The Loom mechanic: a shareable web link that works for non-users too.
      // Best-effort — the handoff already sent; a link failure must not error out.
      if (opts.link) {
        try {
          const hrs = opts.expires ? Number(opts.expires) : undefined;
          const link = await api.createHandoffLink(s, teamId, {
            blocker: body,
            context: ctx,
            ayoId: res.id, // replies from the page thread back to this handoff
            expiresInHours: Number.isFinite(hrs) ? hrs : undefined,
            // Commander: `--no-code` sets opts.code=false. Default (undefined/true)
            // lets the relay embed the code; false explicitly omits it.
            includeJoinCode: opts.code === false ? false : undefined,
          });
          console.log(pc.green("  ✓ share link  ") + pc.cyan(link.url));
          const reach = opts.code === false
            ? "shows your context to anyone — no join code embedded."
            : "works for anyone, even before they're on Ayo — expires automatically.";
          console.log(pc.dim(`     ${reach}`));
        } catch (err) {
          console.log(pc.dim(`  (couldn't mint a share link: ${err instanceof Error ? err.message : "unknown"})`));
        }
      }
    } catch (err) {
      fail(err);
    }
  });

// ── default: send (ayo <handle|all> <message...>) ────────────────────────────
program
  .command("send <target> [message...]", { isDefault: true, hidden: true })
  .description("Send an Ayo: ayo <handle> <message>  (target `all` broadcasts)")
  .option("--urgent", "urgent ping", false)
  .option("--with-diff", "attach full git diff", false)
  .action(async (target: string, message: string[], opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      const teamId = requireTeam(cfg);
      const body = message.join(" ");
      if (!body) {
        // `ayo inbxo` lands here (unknown tokens fall through to the default send
        // command) — a bare near-miss of a command name is a typo, not a ping.
        const near = HELP_ORDER.find((c) => levenshtein(target.toLowerCase(), c) <= 2);
        if (near) {
          console.error(pc.yellow(`⚠ unknown command '${target}'`) + pc.dim(` — did you mean \`ayo ${near}\`?`));
          return void (process.exitCode = 1);
        }
        return void console.log("Nothing to send. `ayo <handle> <message>`");
      }
      const broadcast = ["all", "team", "everyone"].includes(target);
      const to = broadcast ? ["*"] : [resolveHandle(cfg, target)];
      const res = await api.send(s, teamId, {
        to,
        body,
        urgency: opts.urgent ? "urgent" : "normal",
        context: captureContext({ withDiff: opts.withDiff }),
      });
      await reportSend(res, {
        broadcast,
        self: !broadcast && to.every((h) => h.toLowerCase() === s.handle.toLowerCase()),
        lookup: { s, teamId },
      });
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
