// Drop a page's cached copy on the live Worker so its next visit rebuilds it.
//
//   npm run regoggle -- <url>            re-translate (LLM calls, ~1.5¢) and re-render
//   npm run regoggle -- <url> --render   re-render only, from the stored translation (free)
//
// For every page at once: bump CHROME_VERSION (chrome) or the lens version (prompts).
// Uses your wrangler login; the model defaults to MODEL in wrangler.toml.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { aiSafety } from "../../lenses/ai-safety.ts";
import { parseTargetUrl } from "../core/fetchOrigin.ts";
import { pageKey, renderedKey, translationKey } from "../worker/cache.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    render: { type: "boolean", default: false },
    model: { type: "string" },
    site: { type: "string", default: "https://safetygoggles.danmackinlay.workers.dev" },
  },
});
if (!positionals[0]) {
  console.error("usage: npm run regoggle -- <url> [--render] [--model ID]");
  process.exit(2);
}

const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
const model = values.model ?? toml.match(/^MODEL\s*=\s*"([^"]+)"/m)?.[1];
if (!model) throw new Error("No MODEL in wrangler.toml; pass --model");

const url = parseTargetUrl(positionals[0]).href;
const key = await pageKey(url, aiSafety.version, model);
const doomed = values.render ? [renderedKey(key)] : [translationKey(key), renderedKey(key)];

for (const k of doomed) {
  execFileSync("npx", ["wrangler", "kv", "key", "delete", "--binding", "PAGES", "--remote", k], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`deleted ${k}`);
}
console.log(`\n${values.render ? "Re-renders" : "Re-translates"} on the next visit (KV may serve the old copy for up to a minute):`);
console.log(`${values.site}/${url}`);
