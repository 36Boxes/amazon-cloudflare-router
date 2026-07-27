/**
 * Handlers for /retag and /untag — signed HMAC links appearing in the
 * daily digest email so tag corrections are one tap in Gmail.
 *
 *   /retag?order=…&dest=…&exp=…&sig=…    → point order at new destination
 *   /untag?order=…&exp=…&sig=…           → clear order's destination
 */

import * as db from "./db";
import * as hmac from "./hmac";
import type { Env } from "./types";

export async function handleRetag(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const order = url.searchParams.get("order");
  const dest = url.searchParams.get("dest");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!order || !dest || !expStr || !sig) {
    return page("❌ Invalid link — missing parameters.", 400);
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return page("❌ Invalid link — bad expiry.", 400);
  if (Date.now() > exp) {
    return page("⏰ Link expired. Use the CLI: <code>zon-tagger retag &lt;order&gt; &lt;dest&gt;</code>", 410);
  }

  const data = `${order}:${dest}:${exp}`;
  const ok = await hmac.verify(env.HMAC_SECRET, data, sig);
  if (!ok) return page("❌ Invalid signature.", 403);

  const orderRow = await db.getOrder(env.DB, order);
  if (!orderRow) return page(`❌ Order <code>${escapeHtml(order)}</code> not found.`, 404);
  if (orderRow.forwarded_at) {
    return page(
      `⚠️ Order <code>${escapeHtml(order)}</code> was already forwarded to ` +
        `<b>${escapeHtml(orderRow.destination_code ?? "?")}</b>. ` +
        `Use the CLI with <code>--force</code> to override.`,
      409
    );
  }

  const destRow = await db.getDestination(env.DB, dest);
  if (!destRow) return page(`❌ Unknown destination: <code>${escapeHtml(dest)}</code>`, 404);

  await db.updateOrderDestination(env.DB, order, dest);
  await db.auditLog(env.DB, "order-retagged", {
    orderNumber: order,
    fromDest: orderRow.destination_code ?? undefined,
    toDest: dest,
    actor: "retag-link",
  });

  return page(
    `✅ Retagged <code>${escapeHtml(order)}</code> as ` +
      `<b>${escapeHtml(destRow.display_name || destRow.code)}</b> ` +
      `(${escapeHtml(destRow.email)}). You can close this tab.`
  );
}

export async function handleUntag(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const order = url.searchParams.get("order");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!order || !expStr || !sig) {
    return page("❌ Invalid link — missing parameters.", 400);
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return page("❌ Invalid link — bad expiry.", 400);
  if (Date.now() > exp) {
    return page("⏰ Link expired. Use the CLI: <code>zon-tagger untag &lt;order&gt;</code>", 410);
  }

  const data = `${order}:untag:${exp}`;
  const ok = await hmac.verify(env.HMAC_SECRET, data, sig);
  if (!ok) return page("❌ Invalid signature.", 403);

  const orderRow = await db.getOrder(env.DB, order);
  if (!orderRow) return page(`❌ Order <code>${escapeHtml(order)}</code> not found.`, 404);
  if (orderRow.forwarded_at) {
    return page(
      `⚠️ Order <code>${escapeHtml(order)}</code> was already forwarded to ` +
        `<b>${escapeHtml(orderRow.destination_code ?? "?")}</b>. Untagging now ` +
        `won't unsend that email. Use the CLI with <code>--force</code> to override.`,
      409
    );
  }

  const fromDest = orderRow.destination_code;
  await db.clearOrderDestination(env.DB, order);
  await db.auditLog(env.DB, "order-untagged", {
    orderNumber: order,
    fromDest: fromDest ?? undefined,
    actor: "retag-link",
  });

  return page(
    `✅ Untagged <code>${escapeHtml(order)}</code>` +
      (fromDest ? ` (was <b>${escapeHtml(fromDest)}</b>)` : "") +
      `. It's now in the untagged bucket. You can close this tab.`
  );
}

/**
 * GET /cancel?order=…&exp=…&sig=…
 *
 * One-tap "Mark cancelled" button in the daily digest. Handy when Amazon
 * cancels an order silently (no email, or email missed) — user flags it
 * from the digest and it moves into the Awaiting-refund section next
 * digest. Idempotent.
 */
export async function handleCancel(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const order = url.searchParams.get("order");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!order || !expStr || !sig) {
    return page("❌ Invalid link — missing parameters.", 400);
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return page("❌ Invalid link — bad expiry.", 400);
  if (Date.now() > exp) {
    return page("⏰ Link expired. Use the CLI: <code>zon-tagger cancel &lt;order&gt;</code>", 410);
  }

  const data = `${order}:cancel:${exp}`;
  const ok = await hmac.verify(env.HMAC_SECRET, data, sig);
  if (!ok) return page("❌ Invalid signature.", 403);

  const orderRow = await db.getOrder(env.DB, order);
  if (!orderRow) return page(`❌ Order <code>${escapeHtml(order)}</code> not found.`, 404);
  if (orderRow.cancelled_at) {
    return page(
      `ℹ️ Order <code>${escapeHtml(order)}</code> is already marked cancelled. Nothing to do.`,
      200
    );
  }

  await db.markOrderCancelled(env.DB, order);
  await db.auditLog(env.DB, "order-cancelled", {
    orderNumber: order,
    fromDest: orderRow.destination_code ?? undefined,
    actor: "cancel-link",
  });

  return page(
    `✅ Marked <code>${escapeHtml(order)}</code> as cancelled. It'll appear ` +
      `in the Awaiting-refund section of the next digest. You can close this tab.`
  );
}

/**
 * GET /refund?order=…&exp=…&sig=…
 *
 * One-tap "Mark refunded" button rendered next to each Awaiting-refund
 * order in the daily digest. Idempotent: if the order is already refunded
 * or was never cancelled the handler explains and returns 4xx without
 * modifying state.
 */
export async function handleRefund(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const order = url.searchParams.get("order");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (!order || !expStr || !sig) {
    return page("❌ Invalid link — missing parameters.", 400);
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return page("❌ Invalid link — bad expiry.", 400);
  if (Date.now() > exp) {
    return page("⏰ Link expired. Use the CLI: <code>zon-tagger refund &lt;order&gt;</code>", 410);
  }

  const data = `${order}:refund:${exp}`;
  const ok = await hmac.verify(env.HMAC_SECRET, data, sig);
  if (!ok) return page("❌ Invalid signature.", 403);

  const orderRow = await db.getOrder(env.DB, order);
  if (!orderRow) return page(`❌ Order <code>${escapeHtml(order)}</code> not found.`, 404);
  if (!orderRow.cancelled_at) {
    return page(
      `⚠️ Order <code>${escapeHtml(order)}</code> isn't marked cancelled, so ` +
        `there's nothing to refund. Cancel it first with ` +
        `<code>zon-tagger cancel &lt;order&gt;</code>.`,
      409
    );
  }
  if (orderRow.refunded_at) {
    const when = new Date(orderRow.refunded_at).toLocaleDateString("en-GB", {
      timeZone: env.DIGEST_TIMEZONE,
      day: "2-digit",
      month: "short",
    });
    return page(
      `ℹ️ Order <code>${escapeHtml(order)}</code> was already marked refunded on ` +
        `<b>${escapeHtml(when)}</b>. Nothing to do.`,
      200
    );
  }

  const changed = await db.markOrderRefunded(env.DB, order);
  if (!changed) {
    return page(`❌ Could not mark <code>${escapeHtml(order)}</code> as refunded.`, 500);
  }
  await db.auditLog(env.DB, "order-refunded", {
    orderNumber: order,
    fromDest: orderRow.destination_code ?? undefined,
    actor: "refund-link",
  });

  return page(
    `✅ Marked <code>${escapeHtml(order)}</code> as refunded. It'll drop out ` +
      `of the Awaiting-refund list on the next digest. You can close this tab.`
  );
}

// ─── HTML shell ────────────────────────────────────────────────

function page(bodyMsg: string, status = 200): Response {
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Retag</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;max-width:600px;margin:5em auto;padding:0 1.2em;line-height:1.5;color:#222}
p{font-size:1.15em}
code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:.9em}
</style>
</head>
<body><p>${bodyMsg}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
