# safetygoggles: spec

A satirical rewriting proxy. You request `goggles.example/<any URL>` and get back
that page in its original styling, with the prose rewritten so that its subject is AI
Safety. Every page says it was rewritten and links to the original and to the
[README](README.md). The README, not the page, explains that it is satire.

Status: **Phase 0 is done.** That means the shared TypeScript core plus a Node CLI.
The Cloudflare Worker is Phase 1.

## Why it is feasible

Fetching, parsing, rewriting text, caching and serving are each well-trodden. Three
things are actually hard:

1. **Rewrite quality** is the main product risk. A word swap ("climate" → "AI
   safety") stops being funny by the third sentence. A good rewrite needs one
   consistent analogy map across the whole page: fossil-fuel majors → frontier labs,
   COP → AI summits, emissions → capability gains. That's why the pipeline has two
   passes: build a glossary, then rewrite.
2. **Latency.** A long article comes to about 6k output tokens, which takes about
   2 minutes as a single stream. Running segment batches in parallel gets that to
   about 10–20 s. In Phase 1 an interstitial page covers the wait, and cache hits are
   instant.
3. **Not becoming an open proxy or a phishing kit.** A public "rewrite any site under
   my domain" service is a classic abuse vector. That is what drives the access model
   below.

## Architecture

**Chosen: a Cloudflare Worker in TypeScript.** It costs about $5/mo, because Workers
Paid is needed: the free plan's 10 ms CPU cap is too tight for DOM parsing. It needs
no ops and has a native edge cache. Wall-clock time spent waiting on the LLM's
`fetch` doesn't count against the CPU limit.

Alternatives considered:

| Option | Why not (for now) |
|---|---|
| Python on a VPS + Cloudflare CDN | Works equally well and costs about €4–5/mo, but means patching a server. It's the fallback if Workers get in the way. |
| Static snapshot generator | Loses the live "any URL" magic, and republishing static copies is the weakest copyright posture. The Phase 0 CLI already does this anyway. |
| Browser extension | Private only, so nothing can be shared. That defeats the point. |
| Inference on Workers AI at the edge | Small edge models are too weak for analogical rewriting. The edge buys caching near readers, not cheaper inference. |

One TypeScript codebase serves both runtimes. `src/core/` uses only Web-standard
APIs (`fetch`, `URL`, `TextEncoder`, linkedom). `tsconfig.core.json` type-checks it
without Node types to enforce that. The Node CLI (`src/cli/`) and the Worker
(`src/worker/`, Phase 1) are thin adapters.

## Pipeline

Phase 1 request flow:

```
GET /https://site/page   (also /site/page)
  ├─ normalise URL → key = sha256(url | lens.version | model)
  ├─ rendered page in KV for the current CHROME_VERSION ──────────────▶ serve
  ├─ translation in KV → render it now (CPU only, no LLM) → cache ────▶ serve
  └─ neither → gate (see Access) → interstitial "🥽 putting on goggles…"
              └─ page JS calls GET /api/transmute?url=…   (~30 s): translate, store, render
```

**Two cache layers.** The expensive and cheap parts are stored separately, so chrome
changes never cost LLM calls.
- **Translation** (`tr:<key>`, kept 180 days): the origin HTML snapshot, the glossary,
  and the rewrites as a dictionary keyed by segment *source text*. Keying by text
  rather than segment number means a later change to segmentation can't misplace a
  rewrite; unmatched text just stays original. Only `/api/transmute` creates one.
- **Rendered page** (`page:<key>:<CHROME_VERSION>`, kept 30 days): snapshot plus
  rewrites plus the current chrome.

What to bump:
- **Chrome change** (anything in `decorate.ts`, or the lens tagline): bump
  `CHROME_VERSION`. Every page re-renders on its next visit, free.
- **Prompt or primer change:** bump `lens.version`. Every page re-translates on its next
  visit, paid from the daily budget.
- **One page:** `npm run regoggle -- <url>` re-translates it, and `--render`
  re-renders it only.

`transmuteUrl()` in `src/core/transmute.ts` works in both runtimes:

1. **`fetchOrigin`.**
   - Sends GET only, with no cookies and no client headers.
   - Follows redirects by hand, at most 5 hops, re-checking each hop against the SSRF
     guard and the deny hook.
   - Accepts only `text/html` and at most 2 MB, and honours the page's charset.
2. **`sanitize`.**
   - Removes scripts, frames, form controls, `on*` handlers, `javascript:` URLs and
     meta refresh. Forms are unwrapped rather than deleted.
   - Adds `<base href>` so CSS and images load from the origin, which costs us no
     asset bandwidth.
   - Adds `referrer: no-referrer`, so hotlink protection doesn't reject our page's
     asset requests.
   - Rewrites links through the proxy and promotes lazy-loaded image sources.
3. **`extractSegments`.**
   - A segment is a maximal run of inline content in a block. Inline elements become
     numbered placeholders, as in `We <1>poll</1> the public<2/>`.
   - Code, `pre`, SVG and similar elements are opaque and never translated.
   - `<title>` and the description and og/twitter meta tags are segments too.
   - Segments stop at a cap of about 100k characters (~25k tokens). A 100k page
     costs about 6.5¢ and takes about 50 s on Haiku, mostly for the uncached shared
     prefix. Past the cap the page stays original and the banner says so.
4. **Glossary pass (one call).** The input is the lens primer plus the page text. The
   output is `{source_topic, mappings[], frame, author}`. Every source-world proper
   noun gets a specific counterpart: a real institution only in its real role,
   otherwise an invented one.
5. **Rewrite pass, in two waves.** Segments are batched by *section*: they are split at
   h1–h6, small sections are merged up to about 5k characters, and oversized ones are
   split.
   - **Wave 1:** the lead section (the first batch with real prose) goes alone.
   - **Wave 2:** every other batch, in parallel with concurrency 8. These calls also
     get the lead's rewrite as a voice and naming exemplar.

   Every call starts with the same system prompt: lens primer, rules, the original page
   text (capped at about 24k characters), then this page's glossary. So the provider's
   prompt cache applies, when it works. JSON goes in and comes out. Missing ids get one
   retry in smaller batches.
6. **`apply`.**
   - Placeholders map back to clones of the *original* elements. Everything else
     becomes DOM text nodes, so model output is never parsed as markup.
   - `<title>` gets escaped explicitly, because linkedom writes it raw.
   - `stats.unchanged` counts rewrites identical to their source. A high count means
     the model is only doing find-and-replace.
7. **`decorate`.** Adds a one-line banner (tagline, attribution, original link,
   "Goggle a page yourself", README link, bookmarklet), a fixed badge whose
   "goggles off" button links to the original, the lens frame with its printed strip,
   and `noindex`. It adds **no scripts**, so the Worker can serve pages with
   `script-src 'none'`.

**Lenses.** A lens (`lenses/ai-safety.ts`) holds the target domain, the banner
tagline, a **primer** and a version string. The primer is the model's background
reading: a timeline, institutions by real role, recurring fights, idioms, calibration
examples and analogy hints. The version is part of the cache key. Other lenses
(biosecurity, nuclear) are cheap to add.

**Model choice: `anthropic/claude-haiku-5.5`, reasoning off.** We compared 6 models
on 4 pages (climate essay, pandemic interview, aviation-safety blog, Wikipedia on the
nuclear test ban), on identical HTML and prompts (lens `ai-safety@4`, Oct 2026):

| Model | $/article | Time | Segments unchanged | Lost tags |
|---|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` (pinned to DeepSeek) | 0.007 | 36 s | 63% | 8 |
| `anthropic/claude-haiku-5.5` | ~0.015 (est.) | 33 s | 57% | 2 |
| `z-ai/glm-5.2` (fp8) | 0.030 | 124 s | 49% | 3 |
| `deepseek/deepseek-v4-pro` (fp8) | 0.035 | 93 s | 55% | 2 |
| `openai/gpt-6-sol` (effort none) | 0.147 | 35 s | 40% | 0 |
| `x-ai/grok-4.7` (effort low) | 0.270 | 137 s | 53% | 0 |

- **Haiku, GLM-5.2 and V4 Pro read about equally well,** so Haiku wins on cost and
  speed. It keeps the author's voice and adds in-group flavour.
- **GPT-6 Sol is the boldest, but it paraphrases the author away.** That defeats the
  point, which is that the original barely needs to change.
- **Flash stays timid.**
- **Models left out:** GLM-5.3 and Kimi K3 were not tried, because reasoning is
  mandatory for them, which costs speed and money.
- **Haiku's cost:** OpenRouter reported $0 for Haiku runs, so its cost is estimated
  from list price.

**Photo captions are rewritten like any other text.** The worry was that a caption
under a real news photo puts the people *in* the photo into the joke. We addressed that
with framing rather than a caption-specific rule: the safetygoggles lens makes it
visible that the joke is on the wearer, meaning the AI-safety reader who needs the
goggles, not on anyone in the piece.

If brand, date or real-organisation slips remain a problem, the fix is one review
pass. A single call reads the whole rewritten page, flags offending segments, and
redoes only those. That's preferred over per-rule code guards.

**Known limits.**
- JS-rendered SPAs have no content in their HTML.
- Bot-walled sites refuse datacentre fetches. Some sites also refuse our honest
  `safetygoggles/0.1` user-agent outright: amacad.org returned 403 every time, though
  it loads in a browser.
- Paywalls: we don't try to get around them.
- Cross-origin web fonts fail CORS under `<base href>`, so pages render in fallback
  fonts. Phase 1 can proxy font files.

The fallback for unworkable pages is a "reader mode" template, with `r.jina.ai` as an
optional extractor.

## Cost

These are measured figures; see the model table above. A page takes 8 calls: one
glossary call, the lead section, then the rest in parallel. Because every call carries
the primer and the original page as shared context, that comes to about 65–100k tokens
in and 8–12k out. With the default Haiku, that's **about 1.5¢ per long article in
about 30 s**, roughly 650 fresh articles per $10.

Typical blog posts are a third to half that size. Fixed costs are about $5/mo for
Workers Paid and about $10/yr for a domain.

Spend caps, from the true hard stop down. Dan's OpenRouter account uses BYOK for
Anthropic, so Haiku calls bill his Anthropic key: OpenRouter reports `usage.cost: 0`
and puts the real charge in `usage.cost_details.upstream_inference_cost`. `costUsd`
sums both.
1. **Anthropic workspace spend limit** (monthly). A dedicated workspace and key are
   used for OpenRouter BYOK. This is the only cap enforced by whoever bills us.
2. **OpenRouter key limit:** $20/month on a dedicated safetygoggles key, with
   **"Include BYOK usage in limit"** turned on. It's off by default, and without it
   BYOK spend is never counted.
3. **BYOK fallback to paid capacity is allowed.** A failing or exhausted BYOK key may
   fall back to OpenRouter credits (or Bedrock/Vertex). Dan accepts this, because the
   $20 key limit counts BYOK and credit spend together.
4. **The app's daily budget** in D1: `DAILY_BUDGET_USD` (default $2), debited by
   `costUsd`. This is what turns a bad day into "fogged up until midnight UTC" instead
   of a dead site for the rest of the month. The Worker treats OpenRouter 402/403
   errors and Anthropic spend-limit errors the same way.
5. **Per-visitor rate limit:** a Cloudflare dashboard rule on `/api/transmute`, with no
   code.
6. **The input cap** of about 32k characters, the page cache, and the provider's
   prompt cache.

Concurrent requests can overshoot the OpenRouter and app caps by roughly one page's
calls. OpenRouter checks against spend already billed, with no in-flight hold for
BYOK. That's a few cents, which is acceptable.

## Access model and abuse

The service is **open by default and budget-limited, with an automated denylist.**
There's no hand-maintained allowlist.

- **Cache hits** are always served, to everyone.
- **Cache misses** are allowed for any plausible URL, subject to these checks in
  order:
  1. **The denylist:** the opt-out list; login, signin, account and checkout paths;
     webmail and banking hosts; and anything that isn't HTML.
  2. **The daily dollar budget.**

  Per-visitor rate limiting and bot filtering are Cloudflare dashboard settings (a
  rate-limit rule on `/api/transmute`, and Bot Fight Mode), not code.
- **The refusal page** ("the goggles are fogged up for today") says the request has
  been noted. It shows a **directory of already-goggled pages**, grouped by domain.
- **Misses are captured automatically.** Every refused or failed miss goes into a
  `wishlist` table: the URL with **query string and fragment stripped**, the reason, a
  count and first and last seen. Raw IPs are never stored. There's no "request"
  button and no admin page; Dan reads the table with `wrangler d1 execute`.
- **`/directory`** is public and lists only pages that actually got goggled. It is
  `noindex`.
- **The "🥽 Safety-goggle this" bookmarklet** appears on the home page and in every
  goggled page's banner. It is
  `javascript:location.href="https://goggles.example/"+location.href`. Because we
  fetch without the reader's cookies, logged-in or paywalled pages come out in their
  logged-out version.
- **Storage:**
  - D1 holds `pages`, `wishlist` and `budget` (one row per UTC day).
  - KV holds translations (180 days) and rendered pages per chrome version (30 days).

Hardening in every mode:
- **GET-only, end to end.**
  - The Worker answers GET and HEAD and returns 405 for anything else.
  - All of our own endpoints are GET.
  - Upstream fetches are always GET with no body.
  - Goggled pages contain no forms or scripts apart from our own.
- Private IP ranges, single-label hosts and ports other than 80 and 443 are refused.
- No cookies are forwarded.
- Every response carries `X-Robots-Tag: noindex`.
- **Domain reputation:** the trial runs on `safetygoggles.<subdomain>.workers.dev`.
  Any later custom domain should be a throwaway, never a subdomain of a domain you care
  about, because if Safe Browsing flags it the whole registrable domain suffers.
- **Content-Security-Policy:** goggled pages are served with `script-src 'none'`. The
  interstitial is our own page and has one small script.
- **Prompt injection** can only ever change the *text* of a segment (see `apply`).

## Copyright, attribution and ethics

Not legal advice.
- **The page doesn't say "satire"; the README does.** On the page, the banner leads
  with a wry tagline ("Now it’s relevant to you."), aimed at the reader. It then states the
  facts: "This page was originally written by {author} about {topic}; safetygoggles
  rewrote it." Links to the original and the README follow. False attribution is a
  bigger risk than copyright, and this factual line is what addresses it.
- **The safetygoggles lens** frames the viewport: a dark wraparound frame with strap
  stubs, an amber tint and a glare highlight. At the top of the page the dark banner
  reads as the goggles' band. It is CSS only (`#sg-lens`, `pointer-events: none`) and
  makes clear that the joke is on the reader wearing the goggles, not on the page's
  subjects.
- **The badge** ("🥽 safetygoggles · 👓 Goggles off") stays fixed on screen, so most
  screenshots carry it.
- **The frame print:** "safetygoggles · rewritten by machine · not the original"
  repeats along the bottom of the lens frame, like branding on a goggle strap. It was
  added on reader feedback asking for a watermark. Unlike the earlier diagonal
  watermark over the text, it never covers content. It is CSS only; anyone determined
  to fake a screenshot can still edit the DOM, which no watermark prevents.
- **Rewritten bios** may recast the author's career, but only with *invented*
  organisations. A real person is never placed in a real organisation.
- **The posture:** non-commercial, no ads, `noindex`, short cache TTLs, fast opt-out
  and takedown.
- **The law:** fair dealing for "parody or satire" exists explicitly in some
  jurisdictions (e.g. Australia, s41A). US fair use treats satire somewhat less
  generously than parody.

## Layout

```
lenses/ai-safety.ts       lens: target, tagline, primer, version
src/core/                 runtime-agnostic (Node + Workers)
  fetchOrigin.ts          GET-only fetch, manual redirects, SSRF guard, size/type caps
  segment.ts              sanitize, segment with placeholders, apply rewrites as text
  llm.ts                  OpenAI-compatible fetch client, glossary + batched rewrite, mock
  decorate.ts             banner, badge (goggles-off link), lens chrome, bookmarklet; no scripts
  transmute.ts            url → goggled HTML + glossary + usage
src/cli/transmute.ts      Phase 0 CLI → out/<slug>.html + .json
src/worker/               Phase 1: index (router, API), gate (denylist), db (D1), cache (KV), pages, types
schema.sql, wrangler.toml Phase 1 (D1 tables; KV + D1 bindings)
test/                     vitest
```

## Phases

0. ✅ **Core + CLI.**
1. **Trial Worker** on `workers.dev`, in this order:
   1. Scaffold: `wrangler.toml`, a GET/HEAD-only router, `wrangler dev`.
   2. Cache: KV keyed on url | lens version | model, with a 30-day TTL plus the edge
      cache.
   3. Miss flow: an interstitial calls `/api/transmute` and then reloads. A KV
      "in progress" marker stops duplicate spend.
   4. Gate: the denylist, the D1 daily budget, wishlist logging and `/directory`.
      OpenRouter requests are pinned to Anthropic with no fallback.
   5. Pages: home (URL box, bookmarklet, README link) and fogged-up.
   6. Headers: the CSP, `X-Robots-Tag: noindex` and `Referrer-Policy`.
   7. Dashboard: the rate-limit rule, Bot Fight Mode and, optionally, Cloudflare Access
      for a friends-only start.
   8. Deploy and smoke-test, then share with friends. Watch it with `wrangler tail`,
      the D1 `budget` row and OpenRouter's activity page.
2. **Later, if needed:** a custom domain, font proxying, reader mode, the segment
   cache, request coalescing, and a review pass for brand, date and real-organisation
   slips.

## Verification

- **Phase 0:**
  - `npm test` passes.
  - `npm run typecheck` passes, including the Web-only core check.
  - `npm run goggle -- <url>` writes `out/*.html`. The page should have the original
    styling, the banner and the badge, and contain no `<script>`. The CLI also
    prints the `unchanged` count and the provider-reported cost.
- **Phase 1:** run `wrangler dev` and check:
  - The first load shows the interstitial and finishes within 30 s, and a reload is a
    fast hit.
  - With `DAILY_BUDGET_USD` set to 0.001, the second URL gets the fogged-up page,
    which lists the first page.
  - The wishlist row has its query string stripped.
  - Two simultaneous requests for the same uncached URL cost one rewrite.
  - POST, PUT and DELETE return 405.
  - A redirect to `127.0.0.1` is refused.
