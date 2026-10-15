// url → goggled HTML, in two separable steps:
//
//   translate (expensive: LLM calls) → Translation: original HTML snapshot + glossary +
//                                       rewrites keyed by segment source text
//   render    (cheap: CPU only)      → snapshot + rewrites + the current chrome → HTML
//
// Storing the Translation means chrome changes (banner, lens, tagline; see
// CHROME_VERSION) re-render without touching the model. Rewrites are keyed by source
// text, not segment number, so a change to how pages are segmented can't misplace them:
// a rewrite only lands on the text it was written for.
//
// Shared by the CLI and the Worker; no storage, no runtime APIs.

import type { Lens } from "../../lenses/ai-safety.ts";
import { decorate } from "./decorate.ts";
import { fetchOrigin, type FetchOriginOptions } from "./fetchOrigin.ts";
import type { Glossary, Rewriter, Usage } from "./llm.ts";
import { extractSegments, parseDocument, sanitize, serializeDocument, type ApplyStats } from "./segment.ts";

export interface Translation {
  format: 1;
  /** Final URL after redirects. */
  url: string;
  /** The origin's HTML exactly as fetched. */
  html: string;
  /** The original page's <title>, before rewriting. */
  title: string;
  glossary: Glossary;
  /** Rewritten text by segment source (placeholder-annotated). */
  rewrites: Record<string, string>;
  /** maxSourceChars cut the page short; the rest stays original. */
  truncated: boolean;
  /** Segments sent to the model, and how many came back rewritten. */
  segments: number;
  rewritten: number;
  model: string;
  lensVersion: string;
  usage: Usage;
  createdAt: string;
}

export interface TranslateOptions {
  lens: Lens;
  rewriter: Rewriter;
  /** Cap on segment source characters sent to the model (~4 chars per token). */
  maxSourceChars?: number;
  /** Characters of page text given to the glossary pass. */
  glossaryChars?: number;
  fetch?: FetchOriginOptions;
}

export interface RenderOptions {
  lens: Lens;
  readmeUrl: string;
  /** Live proxy root ("https://goggles.example/"). Links, the bookmarklet and the home link use it; null keeps links pointing at the origin. */
  proxyBase?: string | null;
}

export interface RenderResult {
  html: string;
  stats: ApplyStats & { segments: number; rewritten: number; truncated: boolean };
}

export async function translateUrl(url: string, opts: TranslateOptions): Promise<Translation> {
  const page = await fetchOrigin(url, opts.fetch);
  return translateHtml(page.html, page.url, opts);
}

export async function translateHtml(html: string, pageUrl: URL, opts: TranslateOptions): Promise<Translation> {
  const { lens, rewriter } = opts;
  const doc = parseDocument(html);
  sanitize(doc, pageUrl); // link targets don't affect segment text
  const page = extractSegments(doc, { maxSourceChars: opts.maxSourceChars ?? 32_000 });

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const text = page.segments.map((s) => s.original).join("\n").slice(0, opts.glossaryChars ?? 24_000);
  const glossary = await rewriter.glossary({ url: pageUrl.href, title, text }, lens);
  const byId = await rewriter.rewrite(page.segments, glossary, lens);

  const rewrites: Record<string, string> = {};
  for (const s of page.segments) {
    const text = byId.get(s.id);
    if (text !== undefined) rewrites[s.source] = text;
  }
  return {
    format: 1,
    url: pageUrl.href,
    html,
    title,
    glossary,
    rewrites,
    truncated: page.truncated,
    segments: page.segments.length,
    rewritten: byId.size,
    model: rewriter.model,
    lensVersion: lens.version,
    usage: rewriter.usage,
    createdAt: new Date().toISOString(),
  };
}

export function renderTranslation(t: Translation, opts: RenderOptions): RenderResult {
  const proxyBase = opts.proxyBase ?? null;
  const pageUrl = new URL(t.url);
  const doc = parseDocument(t.html);
  sanitize(doc, pageUrl, proxyBase ? { rewriteHref: (abs) => proxyBase + abs.href } : {});
  const page = extractSegments(doc);

  const byId = new Map<number, string>();
  for (const s of page.segments) {
    const text = Object.hasOwn(t.rewrites, s.source) ? t.rewrites[s.source] : undefined;
    if (text !== undefined) byId.set(s.id, text);
  }
  const applied = page.apply(byId);
  decorate(doc, { lens: opts.lens, glossary: t.glossary, originalUrl: t.url, readmeUrl: opts.readmeUrl, proxyBase, truncated: t.truncated });
  return {
    html: serializeDocument(doc),
    stats: { ...applied, segments: page.segments.length, rewritten: byId.size, truncated: t.truncated },
  };
}

export type TransmuteOptions = TranslateOptions & RenderOptions;

export interface TransmuteResult extends RenderResult {
  translation: Translation;
  finalUrl: string;
  title: string;
  glossary: Glossary;
  usage: Usage;
}

/** Translate and render in one go (the CLI's path). */
export async function transmuteUrl(url: string, opts: TransmuteOptions): Promise<TransmuteResult> {
  const page = await fetchOrigin(url, opts.fetch);
  return transmuteHtml(page.html, page.url, opts);
}

export async function transmuteHtml(html: string, pageUrl: URL, opts: TransmuteOptions): Promise<TransmuteResult> {
  const translation = await translateHtml(html, pageUrl, opts);
  const rendered = renderTranslation(translation, opts);
  return {
    ...rendered,
    translation,
    finalUrl: translation.url,
    title: translation.title,
    glossary: translation.glossary,
    usage: translation.usage,
  };
}
