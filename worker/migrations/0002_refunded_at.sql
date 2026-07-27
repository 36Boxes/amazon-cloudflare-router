-- Adds refund state to orders so a cancelled order can be tracked in every
-- daily digest until it is manually marked refunded.
--
-- Also unlocks the account-hold auto-cancel flow, which fires when an
-- "Amazon Account Protection Services" email arrives: every order placed
-- in the last 36 hours that has not already been forwarded is flipped to
-- cancelled. Those cancellations stay visible under "Awaiting refund"
-- forever, exempt from RETENTION_DAYS purge, until the user hits the
-- refund button in the digest or runs `orders refund <#>`.

ALTER TABLE orders ADD COLUMN refunded_at INTEGER;

-- Partial index for the awaiting-refund query, which runs every digest.
CREATE INDEX IF NOT EXISTS idx_orders_awaiting_refund
  ON orders(cancelled_at)
  WHERE cancelled_at IS NOT NULL AND refunded_at IS NULL;

-- Index for "refunded in last 24h" digest lookup.
CREATE INDEX IF NOT EXISTS idx_orders_refunded_at
  ON orders(refunded_at)
  WHERE refunded_at IS NOT NULL;
