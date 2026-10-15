// url → goggled HTML. Shared by the CLI and (later) the Worker; no storage, no runtime APIs.

import type { Lens } from "../../lenses/ai-safety.ts";
import { decorate } from "./decorate.ts";
import { fetchOrigin, type FetchOriginOptions } from "./fetchOrigin.ts";
import type { Glossary, Rewriter, Usage } from "./llm.ts";
import { extractSegments, parseDocument, sanitize, serializeDocument, type ApplyStats } from "./segment.ts";

export interface TransmuteOptions {
  lens: Lens;
  rewriter: Rewriter;
  readmeUrl: string;
  /** Live proxy root ("https://goggles.example/"). Links and the bookmarklet go through it; null keeps links pointing at the origin. */
  proxyBase?: string | null;
  /** Cap on segment source characters sent to the model (~4 chars per token). */
  maxSourceChars?: number;
  /** Characters of page text given to the glossary pass. */
  glossaryChars?: number;
  fetch?: FetchOriginOptions;
}

export interface TransmuteResult {
  html: string;
  finalUrl: string;
  glossary: Glossary;
  usage: Usage;
  stats: ApplyStats & { segments: number; rewritten: number; truncated: boolean };
}

export async function transmuteUrl(url: string, opts: TransmuteOptions): Promise<TransmuteResult> {
  const page = await fetchOrigin(url, opts.fetch);
  return transmuteHtml(page.html, page.url, opts);
}

export async function transmuteHtml(html: string, pageUrl: URL, opts: TransmuteOptions): Promise<TransmuteResult> {
  const { lens, rewriter } = opts;
  const proxyBase = opts.proxyBase ?? null;
  const doc = parseDocument(html);

  sanitize(doc, pageUrl, proxyBase ? { rewriteHref: (abs) => proxyBase + abs.href } : {});

  const page = extractSegments(doc, { maxSourceChars: opts.maxSourceChars ?? 32_000 });
  const truncated = page.truncated;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const text = page.segments.map((s) => s.original).join("\n").slice(0, opts.glossaryChars ?? 24_000);
  const glossary = await rewriter.glossary({ url: pageUrl.href, title, text }, lens);
  const rewrites = await rewriter.rewrite(page.segments, glossary, lens);
  const applied = page.apply(rewrites);

  decorate(doc, { lens, glossary, originalUrl: pageUrl.href, readmeUrl: opts.readmeUrl, proxyBase, truncated });

  return {
    html: serializeDocument(doc),
    finalUrl: pageUrl.href,
    glossary,
    usage: rewriter.usage,
    stats: { ...applied, segments: page.segments.length, rewritten: rewrites.size, truncated },
  };
}
