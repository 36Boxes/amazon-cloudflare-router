-- Baseline schema for amazon-destination-forwarder.
-- Applied automatically on `wrangler d1 migrations apply`.
-- Mirrors what `schema.sql` used to install directly.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS destinations (
  code          TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_number     TEXT PRIMARY KEY,
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  recipient_name   TEXT,
  product_title    TEXT,
  placed_at        INTEGER NOT NULL,
  tagged_at        INTEGER,
  forwarded_at     INTEGER,
  cancelled_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_dest      ON orders(destination_code);
CREATE INDEX IF NOT EXISTS idx_orders_active    ON orders(cancelled_at) WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS session (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  set_at           INTEGER,
  expires_at       INTEGER
);

INSERT OR IGNORE INTO session (singleton, destination_code, set_at, expires_at)
  VALUES (1, NULL, NULL, NULL);

CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  action        TEXT NOT NULL,
  order_number  TEXT,
  from_dest     TEXT,
  to_dest       TEXT,
  actor         TEXT,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
