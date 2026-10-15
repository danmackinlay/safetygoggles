// Turn a page into a list of translatable text segments, and put rewritten text back.
//
// A segment is a maximal run of inline content (text plus inline elements such as
// <a>, <em>) inside some block. Inline elements become numbered placeholders:
//
//   We <1>poll</1> the <2>public</2><3/>      (3 is a <br>, or an <img>, or <code>)
//
// The model only ever sees and returns that string. On the way back the placeholders
// are replaced by clones of the *original* elements (attributes and all), and every
// other character becomes a DOM text node. Model output is never parsed as HTML, so a
// page that prompt-injects the model cannot inject markup.

import { parseHTML } from "linkedom";

export interface Segment {
  id: number;
  /** Placeholder-annotated text sent to the model. */
  source: string;
  /** Plain text of the original, for the glossary pass and page context. */
  original: string;
  /** True for h1–h6 text: section boundaries for batching. */
  heading: boolean;
}

export interface ApplyStats {
  applied: number;
  /** Rewrites identical to their source: a high count means the model is only find-and-replacing. */
  unchanged: number;
  /** Rewrites whose placeholder set differed from the source (links may have been lost). */
  placeholderMismatches: number;
}

export interface SegmentedPage {
  segments: Segment[];
  /** True when maxSourceChars cut off part of the page. */
  truncated: boolean;
  /** Write rewrites back into the document. Segments missing from the map keep their original text. */
  apply(rewrites: Map<number, string>): ApplyStats;
}

export interface SanitizeOptions {
  /** Where a same-page link should point. Default: the absolute origin URL. */
  rewriteHref?: (absolute: URL) => string;
}

const INLINE = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT",
  "I", "IMG", "INS", "KBD", "LABEL", "MARK", "PICTURE", "Q", "S", "SAMP", "SMALL", "SOURCE", "SPAN",
  "STRONG", "SUB", "SUP", "SVG", "TIME", "U", "VAR", "WBR", "MATH",
]);
/** Inline elements passed through untouched as a void placeholder (code is not prose). */
const OPAQUE = new Set(["BR", "WBR", "IMG", "PICTURE", "SOURCE", "SVG", "MATH", "CODE", "KBD", "SAMP", "VAR"]);
/** Blocks whose contents are never translated. */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "PRE", "TEXTAREA", "SELECT"]);

const REMOVE_SELECTOR = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "input", "select", "textarea", "base", "meta[http-equiv]", "meta[charset]",
  "link[rel=preload]", "link[rel=modulepreload]", "link[rel=manifest]", "link[rel=serviceworker]",
].join(", ");

const PLACEHOLDER = /<(\/?)(\d+)(\/?)>/g;
const META_TEXT = [
  'meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]',
  'meta[name="twitter:title"]', 'meta[name="twitter:description"]',
].join(", ");

export function parseDocument(html: string): Document {
  // linkedom only serialises <head> and <body> when the source has an <html> element.
  const wrapped = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return parseHTML(wrapped).document as unknown as Document;
}

/**
 * Make the page inert and self-locating: no scripts, forms, frames or event handlers,
 * and a <base href> so stylesheets and images load straight from the origin.
 */
export function sanitize(doc: Document, pageUrl: URL, opts: SanitizeOptions = {}): void {
  const existingBase = doc.querySelector("base[href]")?.getAttribute("href");
  const baseUrl = existingBase ? safeUrl(existingBase, pageUrl) ?? pageUrl : pageUrl;

  for (const el of [...doc.querySelectorAll(REMOVE_SELECTOR)]) el.remove();

  // Unwrap forms rather than delete them: some sites wrap the whole body in one.
  for (const form of [...doc.querySelectorAll("form")]) {
    while (form.firstChild) form.parentNode!.insertBefore(form.firstChild, form);
    form.remove();
  }
  for (const button of doc.querySelectorAll("button")) button.setAttribute("type", "button");

  for (const el of doc.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith("on") || n === "srcdoc" || n === "formaction" || n === "action" || n === "ping") {
        el.removeAttribute(name);
      } else if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        el.removeAttribute(name);
      }
    }
  }

  // Lazy-loaded images rely on the scripts we just removed.
  for (const img of doc.querySelectorAll("img[data-src], img[data-lazy-src]")) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) {
      img.setAttribute("src", img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src")!);
    }
    const srcset = img.getAttribute("data-srcset");
    if (srcset && !img.getAttribute("srcset")) img.setAttribute("srcset", srcset);
  }

  for (const a of doc.querySelectorAll("a[href]")) {
    const abs = safeUrl(a.getAttribute("href")!, baseUrl);
    if (!abs) continue;
    if (abs.protocol === "http:" || abs.protocol === "https:") {
      const samePage = abs.hash && abs.origin === pageUrl.origin && abs.pathname === pageUrl.pathname && abs.search === pageUrl.search;
      a.setAttribute("href", samePage ? abs.hash : opts.rewriteHref ? opts.rewriteHref(abs) : abs.href);
    }
  }

  const head = doc.head;
  const base = doc.createElement("base");
  base.setAttribute("href", baseUrl.href);
  const referrer = doc.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer"); // so hotlink protection doesn't reject our page's asset requests
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  head.insertBefore(referrer, head.firstChild);
  head.insertBefore(base, head.firstChild);
  head.insertBefore(charset, head.firstChild);
}

interface Run {
  kind: "run";
  nodes: ChildNode[];
  els: Element[];
  voids: Set<number>;
  leadingSpace: boolean;
  trailingSpace: boolean;
}
interface AttrTarget {
  kind: "attr";
  el: Element;
  attr: string;
}

export function extractSegments(doc: Document, opts: { maxSourceChars?: number } = {}): SegmentedPage {
  const maxChars = opts.maxSourceChars ?? Infinity;
  const segments: Segment[] = [];
  const targets: (Run | AttrTarget)[] = [];
  let usedChars = 0;
  let truncated = false;

  const add = (source: string, original: string, target: Run | AttrTarget, heading = false) => {
    if (usedChars + source.length > maxChars) {
      truncated = true;
      return;
    }
    usedChars += source.length;
    segments.push({ id: segments.length, source, original, heading });
    targets.push(target);
  };

  for (const el of doc.querySelectorAll(META_TEXT)) {
    const content = el.getAttribute("content")?.trim();
    if (content && hasWords(content)) add(collapse(content), collapse(content), { kind: "attr", el, attr: "content" });
  }

  const inlineCache = new WeakMap<Node, boolean>();
  const isInline = (n: Node): boolean => {
    if (n.nodeType === 3 || n.nodeType === 8) return true;
    if (n.nodeType !== 1) return false;
    const cached = inlineCache.get(n);
    if (cached !== undefined) return cached;
    const tag = (n as Element).tagName.toUpperCase();
    const result = INLINE.has(tag) && (OPAQUE.has(tag) || [...n.childNodes].every(isInline));
    inlineCache.set(n, result);
    return result;
  };

  const emitRun = (nodes: ChildNode[], heading = false) => {
    const els: Element[] = [];
    const voids = new Set<number>();
    const raw = serialize(nodes, els, voids);
    const source = collapse(raw);
    if (!hasWords(source.replace(PLACEHOLDER, " "))) return;
    const original = collapse(nodes.map((n) => (n.nodeType === 8 ? "" : n.textContent ?? "")).join(""));
    add(source, original, { kind: "run", nodes, els, voids, leadingSpace: /^\s/.test(raw), trailingSpace: /\s$/.test(raw) }, heading);
  };

  const visit = (el: Element) => {
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (tag === "HEAD") {
      const title = el.querySelector("title");
      if (title) emitRun([...title.childNodes]);
      return;
    }
    const heading = /^H[1-6]$/.test(tag);
    let run: ChildNode[] = [];
    for (const child of [...el.childNodes]) {
      if (isInline(child)) {
        run.push(child);
        continue;
      }
      if (run.length) emitRun(run, heading);
      run = [];
      if (child.nodeType === 1) visit(child as Element);
    }
    if (run.length) emitRun(run, heading);
  };
  if (doc.documentElement) visit(doc.documentElement);

  const apply = (rewrites: Map<number, string>): ApplyStats => {
    const stats: ApplyStats = { applied: 0, unchanged: 0, placeholderMismatches: 0 };
    for (const seg of segments) {
      const text = rewrites.get(seg.id);
      if (text === undefined) continue;
      if (text.trim() === seg.source) stats.unchanged++;
      const target = targets[seg.id]!;
      if (target.kind === "attr") {
        target.el.setAttribute(target.attr, text.replace(PLACEHOLDER, ""));
        stats.applied++;
        continue;
      }
      if (placeholderSignature(text) !== placeholderSignature(seg.source)) stats.placeholderMismatches++;
      replaceRun(doc, target, text);
      stats.applied++;
    }
    return stats;
  };

  return { segments, truncated, apply };
}

/** Serialise the document for serving. Call this last. */
export function serializeDocument(doc: Document): string {
  // linkedom writes <title> text verbatim, so "</title><script>" in a rewrite would
  // become live markup. Entities are decoded inside <title>, so escaping is lossless.
  for (const title of doc.querySelectorAll("title")) {
    title.textContent = escapeHtml(title.textContent ?? "");
  }
  return doc.toString();
}

function serialize(nodes: Node[], els: Element[], voids: Set<number>): string {
  let out = "";
  for (const n of nodes) {
    if (n.nodeType === 3) {
      out += n.textContent ?? "";
    } else if (n.nodeType === 1) {
      const el = n as Element;
      els.push(el);
      const k = els.length;
      if (OPAQUE.has(el.tagName.toUpperCase()) || !hasWords(el.textContent ?? "")) {
        voids.add(k);
        out += `<${k}/>`;
      } else {
        out += `<${k}>${serialize([...el.childNodes], els, voids)}</${k}>`;
      }
    }
  }
  return out;
}

function replaceRun(doc: Document, run: Run, text: string): void {
  const first = run.nodes[0]!;
  const parent = first.parentNode!;
  const built = build(doc, text.trim(), run);
  if (run.leadingSpace) built.unshift(doc.createTextNode(" "));
  if (run.trailingSpace) built.push(doc.createTextNode(" "));
  for (const n of built) parent.insertBefore(n, first);
  for (const n of run.nodes) n.remove();
}

function build(doc: Document, text: string, run: Run): Node[] {
  const root = doc.createElement("div");
  const stack: { node: Node; k: number }[] = [{ node: root, k: 0 }];
  const top = () => stack[stack.length - 1]!.node;
  const pushText = (s: string) => {
    if (s) top().appendChild(doc.createTextNode(s));
  };
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    pushText(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const k = Number(m[2]);
    const el = run.els[k - 1];
    if (!el) continue; // the model invented a placeholder; drop it
    if (m[1]) {
      const idx = stack.findLastIndex((f) => f.k === k);
      if (idx > 0) stack.length = idx;
      continue;
    }
    if (m[3] || run.voids.has(k)) {
      top().appendChild(el.cloneNode(run.voids.has(k)));
      continue;
    }
    const clone = el.cloneNode(false);
    top().appendChild(clone);
    stack.push({ node: clone, k });
  }
  pushText(text.slice(last));
  return [...root.childNodes];
}

function placeholderSignature(s: string): string {
  return [...s.matchAll(PLACEHOLDER)].map((m) => m[2]).sort().join(",");
}

function hasWords(s: string): boolean {
  return /\p{L}[\s\S]*\p{L}/u.test(s);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeUrl(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
