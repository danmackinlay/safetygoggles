# safetygoggles

Satirical proxy that rewrites any web page as if it were about AI Safety. Design, costs
and the abuse model are in [SPEC.md](SPEC.md); the user-facing story is in [README.md](README.md).
Phase 0 (TS core + Node CLI) is done; Phase 1 (Cloudflare Worker in `src/worker/`) is next.

## Secrets: never read them

- API keys live in `.envrc` (and possibly `.env`). Both are gitignored. **Do not read,
  cat, grep, diff or otherwise open either file**, and never echo or log a key's value.
  `env.example` is the safe template and shows which variables exist.
- Currently the only key is `OPENROUTER_API_KEY`. It is a budget-limited key, but every
  real run still costs money, so prefer `--mock` unless real model output is the point.
- To run something with the secrets loaded, use direnv:
  `direnv exec . npm run goggle -- <url>`.
- If direnv says `.envrc is blocked`, ask Dan to run `direnv allow`. Don't run it
  yourself, because it approves file contents you haven't seen.
- To check whether a variable is set without revealing it, run something like
  `direnv exec . sh -c '[ -n "$OPENROUTER_API_KEY" ] && echo set || echo unset'`.

## Commands

- `npm test`: vitest.
- `npm run typecheck`: the whole project, then `tsconfig.core.json` (Web-only types).
- `npm run goggle -- <url> [--mock]`: writes `out/<slug>.html` and `.json`, and prints
  tokens and cost.
  - With only `OPENROUTER_API_KEY` set, it defaults to OpenRouter with
    `anthropic/claude-haiku-5.5` and reasoning off. This was chosen by a model
    comparison; see SPEC.md.
  - Override with `SG_BASE_URL`, `SG_API_KEY`, `SG_MODEL` and `SG_EXTRA_BODY`.
  - Cost is OpenRouter's reported `usage.cost`, not a local price table.
  - Watch the `unchanged` count. It measures how much the model is merely
    find-and-replacing.
  - Haiku runs report `usage.cost` as $0 on OpenRouter, so their printed cost
    understates real spend.
  - `--out DIR` keeps runs apart when comparing models or prompts.

## Invariants (tests cover these; keep them true)

- **`src/core/` runs unchanged in Node and Cloudflare Workers.** It uses Web-standard
  APIs plus linkedom only. It has no `node:*` imports and no Worker bindings. Adapters
  live in `src/cli/` and `src/worker/`.
- **GET-only.** Upstream fetches are GET with no body, no cookies and manual redirects.
  Every hop is re-checked by the SSRF guard. The proxy will answer only GET and HEAD.
- **Model output is text, never markup.** Rewrites go into DOM text nodes. Placeholders
  `<n>…</n>` and `<n/>` map back only to clones of the original elements.
  - `serializeDocument()` must stay the last step, because linkedom writes `<title>`
    text raw and that function escapes it.
- **Every goggled page carries the banner (attribution and original link), the fixed
  badge, the goggles lens chrome, and `noindex`.** Don't make any of them optional.
  The lens keeps the joke visibly on the AI-safety reader wearing the goggles, not on
  the people in the piece. The page itself
  deliberately doesn't say "satire"; the README does.
- **Goggled pages contain no scripts at all**, ours included, so the Worker can use
  `script-src 'none'`. "Goggles off" is a link to the original.
- **Rewritten bios use invented organisations only.** Never put a real person in a
  real organisation.
- **Wishlist and miss logs:** strip the query string and fragment, and never store raw
  IPs.
- **Don't publish Dan's email.** The opt-out contact is "open an issue".

## Shell

The Bash tool runs zsh. Commands handed to Dan to run must be fish syntax, for example
`env VAR=x cmd` and `set -x`.
