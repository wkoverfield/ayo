/**
 * `ayo sound` — pick your signature sound (what teammates hear when you ping),
 * preview presets, and mute incoming sounds. The chosen sound lives on your relay
 * profile (the relay stamps it onto each Ayo); mute prefs are local (recipient wins).
 */

import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { SOUND_PRESETS } from "@ayo-dev/core";
import { loadConfig, saveConfig, requireSession } from "./config.js";
import { api, RelayError } from "./client.js";
import { presetPath, playSoundSync } from "./sound.js";

function oops(err: unknown): void {
  console.error(pc.red(`✗ ${err instanceof RelayError ? err.message : (err as Error).message}`));
  process.exitCode = 1;
}

export function soundList(): void {
  console.log(pc.bold("presets:"));
  for (const id of SOUND_PRESETS) console.log(`  ${id}`);
  console.log(pc.dim("\n  ayo sound preview <id>   hear one"));
  console.log(pc.dim("  ayo sound set <id>       make it your signature sound"));
}

export function soundPreview(id: string): void {
  const p = presetPath(id);
  if (!p) return void console.log(pc.red(`✗ no preset "${id}". \`ayo sound list\`.`));
  playSoundSync(p);
  console.log(pc.dim(`▶ ${id}`));
}

export async function soundSet(id: string): Promise<void> {
  const p = presetPath(id);
  if (!p) return void console.log(pc.red(`✗ no preset "${id}". \`ayo sound list\`.`));
  try {
    const s = requireSession();
    await api.setSound(s, { kind: "preset", id });
    playSoundSync(p);
    console.log(pc.green(`✓ your ayo now sounds like "${id}"`) + pc.dim(" — teammates hear this when you ping."));
  } catch (err) {
    oops(err);
  }
}

export async function soundUpload(file: string): Promise<void> {
  if (!existsSync(file)) return void console.log(pc.red(`✗ no file at ${file}`));
  if (!file.toLowerCase().endsWith(".wav")) return void console.log(pc.red("✗ must be a .wav file (≤ 1 MB, ~2s)."));
  const buf = readFileSync(file);
  if (buf.byteLength > 1024 * 1024) return void console.log(pc.red("✗ too big — keep it under 1 MB."));
  try {
    const s = requireSession();
    await api.uploadSound(s, buf);
    playSoundSync(file); // let them hear what they just set
    console.log(pc.green("✓ your custom ayo sound is set") + pc.dim(" — teammates hear this when you ping."));
  } catch (err) {
    oops(err);
  }
}

export async function soundStatus(): Promise<void> {
  try {
    const s = requireSession();
    const { user } = await api.me(s);
    const mine =
      user.sound?.kind === "preset" ? user.sound.id : user.sound?.kind === "custom" ? "custom" : "default";
    const cfg = loadConfig();
    console.log(`your signature sound: ${pc.bold(mine)}`);
    if (cfg.muteSounds) console.log(pc.dim("incoming sounds: muted (all)"));
    else if (cfg.mutedSenders?.length) console.log(pc.dim(`muted senders: ${cfg.mutedSenders.join(", ")}`));
    else console.log(pc.dim("incoming sounds: on"));
  } catch (err) {
    oops(err);
  }
}

export function soundMute(handle?: string): void {
  const cfg = loadConfig();
  if (!handle) {
    cfg.muteSounds = true;
    saveConfig(cfg);
    return void console.log(pc.green("✓ muted all ayo sounds") + pc.dim(" (you still get the toast)"));
  }
  cfg.mutedSenders = [...new Set([...(cfg.mutedSenders ?? []), handle])];
  saveConfig(cfg);
  console.log(pc.green(`✓ muted ${handle}'s sound`));
}

export function soundUnmute(handle?: string): void {
  const cfg = loadConfig();
  if (!handle) {
    cfg.muteSounds = false;
    cfg.mutedSenders = [];
    saveConfig(cfg);
    return void console.log(pc.green("✓ unmuted all ayo sounds"));
  }
  cfg.mutedSenders = (cfg.mutedSenders ?? []).filter((h) => h !== handle);
  saveConfig(cfg);
  console.log(pc.green(`✓ unmuted ${handle}`));
}
