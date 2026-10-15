import { describe, expect, it } from "vitest";
import { aiSafety } from "../lenses/ai-safety.ts";
import { makeBatches, makeSectionBatches, mockRewriter, openAiRewriter } from "../src/core/llm.ts";
import { parseDocument } from "../src/core/segment.ts";
import { transmuteHtml } from "../src/core/transmute.ts";

const PAGE = new URL("https://example.org/post");
const HTML = `<!doctype html><html><head><title>Fifteen years of climate work</title></head>
<body><h1>The climate fight</h1><p>Fossil fuel companies have used their power to defeat climate policy.</p>
<p>By <a href="/tom">Tom</a></p></body></html>`;

describe("transmuteHtml (mock model)", () => {
  it("rewrites prose and adds the attribution banner and badge", async () => {
    const r = await transmuteHtml(HTML, PAGE, {
      lens: aiSafety,
      rewriter: mockRewriter(),
      readmeUrl: "https://github.com/danmackinlay/safetygoggles#readme",
      proxyBase: "https://goggles.test/",
    });
    const doc = parseDocument(r.html);
    expect(doc.querySelector("h1")!.textContent).toBe("The AI safety fight");
    expect(doc.querySelector("title")!.textContent).toBe("Fifteen years of AI safety work");
    expect(doc.querySelector('meta[name="robots"]')!.getAttribute("content")).toContain("noindex");
    const banner = doc.querySelector("#sg-banner")!;
    expect(banner.textContent).toContain("originally about climate change");
    expect(r.html).not.toMatch(/satire/i); // the README says so; the page doesn't
    const links = [...banner.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain(PAGE.href);
    expect(links).toContain("https://github.com/danmackinlay/safetygoggles#readme");
    expect(links.some((h) => h?.startsWith("javascript:location.href=\"https://goggles.test/\""))).toBe(true);
    expect(doc.querySelector("#sg-badge a")!.getAttribute("href")).toBe(PAGE.href); // "goggles off"
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelector("#sg-lens")!.getAttribute("aria-hidden")).toBe("true");
    expect(r.stats.rewritten).toBe(r.stats.segments);
  });

  it("omits the bookmarklet when there is no live proxy", async () => {
    const r = await transmuteHtml(HTML, PAGE, { lens: aiSafety, rewriter: mockRewriter(), readmeUrl: "x", proxyBase: null });
    expect(r.html).not.toContain("javascript:");
  });
});

describe("openAiRewriter", () => {
  it("parses glossary and rewrite JSON, tolerates dropped ids, and totals usage", async () => {
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const user = JSON.parse(body.messages[1].content.startsWith("{") ? body.messages[1].content : "{}");
      const content = user.segments
        ? { segments: user.segments.filter((s: any) => s.id !== 1).map((s: any) => ({ id: s.id, text: s.text.toUpperCase() })) }
        : { source_topic: "climate change", mappings: [{ from: "climate", to: "AI safety" }], frame: "f", author: "Tom" };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.001 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rw = openAiRewriter({ baseUrl: "https://llm.test/v1/", apiKey: "k", model: "m", extraBody: { reasoning: { enabled: false } }, fetchImpl: fakeFetch });
    const g = await rw.glossary({ url: "u", title: "t", text: "x" }, aiSafety);
    expect(g).toMatchObject({ sourceTopic: "climate change", author: "Tom" });
    const segs = [0, 1, 2].map((id) => ({ id, source: `seg ${id}`, original: `seg ${id}`, heading: false }));
    const out = await rw.rewrite(segs, g, aiSafety);
    expect(out.get(0)).toBe("SEG 0");
    expect(out.has(1)).toBe(false); // dropped twice (first pass + retry): left untranslated
    expect(bodies[0].reasoning).toEqual({ enabled: false });
    expect(bodies[0].messages[0].content).toContain(aiSafety.primer); // primer leads the shared prefix
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(rw.usage).toMatchObject({ calls: 3, inputTokens: 300, cachedInputTokens: 120, outputTokens: 150 });
    expect(rw.usage.costUsd).toBeCloseTo(0.003);
  });

  it("counts BYOK spend from the upstream cost, not OpenRouter's zero charge", async () => {
    const usages = [
      { prompt_tokens: 10, completion_tokens: 5, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } },
      { prompt_tokens: 10, completion_tokens: 5, cost: 0.001, cost_details: { upstream_inference_cost: 0.0009 } }, // not BYOK: don't double-count
    ];
    let i = 0;
    const fakeFetch = (async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ source_topic: "x", mappings: [], frame: "", author: null }) } }],
        usage: usages[i++],
      }))) as unknown as typeof fetch;
    const rw = openAiRewriter({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", fetchImpl: fakeFetch });
    await rw.glossary({ url: "u", title: "t", text: "x" }, aiSafety);
    await rw.glossary({ url: "u", title: "t", text: "x" }, aiSafety);
    expect(rw.usage.costUsd).toBeCloseTo(0.003);
  });

  it("batches by size", () => {
    const segs = [10, 10, 10, 25].map((n, id) => ({ id, source: "x".repeat(n), original: "", heading: false }));
    expect(makeBatches(segs, 20).map((b) => b.map((s) => s.id))).toEqual([[0, 1], [2], [3]]);
  });

  it("batches whole sections, merging small ones and splitting oversized ones", () => {
    const seg = (id: number, n: number, heading = false) => ({ id, source: "x".repeat(n), original: "", heading });
    const segs = [seg(0, 5), seg(1, 5, true), seg(2, 10), seg(3, 5, true), seg(4, 5), seg(5, 5, true), seg(6, 30), seg(7, 30)];
    // [0] | [1,2] | [3,4] | [5,6,7]: the first three fit in 40 together, the last is split by size.
    expect(makeSectionBatches(segs, 40).map((b) => b.map((s) => s.id))).toEqual([[0, 1, 2, 3, 4], [5, 6], [7]]);
  });

  it("rewrites the lead section first, then the rest with it as an exemplar", async () => {
    const calls: { system: string; ids: number[] }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const user = JSON.parse(body.messages[1].content);
      calls.push({ system: body.messages[0].content, ids: user.segments.map((s: any) => s.id) });
      const content = { segments: user.segments.map((s: any) => ({ id: s.id, text: `<1>${s.text.toUpperCase()}</1>` })) };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: {} }));
    }) as unknown as typeof fetch;
    const seg = (id: number, text: string, heading = false) => ({ id, source: text, original: text, heading });
    const segs = [
      seg(0, "Site menu"),
      seg(1, "Intro", true),
      seg(2, "lead paragraph ".repeat(15)),
      seg(3, "Part two", true),
      seg(4, "second body"),
    ];
    const rw = openAiRewriter({ baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", batchChars: 230, fetchImpl: fakeFetch });
    const glossary = { sourceTopic: "climate change", mappings: [], frame: "f", author: null };
    const out = await rw.rewrite(segs, glossary, aiSafety);

    expect(out.size).toBe(5);
    expect(calls.map((c) => c.ids)).toEqual([[1, 2], [0], [3, 4]]); // lead first, then the others
    expect(calls[0]!.system).toContain("second body"); // every call sees the whole original page
    expect(calls[0]!.system).not.toContain("already been rewritten");
    for (const later of calls.slice(1)) {
      expect(later.system).toContain("LEAD PARAGRAPH"); // the lead's rewrite, placeholders stripped
      expect(later.system).not.toContain("<1>LEAD");
      expect(later.system.startsWith(calls[0]!.system)).toBe(true); // shared, cacheable prefix
    }
  });
});
