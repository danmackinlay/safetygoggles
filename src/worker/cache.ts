// Rendered pages in KV, plus a short-lived marker so that two simultaneous visitors to
// the same uncached page pay for one rewrite. KV is eventually consistent, so the marker
// is best-effort: it narrows the race rather than closing it.

import type { KV } from "./types.ts";

const PAGE_TTL = 30 * 24 * 3600;
const LOCK_TTL = 120; // KV's minimum is 60 s; a rewrite takes 25–60 s

export async function pageKey(url: string, lensVersion: string, model: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${url}|${lensVersion}|${model}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const getPage = (kv: KV, key: string) => kv.get(`page:${key}`);
export const putPage = (kv: KV, key: string, html: string) => kv.put(`page:${key}`, html, { expirationTtl: PAGE_TTL });

export async function tryLock(kv: KV, key: string): Promise<boolean> {
  if (await kv.get(`lock:${key}`)) return false;
  await kv.put(`lock:${key}`, "1", { expirationTtl: LOCK_TTL });
  return true;
}
export const unlock = (kv: KV, key: string) => kv.delete(`lock:${key}`);
