import { describe, expect, it } from "vitest";
import { extractSegments, parseDocument, sanitize, serializeDocument } from "../src/core/segment.ts";

const PAGE = new URL("https://example.org/blog/post/");

const FIXTURE = `<!doctype html><html><head>
<title>Lessons from the climate community</title>
<meta name="description" content="What 15 years of climate work taught me">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<script>window.tracker = 1</script>
</head><body>
<form action="/subscribe" method="post">
  <nav><a href="/about">About us</a> <a href="#comments">Comments</a></nav>
  <input type="email" name="email"><button onclick="go()">Subscribe now</button>
</form>
<article>
  <h1>Lessons and reflections</h1>
  <p>We will not win because we are <em>right</em>; we <a href="/organise" onclick="x()">organise</a> instead.<br>New line here.</p>
  <div>Loose text before a block <strong>with emphasis</strong><p>Inner paragraph text</p>and loose text after</div>
  <p>Run <code>npm install</code> to install things.</p>
  <ul><li>First item text</li><li><a href="javascript:alert(1)">Bad link text</a></li></ul>
  <img data-src="/lazy.png" src="data:image/gif;base64,R0lGOD">
  <pre>do not translate this code</pre>
  <figure><img src="/a.jpg"><figcaption>Nuns serve worshippers during an outbreak in Bunia</figcaption></figure>
  <div><span>Residents queue outside a clinic in Goma, May 2026. REUTERS/Stringer</span></div>
</article>
<iframe src="https://example.org/login"></iframe>
</body></html>`;

function setup() {
  const doc = parseDocument(FIXTURE);
  sanitize(doc, PAGE, { rewriteHref: (abs) => "https://goggles.test/" + abs.href });
  return { doc, page: extractSegments(doc) };
}

const visibleText = (doc: Document) => (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
const hrefs = (doc: Document) => [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("sanitize", () => {
  it("removes scripts, frames, form controls, handlers and javascript: URLs", () => {
    const { doc } = setup();
    const html = serializeDocument(doc);
    expect(html).not.toMatch(/<script|<iframe|<input|<form|onclick|javascript:|http-equiv/i);
    expect(doc.querySelector("button")!.getAttribute("type")).toBe("button");
    // The form was unwrapped, not deleted with its contents.
    expect(visibleText(doc)).toContain("About us");
  });

  it("adds base href and routes links through the proxy", () => {
    const { doc } = setup();
    expect(doc.querySelector("base")!.getAttribute("href")).toBe(PAGE.href);
    expect(hrefs(doc)).toContain("https://goggles.test/https://example.org/about");
    expect(hrefs(doc)).toContain("https://goggles.test/https://example.org/organise");
    expect(hrefs(doc)).toContain("#comments"); // same-page anchors stay local
  });

  it("promotes lazy-loaded image sources", () => {
    const { doc } = setup();
    expect(doc.querySelector("img")!.getAttribute("src")).toBe("/lazy.png");
  });
});

describe("extractSegments", () => {
  it("turns inline markup into numbered placeholders and skips code", () => {
    const { page } = setup();
    const sources = page.segments.map((s) => s.source);
    expect(sources).toContain("Lessons from the climate community");
    expect(sources).toContain("What 15 years of climate work taught me");
    expect(sources).toContain("We will not win because we are <1>right</1>; we <2>organise</2> instead.<3/>New line here.");
    expect(sources).toContain("Run <1/> to install things.");
    expect(sources).toContain("Loose text before a block <1>with emphasis</1>");
    expect(sources).toContain("and loose text after");
    expect(sources.join("\n")).not.toContain("do not translate");
    expect(sources).toContain("Nuns serve worshippers during an outbreak in Bunia");
    expect(sources).toContain("<1>Residents queue outside a clinic in Goma, May 2026. REUTERS/Stringer</1>");
  });

  it("marks heading segments as section boundaries", () => {
    const { page } = setup();
    const heading = (text: string) => page.segments.find((s) => s.source === text)!.heading;
    expect(heading("Lessons and reflections")).toBe(true);
    expect(heading("First item text")).toBe(false);
    expect(heading("Lessons from the climate community")).toBe(false); // <title>
  });

  it("round-trips: applying each segment's own source changes nothing visible", () => {
    const before = setup();
    const textBefore = visibleText(before.doc);
    const hrefsBefore = hrefs(before.doc);
    const imgsBefore = before.doc.querySelectorAll("img").length;

    const after = setup();
    const stats = after.page.apply(new Map(after.page.segments.map((s) => [s.id, s.source])));
    expect(stats.placeholderMismatches).toBe(0);
    expect(stats.applied).toBe(after.page.segments.length);
    expect(stats.unchanged).toBe(stats.applied);
    expect(visibleText(after.doc)).toBe(textBefore);
    expect(hrefs(after.doc)).toEqual(hrefsBefore);
    expect(after.doc.querySelectorAll("img").length).toBe(imgsBefore);
    expect(after.doc.querySelectorAll("em, strong, br, code").length).toBe(before.doc.querySelectorAll("em, strong, br, code").length);
  });

  it("keeps original attributes when the model moves placeholders around", () => {
    const { doc, page } = setup();
    const seg = page.segments.find((s) => s.source.startsWith("We will not win"))!;
    const stats = page.apply(new Map([[seg.id, "We <2>coordinate labs</2> rather than being <1>correct</1>.<3/>Next."]]));
    expect(stats.placeholderMismatches).toBe(0);
    const p = doc.querySelector("article p")!;
    expect(p.querySelector("a")!.textContent).toBe("coordinate labs");
    expect(p.querySelector("a")!.getAttribute("href")).toBe("https://goggles.test/https://example.org/organise");
    expect(p.querySelector("a")!.hasAttribute("onclick")).toBe(false);
    expect(p.querySelector("em")!.textContent).toBe("correct");
    expect(stats.unchanged).toBe(0);
  });

  it("counts lost placeholders and drops invented ones", () => {
    const { doc, page } = setup();
    const seg = page.segments.find((s) => s.source.startsWith("We will not win"))!;
    const stats = page.apply(new Map([[seg.id, "No links survive <9>here</9>."]]));
    expect(stats.placeholderMismatches).toBe(1);
    expect(doc.querySelector("article p")!.textContent).toBe("No links survive here.");
  });

  it("rewrites loose text beside blocks in place, without wrapper elements", () => {
    const { doc, page } = setup();
    const seg = page.segments.find((s) => s.source === "and loose text after")!;
    page.apply(new Map([[seg.id, "and goggled text after"]]));
    const div = doc.querySelector("article div")!;
    expect(div.lastChild!.textContent).toBe("and goggled text after");
    expect(div.querySelectorAll("span").length).toBe(0);
  });

  it("stops at maxSourceChars and reports truncation", () => {
    const doc = parseDocument(FIXTURE);
    sanitize(doc, PAGE);
    const page = extractSegments(doc, { maxSourceChars: 60 });
    expect(page.truncated).toBe(true);
    expect(page.segments.reduce((n, s) => n + s.source.length, 0)).toBeLessThanOrEqual(60);
  });
});

describe("model output is text, never markup", () => {
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)></title><script>alert(3)</script>`;

  it("escapes markup in body segments", () => {
    const { doc, page } = setup();
    const seg = page.segments.find((s) => s.source === "First item text")!;
    page.apply(new Map([[seg.id, evil]]));
    const html = serializeDocument(doc);
    expect(html).not.toMatch(/<script>alert|<img src=x/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes markup in <title>, which linkedom would otherwise write raw", () => {
    const { doc, page } = setup();
    const title = page.segments.find((s) => s.source === "Lessons from the climate community")!;
    page.apply(new Map([[title.id, evil]]));
    const html = serializeDocument(doc);
    expect(html).not.toMatch(/<\/title><script>/);
    expect(html.match(/<title>(.*?)<\/title>/s)![1]).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&lt;/title&gt;&lt;script&gt;alert(3)&lt;/script&gt;",
    );
  });

  it("keeps attribute rewrites inside their quotes", () => {
    const { doc, page } = setup();
    const meta = page.segments.find((s) => s.source.startsWith("What 15 years"))!;
    page.apply(new Map([[meta.id, `"><script>alert(4)</script>`]]));
    expect(serializeDocument(doc)).not.toMatch(/"><script>alert\(4\)/);
  });
});
