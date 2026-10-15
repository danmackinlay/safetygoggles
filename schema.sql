-- D1 schema. Apply with: npx wrangler d1 execute safetygoggles --file schema.sql [--remote]

-- Money spent per UTC day; the app-level daily budget is checked against this.
CREATE TABLE IF NOT EXISTS budget (
  day TEXT PRIMARY KEY,               -- YYYY-MM-DD, UTC
  spent_usd REAL NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0
);

-- Every page that got goggled; the public /directory lists these.
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,               -- normalised target URL
  host TEXT NOT NULL,
  title TEXT,                         -- original <title>
  source_topic TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0
);

-- Refused or failed misses, for deciding what to allow or fix. Query strings and
-- fragments are stripped before insert; no IPs are stored.
CREATE TABLE IF NOT EXISTS wishlist (
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (url, reason)
);
