/**
 * Daemon process control.
 *
 * Preferred: an OS user service (launchd/systemd, see service.ts) installed via
 * `ayo daemon install` — survives reboots, starts on login. When a service is
 * installed, start/stop/status route through it.
 *
 * Fallback: when no service is installed (or the platform is unsupported), a
 * detached background process tracked by a pidfile — fine for a quick run/debug.
 *
 * Either way the DAEMON owns its pidfile (writes on start, removes on clean
 * stop), so `isDaemonAlive()` works uniformly regardless of launch method.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { AYO_DIR, DAEMON_LOG_PATH, DAEMON_PID_PATH } from "./config.js";
import { getService } from "./service.js";

const LOCK_PATH = join(AYO_DIR, "daemon.lock");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPid(): number | null {
  if (!existsSync(DAEMON_PID_PATH)) return null;
  const pid = Number(readFileSync(DAEMON_PID_PATH, "utf8").trim());
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

/** True if ayod is running (any launch method). Used by the agent hooks. */
export function isDaemonAlive(): boolean {
  const pid = readPid();
  return pid != null && isAlive(pid);
}

// ── install / uninstall (OS service) ─────────────────────────────────────────

export function daemonInstall(): void {
  const svc = getService();
  if (!svc) {
    console.log(
      pc.yellow("! No supported service manager on this platform.") +
        pc.dim("\n  Use `ayo daemon start` to run it in the background for this session."),
    );
    return;
  }
  try {
    svc.install();
    console.log(
      pc.green(`✓ ayod installed as a ${svc.kind} service`) +
        pc.dim(" — starts on login, restarts on crash"),
    );
  } catch (err) {
    console.error(pc.red(`✗ install failed: ${(err as Error).message}`));
  }
}

export function daemonUninstall(): void {
  const svc = getService();
  if (svc?.isInstalled()) {
    svc.uninstall();
    rmSync(DAEMON_PID_PATH, { force: true });
    console.log(pc.green(`✓ ayod ${svc.kind} service removed`));
    return;
  }
  // Not a service — make sure any foreground daemon is stopped.
  daemonStop();
}

// ── start / stop / status ────────────────────────────────────────────────────

export function daemonStart(): void {
  const svc = getService();
  if (svc?.isInstalled()) {
    svc.start();
    console.log(pc.green(`✓ ayod started`) + pc.dim(` (${svc.kind} service)`));
    return;
  }
  startForeground();
}

/** Fallback: spawn a detached ayod tracked by a pidfile. */
function startForeground(): void {
  mkdirSync(AYO_DIR, { recursive: true }); // lock + pidfile live here; may not exist pre-login
  // Atomic lock: two concurrent starts must not both spawn (double-notify).
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
    if (existing) rmSync(DAEMON_PID_PATH, { force: true }); // stale pidfile

    const ayodPath = join(dirname(fileURLToPath(import.meta.url)), "ayod.js");
    const child = spawn(process.execPath, [ayodPath], { detached: true, stdio: "ignore" });
    child.on("error", (err) => console.error(pc.red(`✗ failed to start ayod: ${err.message}`)));
    if (!child.pid) {
      console.error(pc.red("✗ ayod did not start (no pid assigned)"));
      return;
    }
    // Write the pid now (closes the race before the daemon writes its own).
    writeFileSync(DAEMON_PID_PATH, String(child.pid));
    child.unref();
    console.log(
      pc.green(`✓ ayod started`) + pc.dim(` (pid ${child.pid}) — tip: \`ayo daemon install\` to persist`),
    );
  } finally {
    closeSync(lockFd);
    rmSync(LOCK_PATH, { force: true });
  }
}

export function daemonStop(): void {
  const svc = getService();
  if (svc?.isInstalled()) {
    svc.stop();
    // Give the daemon a moment to handle SIGTERM and remove its pidfile.
    for (let i = 0; i < 10 && isDaemonAlive(); i++) sleepSync(50);
    console.log(pc.green(`✓ ayod stopped`) + pc.dim(` (${svc.kind} service; still installed)`));
    return;
  }

  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    rmSync(DAEMON_PID_PATH, { force: true });
    console.log(pc.dim("ayod not running"));
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 10 && isAlive(pid); i++) sleepSync(50);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  rmSync(DAEMON_PID_PATH, { force: true });
  console.log(pc.green("✓ ayod stopped"));
}

export function daemonStatus(): void {
  const svc = getService();
  const installed = svc?.isInstalled() ?? false;
  const running = isDaemonAlive();

  console.log(running ? `${pc.green("●")} ayod running` : `${pc.dim("○")} ayod not running`);
  if (installed) {
    console.log(pc.dim(`  installed as a ${svc!.kind} service (auto-starts on login)`));
  } else if (svc) {
    console.log(pc.dim("  not installed — run `ayo daemon install` to persist across reboots"));
  } else {
    console.log(pc.dim("  service install not supported on this platform"));
  }
}

export function daemonLogs(): void {
  if (!existsSync(DAEMON_LOG_PATH)) return void console.log(pc.dim("no logs yet"));
  console.log(readFileSync(DAEMON_LOG_PATH, "utf8"));
}

// ── internals ────────────────────────────────────────────────────────────────

/** Acquire the start lock; reclaim only a demonstrably-orphaned (old) lock so a
 *  killed start can't permanently block, without racing a live concurrent start. */
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
      /* lost the reclaim race — treat as contended */
    }
    return null;
  }
}
