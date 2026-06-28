/**
 * Daemon process control. For the scaffold this spawns `ayod` as a detached
 * background process and tracks it via a pidfile. ADR 0001's production target
 * is a launchd/systemd user service installed by `ayo daemon start` — that's a
 * TODO; the pidfile approach proves the slice first.
 */

import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { AYO_DIR } from "./config.js";

const PID_PATH = join(AYO_DIR, "daemon.pid");
const LOG_PATH = join(AYO_DIR, "ayod.log");

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True if ayod is running. Used by the agent hooks for self-healing toasts. */
export function isDaemonAlive(): boolean {
  const pid = readPid();
  return pid != null && isAlive(pid);
}

export function daemonStart(): void {
  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.log(pc.dim(`ayod already running (pid ${existing})`));
    return;
  }
  const ayodPath = join(dirname(fileURLToPath(import.meta.url)), "ayod.js");
  const out = openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [ayodPath], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  if (child.pid) writeFileSync(PID_PATH, String(child.pid));
  console.log(pc.green(`✓ ayod started`) + pc.dim(` (pid ${child.pid}) — logs: ayo daemon logs`));
}

export function daemonStatus(): void {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`${pc.green("●")} ayod running (pid ${pid})`);
  } else {
    console.log(`${pc.dim("○")} ayod not running`);
  }
}

export function daemonStop(): void {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    console.log(pc.dim("ayod not running"));
    return;
  }
  process.kill(pid);
  rmSync(PID_PATH, { force: true });
  console.log(pc.green("✓ ayod stopped"));
}

export function daemonLogs(): void {
  if (!existsSync(LOG_PATH)) return void console.log(pc.dim("no logs yet"));
  console.log(readFileSync(LOG_PATH, "utf8"));
}
