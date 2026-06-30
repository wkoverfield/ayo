/**
 * `ayo init` — one command, from `npm i -g` to a working setup in under a minute.
 * Orchestrates the existing installers (login → sound → daemon → mcp → hooks),
 * then fires a real test toast so you SEE+HEAR the product before a teammate even
 * exists. `ayo uninstall` reverses the local wiring. No logic is duplicated here —
 * this is a flow over the same building blocks the individual commands use.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import pc from "picocolors";
import { SOUND_PRESETS } from "@ayo-dev/core";
import type { AyoSound } from "@ayo-dev/core";
import { api, RelayError } from "./client.js";
import { loadConfig, saveConfig, loadSession, saveSession } from "./config.js";
import type { Session } from "./config.js";
import { daemonInstall, daemonUninstall } from "./daemon-ctl.js";
import { mcpInstall, mcpUninstall } from "./mcp-setup.js";
import { hooksInstall, hooksUninstall } from "./hooks.js";
import { fireTestToast } from "./notify.js";
import { presetPath, playSoundSync } from "./sound.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BOTH = { claude: true, codex: true };

/** Best-effort: open the verification URL in the user's browser. The URL comes
 *  from the relay and is handed to a subprocess, so: only plain https URLs, and
 *  NEVER `shell: true` (which would let URL metacharacters be interpreted). */
export function openBrowser(url: string): void {
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

/**
 * GitHub device-flow login. Shared by the `login` command and `ayo init` so the
 * polling/coercion logic lives in exactly one place. Saves the session on success.
 */
export async function deviceLogin(handle?: string): Promise<void> {
  const h = handle ?? process.env.USER ?? "dev";
  const start = await api.deviceStart(h);
  console.log(`\n  Open ${pc.cyan(start.verification_uri)}`);
  console.log(`  Enter code ${pc.bold(start.user_code)}\n`);
  openBrowser(start.verification_uri);

  // Coerce defensively: a malformed relay response must not produce NaN (a NaN
  // deadline exits instantly; a NaN interval spins setTimeout at 0ms).
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
      console.log(pc.green(`\n  ✓ logged in as ${pc.bold(poll.user.handle)}`));
      return;
    }
    if (poll.status === "slow_down") {
      const next = Number(poll.interval);
      interval = Math.min(Number.isFinite(next) && next > 0 ? next : interval + 5, 60);
    }
    process.stdout.write(pc.dim("."));
    await sleep(interval * 1000);
  }
  console.error(pc.red("\n  ✗ login timed out — run `ayo login` again"));
  process.exit(1);
}

type Rl = ReturnType<typeof createInterface>;

interface InitOpts {
  yes?: boolean;
  dryRun?: boolean;
  only?: string;
}

const STEPS = ["login", "sound", "daemon", "mcp", "hooks", "test", "team"] as const;

/** `--only daemon,mcp` → a Set; absent → null (= run everything). Warns on typos
 *  so a misspelled step doesn't silently no-op into a near-empty run. */
function parseOnly(only?: string): Set<string> | null {
  if (!only) return null;
  const set = new Set(only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const unknown = [...set].filter((s) => !(STEPS as readonly string[]).includes(s));
  if (unknown.length) {
    console.log(pc.yellow(`  ⚠ unknown --only step(s): ${unknown.join(", ")}`) + pc.dim(`  (valid: ${STEPS.join(", ")})`));
  }
  return set;
}

export async function runInit(opts: InitOpts): Promise<void> {
  const only = parseOnly(opts.only);
  const want = (step: string): boolean => !only || only.has(step);
  const dry = !!opts.dryRun;
  // No TTY (piped/CI) means we can't prompt — fall back to non-interactive
  // defaults rather than hang or half-run a readline loop on stdin EOF.
  const auto = !!opts.yes || !stdin.isTTY;
  const interactive = !auto && !dry;

  console.log(pc.bold("\n  ayo — let's get you set up.") + (dry ? pc.dim("  (dry run — nothing will change)") : ""));
  // Surface the silent mode switch so a piped/CI run isn't a surprise.
  if (auto && !opts.yes && !dry) console.log(pc.dim("  (no TTY detected — running non-interactive with defaults)"));

  const rl: Rl | null = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  let pickedSound: AyoSound | undefined;
  try {
    // 1 — login
    let session = loadSession();
    if (want("login")) {
      if (session) console.log(`\n  ${pc.green("✓")} logged in as ${pc.bold(session.handle)}`);
      else if (dry) console.log(`\n  ${pc.dim("→ would run GitHub login")}`);
      else {
        await deviceLogin();
        session = loadSession();
      }
    }

    // 2 — signature sound (needs a session to save server-side)
    if (want("sound")) {
      if (dry) console.log(`\n  ${pc.dim("→ would let you pick a signature sound")}`);
      else if (session) pickedSound = await pickSound(session, rl, auto);
    }

    // 3 — wiring: the receiver + both agents
    if (want("daemon") || want("mcp") || want("hooks")) {
      console.log(pc.bold("\n  Wiring your receiver + agents…"));
      if (want("daemon")) step(dry, "daemon (ayod)", () => daemonInstall());
      if (want("mcp")) step(dry, "MCP server (Claude + Codex)", () => mcpInstall(BOTH));
      if (want("hooks")) step(dry, "agent hooks (Claude + Codex)", () => hooksInstall(BOTH));
    }

    // 4 — prove it works on THIS machine (the silent-failure link)
    if (want("test") && dry) {
      console.log(pc.dim("\n  → would fire a test toast (you'd see + hear your sound)"));
    } else if (want("test") && session && !dry) {
      console.log(pc.bold("\n  Let's make sure it works…"));
      fireTestToast(session.handle, pickedSound ?? null);
      if (rl) {
        const ans = (await rl.question(pc.bold("  Did you see and hear it? (Y/n) "))).trim().toLowerCase();
        if (ans.startsWith("n")) {
          console.log(pc.yellow("  No worries — the toast can be suppressed by permissions or Focus."));
          console.log(
            process.platform === "darwin"
              ? pc.dim("  macOS: System Settings ▸ Notifications (allow Ayo / Script Editor), turn off Focus/DND, then `ayo doctor`.")
              : pc.dim("  Check your OS notification settings + Do Not Disturb, then run `ayo doctor`."),
          );
        } else {
          console.log(`  ${pc.green("✓")} you're wired up.`);
        }
      } else {
        console.log(pc.dim("  (fired a test toast — see/hear it? if not, run `ayo doctor`)"));
      }
    }

    // 5 — a team to ping (optional), then teach the magic
    if (want("team") && dry) {
      console.log(pc.dim("  → would offer to create a team (and print a join code)"));
    } else if (want("team") && session && rl) {
      const cfg = loadConfig();
      if (!cfg.activeTeamId) {
        const name = (await rl.question('\n  Name a team to create one (Enter to skip): ')).trim();
        if (name) {
          try {
            const res = await api.createTeam(session, name);
            saveConfig({ ...loadConfig(), activeTeamId: res.id });
            console.log(`  ${pc.green("✓")} created ${pc.bold(name)} — join code ${pc.bold(pc.cyan(res.joinCode))}`);
            console.log(pc.dim(`    teammates run: ayo join ${res.joinCode}`));
          } catch (err) {
            console.log(pc.red(`  ✗ couldn't create team: ${msg(err)}`));
          }
        }
      }
    }

    printNextSteps(dry);
  } finally {
    rl?.close();
  }
}

/** Run an install step (or describe it under --dry-run). */
function step(dry: boolean, label: string, run: () => void): void {
  if (dry) {
    console.log(`  ${pc.dim(`→ would install ${label}`)}`);
    return;
  }
  run();
}

async function pickSound(session: Session, rl: Rl | null, auto: boolean): Promise<AyoSound> {
  // Read the current sound (best-effort) so re-runs default to it and a
  // non-interactive run never resets a sound you already chose.
  let current: AyoSound | null = null;
  try {
    current = (await api.me(session)).user.sound ?? null;
  } catch {
    /* offline / relay down — fall back to defaults below */
  }
  const currentPreset = current?.kind === "preset" ? current.id : null;

  // Non-interactive: keep an existing choice; otherwise set a sensible default.
  if (auto) {
    if (current) {
      console.log(`\n  ${pc.green("✓")} signature sound: ${pc.bold(currentPreset ?? "custom")} ${pc.dim("(kept)")}`);
      return current;
    }
    const id = "chime";
    try {
      await api.setSound(session, { kind: "preset", id });
      console.log(`\n  ${pc.green("✓")} signature sound set to "${id}"`);
    } catch (err) {
      console.log(pc.yellow(`  ⚠ couldn't set a default sound (${msg(err)})`));
    }
    return { kind: "preset", id };
  }

  console.log(pc.bold("\n  Pick your signature sound") + pc.dim(" — teammates hear this when you ping:"));
  console.log("    " + SOUND_PRESETS.join("   "));
  let chosen = currentPreset ?? "chime";
  if (rl) {
    // Preview-and-pick: type a name to hear it, Enter to keep the current one.
    for (;;) {
      const a = (await rl.question(`    type a name to hear it, or Enter to keep "${chosen}": `)).trim();
      if (!a) break;
      if ((SOUND_PRESETS as readonly string[]).includes(a)) {
        const p = presetPath(a);
        if (p) playSoundSync(p);
        chosen = a;
      } else {
        console.log(pc.dim(`    no preset "${a}" — pick one of: ${SOUND_PRESETS.join(", ")}`));
      }
    }
  }
  try {
    await api.setSound(session, { kind: "preset", id: chosen });
    console.log(`    ${pc.green("✓")} your ayo sounds like "${chosen}"`);
  } catch (err) {
    console.log(pc.yellow(`    ⚠ couldn't save your sound (${msg(err)}) — set it later with \`ayo sound set ${chosen}\``));
  }
  return { kind: "preset", id: chosen };
}

function printNextSteps(dry: boolean): void {
  if (dry) {
    console.log(pc.dim("\n  (dry run complete — re-run without --dry-run to apply)"));
    return;
  }
  console.log(pc.bold("\n  ✓ You're set."));
  console.log("  From inside Claude or Codex, just say: " + pc.cyan('"Ayo Maya with my current branch."'));
  console.log("  Or from the terminal: " + pc.cyan("ayo <teammate> \"deploy's cooked\""));
  console.log(pc.dim("  Restart your agent once so the new wiring takes effect."));
}

/** Reverse what `init` wired locally. Leaves login + team membership intact —
 *  those are identity, not local setup. Each step is isolated so a failure in one
 *  (e.g. the `claude` CLI not on PATH) doesn't leave the others half-removed. */
export async function runUninstall(): Promise<void> {
  console.log(pc.bold("\n  Removing Ayo's local wiring…"));
  for (const [label, run] of [
    ["agent hooks", () => hooksUninstall(BOTH)],
    ["MCP server", () => mcpUninstall(BOTH)],
    ["daemon", () => daemonUninstall()],
  ] as const) {
    try {
      run();
    } catch (err) {
      console.log(pc.yellow(`  ⚠ couldn't fully remove ${label}: ${msg(err)}`));
    }
  }
  console.log(`\n  ${pc.green("✓")} removed the daemon + agent wiring.`);
  console.log(pc.dim("  Your login and team membership are untouched. Re-run `ayo init` anytime."));
}

function msg(err: unknown): string {
  return err instanceof RelayError ? err.message : (err as Error).message;
}
