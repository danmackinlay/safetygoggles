// Fetch the page we are going to goggle. GET only, no cookies, no client headers,
// redirects followed by hand so that every hop is re-checked.
//
// The host guard only sees hostnames and literal IPs; it cannot catch a public name
// that resolves to a private address. On Cloudflare Workers that case is moot
// (Workers cannot reach private networks), and the Node CLI runs on your own machine.

export class OriginError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason, logged to the wishlist when a miss is refused. */
    readonly reason: "bad-url" | "blocked-host" | "denied" | "http-error" | "not-html" | "too-large" | "too-many-redirects",
  ) {
    super(message);
    this.name = "OriginError";
  }
}

export interface FetchOriginOptions {
  /** Extra veto per hop (opt-out list, login paths…). Return a reason string to refuse. */
  deny?: (url: URL) => string | null;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface OriginPage {
  url: URL;
  html: string;
}

const DEFAULT_UA = "safetygoggles/0.1 (satirical rewriting proxy; +https://github.com/danmackinlay/safetygoggles)";

/** Accept "https://x.org/a", "x.org/a" or "//x.org/a" and return a validated http(s) URL. */
export function parseTargetUrl(input: string): URL {
  let s = input.trim();
  if (s.startsWith("//")) s = "https:" + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new OriginError(`Not a URL: ${input}`, "bad-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OriginError(`Only http(s) URLs can be goggled: ${input}`, "bad-url");
  }
  if (url.username || url.password) {
    throw new OriginError("URLs with credentials are not allowed", "bad-url");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new OriginError(`Port ${url.port} is not allowed`, "blocked-host");
  }
  if (isBlockedHost(url.hostname)) {
    throw new OriginError(`Host ${url.hostname} is not allowed`, "blocked-host");
  }
  url.hash = "";
  return url;
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|internal|lan|home|arpa|test|invalid)$/.test(h)) return true;
  if (h.includes(":")) return isBlockedIPv6(h);
  if (/^[\d.]+$/.test(h)) return isBlockedIPv4(h);
  // Single-label names ("intranet") only resolve on private networks.
  return !h.includes(".");
}

function isBlockedIPv4(h: string): boolean {
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedIPv6(h: string): boolean {
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  // WHATWG URL normalises ::ffff:a.b.c.d to hex form.
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe[89ab])/.test(h);
}

export async function fetchOrigin(target: string | URL, opts: FetchOriginOptions = {}): Promise<OriginPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = typeof target === "string" ? parseTargetUrl(target) : parseTargetUrl(target.href);

  for (let hop = 0; ; hop++) {
    const denied = opts.deny?.(url);
    if (denied) throw new OriginError(`Refused ${url.href}: ${denied}`, "denied");

    const init: RequestInit = {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": opts.userAgent ?? DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "en;q=1.0, *;q=0.5",
      },
    };
    // fetch() throws (rather than returning a status) only on network failure; connections
    // fail transiently often enough that one retry is worth it.
    const res = await doFetch(url.href, init).catch(() => doFetch(url.href, init));

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new OriginError(`Redirect without Location from ${url.href}`, "http-error");
      if (hop >= maxRedirects) throw new OriginError(`Too many redirects from ${target}`, "too-many-redirects");
      url = parseTargetUrl(new URL(location, url).href);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new OriginError(`${url.href} returned HTTP ${res.status}`, "http-error");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(type)) {
      await res.body?.cancel();
      throw new OriginError(`${url.href} is ${type || "an unknown type"}, not HTML`, "not-html");
    }
    const bytes = await readCapped(res, maxBytes);
    return { url, html: decode(bytes, type) };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new OriginError(`Page is ${declared} bytes; the limit is ${maxBytes}`, "too-large");
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OriginError(`Page exceeds ${maxBytes} bytes`, "too-large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    // Sniff <meta charset> in the first 2 KB, which is ASCII-compatible for every charset we care about.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
