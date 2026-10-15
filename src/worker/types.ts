// The slices of the Workers runtime we use, declared here rather than pulling in
// @cloudflare/workers-types (which fights the DOM lib the core is checked against).
// Tests implement these with a Map and node:sqlite.

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1 {
  prepare(sql: string): D1Statement;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  MODEL: string;
  DAILY_BUDGET_USD: string;
  README_URL: string;
  OPENROUTER_API_KEY?: string;
  /** Webhook for "out of money" alerts (ntfy topic URL, Slack or Discord webhook). Secret. */
  NOTIFY_URL?: string;
  PAGES: KV;
  DB: D1;
}
