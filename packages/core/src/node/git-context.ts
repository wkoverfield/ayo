/**
 * Capture work context from the current git repo. The relay treats this as an
 * opaque blob — privacy boundary holds: explicit packets only, never full
 * session transcripts (ADR 0001/0002). Full diff is opt-in via `withDiff` and
 * capped at MAX_DIFF_BYTES.
 *
 * Shared by the CLI and the MCP server (which is spawned by Codex/Claude in
 * the user's workspace, so process.cwd() is the repo being worked in).
 * Node-only (`child_process`) — under `@ayo-dev/core/node`, never imported by
 * the relay Worker.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { AyoContext } from "../message.js";
import { MAX_DIFF_BYTES } from "../message.js";

// Cap git output read into memory, comfortably above the 64 KB diff cap: a normal
// large diff is read then truncated, while a pathological one (giant generated
// file) throws ENOBUFS -> caught -> null instead of allocating hundreds of MB.
// (Node's default maxBuffer is only 1 MB, which would drop diffs between 1 MB and
// the truncation logic.)
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_MAX_BUFFER,
    }).trim();
  } catch {
    return null;
  }
}

export function captureContext(opts: { withDiff?: boolean } = {}): AyoContext | undefined {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root) return undefined; // not in a repo — caller sends a bare ping

  const ctx: AyoContext = {
    repo: basename(root),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? undefined,
    cwd: process.cwd(),
    commit: git(["rev-parse", "--short", "HEAD"]) ?? undefined,
  };

  const changed = git(["diff", "--name-only", "HEAD"]);
  if (changed) ctx.changedFiles = changed.split("\n").filter(Boolean);

  const stat = git(["diff", "--stat", "HEAD"]);
  if (stat) ctx.diffStat = stat.split("\n").filter(Boolean).pop()?.trim() ?? undefined;

  if (opts.withDiff) {
    const diff = git(["diff", "HEAD"]) ?? "";
    if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
      ctx.diff = Buffer.from(diff, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8");
      ctx.diffTruncated = true;
    } else {
      ctx.diff = diff;
    }
  }

  return ctx;
}
