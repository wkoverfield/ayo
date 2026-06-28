/**
 * Native OS notification. The daemon owns notification (ADR 0001) — this is
 * how an arriving Ayo reaches the human in real time, independent of any agent.
 */

import notifier from "node-notifier";
import type { Ayo } from "@ayo-dev/core";

export function notifyAyo(ayo: Ayo): void {
  const ctx = ayo.context;
  const where = ctx?.branch ? ` (${ctx.repo}@${ctx.branch})` : "";
  const prefix = ayo.urgency === "urgent" ? "🚨 " : "";
  notifier.notify({
    title: `${prefix}Ayo from ${ayo.from.handle}${where}`,
    message: ayo.body,
    sound: ayo.urgency === "urgent",
    // TODO: wire `terminal-notifier -execute "ayo open <id>"` for click-to-open.
  });
}
