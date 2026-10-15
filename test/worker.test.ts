import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { targetFromRequest, type Env } from "../src/worker/index.ts";
import type { D1, D1Statement, KV } from "../src/worker/types.ts";

// In-memory stand-ins for the Workers bindings: a Map for KV, real SQLite for D1.
function fakeKV(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}
function fakeD1(): D1 & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    raw,
    prepare(sql: string): D1Statement {
      let args: unknown[] = [];
      const stmt: D1Statement = {
        bind: (...a) => ((args = a), stmt),
        first: async <T>() => (raw.prepare(sql).get(...(args as never[])) as T) ?? null,
        run: async () => raw.prepare(sql).run(...(args as never[])),
        all: async <T>() => ({ results: raw.prepare(sql).all(...(args as never[])) as T[] }),
      };
      return stmt;
    },
  };
}

const ORIGIN_HTML = `<!doctype html><html><head><title>Fifteen years of climate work</title></head>
<body><h1>The climate fight</h1><p>Fossil fuel companies have used their power to defeat climate policy.</p></body></html>`;

let env: Env & { PAGES: ReturnType<typeof fakeKV>; DB: ReturnType<typeof fakeD1> };
let waits: Promise<unknown>[];
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
const call = async (path: string, method = "GET") => {
  const res = await worker.fetch(new Request(`https://goggles.example.net${path}`, { method }), env, ctx);
  await Promise.all(waits);
  return res;
};

beforeEach(() => {
  env = { MODEL: "mock", DAILY_BUDGET_USD: "1", README_URL: "https://example.org/readme", PAGES: fakeKV(), DB: fakeD1() };
  waits = [];
  // Origin fetches only; the mock model makes no network calls.
  vi.stubGlobal("fetch", async () => new Response(ORIGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));
});
afterEach(() => vi.unstubAllGlobals());

const rows = (sql: string) => env.DB.raw.prepare(sql).all() as Record<string, unknown>[];

describe("worker router", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH"])("refuses %s", async (method) => {
    const res = await call("/https://example.org/", method);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("never spends on HEAD", async () => {
    expect((await call("/api/transmute?url=https://example.org/", "HEAD")).status).toBe(405);
  });

  it("serves the home page with a bookmarklet pointing at itself", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(await res.text()).toContain("javascript:location.href=&quot;https://goggles.example.net/&quot;+location.href");
  });

  it("redirects the home-page form to the path form", async () => {
    const res = await call("/?url=https://example.org/a");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://goggles.example.net/https://example.org/a");
  });

  it.each([
    ["/https://example.org/a?b=1", "https://example.org/a?b=1"],
    ["/https:/example.org/a", "https://example.org/a"],
    ["/example.org/a", "example.org/a"],
    ["/", null],
    ["/favicon.ico", null],
  ])("reads the target from %s", (path, expected) => {
    expect(targetFromRequest(new URL(`https://goggles.example.net${path}`))).toBe(expected);
  });
});

describe("goggling flow", () => {
  it("miss → interstitial → API → cached goggled page", async () => {
    const miss = await call("/https://example.org/post");
    expect(miss.headers.get("Cache-Control")).toBe("no-store");
    const missBody = await miss.text();
    expect(missBody).toContain("Putting on goggles");
    expect(missBody).toContain('<script src="/sg.js">');

    const api = await call("/api/transmute?url=https%3A%2F%2Fexample.org%2Fpost");
    expect(await api.json()).toEqual({ status: "ready" });

    const hit = await call("/https://example.org/post");
    expect(hit.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    const body = await hit.text();
    expect(body).toContain("The AI safety fight");
    expect(body).not.toContain("<script");

    expect(rows("SELECT url, title, views FROM pages")).toEqual([{ url: "https://example.org/post", title: "Fifteen years of climate work", views: 1 }]);
    expect((await call("/directory").then((r) => r.text()))).toContain("Fifteen years of climate work");
  });

  it("says pending while another request holds the lock, and doesn't spend twice", async () => {
    await call("/https://example.org/post"); // interstitial only; nothing cached yet
    expect(env.PAGES.map.size).toBe(0);
    // Simulate a rewrite already in flight.
    const { pageKey } = await import("../src/worker/cache.ts");
    const { aiSafety } = await import("../lenses/ai-safety.ts");
    await env.PAGES.put(`lock:${await pageKey("https://example.org/post", aiSafety.version, "mock")}`, "1");
    expect(await (await call("/api/transmute?url=https://example.org/post")).json()).toEqual({ status: "pending" });
  });

  it("fogs up when today's budget is spent, logging the miss without its query string", async () => {
    env.DAILY_BUDGET_USD = "0";
    const res = await call("/https://example.org/secret?token=abc123");
    expect(await res.text()).toContain("fogged up");
    expect(await (await call("/api/transmute?url=https://example.org/other")).json()).toEqual({ status: "fogged" });
    expect(rows("SELECT url, reason FROM wishlist ORDER BY url")).toEqual([
      { url: "https://example.org/other", reason: "budget" },
      { url: "https://example.org/secret", reason: "budget" },
    ]);
  });

  it("refuses login pages and itself, and logs why", async () => {
    expect((await call("/https://example.org/account/login")).status).toBe(403);
    expect((await call("/https://goggles.example.net/https://example.org/")).status).toBe(403);
    expect(rows("SELECT reason FROM wishlist ORDER BY reason")).toEqual([{ reason: "own-host" }, { reason: "sensitive-path" }]);
  });

  it("keeps private-address targets away from fetch entirely", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await call("/http://127.0.0.1/admin")).status).toBe(400);
    expect((await call("/api/transmute?url=http://169.254.169.254/")).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not list pages with query strings in the public directory", async () => {
    await call("/api/transmute?url=" + encodeURIComponent("https://example.org/a?session=xyz"));
    await call("/api/transmute?url=https://example.org/b");
    const dir = await (await call("/directory")).text();
    expect(dir).toContain("https://example.org/b");
    expect(dir).not.toContain("session=xyz");
  });
});
