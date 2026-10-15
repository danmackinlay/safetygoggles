// Two KV layers, so chrome changes never cost LLM calls:
//   tr:<key>                 Translation (snapshot + rewrites): expensive, kept long
//   page:<key>:<chrome>      rendered HTML for one CHROME_VERSION: cheap to rebuild
// plus a short-lived marker so that two simultaneous visitors to the same untranslated
// page pay for one rewrite. KV is eventually consistent, so the marker is best-effort.

import { CHROME_VERSION } from "../core/decorate.ts";
import type { Translation } from "../core/transmute.ts";
import type { KV } from "./types.ts";

const TRANSLATION_TTL = 180 * 24 * 3600;
const PAGE_TTL = 30 * 24 * 3600;
const LOCK_TTL = 120; // KV's minimum is 60 s; a rewrite takes 25–60 s

/** Identifies a translation: page URL, lens (prompt) version and model. */
export async function pageKey(url: string, lensVersion: string, model: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${url}|${lensVersion}|${model}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const translationKey = (key: string) => `tr:${key}`;
export const renderedKey = (key: string, chrome = CHROME_VERSION) => `page:${key}:${chrome}`;

export async function getTranslation(kv: KV, key: string): Promise<Translation | null> {
  const raw = await kv.get(translationKey(key));
  return raw ? (JSON.parse(raw) as Translation) : null;
}
export const putTranslation = (kv: KV, key: string, t: Translation) =>
  kv.put(translationKey(key), JSON.stringify(t), { expirationTtl: TRANSLATION_TTL });

export const getRendered = (kv: KV, key: string) => kv.get(renderedKey(key));
export const putRendered = (kv: KV, key: string, html: string) => kv.put(renderedKey(key), html, { expirationTtl: PAGE_TTL });

export async function tryLock(kv: KV, key: string): Promise<boolean> {
  if (await kv.get(`lock:${key}`)) return false;
  await kv.put(`lock:${key}`, "1", { expirationTtl: LOCK_TTL });
  return true;
}
export const unlock = (kv: KV, key: string) => kv.delete(`lock:${key}`);
