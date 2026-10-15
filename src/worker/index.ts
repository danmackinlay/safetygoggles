// Cloudflare Worker: the public proxy. GET and HEAD only; only GET /api/transmute spends.
//
//   /                               home page        /directory   goggled pages
//   /?url=<target>                  → /<target>      /sg.js       interstitial script
//   /https://site/page, /site/page  goggled page from cache, else the interstitial
//   /api/transmute?url=<target>     goggle a page into the cache (JSON status)

import { aiSafety } from "../../lenses/ai-safety.ts";
import { OriginError, parseTargetUrl } from "../core/fetchOrigin.ts";
import { mockRewriter, openAiRewriter, type Rewriter } from "../core/llm.ts";
import { renderTranslation, translateUrl, type Translation } from "../core/transmute.ts";
import { getRendered, getTranslation, pageKey, putRendered, putTranslation, tryLock, unlock } from "./cache.ts";
import { countView, directory, exhaustToday, logMiss, recordPage, recordSpend, spentToday } from "./db.ts";
import { denyReason } from "./gate.ts";
import { deniedPage, directoryPage, errorPage, foggedPage, homePage, INTERSTITIAL_SCRIPT, interstitialPage } from "./pages.ts";
import type { Ctx, Env } from "./types.ts";

export type { Env } from "./types.ts";

const COMMON_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
// Goggled pages carry no scripts at all (see decorate.ts); the origin's CSS, fonts and
// images still load via <base href>.
const GOGGLED_CSP = "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri *";
const OWN_PAGE_CSP = "script-src 'self'; object-src 'none'; frame-src 'none'; form-action 'self'";
/** Below this share of segments rewritten, treat the run as failed rather than cache it. */
const MIN_REWRITTEN = 0.5;

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "GET, HEAD", ...COMMON_HEADERS } });
    }
    const url = new URL(request.url);
    const proxyBase = `${url.origin}/`;

    switch (url.pathname) {
      case "/sg.js":
        return new Response(INTERSTITIAL_SCRIPT, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", ...COMMON_HEADERS },
        });
      case "/directory":
        return html(directoryPage(await directory(env.DB)), 200);
      case "/api/transmute":
        if (request.method !== "GET") return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "GET", ...COMMON_HEADERS } });
        return transmuteApi(url.searchParams.get("url") ?? "", env, ctx, url);
    }

    const target = targetFromRequest(url);
    if (target === null) {
      const query = url.searchParams.get("url");
      if (query) return Response.redirect(proxyBase + query.trim(), 302);
      return html(homePage(proxyBase, env.README_URL), 200);
    }

    const checked = await checkTarget(target, env, ctx, url.hostname);
    if ("response" in checked) return checked.response;
    const { page, key } = checked;

    let rendered = await getRendered(env.PAGES, key);
    if (!rendered) {
      // Translated before, but not with the current chrome: re-render, no LLM needed.
      const translation = await getTranslation(env.PAGES, key);
      if (translation) {
        rendered = render(translation, env, proxyBase);
        ctx.waitUntil(putRendered(env.PAGES, key, rendered).catch(() => undefined));
      }
    }
    if (rendered) {
      ctx.waitUntil(countView(env.DB, page.href).catch(() => undefined));
      return html(rendered, 200, { "Content-Security-Policy": GOGGLED_CSP, "Cache-Control": "public, max-age=3600" });
    }
    if ((await spentToday(env.DB)) >= budget(env)) {
      ctx.waitUntil(logMiss(env.DB, page.href, "budget").catch(() => undefined));
      return html(foggedPage(page.href, await directory(env.DB)), 200, { "Cache-Control": "no-store" });
    }
    return html(interstitialPage(page.href), 200, { "Content-Security-Policy": OWN_PAGE_CSP, "Cache-Control": "no-store" });
  },
};

async function transmuteApi(target: string, env: Env, ctx: Ctx, self: URL): Promise<Response> {
  const checked = await checkTarget(target, env, ctx, self.hostname);
  if ("response" in checked) return json({ status: "error", message: "We don't goggle this page." }, checked.response.status);
  const { page, key } = checked;

  if (await getTranslation(env.PAGES, key)) return json({ status: "ready" });
  if ((await spentToday(env.DB)) >= budget(env)) {
    ctx.waitUntil(logMiss(env.DB, page.href, "budget").catch(() => undefined));
    return json({ status: "fogged" });
  }
  if (!(await tryLock(env.PAGES, key))) return json({ status: "pending" });

  let rewriter: Rewriter | undefined;
  try {
    rewriter = makeRewriter(env);
    const t = await translateUrl(page.href, { lens: aiSafety, rewriter, fetch: { deny: (u) => denyReason(u, self.hostname) } });
    if (t.segments > 0 && t.rewritten / t.segments < MIN_REWRITTEN) throw new Error(`only ${t.rewritten}/${t.segments} segments rewritten`);
    await putTranslation(env.PAGES, key, t);
    await putRendered(env.PAGES, key, render(t, env, `${self.origin}/`));
    await recordPage(env.DB, { url: page.href, title: t.title, sourceTopic: t.glossary.sourceTopic, costUsd: t.usage.costUsd });
    return json({ status: "ready" });
  } catch (e) {
    if (e instanceof OriginError) {
      ctx.waitUntil(logMiss(env.DB, page.href, e.reason).catch(() => undefined));
      return json({ status: "error", message: e.message }, 422);
    }
    if (e instanceof Error && /LLM HTTP 40[23]/.test(e.message)) {
      // The OpenRouter key's limit (or credits) ran out: fog up for the rest of the day.
      await exhaustToday(env.DB, budget(env));
      ctx.waitUntil(logMiss(env.DB, page.href, "llm-limit").catch(() => undefined));
      return json({ status: "fogged" });
    }
    console.error("transmute failed", page.href, e);
    ctx.waitUntil(logMiss(env.DB, page.href, "failed").catch(() => undefined));
    return json({ status: "error", message: "Something went wrong putting the goggles on." }, 502);
  } finally {
    // Spend counts even when the run failed.
    const cost = rewriter?.usage.costUsd;
    if (cost) await recordSpend(env.DB, cost).catch((e) => console.error("recordSpend failed", e));
    await unlock(env.PAGES, key).catch(() => undefined);
  }
}

type Checked = { page: URL; key: string } | { response: Response };

async function checkTarget(target: string, env: Env, ctx: Ctx, ownHost: string): Promise<Checked> {
  let page: URL;
  try {
    page = parseTargetUrl(target);
  } catch (e) {
    return { response: html(errorPage(e instanceof Error ? e.message : "Not a URL."), 400) };
  }
  const denied = denyReason(page, ownHost);
  if (denied) {
    ctx.waitUntil(logMiss(env.DB, page.href, denied).catch(() => undefined));
    return { response: html(deniedPage(page.href, denied), 403) };
  }
  return { page, key: await pageKey(page.href, aiSafety.version, env.MODEL) };
}

/** The page to goggle, from a path like "/https://site/page?x=1" or "/site/page". Null for the home page. */
export function targetFromRequest(url: URL): string | null {
  const raw = url.pathname.slice(1) + url.search;
  if (!raw || raw.startsWith("?") || raw === "favicon.ico") return null;
  // Some clients collapse "https://" to "https:/" in paths; put the second slash back.
  return decodeURI(raw).replace(/^(https?):\/+/i, "$1://");
}

const budget = (env: Env) => Number(env.DAILY_BUDGET_USD) || 0;

const render = (t: Translation, env: Env, proxyBase: string) =>
  renderTranslation(t, { lens: aiSafety, readmeUrl: env.README_URL, proxyBase }).html;

function makeRewriter(env: Env): Rewriter {
  if (env.MODEL === "mock") return mockRewriter();
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  return openAiRewriter({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    model: env.MODEL,
    extraBody: { reasoning: { enabled: false } },
  });
}

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": OWN_PAGE_CSP, ...COMMON_HEADERS, ...extra },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...COMMON_HEADERS },
  });
}
