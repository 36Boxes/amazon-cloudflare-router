/**
 * Thin wrapper over D1 queries. Every DB access in the Worker goes through
 * one of these functions so schema changes and query tweaks live in one file.
 */

import { AuditAction, AuditOptions, Destination, Order, Session } from "./types";

// ─── session ────────────────────────────────────────────────────

export async function getSession(db: D1Database): Promise<Session | null> {
  const row = await db
    .prepare("SELECT * FROM session WHERE singleton = 1")
    .first<Session>();
  return row ?? null;
}

export async function setSession(
  db: D1Database,
  code: string | null,
  expiresAt: number | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session (singleton, destination_code, set_at, expires_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         destination_code = excluded.destination_code,
         set_at           = excluded.set_at,
         expires_at       = excluded.expires_at`
    )
    .bind(code, code ? Date.now() : null, expiresAt)
    .run();
}

/** Returns the active destination code, or null if none / expired. Auto-clears expired sessions. */
export async function getActiveSessionCode(db: D1Database): Promise<string | null> {
  const s = await getSession(db);
  if (!s || !s.destination_code) return null;
  if (s.expires_at && Date.now() > s.expires_at) {
    await setSession(db, null, null);
    return null;
  }
  return s.destination_code;
}

// ─── destinations ───────────────────────────────────────────────

export async function getDestination(
  db: D1Database,
  code: string
): Promise<Destination | null> {
  return await db
    .prepare("SELECT * FROM destinations WHERE code = ?")
    .bind(code)
    .first<Destination>();
}

export async function listDestinations(db: D1Database): Promise<Destination[]> {
  const res = await db.prepare("SELECT * FROM destinations ORDER BY code").all<Destination>();
  return res.results ?? [];
}

export async function addDestination(
  db: D1Database,
  code: string,
  email: string,
  displayName: string | null
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO destinations (code, email, display_name, created_at) VALUES (?, ?, ?, ?)"
    )
    .bind(code, email, displayName, Date.now())
    .run();
}

export async function removeDestination(db: D1Database, code: string): Promise<void> {
  await db.prepare("DELETE FROM destinations WHERE code = ?").bind(code).run();
}

// ─── orders ─────────────────────────────────────────────────────

export async function insertOrder(
  db: D1Database,
  orderNumber: string,
  destCode: string | null,
  recipientName: string | null,
  productTitle: string | null,
  accountEmail: string | null = null
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO orders (order_number, destination_code, recipient_name,
                           product_title, placed_at, tagged_at, account_email)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_number) DO NOTHING`
    )
    .bind(
      orderNumber,
      destCode,
      recipientName,
      productTitle,
      now,
      destCode ? now : null,
      accountEmail
    )
    .run();
}

export async function getOrder(db: D1Database, orderNumber: string): Promise<Order | null> {
  return await db
    .prepare("SELECT * FROM orders WHERE order_number = ?")
    .bind(orderNumber)
    .first<Order>();
}

export async function updateOrderDestination(
  db: D1Database,
  orderNumber: string,
  destCode: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE orders SET destination_code = ?, tagged_at = ? WHERE order_number = ?"
    )
    .bind(destCode, Date.now(), orderNumber)
    .run();
}

export async function clearOrderDestination(
  db: D1Database,
  orderNumber: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE orders SET destination_code = NULL, tagged_at = NULL WHERE order_number = ?"
    )
    .bind(orderNumber)
    .run();
}

export async function markOrderForwarded(
  db: D1Database,
  orderNumber: string
): Promise<void> {
  await db
    .prepare("UPDATE orders SET forwarded_at = ? WHERE order_number = ?")
    .bind(Date.now(), orderNumber)
    .run();
}

export async function markOrderCancelled(
  db: D1Database,
  orderNumber: string
): Promise<void> {
  await db
    .prepare("UPDATE orders SET cancelled_at = ? WHERE order_number = ?")
    .bind(Date.now(), orderNumber)
    .run();
}

/** Clear cancelled_at (used to undo a false-positive bulk cancel). */
export async function clearOrderCancelled(
  db: D1Database,
  orderNumber: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE orders SET cancelled_at = NULL, refunded_at = NULL WHERE order_number = ?"
    )
    .bind(orderNumber)
    .run();
}

/** Mark an order refunded. No-op if the order isn't cancelled or is already refunded. */
export async function markOrderRefunded(
  db: D1Database,
  orderNumber: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE orders SET refunded_at = ?
       WHERE order_number = ? AND cancelled_at IS NOT NULL AND refunded_at IS NULL`
    )
    .bind(Date.now(), orderNumber)
    .run();
  return ((res.meta as { changes?: number })?.changes ?? 0) > 0;
}

/**
 * Auto-cancel every order for a given Amazon account (i.e. every order
 * received on the given inbox address) placed within the last `windowMs`
 * that has not already been forwarded (delivered) and is not already
 * cancelled. Called from the account-hold email handler with the
 * recipient address of the incoming hold email — this scopes the
 * bulk-cancel to only the account that received the hold notice.
 *
 * `accountEmail` is matched case-insensitively (LOWER on both sides) so
 * that display-cased vs canonical-cased addresses agree. Returns the
 * flipped rows so the caller can audit-log each one individually.
 */
export async function bulkCancelUnforwardedForAccount(
  db: D1Database,
  accountEmail: string,
  windowMs: number
): Promise<{ order_number: string; destination_code: string | null }[]> {
  const now = Date.now();
  const cutoff = now - windowMs;
  const res = await db
    .prepare(
      `UPDATE orders
         SET cancelled_at = ?
       WHERE cancelled_at IS NULL
         AND forwarded_at IS NULL
         AND placed_at   >= ?
         AND LOWER(account_email) = LOWER(?)
       RETURNING order_number, destination_code`
    )
    .bind(now, cutoff, accountEmail)
    .all<{ order_number: string; destination_code: string | null }>();
  return res.results ?? [];
}

export interface ListOrdersOptions {
  since?: number;
  destCode?: string;
  untaggedOnly?: boolean;
  limit?: number;
}

export async function listOrders(
  db: D1Database,
  opts: ListOrdersOptions
): Promise<Order[]> {
  const conds: string[] = ["cancelled_at IS NULL"];
  const binds: unknown[] = [];

  if (opts.since !== undefined) {
    conds.push("placed_at >= ?");
    binds.push(opts.since);
  }
  if (opts.destCode) {
    conds.push("destination_code = ?");
    binds.push(opts.destCode);
  }
  if (opts.untaggedOnly) {
    conds.push("destination_code IS NULL");
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const q = `SELECT * FROM orders WHERE ${conds.join(" AND ")} ORDER BY placed_at DESC LIMIT ${limit}`;
  const res = await db.prepare(q).bind(...binds).all<Order>();
  return res.results ?? [];
}

export async function listOrdersCancelledSince(
  db: D1Database,
  since: number,
  limit = 200
): Promise<Order[]> {
  const res = await db
    .prepare("SELECT * FROM orders WHERE cancelled_at >= ? ORDER BY cancelled_at DESC LIMIT ?")
    .bind(since, limit)
    .all<Order>();
  return res.results ?? [];
}

export async function listOrdersForwardedSince(
  db: D1Database,
  since: number,
  limit = 200
): Promise<Order[]> {
  const res = await db
    .prepare("SELECT * FROM orders WHERE forwarded_at >= ? ORDER BY forwarded_at DESC LIMIT ?")
    .bind(since, limit)
    .all<Order>();
  return res.results ?? [];
}

/**
 * Every cancelled-but-not-refunded order, all-time. Used by the digest to
 * show a persistent "Awaiting refund" section until the user marks each
 * one refunded via CLI or digest button.
 */
export async function listOrdersAwaitingRefund(
  db: D1Database,
  limit = 500
): Promise<Order[]> {
  const res = await db
    .prepare(
      `SELECT * FROM orders
       WHERE cancelled_at IS NOT NULL AND refunded_at IS NULL
       ORDER BY cancelled_at DESC LIMIT ?`
    )
    .bind(limit)
    .all<Order>();
  return res.results ?? [];
}

/** Orders refunded in the last `since` window — for the confirmation section of the digest. */
export async function listOrdersRefundedSince(
  db: D1Database,
  since: number,
  limit = 200
): Promise<Order[]> {
  const res = await db
    .prepare("SELECT * FROM orders WHERE refunded_at >= ? ORDER BY refunded_at DESC LIMIT ?")
    .bind(since, limit)
    .all<Order>();
  return res.results ?? [];
}

export async function pruneOrders(db: D1Database, olderThan: number): Promise<number> {
  // Awaiting-refund orders (cancelled but never refunded) are EXEMPT from
  // retention purge — they persist in the digest until manually marked
  // refunded. Refunded orders age out normally alongside completed orders.
  const res = await db
    .prepare(
      `DELETE FROM orders
       WHERE placed_at < ?
         AND NOT (cancelled_at IS NOT NULL AND refunded_at IS NULL)`
    )
    .bind(olderThan)
    .run();
  return (res.meta as { changes?: number })?.changes ?? 0;
}

// ─── audit ──────────────────────────────────────────────────────

export async function auditLog(
  db: D1Database,
  action: AuditAction | string,
  opts: AuditOptions = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit (at, action, order_number, from_dest, to_dest, actor, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      Date.now(),
      action,
      opts.orderNumber ?? null,
      opts.fromDest ?? null,
      opts.toDest ?? null,
      opts.actor ?? null,
      opts.note ?? null
    )
    .run();
}
