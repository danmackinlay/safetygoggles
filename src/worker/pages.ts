// Our own pages: home, the "putting on goggles" interstitial (and its script), the
// fogged-up and error pages, and the directory. Goggled pages themselves come from core.

import { aiSafety } from "../../lenses/ai-safety.ts";
import { escapeHtml } from "../core/segment.ts";
import type { PageRow } from "./db.ts";

export function homePage(proxyBase: string, readmeUrl: string): string {
  const bookmarklet = `javascript:location.href=${JSON.stringify(proxyBase)}+location.href`;
  return shell(
    "safetygoggles",
    `<h1>🥽 safetygoggles</h1>
<p>${escapeHtml(aiSafety.tagline)}</p>
<form action="/" method="get"><input name="url" type="url" placeholder="https://…" required autofocus> <button>Put on goggles</button></form>
<p><a class="bm" href="${escapeHtml(bookmarklet)}">🥽 Safety-goggle this</a> ← drag to your bookmarks bar</p>
<p><a href="/directory">Already goggled</a> · <a href="${escapeHtml(readmeUrl)}">What is this?</a></p>`,
  );
}

/** Shown on a cache miss; /sg.js asks the API to goggle the page, then reloads. */
export function interstitialPage(target: string): string {
  return shell(
    "safetygoggles: putting on goggles…",
    `<h1>🥽 Putting on goggles…</h1>
<p id="msg">The first visit to a page takes about half a minute. After that it's instant for everyone.</p>
<p><a href="${escapeHtml(target)}">Read the original instead</a></p>`,
    `data-target="${escapeHtml(target)}"`,
    `<script src="/sg.js"></script>`,
  );
}

export const INTERSTITIAL_SCRIPT = `(async () => {
  const target = document.body.dataset.target, msg = document.getElementById("msg");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    let res;
    try { res = await fetch("/api/transmute?url=" + encodeURIComponent(target)); }
    catch { await sleep(3000); continue; }
    const body = await res.json().catch(() => ({}));
    if (body.status === "ready" || body.status === "fogged") { location.reload(); return; }
    if (body.status === "pending") { await sleep(3000); continue; }
    msg.textContent = body.message || "The goggles didn't fit this page.";
    return;
  }
  msg.textContent = "This is taking too long. Try again in a minute.";
})();`;

export function foggedPage(target: string, pages: PageRow[]): string {
  return shell(
    "safetygoggles: fogged up",
    `<h1>🥽 The goggles are fogged up for today</h1>
<p>Today's budget for new pages is spent. We've noted this one; it resets at midnight UTC.</p>
<p><a href="${escapeHtml(target)}">Read the original</a>, or try a page that's already goggled:</p>
${directoryList(pages.slice(0, 60))}`,
  );
}

export function deniedPage(target: string, reason: string): string {
  const why: Record<string, string> = {
    "own-host": "That's already a goggled page.",
    "opted-out": "This site's owner has asked not to be goggled.",
    "sensitive-host": "We don't goggle mail, banking or payment sites.",
    "sensitive-path": "We don't goggle login, account or checkout pages.",
  };
  return errorPage(why[reason] ?? "We don't goggle this page.", target);
}

export function errorPage(message: string, target?: string): string {
  return shell(
    "safetygoggles: no goggles",
    `<h1>🥽 The goggles didn't fit</h1><p>${escapeHtml(message)}</p>
<p>${target ? `<a href="${escapeHtml(target)}">Read the original</a> · ` : ""}<a href="/">Try another page</a></p>`,
  );
}

export function directoryPage(pages: PageRow[]): string {
  return shell("safetygoggles: directory", `<h1>🥽 Already goggled</h1>${pages.length ? directoryList(pages) : "<p>Nothing yet.</p>"}<p><a href="/">Goggle another page</a></p>`);
}

function directoryList(pages: PageRow[]): string {
  const byHost = new Map<string, PageRow[]>();
  for (const p of pages) byHost.set(p.host, [...(byHost.get(p.host) ?? []), p]);
  return [...byHost]
    .map(([host, rows]) => `<h2>${escapeHtml(host)}</h2><ul>${rows.map((r) => `<li><a href="/${escapeHtml(r.url)}">${escapeHtml(r.title || r.url)}</a></li>`).join("")}</ul>`)
    .join("");
}

function shell(title: string, body: string, bodyAttrs = "", tail = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f2328;color:#fff8c5;font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:640px;width:100%}a{color:#ffd84d}h1{margin:0 0 8px}h2{font-size:15px;margin:20px 0 4px;color:#c9c3a3}ul{margin:0;padding-left:20px}
input{width:min(100%,380px);padding:8px 10px;border-radius:6px;border:0;font:inherit}button{padding:8px 14px;border-radius:6px;border:0;background:#ffd84d;font:inherit;cursor:pointer}
.bm{display:inline-block;padding:2px 10px;border:2px dashed #ffd84d;border-radius:6px;text-decoration:none;white-space:nowrap}
</style></head><body ${bodyAttrs}><main>${body}</main>${tail}</body></html>`;
}
