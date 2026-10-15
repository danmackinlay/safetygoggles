// Phase 0 CLI: goggle one URL and write the result to out/<slug>.html.
//
//   npx tsx src/cli/transmute.ts <url> [--mock] [--out DIR]
//
// Env: OPENROUTER_API_KEY (or SG_API_KEY for another endpoint), SG_BASE_URL, SG_MODEL,
// SG_EXTRA_BODY (JSON), SG_PROXY_BASE, SG_README_URL.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { aiSafety } from "../../lenses/ai-safety.ts";
import { mockRewriter, openAiRewriter, type Rewriter } from "../core/llm.ts";
import { transmuteUrl } from "../core/transmute.ts";

const README_URL = "https://github.com/danmackinlay/safetygoggles#readme";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: "boolean", default: false },
    out: { type: "string", default: "out" },
  },
});
const url = positionals[0];
if (!url) {
  console.error("usage: npx tsx src/cli/transmute.ts <url> [--mock] [--out DIR]");
  process.exit(2);
}

const env = process.env;
let rewriter: Rewriter;
if (values.mock) {
  rewriter = mockRewriter();
} else {
  const apiKey = env.SG_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("No API key: set OPENROUTER_API_KEY (e.g. via `direnv exec .`), or pass --mock.");
    process.exit(2);
  }
  const baseUrl = env.SG_BASE_URL ?? "https://openrouter.ai/api/v1";
  // Reasoning is slow and pointless for rewriting; this is OpenRouter's spelling of "off".
  const extraBody = env.SG_EXTRA_BODY
    ? JSON.parse(env.SG_EXTRA_BODY)
    : baseUrl.includes("openrouter.ai")
      ? { reasoning: { enabled: false } }
      : undefined;
  rewriter = openAiRewriter({ baseUrl, apiKey, model: env.SG_MODEL ?? "anthropic/claude-haiku-5.5", extraBody });
}

const started = Date.now();
const result = await transmuteUrl(url, {
  lens: aiSafety,
  rewriter,
  readmeUrl: env.SG_README_URL ?? README_URL,
  proxyBase: env.SG_PROXY_BASE ?? null,
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const final = new URL(result.finalUrl);
const slug = `${final.hostname}${final.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 100);
await mkdir(values.out!, { recursive: true });
const htmlPath = join(values.out!, `${slug}.html`);
await writeFile(htmlPath, result.html);
await writeFile(
  join(values.out!, `${slug}.json`),
  JSON.stringify({ model: rewriter.model, lens: aiSafety.version, seconds: Number(seconds), ...result }, (k, v) => (k === "html" ? undefined : v), 2),
);

const { stats, usage, glossary } = result;
const cost = usage.costUsd === null ? "cost not reported" : `$${usage.costUsd.toFixed(4)}`;
console.log(`🥽 ${result.finalUrl}`);
console.log(`   was about: ${glossary.sourceTopic}${glossary.author ? ` (by ${glossary.author})` : ""}`);
console.log(`   segments:  ${stats.rewritten}/${stats.segments} rewritten, ${stats.unchanged} unchanged, ${stats.placeholderMismatches} placeholder mismatches${stats.truncated ? ", TRUNCATED" : ""}`);
console.log(`   model:     ${rewriter.model}, ${usage.calls} calls in ${seconds}s`);
console.log(`   tokens:    ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out, ${cost}`);
console.log(`   wrote:     ${htmlPath}`);
