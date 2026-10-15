import { describe, expect, it } from "vitest";
import { fetchOrigin, OriginError, parseTargetUrl } from "../src/core/fetchOrigin.ts";

describe("parseTargetUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.20.0.1/",
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://intranet/",
    "https://example.org:8443/",
    "ftp://example.org/file",
    "file:///etc/passwd",
    "https://user:pass@example.org/",
  ])("rejects %s", (url) => {
    expect(() => parseTargetUrl(url)).toThrow(OriginError);
  });

  it("accepts bare hosts and strips fragments", () => {
    expect(parseTargetUrl("www.greenfunders.org/blog/x/#top").href).toBe("https://www.greenfunders.org/blog/x/");
    expect(parseTargetUrl("http://example.org:80/a?b=1").href).toBe("http://example.org/a?b=1");
  });
});

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe("fetchOrigin", () => {
  it("uses GET with no body and no cookies, following safe redirects by hand", async () => {
    const calls: Call[] = [];
    const page = await fetchOrigin("https://a.example/start", {
      fetchImpl: fakeFetch(
        { "https://a.example/start": () => redirect("/final"), "https://a.example/final": () => html("<p>hi</p>") },
        calls,
      ),
    });
    expect(page.url.href).toBe("https://a.example/final");
    expect(page.html).toBe("<p>hi</p>");
    for (const c of calls) {
      expect(c.init?.method).toBe("GET");
      expect(c.init?.body).toBeUndefined();
      expect(c.init?.redirect).toBe("manual");
      expect(Object.keys(c.init?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("cookie");
    }
  });

  it("retries once after a network failure", async () => {
    let attempts = 0;
    const flaky = (async () => {
      if (++attempts === 1) throw new TypeError("fetch failed");
      return html("<p>ok</p>");
    }) as unknown as typeof fetch;
    expect((await fetchOrigin("https://a.example/", { fetchImpl: flaky })).html).toBe("<p>ok</p>");
    expect(attempts).toBe(2);
  });

  it("refuses a redirect into a private address", async () => {
    const run = fetchOrigin("https://a.example/", {
      fetchImpl: fakeFetch({ "https://a.example/": () => redirect("http://127.0.0.1/admin") }),
    });
    await expect(run).rejects.toMatchObject({ reason: "blocked-host" });
  });

  it("applies the deny hook on every hop", async () => {
    const run = fetchOrigin("https://a.example/", {
      deny: (u) => (u.pathname.includes("login") ? "login page" : null),
      fetchImpl: fakeFetch({ "https://a.example/": () => redirect("/login") }),
    });
    await expect(run).rejects.toMatchObject({ reason: "denied" });
  });

  it("gives up after too many redirects", async () => {
    const run = fetchOrigin("https://a.example/", {
      maxRedirects: 2,
      fetchImpl: fakeFetch({ "https://a.example/": () => redirect("/") }),
    });
    await expect(run).rejects.toMatchObject({ reason: "too-many-redirects" });
  });

  it("refuses non-HTML and oversized pages", async () => {
    const pdf = fetchOrigin("https://a.example/x.pdf", {
      fetchImpl: fakeFetch({ "https://a.example/x.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) }),
    });
    await expect(pdf).rejects.toMatchObject({ reason: "not-html" });
    const big = fetchOrigin("https://a.example/", {
      maxBytes: 10,
      fetchImpl: fakeFetch({ "https://a.example/": () => html("<p>" + "x".repeat(100) + "</p>") }),
    });
    await expect(big).rejects.toMatchObject({ reason: "too-large" });
  });

  it("decodes the declared charset", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const page = await fetchOrigin("https://a.example/", {
      fetchImpl: fakeFetch({ "https://a.example/": () => new Response(latin1, { headers: { "content-type": "text/html; charset=iso-8859-1" } }) }),
    });
    expect(page.html).toBe("café");
  });
});
