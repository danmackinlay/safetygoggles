// What we add to a goggled page: a banner with attribution and a link to the original,
// a fixed badge whose "goggles off" button is just that link again, and a safety-goggles
// lens framing the viewport so the joke is visibly on the wearer, not on the page.
// No scripts, so the Worker can serve pages under `script-src 'none'`.
// Built with DOM calls, not HTML strings, because the author name and topic come from the model.

import type { Lens } from "../../lenses/ai-safety.ts";
import type { Glossary } from "./llm.ts";

export interface DecorateOptions {
  lens: Lens;
  glossary: Glossary;
  originalUrl: string;
  readmeUrl: string;
  /** Live proxy root such as "https://goggles.example/". Enables the bookmarklet. */
  proxyBase: string | null;
  truncated: boolean;
}

export function decorate(doc: Document, o: DecorateOptions): void {
  const h = (tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const c of children) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
    return el;
  };
  const link = (href: string, text: string, attrs: Record<string, string> = {}) => h("a", { href, ...attrs }, text);
  const { author, sourceTopic } = o.glossary;

  doc.head.appendChild(h("meta", { name: "robots", content: "noindex, nofollow, noarchive" }));
  const style = h("style", { id: "sg-style" });
  style.textContent = CSS;
  doc.head.appendChild(style);

  const banner = h(
    "div",
    { id: "sg-banner", role: "note" },
    h("strong", {}, `🥽 ${o.lens.tagline}`),
    ` This page was originally ${author ? `written by ${author} ` : ""}about ${sourceTopic}; safetygoggles rewrote it.`,
    ...(o.truncated ? [" The goggles ran out of lens partway down, so the rest is unaltered."] : []),
    " ",
    link(o.originalUrl, "Read the original"),
    " · ",
    link(o.readmeUrl, "What is this?"),
    ...(o.proxyBase
      ? [
          " · ",
          link(`javascript:location.href=${JSON.stringify(o.proxyBase)}+location.href`, "🥽 Safety-goggle this", {
            class: "sg-bookmarklet",
            title: "Drag to your bookmarks bar, then click it on any page",
          }),
        ]
      : []),
  );
  const badge = h("div", { id: "sg-badge" }, "🥽 safetygoggles ", link(o.originalUrl, "👓 Goggles off"));

  const lens = h("div", { id: "sg-lens", "aria-hidden": "true" });

  doc.body.insertBefore(banner, doc.body.firstChild);
  doc.body.appendChild(badge);
  doc.body.appendChild(lens);
}

const CSS = `
#sg-banner, #sg-banner *, #sg-badge, #sg-badge * { all: revert; box-sizing: border-box; }
#sg-banner { display: block; position: relative; z-index: 2147483646; margin: 0; padding: 10px 16px;
  background: #1f2328; color: #fff8c5; /* the frame's colour: at the top it reads as the goggles' band */
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left; }
#sg-banner a { color: #ffd84d; text-decoration: underline; }
#sg-banner .sg-bookmarklet { padding: 1px 8px; border: 2px dashed #ffd84d; border-radius: 6px; text-decoration: none; cursor: grab; white-space: nowrap; }
#sg-badge { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; padding: 6px 12px; border-radius: 999px;
  background: #1f2328; color: #fff8c5; font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 2px 8px rgba(0,0,0,.3); }
#sg-badge a { color: #fff8c5; margin-left: 6px; }
/* One wraparound lens: everything outside a rounded rectangle is frame, with a strap
   stub on each side, an amber tint and a glare highlight. Purely decorative. */
#sg-lens { position: fixed; inset: 10px; z-index: 2147483645; pointer-events: none; border-radius: 56px / 44px;
  box-shadow: 0 0 0 100vmax rgba(31,35,40,.92), inset 0 0 0 3px #1f2328, inset 0 0 36px 10px rgba(255,190,40,.28);
  background: linear-gradient(125deg, rgba(255,255,255,.16), rgba(255,255,255,0) 22%), rgba(255,214,0,.035); }
#sg-lens::before, #sg-lens::after { content: ""; position: absolute; top: calc(50% - 28px); width: 14px; height: 56px;
  background: #3a3f47; border-radius: 4px; }
#sg-lens::before { left: -12px; }
#sg-lens::after { right: -12px; }
@media print { #sg-lens { display: none; } }
`;
