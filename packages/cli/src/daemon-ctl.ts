/**
 * Daemon process control. For the scaffold this spawns `ayod` as a detached
 * background process and tracks it via a pidfile. ADR 0001's production target
 * is a launchd/systemd user service installed by `ayo daemon start` — that's a
 * TODO; the pidfile approach proves the slice first.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { AYO_DIR } from "./config.js";

const PID_PATH = join(AYO_DIR, "daemon.pid");
const LOCK_PATH = join(AYO_DIR, "daemon.lock");
const LOG_PATH = join(AYO_DIR, "ayod.log");

/** Synchronous sleep (CLI is one-shot; we briefly block to confirm process death). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the start lock. `daemonStart` is fast and fully synchronous, so a lock
 * older than a few seconds was orphaned by a killed start process and has no
 * living owner — reclaim it. A genuinely concurrent start holds a fresh lock, so
 * we don't touch that (reclaiming a fresh lock would reintroduce the double-start
 * race). Returns the fd, or null if a real concurrent start holds it.
 */
function acquireStartLock(): number | null {
  try {
    return openSync(LOCK_PATH, "wx");
  } catch {
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > 10_000) {
        rmSync(LOCK_PATH, { force: true });
        return openSync(LOCK_PATH, "wx");
      }
    } catch {
      /* lost the reclaim race to another start — treat as contended */
    }
    return null;
  }
}

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
  // Atomic lock: two concurrent starts (e.g. a hook firing while the user runs
  // `ayo daemon start`) must not both spawn a daemon — that double-notifies.
  const lockFd = acquireStartLock();
  if (lockFd === null) {
    console.log(pc.dim("ayod start already in progress"));
    return;
  }
  try {
    const existing = readPid();
    if (existing && isAlive(existing)) {
      console.log(pc.dim(`ayod already running (pid ${existing})`));
      return;
    }
    if (existing) rmSync(PID_PATH, { force: true }); // stale pidfile from a crash

    const ayodPath = join(dirname(fileURLToPath(import.meta.url)), "ayod.js");
    const out = openSync(LOG_PATH, "w"); // fresh log each start — no unbounded growth
    const child = spawn(process.execPath, [ayodPath], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.on("error", (err) => console.error(pc.red(`✗ failed to start ayod: ${err.message}`)));
    if (!child.pid) {
      console.error(pc.red("✗ ayod did not start (no pid assigned)"));
      return;
    }
    writeFileSync(PID_PATH, String(child.pid));
    child.unref();
    console.log(pc.green(`✓ ayod started`) + pc.dim(` (pid ${child.pid}) — logs: ayo daemon logs`));
  } finally {
    closeSync(lockFd);
    rmSync(LOCK_PATH, { force: true });
  }
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
    rmSync(PID_PATH, { force: true }); // clean up a stale pidfile
    console.log(pc.dim("ayod not running"));
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // Confirm death before removing the pidfile, so a follow-up `start` can't race
  // a still-alive daemon into a double.
  for (let i = 0; i < 10 && isAlive(pid); i++) sleepSync(50);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  rmSync(PID_PATH, { force: true });
  console.log(pc.green("✓ ayod stopped"));
}

export function daemonLogs(): void {
  if (!existsSync(LOG_PATH)) return void console.log(pc.dim("no logs yet"));
  console.log(readFileSync(LOG_PATH, "utf8"));
}
