#!/usr/bin/env node
/**
 * `ayo` — the one-shot CLI. Sends over HTTP (stateless), reads the inbox, and
 * manages the daemon. Receiving is the daemon's job (ADR 0001/0002).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import {
  loadConfig,
  saveConfig,
  saveSession,
  requireSession,
  resolveHandle,
} from "./config.js";
import { api, RelayError } from "./client.js";
import { captureContext } from "./context.js";
import {
  daemonInstall,
  daemonUninstall,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonLogs,
} from "./daemon-ctl.js";
import { surfaceUnread } from "./agent.js";
import { board } from "./board.js";
import { hackathonEnd, hackathonExport, hackathonStart, hackathonStatus } from "./hackathon.js";
import { hooksInstall, hooksStatus, hooksUninstall } from "./hooks.js";
import { mcpInstall, mcpStatus, mcpUninstall } from "./mcp-setup.js";
import { soundList, soundMute, soundPreview, soundSet, soundStatus, soundUnmute } from "./sound-setup.js";

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

function fail(err: unknown): never {
  if (err instanceof RelayError) console.error(pc.red(`✗ ${err.code}: ${err.message}`));
  else console.error(pc.red(`✗ ${(err as Error).message}`));
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Best-effort: open the verification URL in the user's browser. The URL comes
 *  from the relay and is handed to a subprocess, so: only plain https URLs, and
 *  NEVER `shell: true` (which would let URL metacharacters be interpreted). */
function openBrowser(url: string): void {
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(url)) return; // also skips the dev stub's spaced pseudo-URL
  const [cmd, args]: readonly [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }).unref();
  } catch {
    /* no browser — the user can open the URL manually */
  }
}

// ── login ────────────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Authenticate with GitHub (device flow)")
  .option("--handle <handle>", "handle to use with the local dev stub", process.env.USER ?? "dev")
  .action(async (opts) => {
    try {
      const start = await api.deviceStart(opts.handle);
      console.log(`\n  Open ${pc.cyan(start.verification_uri)}`);
      console.log(`  Enter code ${pc.bold(start.user_code)}\n`);
      openBrowser(start.verification_uri);

      // Coerce defensively: a malformed relay response must not produce NaN
      // (NaN deadline exits instantly; NaN interval spins setTimeout at 0ms).
      const expiresIn = Number(start.expires_in);
      const deadline = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000;
      const startInterval = Number(start.interval);
      let interval = Number.isFinite(startInterval) && startInterval > 0 ? startInterval : 5;

      process.stdout.write(pc.dim("  Waiting for authorization"));
      while (Date.now() < deadline) {
        // Poll first so the dev stub (which is instantly complete) returns at once.
        const poll = await api.devicePoll(start.device_code);
        if (poll.status === "complete") {
          saveSession({ token: poll.session_token, userId: poll.user.id, handle: poll.user.handle });
          console.log(pc.green(`\n✓ logged in as ${pc.bold(poll.user.handle)}`));
          return;
        }
        if (poll.status === "slow_down") {
          // Honor GitHub's new interval (forwarded by the relay), capped so a
          // repeated slow_down can't ratchet the wait to absurd lengths.
          const next = Number(poll.interval);
          interval = Math.min(Number.isFinite(next) && next > 0 ? next : interval + 5, 60);
        }
        process.stdout.write(pc.dim("."));
        await sleep(interval * 1000);
      }
      console.error(pc.red("\n✗ login timed out — run `ayo login` again"));
      process.exit(1);
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
      console.log(`  join code: ${pc.bold(pc.cyan(res.joinCode))}  →  share with \`ayo join ${res.joinCode}\``);
    } catch (err) {
      fail(err);
    }
  });
team
  .command("status")
  .description("Show team roster + presence")
  .action(async () => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team.");
      const { members } = await api.members(s, cfg.activeTeamId);
      for (const m of members) {
        const dot = m.online ? pc.green("●") : pc.dim("○");
        const note = m.statusText ? pc.dim(` — ${m.statusText}`) : "";
        console.log(`${dot} ${pc.bold(m.handle)} ${pc.dim(`(${m.status})`)}${note}`);
      }
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
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const body = message.join(" ");
      if (!body) {
        console.log("Usage: ayo team <message>  ·  ayo team create <name>  ·  ayo team status");
        return;
      }
      const res = await api.send(s, cfg.activeTeamId, {
        to: ["*"],
        body,
        urgency: opts.urgent ? "urgent" : "normal",
        context: captureContext(),
      });
      console.log(pc.green(`✓ team ayo sent`) + pc.dim(` (${res.deliveredTo.length} live, ${res.queuedFor.length} queued)`));
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
      const res = await api.joinTeam(s, code);
      saveConfig({ ...loadConfig(), activeTeamId: res.id });
      console.log(pc.green(`✓ joined ${pc.bold(res.name)}`));
    } catch (err) {
      fail(err);
    }
  });

// ── inbox ────────────────────────────────────────────────────────────────────
program
  .command("inbox")
  .description("Read your Ayos")
  .option("--unread", "only unread", false)
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team.");
      const { ayos } = await api.inbox(s, cfg.activeTeamId, undefined, opts.unread);
      if (opts.json) return void console.log(JSON.stringify(ayos, null, 2));
      if (!ayos.length) return void console.log(pc.dim("inbox zero ✨"));
      for (const a of ayos) {
        const where = a.context?.branch ? pc.dim(` ${a.context.repo}@${a.context.branch}`) : "";
        console.log(`${pc.bold(pc.cyan(a.from.handle))}${where}: ${a.body}`);
        if (a.context?.diffStat) console.log(pc.dim(`   ${a.context.diffStat}`));
      }
      // Viewing the inbox is an explicit human action -> mark read.
      const results = await Promise.allSettled(ayos.map((a) => api.markRead(s, a.id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) console.error(pc.yellow(`⚠ ${failed} read receipt(s) didn't reach the relay`));
    } catch (err) {
      fail(err);
    }
  });

// ── status ───────────────────────────────────────────────────────────────────
program
  .command("status <text>")
  .description('Set your status, e.g. ayo status "locked in on demo"')
  .option("--dnd", "do not disturb", false)
  .action(async (text: string, opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team.");
      await api.setStatus(s, cfg.activeTeamId, { status: opts.dnd ? "dnd" : "heads-down", statusText: text });
      console.log(pc.green(`✓ status set`));
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
const mcp = program.command("mcp").description("Register the Ayo MCP server with Codex & Claude Code");
mcp
  .command("install")
  .description("Register the Ayo tools with your agents (default: both)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .action((opts) => mcpInstall(targets(opts)));
mcp.command("status").description("Show where the Ayo MCP server is registered").action(() => mcpStatus());
mcp
  .command("uninstall")
  .description("Unregister the Ayo MCP server (default: both)")
  .option("--claude", "Claude Code only")
  .option("--codex", "Codex only")
  .action((opts) => mcpUninstall(targets(opts)));

// ── agent surfacing entrypoints (hook targets; hidden) ───────────────────────
program
  .command("agent-context", { hidden: true })
  .description("Print unread Ayos for agent context injection (Claude hooks)")
  .action(() => surfaceUnread({ surface: "claude", print: true }));
program
  .command("notify-check", { hidden: true })
  .description("Toast fallback for unread Ayos (Codex notify)")
  .action(() => surfaceUnread({ surface: "codex", print: false }));

// ── doctor ───────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check environment + connectivity")
  .action(async () => {
    const cfg = loadConfig();
    const s = requireSession();
    console.log(`relay:   ${cfg.relayUrl}`);
    console.log(`session: ${s ? pc.green(`logged in as ${s.handle}`) : pc.red("none")}`);
    console.log(`team:    ${cfg.activeTeamId ?? pc.dim("none")}`);
    try {
      await api.me(s);
      console.log(pc.green("✓ relay reachable"));
    } catch (err) {
      console.log(pc.red(`✗ relay unreachable: ${(err as Error).message}`));
    }
  });

// ── hackathon mode ───────────────────────────────────────────────────────────
const hack = program.command("hackathon").description("Shared deadline + ⏰ nudges + timeline export");
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
sound.command("status").description("Show your sound + mute settings").action(() => soundStatus());
sound.command("mute [handle]").description("Mute all incoming sounds, or one sender").action((h?: string) => soundMute(h));
sound.command("unmute [handle]").description("Unmute all, or one sender").action((h?: string) => soundUnmute(h));

// ── board (live team dashboard) ──────────────────────────────────────────────
program
  .command("board")
  .description("Live team dashboard — presence, status, open handoffs, recent activity")
  .option("--once", "print one frame and exit (for piping / scripts)")
  .action((opts) => board({ once: !!opts.once }));

// ── handoff (the hero: hand off your work with full context) ─────────────────
program
  .command("handoff <target> [message...]")
  .description("Hand off your work to a teammate (branch, changed files, diff stat, note)")
  .option("--with-diff", "attach the full git diff (may contain uncommitted secrets)", false)
  .option("--urgent", "mark urgent", false)
  .action(async (target: string, message: string[], opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const broadcast = ["all", "team", "everyone"].includes(target);
      const to = broadcast ? ["*"] : [resolveHandle(cfg, target)];
      const ctx = captureContext({ withDiff: opts.withDiff });
      const res = await api.send(s, cfg.activeTeamId, {
        to,
        body: message.join(" ") || "Handing this off.",
        kind: "handoff",
        urgency: opts.urgent ? "urgent" : "normal",
        context: ctx,
      });
      console.log(pc.green(`✓ handoff sent`) + pc.dim(` (${res.deliveredTo.length} live, ${res.queuedFor.length} queued)`));
      if (ctx?.repo) {
        const bits = [`${ctx.repo}@${ctx.branch ?? "?"}`, `${ctx.changedFiles?.length ?? 0} changed`];
        if (ctx.diff) bits.push("full diff");
        if (ctx.diffStat) bits.push(ctx.diffStat);
        console.log(pc.dim(`  ${bits.join(" · ")}`));
      } else {
        console.log(pc.dim("  (not in a git repo — sent without code context)"));
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
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const body = message.join(" ");
      if (!body) return console.log("Nothing to send. `ayo <handle> <message>`");
      const broadcast = ["all", "team", "everyone"].includes(target);
      const to = broadcast ? ["*"] : [resolveHandle(cfg, target)];
      const res = await api.send(s, cfg.activeTeamId, {
        to,
        body,
        urgency: opts.urgent ? "urgent" : "normal",
        context: captureContext({ withDiff: opts.withDiff }),
      });
      const live = res.deliveredTo.length;
      const queued = res.queuedFor.length;
      console.log(pc.green(`✓ ayo sent`) + pc.dim(` (${live} live, ${queued} queued)`));
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
