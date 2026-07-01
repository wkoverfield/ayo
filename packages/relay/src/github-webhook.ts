/**
 * GitHub webhook → Ayo. Verifies the HMAC signature, then maps the high-signal
 * "someone needs you" events to a recipient + a one-line message. Recipients are
 * GitHub logins; they resolve against team handles (which default to the login)
 * in the DO, so a GitHub user not on the Ayo team is a silent no-op.
 *
 * Only a curated set of events routes — everything else returns null (the route
 * ACKs it 200 so GitHub doesn't retry). Bot senders and self-directed events are
 * dropped to avoid noise.
 */

/** Constant-time compare of two equal-length hex strings (avoids a timing side
 *  channel on signature verification). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify GitHub's `X-Hub-Signature-256: sha256=<hex>` over the RAW body. */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, provided);
}

/** @-mentions in a comment body → deduped logins. */
function mentions(body: string): string[] {
  const out = new Set<string>();
  // GitHub logins: alphanumerics + single hyphens; require a boundary before @
  // so emails / `foo@bar` don't match.
  for (const m of body.matchAll(/(?:^|[^a-zA-Z0-9_@])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

function firstLine(s: string, max = 140): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

const REVIEW_VERB: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  commented: "commented on",
  dismissed: "dismissed their review on",
};

export interface MappedEvent {
  to: string[];
  body: string;
}

/**
 * Map a (event, payload) to recipients + a message, or null to ignore.
 * `payload` is untrusted JSON — read defensively.
 */
export function mapGithubEvent(event: string, payload: any): MappedEvent | null {
  const sender: string | undefined = payload?.sender?.login;
  const senderIsBot = payload?.sender?.type === "Bot";
  if (senderIsBot) return null;
  const repo: string = payload?.repository?.full_name ?? payload?.repository?.name ?? "a repo";
  const action: string | undefined = payload?.action;

  // 1) Review requested → ping the requested reviewer.
  if (event === "pull_request" && action === "review_requested") {
    const reviewer: string | undefined = payload?.requested_reviewer?.login;
    const pr = payload?.pull_request;
    if (!reviewer || !pr) return null; // team review requests have no requested_reviewer
    if (reviewer === sender) return null;
    return {
      to: [reviewer],
      body: `${sender ?? "someone"} requested your review — ${repo}#${pr.number}: ${firstLine(pr.title ?? "")}\n${pr.html_url ?? ""}`.trim(),
    };
  }

  // 2) @-mentions in an issue or PR comment → ping the mentioned people.
  if ((event === "issue_comment" || event === "pull_request_review_comment") && action === "created") {
    const comment = payload?.comment;
    const number = payload?.issue?.number ?? payload?.pull_request?.number;
    if (!comment?.body || number == null) return null;
    const targets = mentions(comment.body).filter((h) => h !== sender);
    if (targets.length === 0) return null;
    return {
      to: targets,
      body: `${sender ?? "someone"} mentioned you — ${repo}#${number}\n"${firstLine(comment.body)}"\n${comment.html_url ?? ""}`.trim(),
    };
  }

  // 3) Review submitted → ping the PR author (unless they reviewed their own).
  if (event === "pull_request_review" && action === "submitted") {
    const pr = payload?.pull_request;
    const author: string | undefined = pr?.user?.login;
    const state: string = payload?.review?.state ?? "";
    if (!author || author === sender) return null;
    const verb = REVIEW_VERB[state] ?? "reviewed";
    return {
      to: [author],
      body: `${sender ?? "someone"} ${verb} your PR — ${repo}#${pr.number}\n${payload?.review?.html_url ?? pr.html_url ?? ""}`.trim(),
    };
  }

  return null;
}
