// D1 queries: daily budget, the goggled-pages directory, and the wishlist of misses.

import type { D1 } from "./types.ts";

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export async function spentToday(db: D1): Promise<number> {
  const row = await db.prepare("SELECT spent_usd FROM budget WHERE day = ?").bind(today()).first<{ spent_usd: number }>();
  return row?.spent_usd ?? 0;
}

export async function recordSpend(db: D1, usd: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budget (day, spent_usd, pages) VALUES (?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, pages = pages + 1`,
    )
    .bind(today(), usd)
    .run();
}

/** Mark today's budget as used up, e.g. when OpenRouter says the key limit is reached. */
export async function exhaustToday(db: D1, capUsd: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budget (day, spent_usd, pages) VALUES (?, ?, 0)
       ON CONFLICT(day) DO UPDATE SET spent_usd = MAX(spent_usd, excluded.spent_usd)`,
    )
    .bind(today(), capUsd)
    .run();
}

export interface PageRow {
  url: string;
  host: string;
  title: string | null;
  views: number;
}

export async function recordPage(db: D1, p: { url: string; title: string; sourceTopic: string; costUsd: number | null }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pages (url, host, title, source_topic, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET title = excluded.title, source_topic = excluded.source_topic,
         cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
    )
    .bind(p.url, new URL(p.url).hostname, p.title, p.sourceTopic, p.costUsd, new Date().toISOString())
    .run();
}

export async function countView(db: D1, url: string): Promise<void> {
  await db.prepare("UPDATE pages SET views = views + 1 WHERE url = ?").bind(url).run();
}

/** Public listing. Pages whose URL has a query string are left out: queries can carry tokens. */
export async function directory(db: D1, limit = 500): Promise<PageRow[]> {
  const { results } = await db
    .prepare("SELECT url, host, title, views FROM pages WHERE url NOT LIKE '%?%' ORDER BY host, views DESC LIMIT ?")
    .bind(limit)
    .all<PageRow>();
  return results;
}

export async function logMiss(db: D1, target: string, reason: string): Promise<void> {
  let url: string;
  try {
    const u = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
    url = `${u.origin}${u.pathname}`; // never store query strings or fragments
  } catch {
    url = target.split(/[?#]/)[0]!.slice(0, 500);
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO wishlist (url, reason, count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(url, reason) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
    )
    .bind(url, reason, now, now)
    .run();
}
