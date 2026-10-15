# 🥽 safetygoggles

**Satire.** safetygoggles rewrites any web page as if it were about AI Safety. It
keeps the page's look, its structure and its argument, and changes the subject.

## Why

People working on AI Safety tend not to take seriously the hard-won lessons of people
who have spent decades on other catastrophic risks: climate, nuclear, pandemics.

Take Tom Brookes'
[*Lessons and reflections from 15 years in the climate community*](https://www.greenfunders.org/blog/lessons-and-reflections-from-15-years-in-the-climate-community/).
Its first lesson is "we will not win because we are right". Others: access is not
influence, and plan for your opposition. Every one of those lessons applies to AI
Safety. Most AI Safety readers will never
take it in, because it's "about climate".

So put on the goggles. If the advice reads as obviously right once it's about AI,
maybe it was right all along.

## What you're looking at

A goggled page is a satirical machine rewrite of someone else's work. **The original
author did not write it and may not agree with it.** Every goggled page has:
- a banner saying who originally wrote it and what it was about, with a link to the
  original;
- a fixed **"🥽 safetygoggles · 👓 Goggles off"** badge that takes you to the original;
- "rewritten by machine · not the original" printed along the bottom of the goggles
  frame.

The rewrite may give the author an imaginary AI-safety career. Any organisations in
it are invented.

Pages are not indexed by search engines, cached only briefly, and never monetised.

## Opt-out and takedown

If you own a site and don't want it goggled, open an issue on this repository.
Opt-outs are honoured promptly and cached copies are deleted.

## Status

Trial. Try it at **https://safetygoggles.danmackinlay.workers.dev**: paste a URL, or
put that address in front of any page's address. Pages others have already goggled
are listed at [/directory](https://safetygoggles.danmackinlay.workers.dev/directory).
See [SPEC.md](SPEC.md) for the design, the costs and the abuse safeguards.

**Bookmarklet.** The home page has a drag-to-bookmarks button. GitHub won't render it as
a link, so if you'd rather make it by hand, create a bookmark with this as its URL:

```
javascript:location.href="https://safetygoggles.danmackinlay.workers.dev/"+location.href
```

Logged-in or paywalled pages come out in their logged-out version, because the proxy
fetches pages without your cookies.

## Running the prototype

You need Node 20+ and an [OpenRouter](https://openrouter.ai/) API key. Any other
OpenAI-compatible endpoint also works via `SG_BASE_URL` and `SG_API_KEY`. The default
model, Claude Haiku 5.5, costs about 1.5¢ per long article.

Put the key in an untracked `.envrc` (copy [env.example](env.example)) and load it
with [direnv](https://direnv.net/):

```sh
npm install
cp env.example .envrc        # then edit in your real key; .envrc and .env are gitignored
direnv allow
direnv exec . npm run goggle -- https://www.greenfunders.org/blog/lessons-and-reflections-from-15-years-in-the-climate-community/
open out/*.html
```

If you `cd` into a direnv-enabled shell, the key is already loaded and a plain
`npm run goggle -- <url>` works. Exporting `OPENROUTER_API_KEY` by any other means
works too. The CLI prints the cost OpenRouter reports for the run.

`--mock` runs the whole pipeline with a dumb word swap and no API calls.

| Variable | Default | Meaning |
|---|---|---|
| `SG_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible API root |
| `SG_API_KEY` | `$OPENROUTER_API_KEY` | key for that endpoint |
| `SG_MODEL` | `anthropic/claude-haiku-5.5` | model name (see SPEC.md for the comparison) |
| `SG_EXTRA_BODY` | `{"reasoning":{"enabled":false}}` on OpenRouter | JSON merged into each request |
| `SG_PROXY_BASE` | unset | live proxy root; routes links through it and enables the bookmarklet |

Tests: `npm test`. Type-checks: `npm run typecheck`. The second type-check confirms
that `src/core` uses only Web APIs, so it can run in a Worker.
