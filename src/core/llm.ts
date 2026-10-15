// The two LLM passes: one call to build a page-specific glossary, then the segments in
// parallel batches. The client speaks the OpenAI chat-completions dialect over plain
// fetch (no SDK), so it runs anywhere; OpenRouter is the default endpoint.

import type { Lens } from "../../lenses/ai-safety.ts";
import type { Segment } from "./segment.ts";

export interface Analogy {
  from: string;
  to: string;
}

export interface Glossary {
  /** What the page was originally about, as a short noun phrase ("climate change"). */
  sourceTopic: string;
  mappings: Analogy[];
  /** One paragraph describing who the rewritten author is and what they argue. */
  frame: string;
  /** The page's byline, if any, for the attribution line. */
  author: string | null;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * USD actually spent, as reported by OpenRouter: its own charge plus, for BYOK requests,
   * the upstream provider's charge to your key. Null if never reported.
   */
  costUsd: number | null;
}

export interface Rewriter {
  readonly model: string;
  glossary(input: { url: string; title: string; text: string }, lens: Lens): Promise<Glossary>;
  /** Returns rewritten source strings by segment id; ids the model dropped are simply absent. */
  rewrite(segments: Segment[], glossary: Glossary, lens: Lens): Promise<Map<number, string>>;
  readonly usage: Usage;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Merged into every request body (e.g. OpenRouter's {"reasoning":{"enabled":false}}). */
  extraBody?: Record<string, unknown>;
  concurrency?: number;
  /** Approximate characters of segment source per rewrite call. */
  batchChars?: number;
  /** Characters of original page text every rewrite call sees as context. */
  contextChars?: number;
  fetchImpl?: typeof fetch;
}

export function emptyUsage(): Usage {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: null };
}

// ---------------------------------------------------------------------------
// Prompts. The lens primer goes first so that every rewrite batch shares a long,
// identical prefix, which providers bill at the cached-input rate.

function glossaryPrompt(lens: Lens): string {
  const t = lens.target;
  return [
    `You are planning a rewrite of a web page so that it reads as if it had always been about ${t}: same author, same argument, same structure and voice, but set in the ${t} world.`,
    ``,
    `Background on that world:`,
    lens.primer,
    ``,
    `Read the page, work out what it is really about, and design the analogy map.`,
    `- Map every proper noun that belongs to the source world (organisations, programmes, reports, events, named models or frameworks) to a specific counterpart. Use a real ${t} institution only when it genuinely plays that role; otherwise invent a specific, plausible name of your own, never a generic description such as "an AI safety foundation".`,
    `- Also map the page's key concepts, jargon and examples, not just its headline topic.`,
    `- Dates on the page stay as they are: choose analogues that existed or happened around those dates.`,
    `- The author keeps their name, but their own career may be recast as a ${t} career. Any organisation in that career must be an invented one: never place a real person in a real organisation they were not part of.`,
    `- The website's own name and brand (see the URL and title) stay as they are and do not appear in the mappings.`,
    ``,
    `Reply with JSON only, in this shape:`,
    `{"source_topic": "short noun phrase for what the page is originally about",`,
    ` "author": "the byline's name if the page states one, else null",`,
    ` "frame": "one paragraph: who the rewritten author is in the ${t} world, a career arc consistent with the page's dates, and what they argue",`,
    ` "mappings": [{"from": "term, name or concept on the page", "to": "its ${t} counterpart"}]}`,
    `Each "to" is just the counterpart, with no commentary or alternatives. Give 10 to 30 mappings, most important first. If the page is already about ${t}, map it onto itself and say so in the frame.`,
  ].join("\n");
}

function rewritePrompt(lens: Lens, g: Glossary, pageText: string): string {
  const t = lens.target;
  return [
    `You rewrite web pages as if their author had spent their career in ${t} rather than in whatever the page is about. Rewrite, don't substitute: a reader from the ${t} community should find every paragraph native to their world, with no leftover traces of the original subject.`,
    ``,
    `Background on the ${t} world:`,
    lens.primer,
    ``,
    `Rules:`,
    `- You receive JSON {"segments": [{"id": number, "text": string}]}; each segment is one paragraph, heading, list item, link label or similar piece of the page. Return JSON {"segments": [{"id": number, "text": string}]} with every id, in the same order.`,
    `- Segments contain numbered tags such as <1>…</1> and <2/>. They stand for links, emphasis, images and line breaks. Keep every tag, with the same number, around the corresponding words of your rewrite. Do not add new tags or any other markup.`,
    `- When an example, anecdote or named thing only makes sense in the original subject, replace it with a ${t} example that makes the same point: use the glossary, or invent something specific and plausible that is consistent with it. Never leave such a reference untranslated, and never retreat to vague phrases like "a relevant initiative".`,
    `- Keep the page's dates, and keep every dated claim consistent with the timeline in the background.`,
    `- Write in the community's own voice, at the flavour shown in the calibration examples: most paragraphs of body prose should carry at least one touch of it (a community idiom, a concrete ${t} example, an in-group reference), even when their argument transfers unchanged.`,
    `- Biographies and author boxes count too: recast the author's source-field roles and affiliations as ${t} ones, using invented organisations only (never put a real person in a real organisation).`,
    `- Keep each segment's role and roughly its length (within about 30%): headings stay heading-length, menu labels stay short labels.`,
    `- Leave unchanged only what has nothing to do with the subject: dates, people's names, "Read more", "Contact", legal and copyright lines, and the website's own name and brand, even in the page title.`,
    `- Never invent statistics, or quotes attributed to real, named people other than the author.`,
    `- You are given one section at a time. The full original page follows for context only; rewrite just the segments you receive.`,
    ``,
    `The original page:`,
    `<<<`,
    pageText,
    `>>>`,
    ``,
    `This page was originally about ${g.sourceTopic}.`,
    `Frame: ${g.frame}`,
    ``,
    `Glossary for this page (apply consistently):`,
    ...g.mappings.map((m) => `- ${m.from} → ${m.to}`),
  ].join("\n");
}

function exemplarPrompt(leadText: string): string {
  return [
    ``,
    `An earlier section of this page has already been rewritten. Match its voice and flavour, and reuse any names it introduced:`,
    `<<<`,
    leadText,
    `>>>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// OpenAI-compatible implementation

export function openAiRewriter(cfg: LlmConfig): Rewriter {
  const doFetch = cfg.fetchImpl ?? fetch;
  const concurrency = cfg.concurrency ?? 8;
  const batchChars = cfg.batchChars ?? 5000;
  const usage = emptyUsage();

  async function chatJson(system: string, user: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      try {
        const res = await doFetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
            temperature: 0.7,
            ...cfg.extraBody,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          lastError = new Error(`LLM HTTP ${res.status}: ${body.slice(0, 500)}`);
          if (res.status === 429 || res.status >= 500) continue;
          throw lastError;
        }
        const data = (await res.json()) as ChatResponse;
        recordUsage(usage, data.usage);
        const content = data.choices?.[0]?.message?.content ?? "";
        return JSON.parse(stripFences(content));
      } catch (e) {
        lastError = e;
        if (e instanceof SyntaxError) continue; // malformed JSON from the model; try again
        if (e instanceof Error && e.message.startsWith("LLM HTTP 4")) throw e;
      }
    }
    throw lastError;
  }

  return {
    model: cfg.model,
    usage,

    async glossary(input, lens) {
      const raw = (await chatJson(
        glossaryPrompt(lens),
        `URL: ${input.url}\nTitle: ${input.title}\n\n${input.text}`,
      )) as Partial<{ source_topic: string; mappings: Analogy[]; frame: string; author: string | null }>;
      return {
        sourceTopic: raw.source_topic?.trim() || "something else entirely",
        mappings: (raw.mappings ?? []).filter((m) => m && typeof m.from === "string" && typeof m.to === "string").slice(0, 25),
        frame: raw.frame?.trim() || "",
        author: typeof raw.author === "string" && raw.author.trim() && raw.author !== "null" ? raw.author.trim() : null,
      };
    },

    // Two waves: the lead section alone, then every other section in parallel with the
    // lead's rewrite in the prompt as a voice and naming exemplar. All calls share the
    // primer, rules, original page and glossary as one cacheable prefix.
    async rewrite(segments, glossary, lens) {
      const pageText = segments.map((s) => s.original).join("\n").slice(0, cfg.contextChars ?? 24_000);
      let system = rewritePrompt(lens, glossary, pageText);
      const out = new Map<number, string>();
      if (!segments.length) return out;
      const runBatch = async (batch: Segment[]) => {
        const raw = (await chatJson(
          system,
          JSON.stringify({ segments: batch.map((s) => ({ id: s.id, text: s.source })) }),
        )) as { segments?: { id: unknown; text: unknown }[] };
        const wanted = new Set(batch.map((s) => s.id));
        for (const item of raw.segments ?? []) {
          const id = Number(item.id);
          if (wanted.has(id) && typeof item.text === "string") out.set(id, item.text);
        }
      };

      const batches = makeSectionBatches(segments, batchChars);
      const leadIndex = Math.max(0, batches.findIndex((b) => b.some((s) => !s.heading && s.source.length >= 200)));
      const lead = batches[leadIndex] ?? [];
      await runBatch(lead).catch(() => undefined);
      const leadText = lead.flatMap((s) => out.get(s.id) ?? []).map((t) => t.replace(/<\/?\d+\/?>/g, "")).join("\n");
      if (leadText) system += exemplarPrompt(leadText);
      await pool(batches.filter((_, i) => i !== leadIndex), concurrency, (b) => runBatch(b).catch(() => undefined));
      // One retry, in small batches, for whatever went missing.
      const missing = segments.filter((s) => !out.has(s.id));
      if (missing.length) {
        await pool(makeBatches(missing, Math.ceil(batchChars / 2)), concurrency, (b) => runBatch(b).catch(() => undefined));
      }
      return out;
    },
  };
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number; // DeepSeek
    prompt_tokens_details?: { cached_tokens?: number }; // OpenAI / OpenRouter
    cost?: number; // OpenRouter credits charged, USD (0 for BYOK under the fee allowance)
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: number | null }; // what the BYOK provider billed
  };
}

function recordUsage(u: Usage, r: ChatResponse["usage"]): void {
  u.calls++;
  u.inputTokens += r?.prompt_tokens ?? 0;
  u.outputTokens += r?.completion_tokens ?? 0;
  u.cachedInputTokens += r?.prompt_cache_hit_tokens ?? r?.prompt_tokens_details?.cached_tokens ?? 0;
  const upstream = r?.is_byok ? (r.cost_details?.upstream_inference_cost ?? 0) : 0;
  if (typeof r?.cost === "number") u.costUsd = (u.costUsd ?? 0) + r.cost + upstream;
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

/** Batch whole sections (split at headings), merging small ones and splitting oversized ones. */
export function makeSectionBatches(segments: Segment[], maxChars: number): Segment[][] {
  const sections: Segment[][] = [];
  for (const s of segments) {
    if (s.heading || !sections.length) sections.push([]);
    sections[sections.length - 1]!.push(s);
  }
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let size = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    size = 0;
  };
  for (const section of sections) {
    const length = section.reduce((n, s) => n + s.source.length, 0);
    if (length > maxChars) {
      flush();
      batches.push(...makeBatches(section, maxChars));
      continue;
    }
    if (size + length > maxChars) flush();
    current.push(...section);
    size += length;
  }
  flush();
  return batches;
}

export function makeBatches(segments: Segment[], maxChars: number): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    if (current.length && size + s.source.length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += s.source.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Mock implementation: no network, deterministic. Lets the plumbing be tested and
// demoed without an API key; the output is a dumb word swap, not the real thing.

export function mockRewriter(): Rewriter {
  const usage = emptyUsage();
  const swaps: [RegExp, string][] = [
    [/\bclimate crisis\b/gi, "AI risk crisis"],
    [/\bclimate change\b/gi, "AI risk"],
    [/\bclimate\b/gi, "AI safety"],
    [/\bfossil fuels?\b/gi, "frontier AI"],
    [/\bpolluting corporations\b/gi, "frontier labs"],
    [/\bcoal[- ]fired power stations\b/gi, "gigawatt datacentres"],
    [/\bemissions\b/gi, "capability gains"],
    [/\blow-carbon\b/gi, "safe-AI"],
  ];
  return {
    model: "mock",
    usage,
    async glossary() {
      return {
        sourceTopic: "climate change",
        mappings: [
          { from: "climate", to: "AI safety" },
          { from: "fossil fuel companies", to: "frontier AI labs" },
        ],
        frame: "Mock glossary: no model was called.",
        author: null,
      };
    },
    async rewrite(segments) {
      const out = new Map<number, string>();
      for (const s of segments) out.set(s.id, swaps.reduce((t, [re, to]) => t.replace(re, to), s.source));
      return out;
    },
  };
}
