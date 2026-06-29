/**
 * Capture work context from the agent's current git repo. Mirrors the CLI's
 * context.ts — it can't live in @ayo-dev/core because the relay imports core and
 * runs in Cloudflare Workers (no child_process). The relay treats this as an
 * opaque blob; full diff is opt-in and capped (ADR 0001/0002).
 *
 * The MCP server is spawned by Codex/Claude in the user's workspace, so
 * process.cwd() is the repo the developer is working in.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { type AyoContext, MAX_DIFF_BYTES } from "@ayo-dev/core";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
