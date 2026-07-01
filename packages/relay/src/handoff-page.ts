/**
 * Server-rendered HTML for a handoff share link. PUBLIC page rendering
 * attacker-influenceable content (any sender, any repo/filename/diff), so every
 * interpolated value goes through escapeHtml — the route also sets a CSP
 * (scripts blocked; styles + Google Fonts allowed; images only self/data) as
 * defense in depth. No JS. On-brand: warm paper, coral + navy ink + sage, the
 * real Ayo mark. Light-mode base, dark via prefers-color-scheme.
 */

import type { HandoffShare } from "@ayo-dev/core";
import { AYO_LOGO_DATA_URI } from "./ayo-logo.js";

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

/** Up-to-two-letter initials for the sender avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Render a git diff as escaped, colorized lines (+ = add, - = del, @@ = hunk). */
function renderDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      let cls = "row";
      if (line.startsWith("@@")) cls = "row hunk";
      else if (line.startsWith("+") && !line.startsWith("+++")) cls = "row add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls = "row del";
      return `<div class="${cls}">${escapeHtml(line) || "&nbsp;"}</div>`;
    })
    .join("");
}

const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Sora:wght@400;500;600&display=swap";

const STYLE = `
*{box-sizing:border-box;margin:0}
:root{--paper:#F4EDE1;--card:#FDFBF7;--ink:#2A2E45;--ink2:#585C70;--muted:#6B6660;--coral:#E15C3D;--coral-bg:#F9E6DD;--sage:#3E9A6E;--sage-strong:#256B48;--sage-bg:#EAF3EC;--border:#E7DCC9;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
body{background:var(--paper);color:var(--ink);font-family:'Sora',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.6;padding:34px 22px 30px}
.wrap{max-width:596px;margin:0 auto}
.rise{opacity:0;transform:translateY(7px);animation:rise .5s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.rise{animation:none;opacity:1;transform:none}}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:24px}
.brand img{width:40px;height:40px;border-radius:10px;display:block}
.brand .tag{font-size:12px;color:var(--muted);letter-spacing:.02em}
.eyebrow{display:flex;align-items:center;gap:11px;margin-bottom:15px}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--coral);color:#FDEDE7;font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.who{font-size:13.5px;color:var(--ink2)}
.who b{color:var(--ink);font-weight:600}
.who .h{color:var(--coral);font-weight:500}
h1{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:26px;line-height:1.3;letter-spacing:-.015em;color:var(--ink);margin:2px 0 14px}
.expiry{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);background:#FBF6EC;border:1px solid var(--border);border-radius:999px;padding:4px 11px}
.expiry::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--sage)}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:17px 19px;margin:15px 0;box-shadow:0 1px 2px rgba(42,46,69,.035)}
.lbl{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:11px}
.note{white-space:pre-wrap;font-size:14.5px;color:#33374B;line-height:1.62}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
code{font-family:var(--mono)}
.chip{font-family:var(--mono);font-size:12.5px;padding:5px 10px;border-radius:8px;background:var(--coral-bg);color:#A63A1B;font-weight:500;max-width:100%;word-break:break-all}
.pill{font-family:var(--mono);font-size:12px;padding:5px 9px;border-radius:8px;background:#FBF6EC;border:1px solid var(--border);color:var(--ink2)}
.files{list-style:none;margin:13px 0 0;padding:0}
.files li{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:12.5px;color:#3B3F52;padding:5px 0;border-top:1px solid #F0E8D9}
.files li:first-child{border-top:0}
.files li span{min-width:0;word-break:break-all}
.files li::before{content:"";width:6px;height:6px;border-radius:2px;background:var(--sage);flex:0 0 auto;opacity:.75}
.diff{margin:0;border-radius:10px;overflow-x:auto;overflow-y:hidden;border:1px solid #EADFCB}
.diff .row{font-family:var(--mono);font-size:12px;line-height:1.75;padding:0 13px;white-space:pre;color:#494D5F;background:#FCF8F0}
.diff .add{background:#E7F1E9;color:#1F5E40}
.diff .del{background:#FAE7E0;color:#A23A1E}
.diff .hunk{background:#F1E9DB;color:#5C5445}
.cta{background:var(--sage-bg);border:1px solid #CDE3D5;border-radius:15px;padding:20px;margin:22px 0 8px}
.cta .lbl{color:var(--sage-strong)}
.cta-h{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:18px;color:var(--ink);margin-bottom:13px;letter-spacing:-.01em}
.step{display:flex;gap:12px;margin-top:13px}
.num{width:22px;height:22px;border-radius:50%;background:var(--sage-strong);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-top:2px}
.step .body{flex:1;min-width:0}
.step .t{font-size:13.5px;color:var(--ink);font-weight:500;margin-bottom:6px}
.term{font-family:var(--mono);font-size:13px;background:var(--ink);color:#F4EDE1;border-radius:9px;padding:10px 13px;overflow-x:auto;display:flex;align-items:center;gap:8px}
.term::before{content:"$";color:#72C293;font-weight:600}
.term .code{color:#F7EFE3;font-weight:500;white-space:pre}
.code-em{color:#F6A98E;font-weight:600}
.codenote{font-size:11.5px;color:var(--ink2);margin-top:6px}
.ask{font-size:13.5px;color:var(--ink);line-height:1.55}
.foot{display:flex;align-items:center;justify-content:center;gap:7px;font-size:12px;color:var(--muted);margin-top:24px;text-align:center}
.foot img{width:16px;height:16px;border-radius:4px;vertical-align:middle}
.foot a{color:var(--ink2);text-decoration:none}
@media (prefers-color-scheme:dark){
:root{--paper:#1C1B1E;--card:#242327;--ink:#F1E9DC;--ink2:#BCB6A8;--muted:#8B8577;--coral:#F0795A;--coral-bg:#3A2620;--sage:#66C296;--sage-strong:#93DDB7;--sage-bg:#1F2C26;--border:#33313A}
.note{color:#DBD4C6}.chip{background:#3A2620;color:#F6A98E}.pill{background:#242327;color:#BCB6A8}
.expiry{background:#242327}.files li{color:#CFC8BA;border-top-color:#33313A}
.diff{border-color:#33313A}.diff .row{background:#201F23;color:#BCB6A8}.diff .add{background:#1F2C26;color:#84D3A8}.diff .del{background:#331F1B;color:#F09C7E}.diff .hunk{background:#2A2830;color:#A89F8F}
.cta{background:#1F2C26;border-color:#2E5040}.num{background:var(--sage);color:#12241B}
.term{background:#100F12}
}
`;

function shell(inner: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Ayo handoff</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="${FONTS}">` +
    `<style>${STYLE}</style></head>` +
    `<body><div class="wrap">${inner}</div></body></html>`
  );
}

const HEADER = `<div class="brand rise"><img src="${AYO_LOGO_DATA_URI}" alt="Ayo" width="40" height="40"><span class="tag">a handoff for you</span></div>`;
const FOOTER = `<div class="foot rise"><img src="${AYO_LOGO_DATA_URI}" alt=""> Sent with <a href="${REPO_URL}">Ayo</a> — attention pings from inside your terminal &amp; agents</div>`;

/** Render a live handoff. Every `${}` is an escaped value or a constant. */
export function renderHandoffPage(share: HandoffShare): string {
  const name = share.from.name || share.from.handle;
  const from = escapeHtml(name);
  const handle = escapeHtml(share.from.handle);
  const team = escapeHtml(share.teamName);
  const ctx = share.context;

  let contextCard = "";
  if (ctx && (ctx.repo || ctx.changedFiles?.length || ctx.diffStat)) {
    const bits: string[] = [];
    if (ctx.repo) {
      bits.push(`<span class="chip">${escapeHtml(ctx.repo)}${ctx.branch ? "@" + escapeHtml(ctx.branch) : ""}</span>`);
    }
    if (ctx.commit) bits.push(`<span class="pill">commit ${escapeHtml(ctx.commit)}</span>`);
    if (ctx.diffStat) bits.push(`<span class="pill">${escapeHtml(ctx.diffStat)}</span>`);
    const files = ctx.changedFiles?.length
      ? `<ul class="files">${ctx.changedFiles.map((f) => `<li><span>${escapeHtml(f)}</span></li>`).join("")}</ul>`
      : "";
    contextCard = `<div class="card rise"><div class="lbl">Work context</div><div class="meta">${bits.join("")}</div>${files}</div>`;
  }

  const diffCard = ctx?.diff
    ? `<div class="card rise"><div class="lbl">Diff${ctx.diffTruncated ? " · truncated" : ""}</div><div class="diff">${renderDiff(ctx.diff)}</div></div>`
    : "";

  const noteCard = share.note
    ? `<div class="card rise"><div class="lbl">Notes</div><div class="note">${escapeHtml(share.note)}</div></div>`
    : "";

  // Conversion CTA. A code can rotate/expire independently of the link, so flag a
  // stale one rather than hand out a dead command.
  const installStep = `<div class="step"><div class="num">1</div><div class="body"><div class="t">Install Ayo</div><div class="term"><span class="code">${escapeHtml(INSTALL_CMD)}</span></div></div></div>`;
  let joinBlock: string;
  if (share.joinCode) {
    const exp = share.joinCodeExpiresAt;
    const codeExpired = exp != null && new Date(exp).getTime() <= Date.now();
    if (codeExpired) {
      joinBlock = `<div class="ask">The join code in this handoff has expired — ask ${from} for a fresh <code>ayo invite</code>.</div>`;
    } else {
      const note = exp ? `<div class="codenote">code ${escapeHtml(timeLeft(exp))}</div>` : "";
      joinBlock = `<div class="step"><div class="num">2</div><div class="body"><div class="t">Join the team &amp; pick it up</div><div class="term"><span class="code">ayo join <span class="code-em">${escapeHtml(share.joinCode)}</span></span></div>${note}</div></div>`;
    }
  } else {
    joinBlock = `<div class="ask">Then ask ${from} for a join code and run <code>ayo join &lt;code&gt;</code>.</div>`;
  }
  const cta = `<div class="cta rise"><div class="lbl">Pick this up</div><div class="cta-h">Grab ${from}'s work</div>${installStep}${joinBlock}</div>`;

  const body = `
    ${HEADER}
    <div class="eyebrow rise"><div class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</div><div class="who"><b>${from}</b> <span class="h">@${handle}</span> handed off work to you<br>on <b>${team}</b></div></div>
    <h1 class="rise">${escapeHtml(share.blocker)}</h1>
    <div class="rise"><span class="expiry">${escapeHtml(timeLeft(share.expiresAt))}</span></div>
    ${noteCard}
    ${contextCard}
    ${diffCard}
    ${cta}
    ${FOOTER}
  `;
  return shell(body);
}

/** Shown when a token is unknown or its KV entry has expired. */
export function renderExpiredPage(): string {
  const body = `
    ${HEADER}
    <h1 class="rise">This handoff link has expired.</h1>
    <div class="card rise"><div class="note">Handoff links are short-lived by design. Ask whoever sent it to share a fresh one with <code>ayo handoff</code>.</div></div>
    ${FOOTER}
  `;
  return shell(body);
}
