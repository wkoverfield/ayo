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
.brand .tag a{color:var(--ink2);font-weight:500;text-decoration:underline;text-underline-offset:2px}
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
.note a{color:#A63A1B;font-weight:500}
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
.reply{background:#FBF1EA;border:1.5px solid #EBC4B4;border-radius:15px;padding:20px;margin:22px 0 0}
.reply .lbl{color:#A63A1B}
.reply-h{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:18px;color:var(--ink);margin-bottom:4px;letter-spacing:-.01em}
.reply-sub{font-size:13px;color:var(--ink2);margin-bottom:12px}
.field{width:100%;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:10px 12px;font:inherit;font-size:16px;color:var(--ink);margin-bottom:9px}
textarea.field{min-height:88px;resize:vertical}
.frow{display:flex;gap:9px;align-items:stretch}
.frow .field{flex:1;margin-bottom:0}
.btn{background:var(--coral);color:#fff;font:inherit;font-weight:600;font-size:14px;border-radius:9px;padding:10px 18px;border:none;cursor:pointer;white-space:nowrap}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.hint{font-size:11.5px;color:var(--muted);margin-top:8px}
.sent{display:flex;align-items:center;gap:12px;background:#FBF1EA;border:1.5px solid #EBC4B4;border-radius:15px;padding:18px;margin:0 0 15px}
.sent .check{width:32px;height:32px;border-radius:50%;background:var(--coral);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;flex:0 0 auto}
.sent-h{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:16px;color:var(--ink)}
.sent-sub{font-size:12.5px;color:var(--ink2)}
.cta{background:var(--sage-bg);border:1px solid #CDE3D5;border-radius:15px;padding:20px;margin:22px 0 8px}
.cta .lbl{color:var(--sage-strong)}
.cta-h{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:18px;color:var(--ink);margin-bottom:13px;letter-spacing:-.01em}
.cta-quiet{padding:16px 19px;margin-top:18px}
.cta-quiet .cta-h{font-size:15.5px;margin-bottom:10px}
.cta-quiet .step{margin-top:11px}
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
@media (max-width:600px){
body{padding:24px 15px 26px}
h1{font-size:22px}
.card{padding:15px 16px}
.field{padding:12px 13px}
textarea.field{min-height:110px}
.frow{flex-direction:column}
.btn{width:100%;padding:13px 18px}
.diff .row{font-size:11px}
}
@media (prefers-color-scheme:dark){
:root{--paper:#1C1B1E;--card:#242327;--ink:#F1E9DC;--ink2:#BCB6A8;--muted:#8B8577;--coral:#F0795A;--coral-bg:#3A2620;--sage:#66C296;--sage-strong:#93DDB7;--sage-bg:#1F2C26;--border:#33313A}
.note{color:#DBD4C6}.chip{background:#3A2620;color:#F6A98E}.pill{background:#242327;color:#BCB6A8}
.expiry{background:#242327}.files li{color:#CFC8BA;border-top-color:#33313A}
.diff{border-color:#33313A}.diff .row{background:#201F23;color:#BCB6A8}.diff .add{background:#1F2C26;color:#84D3A8}.diff .del{background:#331F1B;color:#F09C7E}.diff .hunk{background:#2A2830;color:#A89F8F}
.cta{background:#1F2C26;border-color:#2E5040}.num{background:var(--sage);color:#12241B}
.term{background:#100F12}
.reply,.sent{background:#33231D;border-color:#5A3A2D}
.note a{color:#F6A98E}
.reply .lbl{color:#F6A98E}
.field{background:#242327;border-color:#33313A;color:#F1E9DC}
.btn{color:#2A1610}
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

const HEADER = `<div class="brand rise"><img src="${AYO_LOGO_DATA_URI}" alt="Ayo" width="40" height="40"><span class="tag">a handoff for you · sent with <a href="${REPO_URL}">Ayo</a> (open source)</span></div>`;
const FOOTER = `<div class="foot rise"><img src="${AYO_LOGO_DATA_URI}" alt=""> Sent with <a href="${REPO_URL}">Ayo</a> — attention pings from inside your terminal &amp; agents</div>`;

/** Render a live handoff. Every `${}` is an escaped value or a constant.
 *  `token` (url-safe by the route regex) names the reply form's POST target. */
export function renderHandoffPage(share: HandoffShare, token: string): string {
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
      joinBlock = `<div class="ask">The join code in this handoff has expired — replying above still works. When you're ready to join, ask ${from} for a fresh code and run <code>ayo join &lt;code&gt;</code>.</div>`;
    } else {
      const note = exp ? `<div class="codenote">code ${escapeHtml(timeLeft(exp))}</div>` : "";
      joinBlock = `<div class="step"><div class="num">2</div><div class="body"><div class="t">Join the team &amp; pick it up</div><div class="term"><span class="code">ayo join <span class="code-em">${escapeHtml(share.joinCode)}</span></span></div>${note}</div></div>`;
    }
  } else {
    joinBlock = `<div class="ask">Then ask ${from} for a join code and run <code>ayo join &lt;code&gt;</code>.</div>`;
  }
  const cta = `<div class="cta cta-quiet rise"><div class="lbl">Pick this up</div><div class="cta-h">Grab ${from}'s work</div>${installStep}${joinBlock}</div>`;

  // The conversion order is deliberate: reply FIRST (coral, zero-friction, no
  // account), install second (sage). The `website` field is a honeypot — hidden
  // from humans, and a submission that fills it is silently dropped.
  const replyCard = `<div class="reply rise"><div class="lbl">Reply</div>
    <div class="reply-h">Answer ${from} right here</div>
    <div class="reply-sub">No account, no install — it lands in ${from}'s terminal.</div>
    <form method="post" action="/h/${token}/reply">
      <textarea class="field" name="message" required maxlength="2000" placeholder="on it — looking now…"></textarea>
      <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="frow"><input class="field" type="text" name="name" maxlength="40" placeholder="Your name"><button class="btn" type="submit">Send reply</button></div>
      <div class="hint">Your name is shown to ${from} — replying doesn't add you to the team.</div>
    </form></div>`;

  const body = `
    ${HEADER}
    <div class="eyebrow rise"><div class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</div><div class="who"><b>${from}</b> <span class="h">@${handle}</span> handed off work to you<br>on <b>${team}</b></div></div>
    <h1 class="rise">${escapeHtml(share.blocker)}</h1>
    <div class="rise"><span class="expiry">${escapeHtml(timeLeft(share.expiresAt))}</span></div>
    ${noteCard}
    ${contextCard}
    ${diffCard}
    ${replyCard}
    ${cta}
    ${FOOTER}
  `;
  return shell(body);
}

/** The post-reply state — the warm conversion moment. The install ask lands
 *  HERE, after they've gotten value, not before. Echoes the guest's message
 *  back so they trust it actually landed. */
export function renderReplySentPage(share: HandoffShare, guestName: string, message: string): string {
  const from = escapeHtml(share.from.name || share.from.handle);
  const guest = escapeHtml(guestName);
  // Same stale-code rule as the live page: never hand out a dead command.
  const exp = share.joinCodeExpiresAt;
  const codeExpired = exp != null && new Date(exp).getTime() <= Date.now();
  const joinStep = share.joinCode && !codeExpired
    ? `<div class="step"><div class="num">2</div><div class="body"><div class="t">Join ${from}'s team</div><div class="term"><span class="code">ayo join <span class="code-em">${escapeHtml(share.joinCode)}</span></span></div></div></div>`
    : "";
  const replyEcho = message
    ? `<div class="card rise"><div class="lbl">Your reply</div><div class="note">${escapeHtml(message)}</div></div>`
    : "";
  const body = `
    ${HEADER}
    <div class="sent rise"><div class="check">✓</div><div><div class="sent-h">Sent — ${from} will see it in their terminal</div><div class="sent-sub">Threaded to this handoff, from &ldquo;${guest} (via link)&rdquo;.</div></div></div>
    ${replyEcho}
    <div class="cta rise"><div class="lbl">Keep the loop going</div><div class="cta-h">Want ${from}'s reply to land where <em>you</em> work?</div>
      <div class="step"><div class="num">1</div><div class="body"><div class="t">Install Ayo — the conversation follows you into your terminal &amp; agents, with the code context attached</div><div class="term"><span class="code">${escapeHtml(INSTALL_CMD)}</span></div></div></div>
      ${joinStep}
    </div>
    ${FOOTER}
  `;
  return shell(body);
}

/** A branded error page for the no-JS reply form — a human must never land on
 *  raw JSON. Links back to the handoff so their context isn't a dead end.
 *  When we have the guest's draft, echo it back so the failure can't eat it. */
export function renderReplyErrorPage(token: string, message: string, draft?: string): string {
  const draftCard = draft
    ? `<div class="card rise"><div class="lbl">Your reply</div><div class="note">${escapeHtml(draft)}</div></div>`
    : "";
  const backNote = draft
    ? `<a href="/h/${token}">← Back to the handoff</a> — your reply is shown above, copy it first.`
    : `<a href="/h/${token}">← Back to the handoff</a> — your reply isn't saved, so copy it before you retry.`;
  const body = `
    ${HEADER}
    <div class="sent rise"><div class="check" style="background:#A63A1B">!</div><div><div class="sent-h">That didn't go through</div><div class="sent-sub">${escapeHtml(message)}</div></div></div>
    ${draftCard}
    <div class="card rise"><div class="note">${backNote}</div></div>
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
