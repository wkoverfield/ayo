#!/usr/bin/env node
/**
 * `ayo` — the one-shot CLI. Sends over HTTP (stateless), reads the inbox, and
 * manages the daemon. Receiving is the daemon's job (ADR 0001/0002).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  AYO_DIR,
  loadConfig,
  saveConfig,
  requireSession,
  loadSession,
  resolveHandle,
} from "./config.js";
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

function fail(err: unknown): never {
  if (err instanceof RelayError) console.error(pc.red(`✗ ${err.code}: ${err.message}`));
  else console.error(pc.red(`✗ ${(err as Error).message}`));
  process.exit(1);
}

/**
 * Report a send result honestly. The relay tells us who it actually reached and
 * which requested handles match no teammate — so we never print a green ✓ for an
 * Ayo that went nowhere (a typo'd or not-yet-joined handle used to look like a
 * success). Shared by `send`, `handoff`, and `team` broadcast.
 */
function reportSend(res: SendAyoResponse, opts: { label?: string; broadcast?: boolean } = {}): void {
  const label = opts.label ?? "ayo sent";
  const live = res.deliveredTo.length;
  const queued = res.queuedFor.length;
  const unknown = res.unknownRecipients ?? [];
  const held = res.heldFor ?? [];

  if (unknown.length) {
    const names = unknown.map((h) => pc.bold(h)).join(", ");
    console.log(pc.yellow(`⚠ no such teammate: ${names}`) + pc.dim("  — run `ayo who` to see who you can ping"));
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
    // A real send that reached no one — not a typo, just an empty room.
    console.log(
      opts.broadcast
        ? pc.yellow("· nobody to reach yet — invite a teammate with a join code")
        : pc.yellow("· reached no one"),
    );
  }
  // (reached 0 AND unknown.length > 0 — the warning above already explained it.)
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
team
  .command("rotate-code")
  .description("Rotate your team's join code (revokes the old one) — creator only")
  .option("--expires <hours>", "auto-expire the new code after N hours")
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team.");
      const hrs = opts.expires ? Number(opts.expires) : undefined;
      const res = await api.rotateCode(s, cfg.activeTeamId, hrs);
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
      reportSend(res, { label: "team ayo sent", broadcast: true });
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
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const { name, joinCode, codeExpiresAt } = await api.invite(s, cfg.activeTeamId);
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

// ── hook (inbound webhooks: one curl → Ayo) ──────────────────────────────────
const hook = program
  .command("hook")
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
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      if (opts.github && opts.to) {
        console.log(pc.yellow("⚠ --to is ignored for GitHub webhooks — recipients come from the event (reviewer, mentioned, author)."));
      }
      const info = await api.createWebhook(s, cfg.activeTeamId, {
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
            "\n  Review requests, @mentions, and review submissions become Ayos to the\n  matching handle (Ayo handle = GitHub login). Secret shown once — revoke with `ayo hook revoke <url>`.",
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
        pc.dim("\n  Keep this URL secret — anyone with it can ping your team. Revoke with `ayo hook revoke <url>`."),
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
      if (!cfg.activeTeamId) return console.log("No active team.");
      const { hooks } = await api.listWebhooks(s, cfg.activeTeamId);
      if (!hooks.length) return console.log(pc.dim("No webhooks yet. `ayo hook create`."));
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
      if (!cfg.activeTeamId) return console.log("No active team.");
      // Accept a full URL (with any query/trailing slash) or a bare token.
      let t = token;
      if (token.includes("/")) {
        try {
          t = new URL(token).pathname.split("/").filter(Boolean).pop() ?? token;
        } catch {
          t = token.split("/").filter(Boolean).pop() ?? token;
        }
      }
      await api.revokeWebhook(s, cfg.activeTeamId, t);
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

program
  .command("agents")
  .description("Which asks are waiting on you (blocked agents + teammates' questions)")
  .option("--json", "raw JSON for agents", false)
  .action(async (opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team.");
      const { ayos } = await api.inbox(s, cfg.activeTeamId, undefined, false);
      const now = Date.now();
      const waiting = ayos.filter(
        (a) =>
          a.kind === "ask" &&
          a.askAnswer === null &&
          (!a.expiresAt || new Date(a.expiresAt).getTime() > now),
      );
      if (opts.json) return void console.log(JSON.stringify(waiting, null, 2));
      if (!waiting.length) return void console.log(pc.dim("nothing waiting on you ✨"));
      waiting.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)); // longest-waiting first
      console.log(pc.bold("\n  ⧗ waiting on you") + pc.dim(`   ${waiting.length} blocked`));
      console.log(pc.dim("  " + "─".repeat(60)));
      const map: Record<string, string> = {};
      waiting.forEach((a, i) => {
        const n = i + 1;
        map[String(n)] = a.id;
        const mark = CIRCLED[i] ?? `${n}.`;
        const who = a.from.id === s.userId ? "your agent" : a.from.handle;
        const where = a.context?.repo ? ` · ${a.context.repo}@${a.context.branch ?? "?"}` : "";
        console.log(`  ${pc.bold(mark)}  ${pc.cyan(who)}${pc.dim(where)} · ${pc.dim(`waiting ${waitingFor(a.createdAt)}`)}`);
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
  .action(async (which: string, answerParts: string[]) => {
    try {
      const s = requireSession();
      let id = which;
      if (!which.startsWith("ayo_")) {
        const map: Record<string, string> = existsSync(ASK_MAP_PATH)
          ? (JSON.parse(readFileSync(ASK_MAP_PATH, "utf8")) as Record<string, string>)
          : {};
        const mapped = map[which];
        if (!mapped) return console.log(pc.yellow(`No ask #${which} — run \`ayo agents\` to see what's waiting.`));
        id = mapped;
      }
      await api.answerAsk(s, id, answerParts.join(" "));
      console.log(pc.green("✓ answered") + pc.dim(" — the agent picks it up within ~3s."));
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
      // Unanswered asks PIN to the top — each one is a blocked agent, not a
      // scrollable message. Everything else keeps chronological order.
      const isOpenAsk = (a: (typeof ayos)[number]): boolean =>
        a.kind === "ask" && a.askAnswer === null && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now());
      const pinned = ayos.filter(isOpenAsk);
      const rest = ayos.filter((a) => !isOpenAsk(a));
      if (pinned.length) {
        console.log(pc.bold(`  ⧗ ${pinned.length} waiting on you`) + pc.dim("  — `ayo agents` to answer"));
      }
      for (const a of [...pinned, ...rest]) {
        const where = a.context?.branch ? pc.dim(` ${a.context.repo}@${a.context.branch}`) : "";
        const mark = isOpenAsk(a) ? pc.yellow("⧗ ") : "";
        const from = a.kind === "ask" && a.from.id === s.userId ? "your agent" : a.from.handle;
        console.log(`${mark}${pc.bold(pc.cyan(from))}${where}: ${a.body}`);
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

// ── who (handles you can ping) ───────────────────────────────────────────────
program
  .command("who")
  .description("List who's on your team (the handles you can ping)")
  .action(async () => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const { members } = await api.members(s, cfg.activeTeamId);
      if (!members.length) return void console.log(pc.dim("No teammates yet — share a join code."));
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
      if (!cfg.activeTeamId) return console.log("No active team.");

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
        const { members } = await api.members(s, cfg.activeTeamId);
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
      await api.setStatus(s, cfg.activeTeamId, { status, statusText });
      echo(status, statusText);
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
    console.log(`team:    ${cfg.activeTeamId ?? pc.dim("none — `ayo team create` or `ayo join`")}`);

    if (s) {
      try {
        await api.me(s);
        console.log(pc.green("✓ relay reachable"));
      } catch (err) {
        console.log(pc.red(`✗ relay unreachable: ${(err as Error).message}`));
      }
    }

    // The daemon is the receiver — without it, Ayos never reach this machine.
    console.log(
      isDaemonAlive()
        ? pc.green("✓ daemon running (ayod)")
        : pc.yellow("⚠ daemon not running — `ayo daemon install` (or `ayo daemon start`)"),
    );

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
sound.command("upload <file>").description("Upload your own WAV (≤ 1 MB, ~2s) as your signature sound").action((f: string) => soundUpload(f));
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
  .option("--no-link", "don't also mint a shareable web link for the handoff")
  .option("--no-code", "mint the link but don't embed the team join code (share context without granting join access)")
  .option("--expires <hours>", "when the share link expires (default 7 days)")
  .action(async (target: string, message: string[], opts) => {
    try {
      const s = requireSession();
      const cfg = loadConfig();
      if (!cfg.activeTeamId) return console.log("No active team. `ayo team create` or `ayo join` first.");
      const broadcast = ["all", "team", "everyone"].includes(target);
      const to = broadcast ? ["*"] : [resolveHandle(cfg, target)];
      const ctx = captureContext({ withDiff: opts.withDiff });
      const body = message.join(" ") || "Handing this off.";
      const res = await api.send(s, cfg.activeTeamId, {
        to,
        body,
        kind: "handoff",
        urgency: opts.urgent ? "urgent" : "normal",
        context: ctx,
      });
      reportSend(res, { label: "handoff sent" });
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
          const link = await api.createHandoffLink(s, cfg.activeTeamId, {
            blocker: body,
            context: ctx,
            expiresInHours: Number.isFinite(hrs) ? hrs : undefined,
            // Commander: `--no-code` sets opts.code=false. Default (undefined/true)
            // lets the relay embed the code; false explicitly omits it.
            includeJoinCode: opts.code === false ? false : undefined,
          });
          console.log(pc.green("  🔗 share link: ") + pc.cyan(link.url));
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
      reportSend(res);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
