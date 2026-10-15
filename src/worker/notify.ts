// Tell Dan when the money runs out, so he can decide whether to add more. One message
// per kind per UTC day, to NOTIFY_URL (a Worker secret). The body format follows the
// destination: Slack and Discord webhooks want JSON; anything else (e.g. an ntfy.sh
// topic URL, which pushes to a phone) gets plain text.

import { today } from "./db.ts";
import type { Env } from "./types.ts";

export type Alert = "budget" | "llm-limit";

export async function notifyOnce(env: Env, kind: Alert, message: string): Promise<void> {
  if (!env.NOTIFY_URL) return;
  const flag = `notified:${kind}:${today()}`;
  if (await env.PAGES.get(flag)) return;
  await env.PAGES.put(flag, "1", { expirationTtl: 2 * 24 * 3600 });

  const host = new URL(env.NOTIFY_URL).hostname;
  const [body, type] = host.endsWith("slack.com")
    ? [JSON.stringify({ text: message }), "application/json"]
    : host.endsWith("discord.com")
      ? [JSON.stringify({ content: message }), "application/json"]
      : [message, "text/plain; charset=utf-8"];
  const res = await fetch(env.NOTIFY_URL, { method: "POST", headers: { "Content-Type": type, Title: "safetygoggles" }, body });
  if (!res.ok) console.error("notify failed", res.status, await res.text().catch(() => ""));
}
