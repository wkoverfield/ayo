/**
 * Signature sounds. The daemon plays the SENDER's chosen sound on receipt,
 * decoupled from the OS toast's own sound (any length/format, uniform across
 * platforms). WAV only — it's the cross-platform lowest common denominator.
 *
 * Resolution: preset -> bundled assets/sounds/<id>.wav; custom -> the daemon's
 * hash cache under $AYO_DIR/sounds/ (Phase A2). Playback is fire-and-forget.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AyoSound } from "@ayo-dev/core";
import { SOUND_PRESETS } from "@ayo-dev/core";
import { AYO_DIR } from "./config.js";

// dist/sound.js -> ../assets/sounds/ (shipped in the npm tarball via `files`).
const PRESET_DIR = fileURLToPath(new URL("../assets/sounds/", import.meta.url));
const CACHE_DIR = join(AYO_DIR, "sounds");

export function presetPath(id: string): string | null {
  if (!(SOUND_PRESETS as readonly string[]).includes(id)) return null;
  const p = join(PRESET_DIR, `${id}.wav`);
  return existsSync(p) ? p : null;
}

/** Resolve an AyoSound to a local WAV path, or null if not locally playable. */
export function resolveSound(sound: AyoSound | null | undefined): string | null {
  if (!sound) return null;
  if (sound.kind === "preset") return presetPath(sound.id);
  // custom (A2): play from the hash cache if the daemon has already fetched it.
  const cached = join(CACHE_DIR, `${sound.hash}.wav`);
  return existsSync(cached) ? cached : null;
}

/** Play a WAV fire-and-forget via the platform's CLI player. Never throws. */
export function playSound(file: string): void {
  try {
    if (process.platform === "darwin") {
      detached("afplay", [file]);
    } else if (process.platform === "win32") {
      const esc = file.replace(/'/g, "''");
      detached("powershell", ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${esc}').PlaySync()`]);
    } else {
      const p = linuxPlayer();
      if (p) detached(p.cmd, [...p.args, file]);
    }
  } catch {
    /* best-effort: a missing player must never break delivery */
  }
}

/** Blocking play for interactive CLI commands (preview/set) — the short-lived CLI
 *  would otherwise exit before a detached player finishes (notably on Windows).
 *  The daemon must NEVER use this; it uses fire-and-forget playSound. */
export function playSoundSync(file: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("afplay", [file], { stdio: "ignore", timeout: 5000 });
    } else if (process.platform === "win32") {
      const esc = file.replace(/'/g, "''");
      execFileSync("powershell", ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${esc}').PlaySync()`], { stdio: "ignore", timeout: 5000 });
    } else {
      const p = linuxPlayer();
      if (p) execFileSync(p.cmd, [...p.args, file], { stdio: "ignore", timeout: 5000 });
    }
  } catch {
    /* best-effort */
  }
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {}); // swallow ENOENT etc.
  child.unref();
}

/** First available Linux player (paplay -> canberra -> aplay -> ffplay). */
function linuxPlayer(): { cmd: string; args: string[] } | null {
  const candidates: { cmd: string; args: string[] }[] = [
    { cmd: "paplay", args: [] },
    { cmd: "canberra-gtk-play", args: ["-f"] },
    { cmd: "aplay", args: ["-q"] },
    { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] },
  ];
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const c of candidates) {
    if (dirs.some((d) => existsSync(join(d, c.cmd)))) return c;
  }
  return null;
}
