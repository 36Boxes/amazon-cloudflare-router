-- 0003_account_email.sql
--
-- Track which Amazon account (i.e. inbox address the message was sent to)
-- each order belongs to. Used by the account-hold handler to scope the
-- bulk-cancel to a single account rather than every recent order across
-- every account.
--
-- Nullable — rows created before this migration will have NULL. The
-- account-hold handler only cancels orders where account_email matches
-- the recipient of the incoming account-hold email, so pre-migration
-- rows are naturally excluded.

ALTER TABLE orders ADD COLUMN account_email TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_account_email
  ON orders(account_email);
