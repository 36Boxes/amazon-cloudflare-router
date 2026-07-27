-- Schema for amazon-destination-forwarder.
-- Applied automatically by wrangler D1 migrations from ./migrations/.
--
-- Reference-only:  this file mirrors the full current schema so tooling
-- (linters, DB browsers, code reviewers) can see the whole picture in one
-- place. Production deploys should run:
--
--   npx wrangler d1 migrations apply amazon-destination-forwarder --remote
--
-- and NOT execute this file directly on an existing database — that would
-- skip the migration ledger and could reapply idempotent CREATEs safely
-- but would fail on ALTER-based migrations (like 0002_refunded_at.sql).

PRAGMA foreign_keys = ON;

-- ─── destinations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS destinations (
  code          TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

-- ─── orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  order_number     TEXT PRIMARY KEY,
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  recipient_name   TEXT,
  product_title    TEXT,
  placed_at        INTEGER NOT NULL,
  tagged_at        INTEGER,
  forwarded_at     INTEGER,
  cancelled_at     INTEGER,
  refunded_at      INTEGER, -- added in migration 0002
  account_email    TEXT     -- added in migration 0003: which Amazon inbox this order came in on
);

CREATE INDEX IF NOT EXISTS idx_orders_placed_at     ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_dest          ON orders(destination_code);
CREATE INDEX IF NOT EXISTS idx_orders_account_email ON orders(account_email);
CREATE INDEX IF NOT EXISTS idx_orders_active        ON orders(cancelled_at) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_awaiting_refund
  ON orders(cancelled_at) WHERE cancelled_at IS NOT NULL AND refunded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_refunded_at
  ON orders(refunded_at) WHERE refunded_at IS NOT NULL;

-- ─── session (singleton row) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  set_at           INTEGER,
  expires_at       INTEGER
);

INSERT OR IGNORE INTO session (singleton, destination_code, set_at, expires_at)
  VALUES (1, NULL, NULL, NULL);

-- ─── audit log ────────────────────────────────────────────────
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

