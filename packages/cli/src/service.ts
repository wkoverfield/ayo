/**
 * OS service managers so `ayod` runs as a persistent user service that starts
 * on login and survives reboots (ADR 0001 install target).
 *
 *  - macOS: a launchd LaunchAgent (~/Library/LaunchAgents/dev.ayo.daemon.plist)
 *  - Linux: a systemd --user unit (~/.config/systemd/user/ayo-daemon.service)
 *  - Windows / other: unsupported — getService() returns null and the caller
 *    falls back to the foreground/manual pidfile path (fail gracefully).
 *
 * "Running" state is NOT tracked here — the daemon owns its pidfile, so the
 * controller derives running-ness uniformly via that (see daemon-ctl).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";

function ayodPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ayod.js");
}

/** Run a command, swallowing failure (service tools are noisy/idempotent). */
function tryRun(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    /* ignore — e.g. "already loaded" / "not loaded" */
  }
}

export interface DaemonService {
  /** Human label for messages, e.g. "launchd". */
  readonly kind: string;
  install(): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  isInstalled(): boolean;
}

// ── macOS: launchd ───────────────────────────────────────────────────────────

const LAUNCHD_LABEL = "dev.ayo.daemon";

class LaunchdService implements DaemonService {
  readonly kind = "launchd";
  private plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  private domain = `gui/${process.getuid?.() ?? 0}`;
  private target = `${this.domain}/${LAUNCHD_LABEL}`;

  private plist(): string {
    // KeepAlive only on crash (SuccessfulExit=false): a clean SIGTERM stop won't
    // be auto-restarted, but a crash will. RunAtLoad starts it on login/load.
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${ayodPath()}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  }

  install(): void {
    mkdirSync(dirname(this.plistPath), { recursive: true });
    writeFileSync(this.plistPath, this.plist());
    tryRun("launchctl", ["bootout", this.target]); // in case an old one is loaded
    execFileSync("launchctl", ["bootstrap", this.domain, this.plistPath], { stdio: "ignore" });
  }

  uninstall(): void {
    tryRun("launchctl", ["bootout", this.target]);
    rmSync(this.plistPath, { force: true });
  }

  start(): void {
    // kickstart if loaded; bootstrap if not.
    try {
      execFileSync("launchctl", ["kickstart", "-k", this.target], { stdio: "ignore" });
    } catch {
      tryRun("launchctl", ["bootstrap", this.domain, this.plistPath]);
    }
  }

  stop(): void {
    // SIGTERM -> daemon exits 0 -> KeepAlive(SuccessfulExit=false) won't restart.
    tryRun("launchctl", ["kill", "SIGTERM", this.target]);
  }

  isInstalled(): boolean {
    return existsSync(this.plistPath);
  }
}

// ── Linux: systemd --user ────────────────────────────────────────────────────

const SYSTEMD_UNIT = "ayo-daemon.service";

class SystemdService implements DaemonService {
  readonly kind = "systemd";
  private unitPath = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);

  private unit(): string {
    return `[Unit]
Description=Ayo daemon (receives Ayos)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${ayodPath()}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  }

  install(): void {
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, this.unit());
    tryRun("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
  }

  uninstall(): void {
    tryRun("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(this.unitPath, { force: true });
    tryRun("systemctl", ["--user", "daemon-reload"]);
  }

  start(): void {
    execFileSync("systemctl", ["--user", "start", SYSTEMD_UNIT], { stdio: "ignore" });
  }

  stop(): void {
    tryRun("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
  }

  isInstalled(): boolean {
    return existsSync(this.unitPath);
  }
}

/** The service manager for this platform, or null if unsupported. */
export function getService(): DaemonService | null {
  if (process.platform === "darwin") return new LaunchdService();
  if (process.platform === "linux") return new SystemdService();
  return null;
}
