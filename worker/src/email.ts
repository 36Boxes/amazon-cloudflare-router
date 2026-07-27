/**
 * Email dispatcher. Every incoming email hits `handleEmail` (this Worker
 * is intended to be the catch-all across every zone that uses it — it
 * supersedes the previous `request-email-filter` Worker and preserves
 * that Worker's silent-drop rule for Amazon "invitation request received".
 *
 * Flow:
 *   0. Silent-drop rules — inherited from `request-email-filter`.
 *   1. Always forward the raw message to `MASTER_EMAIL` — regardless of
 *      what happens next, the master inbox stays complete for anything
 *      that isn't silent-dropped.
 *   2. Parse the MIME body with postal-mime.
 *   3. Classify the message.
 *   4. Dispatch to the appropriate handler.
 */

import PostalMime from "postal-mime";
import * as amazon from "./amazon";
import * as db from "./db";
import type { Env } from "./types";

function shouldDropSilently(from: string, subject: string): boolean {
  if (!amazon.isAmazonDomain(from.toLowerCase().split("@")[1] ?? "")) return false;
  return subject.toLowerCase().includes("invitation request received");
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  // 0. Silent-drop rules (preserved from previous request-email-filter Worker).
  //    These emails never reach master Gmail or any destination.
  const rawFrom = message.from ?? "";
  const rawSubject = message.headers.get("subject") ?? "";
  if (shouldDropSilently(rawFrom, rawSubject)) {
    console.log(`[email] dropped (invitation-request) from=${rawFrom}`);
    return;
  }

  // 1. Always forward the original to master.
  try {
    await message.forward(env.MASTER_EMAIL);
  } catch (e) {
    console.error("[email] forward-to-master failed:", e);
    // Continue: we still want to classify and record even if the forward
    // failed (Cloudflare will surface repeat failures via logs).
  }

  // 2. Parse.
  const parsed = await PostalMime.parse(await streamToArrayBuffer(message.raw));
  const from = parsed.from?.address ?? message.from ?? "";
  const fromDisplayName = parsed.from?.name ?? "";
  const rawFromHeader = message.headers.get("from") ?? "";
  const subject = parsed.subject ?? "";
  const text = parsed.text ?? htmlToText(parsed.html ?? "");
  // Which of our Amazon inbox addresses this email arrived at. In
  // Cloudflare Email Routing, `message.to` is the routed recipient — for
  // this Worker that's the amazon-inbox address the customer registered
  // on Amazon (e.g. amazon-alice@…, amazon-bob@…). Lower-cased so account
  // matching is case-insensitive downstream.
  const accountEmail = (message.to ?? "").toLowerCase() || null;

  // 2a. Account-hold bulk-cancel. Matches Amazon's "Account Protection
  // Services" email, which cancels every pending order on the target
  // account at once and carries no order number of its own. We scope the
  // cancel to only orders whose `account_email` equals the recipient of
  // this hold email so other accounts served by the same Worker are
  // untouched. We still forward the original to master (done above) —
  // this branch only mutates D1, then falls through so the classifier
  // below tags this as `other` and does nothing extra.
  if (
    accountEmail &&
    (amazon.isAccountHoldEmail(fromDisplayName) ||
      amazon.isAccountHoldEmail(rawFromHeader))
  ) {
    await handleAccountHold(env, accountEmail);
  }

  // 3. Classify.
  const kind = amazon.classifyAmazonEmail(from, subject);
  console.log(
    `[email] kind=${kind} from=${from} subject=${JSON.stringify(subject.slice(0, 80))}`
  );

  // 4. Dispatch.
  try {
    if (kind === "confirmation") {
      await handleConfirmation(env, text, subject, accountEmail);
    } else if (kind === "shipping-update") {
      await handleShippingUpdate(env, text, subject, message);
    }
  } catch (e) {
    console.error(`[email] handler(${kind}) threw:`, e);
  }
}

// ─── handlers ──────────────────────────────────────────────────

const ACCOUNT_HOLD_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Auto-cancel every order for the given Amazon account (matched by
 * `account_email` = the recipient of this hold email) that was placed
 * in the last 36h and hasn't already been forwarded. Fires when the
 * "Amazon Account Protection Services" email is received.
 *
 * The email itself carries no order number, so this is a bulk operation
 * — but scoped by account so other Amazon inboxes routed through the
 * same Worker are untouched. Delivered orders (`forwarded_at` set) are
 * excluded because those have already reached the destination.
 *
 * Each flipped row gets an individual audit entry with actor set to
 * `worker-account-hold` so it can be told apart from per-order cancel
 * events (which use actor="worker") and from CLI cancels (actor="cli").
 */
async function handleAccountHold(env: Env, accountEmail: string): Promise<void> {
  const flipped = await db.bulkCancelUnforwardedForAccount(
    env.DB,
    accountEmail,
    ACCOUNT_HOLD_WINDOW_MS
  );
  console.log(
    `[account-hold] account=${accountEmail} auto-cancelled ${flipped.length} ` +
      `orders placed in last 36h (unforwarded only)`
  );
  for (const row of flipped) {
    await db.auditLog(env.DB, "order-cancelled", {
      orderNumber: row.order_number,
      fromDest: row.destination_code ?? undefined,
      actor: "worker-account-hold",
      note: `bulk-cancelled by account-hold email to ${accountEmail}`,
    });
  }
}

async function handleConfirmation(
  env: Env,
  text: string,
  subject: string,
  accountEmail: string | null
): Promise<void> {
  const orderNum = amazon.extractOrderNumber(text) ?? amazon.extractOrderNumber(subject);
  if (!orderNum) {
    console.log("[confirmation] no order number");
    return;
  }

  const activeDest = await db.getActiveSessionCode(env.DB);
  const name = amazon.extractRecipientName(text);
  const title = amazon.extractProductTitle(text, subject);

  await db.insertOrder(env.DB, orderNum, activeDest, name, title, accountEmail);
  await db.auditLog(env.DB, "order-tagged", {
    orderNumber: orderNum,
    toDest: activeDest ?? undefined,
    actor: "worker",
    note: activeDest
      ? `auto-tagged from session (account=${accountEmail ?? "?"})`
      : `untagged: no active session (account=${accountEmail ?? "?"})`,
  });
  console.log(
    `[confirmation] order=${orderNum} dest=${activeDest ?? "(untagged)"} ` +
      `name=${name ?? "?"} account=${accountEmail ?? "?"}`
  );
}

/**
 * Every email from `order-update@amazon.*` or `shipment-tracking@amazon.*`.
 *
 * Behaviour:
 *   - If the subject looks like a cancellation, mark `cancelled_at` (this
 *     also protects against post-cancel glitchy delivery emails).
 *   - If the order is known + has a destination, forward to it — every
 *     time, no dedup. (Dispatched, out-for-delivery, arriving-today are
 *     genuinely different notifications the destination should see.)
 *   - Post-cancellation shipping updates (other than the cancellation
 *     email itself) are dropped to avoid confusing the destination.
 *   - Unknown orders / untagged orders → forward to `unrouted@` fallback.
 */
async function handleShippingUpdate(
  env: Env,
  text: string,
  subject: string,
  message: ForwardableEmailMessage
): Promise<void> {
  const orderNum = amazon.extractOrderNumber(text) ?? amazon.extractOrderNumber(subject);
  if (!orderNum) {
    console.log("[shipping] no order number");
    return;
  }

  const isCancellation = amazon.isCancellationSubject(subject);
  if (isCancellation) {
    await db.markOrderCancelled(env.DB, orderNum);
    await db.auditLog(env.DB, "order-cancelled", { orderNumber: orderNum, actor: "worker" });
    console.log(`[shipping] order=${orderNum} cancellation detected — marked`);
  }

  const order = await db.getOrder(env.DB, orderNum);

  if (!order) {
    console.log(`[shipping] order=${orderNum} not in DB → unrouted`);
    await forwardToUnrouted(env, message, orderNum, "no matching order");
    return;
  }

  // Post-cancellation guard: don't forward stray "arriving today" for a
  // cancelled order. The cancellation email itself IS still forwarded
  // (the isCancellation branch bypasses this check via the sequence
  // above — cancelled_at is set THIS invocation, but we still fall
  // through and forward).
  if (order.cancelled_at && !isCancellation) {
    console.log(`[shipping] order=${orderNum} cancelled → not forwarding`);
    return;
  }

  if (!order.destination_code) {
    console.log(`[shipping] order=${orderNum} untagged → unrouted`);
    await forwardToUnrouted(env, message, orderNum, "order untagged");
    return;
  }

  const dest = await db.getDestination(env.DB, order.destination_code);
  if (!dest) {
    console.log(`[shipping] destination ${order.destination_code} missing → unrouted`);
    await forwardToUnrouted(env, message, orderNum, `destination ${order.destination_code} missing`);
    return;
  }

  try {
    await message.forward(dest.email);
    await db.markOrderForwarded(env.DB, orderNum);
    await db.auditLog(env.DB, "delivery-forwarded", {
      orderNumber: orderNum,
      toDest: order.destination_code,
      actor: "worker",
      note: subject.slice(0, 100),
    });
    console.log(`[shipping] order=${orderNum} → ${dest.email} (${subject.slice(0, 60)})`);
  } catch (e) {
    console.error(`[shipping] forward to ${dest.email} failed:`, e);
    await forwardToUnrouted(env, message, orderNum, `forward failed: ${String(e)}`);
  }
}

async function forwardToUnrouted(
  env: Env,
  message: ForwardableEmailMessage,
  orderNum: string,
  reason: string
): Promise<void> {
  try {
    await message.forward(env.UNROUTED_EMAIL);
    await db.auditLog(env.DB, "delivery-unrouted", {
      orderNumber: orderNum,
      actor: "worker",
      note: reason,
    });
  } catch (e) {
    console.error("[unrouted] forward failed:", e);
  }
}

// ─── helpers ────────────────────────────────────────────────────

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/** Very rough HTML→text fallback for emails that lack a plain-text part. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
