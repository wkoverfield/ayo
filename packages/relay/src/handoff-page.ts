/**
 * Server-rendered HTML for a handoff share link. This is a PUBLIC page rendering
 * attacker-influenceable content (any sender, any repo/filename/diff), so every
 * interpolated value goes through escapeHtml — the route also sets a strict CSP
 * (no scripts, inline styles only) as defense in depth. No JS, no external deps.
 */

import type { HandoffShare } from "@ayo-dev/core";

const REPO_URL = "https://github.com/wkoverfield/ayo";
const INSTALL_CMD = "npm install -g @ayo-dev/cli";

/** Escape the five HTML-significant chars. Applied to EVERY interpolated value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 1) return "expires within the hour";
  if (hrs < 48) return `expires in ~${hrs}h`;
  return `expires in ~${Math.round(hrs / 24)}d`;
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d0f12;color:#e6e8eb;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px 16px}
.wrap{max-width:640px;margin:0 auto}
.eyebrow{font-size:13px;color:#8b93a1;letter-spacing:.02em;margin-bottom:6px}
.eyebrow b{color:#e6e8eb}
h1{font-size:22px;margin:0 0 20px;font-weight:650;line-height:1.35}
.card{background:#15181d;border:1px solid #23272e;border-radius:12px;padding:16px 18px;margin:14px 0}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b93a1;margin:0 0 10px;font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:#b6bcc6}
.meta code{color:#e6e8eb}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.files{margin:8px 0 0;padding:0;list-style:none;font-size:13px}
.files li{padding:2px 0;color:#b6bcc6}
pre.diff{background:#0d0f12;border:1px solid #23272e;border-radius:8px;padding:12px;overflow:auto;font-size:12px;line-height:1.5;max-height:420px;color:#c9ced6}
.note{white-space:pre-wrap}
.cta{background:#1a1d23;border:1px solid #2b7a4b;border-radius:12px;padding:18px;margin:22px 0}
.cta h2{color:#5fd08a}
.step{margin:10px 0}
.step code{display:block;background:#0d0f12;border:1px solid #23272e;border-radius:8px;padding:10px 12px;margin-top:4px;color:#e6e8eb;overflow:auto}
.foot{font-size:12px;color:#6b7280;margin-top:26px;text-align:center}
.foot a{color:#8b93a1}
.expiry{font-size:12px;color:#6b7280;margin-top:2px}
`;

function shell(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Ayo handoff</title><style>${STYLE}</style></head>` +
    `<body><div class="wrap">${inner}</div></body></html>`;
}

/** Render a live handoff. Every `${}` here is an escaped value or a constant. */
export function renderHandoffPage(share: HandoffShare): string {
  const from = escapeHtml(share.from.name || share.from.handle);
  const handle = escapeHtml(share.from.handle);
  const team = escapeHtml(share.teamName);
  const ctx = share.context;

  let contextCard = "";
  if (ctx && (ctx.repo || ctx.changedFiles?.length || ctx.diffStat)) {
    const bits: string[] = [];
    if (ctx.repo) bits.push(`<code>${escapeHtml(ctx.repo)}${ctx.branch ? "@" + escapeHtml(ctx.branch) : ""}</code>`);
    if (ctx.commit) bits.push(`<span>commit <code>${escapeHtml(ctx.commit)}</code></span>`);
    if (ctx.diffStat) bits.push(`<span>${escapeHtml(ctx.diffStat)}</span>`);
    const files = ctx.changedFiles?.length
      ? `<ul class="files">${ctx.changedFiles.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
      : "";
    contextCard = `<div class="card"><h2>Work context</h2><div class="meta">${bits.join("")}</div>${files}</div>`;
  }

  let diffCard = "";
  if (ctx?.diff) {
    const trunc = ctx.diffTruncated ? ` <span class="expiry">(truncated)</span>` : "";
    diffCard = `<div class="card"><h2>Diff${trunc}</h2><pre class="diff">${escapeHtml(ctx.diff)}</pre></div>`;
  }

  const noteCard = share.note
    ? `<div class="card"><h2>Notes</h2><div class="note">${escapeHtml(share.note)}</div></div>`
    : "";

  // Conversion CTA. If the sender embedded a join code, it's a two-command path;
  // otherwise we tell the viewer to ask the sender for one (never invent a code).
  const joinStep = share.joinCode
    ? `<div class="step">Then join ${from}'s team:<code>ayo join ${escapeHtml(share.joinCode)}</code></div>`
    : `<div class="step expiry">Then ask ${from} for a join code and run <code>ayo join &lt;code&gt;</code>.</div>`;

  const cta = `<div class="cta"><h2>Pick this up</h2>` +
    `<div class="step">Install Ayo:<code>${escapeHtml(INSTALL_CMD)}</code></div>` +
    joinStep +
    `</div>`;

  const body = `
    <div class="eyebrow"><b>${from}</b> <span>(@${handle})</span> handed off work to you · <b>${team}</b></div>
    <h1>${escapeHtml(share.blocker)}</h1>
    <div class="expiry">${escapeHtml(timeLeft(share.expiresAt))}</div>
    ${noteCard}
    ${contextCard}
    ${diffCard}
    ${cta}
    <div class="foot">Sent with <a href="${REPO_URL}">Ayo</a> — attention pings from inside your terminal &amp; agents.</div>
  `;
  return shell(body);
}

/** Shown when a token is unknown or its KV entry has expired. */
export function renderExpiredPage(): string {
  const body = `
    <div class="eyebrow">Ayo handoff</div>
    <h1>This handoff link has expired.</h1>
    <div class="card note">Handoff links are short-lived by design. Ask whoever sent it to share a fresh one with <code>ayo handoff</code>.</div>
    <div class="foot">What's Ayo? <a href="${REPO_URL}">${REPO_URL.replace("https://", "")}</a></div>
  `;
  return shell(body);
}
