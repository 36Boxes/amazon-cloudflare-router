/**
 * Daily digest: grouped-by-destination summary of the last 24h of orders
 * with retag buttons per row. Sent to MASTER_EMAIL via CF's send_email
 * binding.
 */

import { EmailMessage } from "cloudflare:email";
import * as db from "./db";
import * as hmac from "./hmac";
import type { Destination, Env, Order } from "./types";

const DAY_MS = 24 * 3600 * 1000;
const RETAG_TTL_MS = 7 * DAY_MS;

type DigestTrigger = "cron" | "on-demand";

export async function sendDigest(env: Env, trigger: DigestTrigger): Promise<void> {
  const now = Date.now();
  const since = now - DAY_MS;

  const destinations = await db.listDestinations(env.DB);
  const destByCode = new Map(destinations.map((d) => [d.code, d]));

  const recent = await db.listOrders(env.DB, { since, limit: 500 });
  const tagged = recent.filter((o) => !!o.destination_code);
  const untagged = recent.filter((o) => !o.destination_code);
  const awaitingRefund = await db.listOrdersAwaitingRefund(env.DB);
  const refundedRecent = await db.listOrdersRefundedSince(env.DB, since);
  const forwarded = await db.listOrdersForwardedSince(env.DB, since);
  const activeSession = await db.getActiveSessionCode(env.DB);

  const html = await renderDigestHtml({
    env,
    now,
    activeSession,
    destinations,
    destByCode,
    tagged,
    untagged,
    awaitingRefund,
    refundedRecent,
    forwarded,
  });

  const subject = `Amazon summary — ${formatDate(now, env.DIGEST_TIMEZONE, "short")}`;

  await sendMail(env, subject, html);
  await db.auditLog(env.DB, "digest-sent", {
    actor: trigger,
    note:
      `tagged=${tagged.length} untagged=${untagged.length} ` +
      `awaiting_refund=${awaitingRefund.length} refunded_24h=${refundedRecent.length} ` +
      `forwarded=${forwarded.length}`,
  });
}

// ─── HTML rendering ─────────────────────────────────────────────

async function renderDigestHtml(args: {
  env: Env;
  now: number;
  activeSession: string | null;
  destinations: Destination[];
  destByCode: Map<string, Destination>;
  tagged: Order[];
  untagged: Order[];
  awaitingRefund: Order[];
  refundedRecent: Order[];
  forwarded: Order[];
}): Promise<string> {
  const {
    env,
    now,
    activeSession,
    destinations,
    destByCode,
    tagged,
    untagged,
    awaitingRefund,
    refundedRecent,
    forwarded,
  } = args;

  const exp = now + RETAG_TTL_MS;
  const workerBase = env.WORKER_BASE_URL || "";

  // Group tagged by destination
  const byDest = new Map<string, Order[]>();
  for (const o of tagged) {
    const code = o.destination_code!;
    if (!byDest.has(code)) byDest.set(code, []);
    byDest.get(code)!.push(o);
  }

  const parts: string[] = [];
  parts.push(`<!doctype html>
<html><head><meta charset="utf-8"><title>Amazon summary</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;max-width:840px;margin:1.5em auto;padding:0 1em;line-height:1.45;color:#222}
h1{font-size:1.35em;margin:0 0 .3em}
h2{font-size:1.05em;background:#f6f6f6;padding:.4em .6em;border-left:4px solid #888;margin-top:1.7em}
h2.untagged{border-color:#e6a417}
h2.cancelled{border-color:#c63}
h2.refunded{border-color:#4a8}
h2.forwarded{border-color:#4c8}
h2.empty{border-color:#ccc;color:#888}
.session{color:#555;margin-bottom:1em}
.session b{color:#222}
table{border-collapse:collapse;width:100%;font-size:.93em;margin-top:.3em}
td{padding:.35em .5em;border-bottom:1px solid #eee;vertical-align:top}
td.order{font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:#666;white-space:nowrap}
td.name{font-weight:600;white-space:nowrap}
td.actions{white-space:nowrap;font-size:.82em;text-align:right}
td.strike{text-decoration:line-through;color:#888}
td.muted{color:#888}
a.retag{display:inline-block;padding:2px 8px;margin:1px;border:1px solid #ccc;border-radius:3px;color:#333;text-decoration:none;background:#fafafa}
a.retag:hover{background:#eef}
a.retag.untag{border-color:#e0b0b0;color:#833;background:#fdf6f6}
a.retag.untag:hover{background:#fce6e6}
a.retag.refund{border-color:#a8d5a8;color:#265;background:#f4fbf4}
a.retag.refund:hover{background:#e6f5e6}
.dest-mail{color:#666;font-size:.82em}
.empty-note{padding:1.2em;text-align:center;color:#888;border:1px dashed #ccc;border-radius:6px;margin-top:1em}
.foot{margin-top:2.5em;color:#888;font-size:.83em;border-top:1px solid #eee;padding-top:.8em}
.foot code{font-family:ui-monospace,Consolas,monospace;background:#f6f6f6;padding:1px 5px;border-radius:3px}
</style></head><body>`);

  // ─── header ──────────────────────────────────────────
  parts.push(
    `<h1>📊 Amazon summary — ${escapeHtml(formatDate(now, env.DIGEST_TIMEZONE, "full"))}</h1>`
  );

  if (activeSession) {
    const d = destByCode.get(activeSession);
    parts.push(
      `<p class="session">Active session: <b>${escapeHtml(d?.display_name || activeSession)}</b> <span class="dest-mail">→ ${escapeHtml(d?.email || "?")}</span></p>`
    );
  } else {
    parts.push(`<p class="session">No active session.</p>`);
  }

  // ─── tagged, grouped by destination ─────────────────
  const codesInUse = Array.from(byDest.keys()).sort();
  for (const code of codesInUse) {
    const dest = destByCode.get(code);
    const orders = byDest.get(code)!;
    parts.push(
      `<h2>${escapeHtml(dest?.display_name || code)} → ${escapeHtml(dest?.email || code)} — ${orders.length} order${orders.length === 1 ? "" : "s"}</h2><table>`
    );
    for (const o of orders) {
      const others = destinations.filter((d) => d.code !== code);
      const retagLinks = await Promise.all(
        others.map(async (d) => {
          if (!workerBase) return "";
          const href = await hmac.makeRetagUrl(workerBase, env.HMAC_SECRET, {
            order: o.order_number,
            dest: d.code,
            exp,
          });
          return `<a class="retag" href="${escapeHtml(href)}">→ ${escapeHtml(d.display_name || d.code)}</a>`;
        })
      );
      let untagBtn = "";
      let cancelBtn = "";
      if (workerBase) {
        const untagHref = await hmac.makeUntagUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        untagBtn = `<a class="retag untag" href="${escapeHtml(untagHref)}" title="Remove tag — order returns to Untagged">✕ untag</a>`;
        const cancelHref = await hmac.makeCancelUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        cancelBtn = `<a class="retag untag" href="${escapeHtml(cancelHref)}" title="Mark as cancelled">✗ cancel</a>`;
      }
      parts.push(orderRow(o, retagLinks.join("") + untagBtn + cancelBtn));
    }
    parts.push(`</table>`);
  }

  // ─── untagged ────────────────────────────────────────
  if (untagged.length > 0) {
    parts.push(
      `<h2 class="untagged">⚠ Untagged (Going to my house) — ${untagged.length}</h2><table>`
    );
    for (const o of untagged) {
      const tagLinks = await Promise.all(
        destinations.map(async (d) => {
          if (!workerBase) return "";
          const href = await hmac.makeRetagUrl(workerBase, env.HMAC_SECRET, {
            order: o.order_number,
            dest: d.code,
            exp,
          });
          return `<a class="retag" href="${escapeHtml(href)}">Tag ${escapeHtml(d.display_name || d.code)}</a>`;
        })
      );
      let cancelBtn = "";
      if (workerBase) {
        const cancelHref = await hmac.makeCancelUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        cancelBtn = `<a class="retag untag" href="${escapeHtml(cancelHref)}" title="Mark as cancelled">✗ cancel</a>`;
      }
      parts.push(orderRow(o, tagLinks.join("") + cancelBtn));
    }
    parts.push(`</table>`);
  }

  // ─── forwarded ───────────────────────────────────────
  if (forwarded.length > 0) {
    parts.push(
      `<h2 class="forwarded">📬 Delivery emails forwarded — ${forwarded.length}</h2><table>`
    );
    for (const o of forwarded) {
      const d = o.destination_code ? destByCode.get(o.destination_code) : undefined;
      const dest = d?.email || o.destination_code || "?";
      parts.push(
        orderRow(o, `<span class="dest-mail">→ ${escapeHtml(dest)}</span>`)
      );
    }
    parts.push(`</table>`);
  }

  // ─── awaiting refund (persistent, all-time) ─────────
  if (awaitingRefund.length > 0) {
    parts.push(
      `<h2 class="cancelled">❌ Awaiting refund — ${awaitingRefund.length}</h2><table>`
    );
    for (const o of awaitingRefund) {
      let refundBtn = "";
      if (workerBase) {
        const href = await hmac.makeRefundUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        refundBtn = `<a class="retag refund" href="${escapeHtml(href)}" title="Mark refunded">✓ Mark refunded</a>`;
      }
      const cancelledDate = o.cancelled_at
        ? escapeHtml(formatDate(o.cancelled_at, env.DIGEST_TIMEZONE, "short"))
        : "?";
      parts.push(
        orderRow(
          o,
          `<span class="dest-mail">cancelled ${cancelledDate}</span> ${refundBtn}`,
          { titleClass: "strike" }
        )
      );
    }
    parts.push(`</table>`);
  }

  // ─── refunded in last 24h (confirmation section) ────
  if (refundedRecent.length > 0) {
    parts.push(
      `<h2 class="refunded">✅ Refunded in last 24h — ${refundedRecent.length}</h2><table>`
    );
    for (const o of refundedRecent) {
      parts.push(orderRow(o, "", { titleClass: "muted" }));
    }
    parts.push(`</table>`);
  }

  // ─── nothing happened empty state ────────────────────
  const nothingHappened =
    codesInUse.length === 0 &&
    untagged.length === 0 &&
    awaitingRefund.length === 0 &&
    refundedRecent.length === 0 &&
    forwarded.length === 0;
  if (nothingHappened) {
    parts.push(
      `<div class="empty-note">💤 Quiet in the last 24 hours — nothing to report.</div>`
    );
  }

  // ─── footer ──────────────────────────────────────────
  const workerNote = workerBase
    ? `Retag/untag links expire ${escapeHtml(new Date(exp).toLocaleDateString("en-GB", { timeZone: env.DIGEST_TIMEZONE, day: "2-digit", month: "short" }))}`
    : `⚠ <code>WORKER_BASE_URL</code> not set — buttons omitted. Use the CLI: <code>zon-tagger retag &lt;order&gt; &lt;dest&gt;</code>`;
  parts.push(
    `<div class="foot">${workerNote} · Generated by <code>request-email-filter</code></div>`
  );

  parts.push(`</body></html>`);
  return parts.join("");
}

function orderRow(
  o: Order,
  actionsHtml: string,
  opts: { titleClass?: string } = {}
): string {
  const titleCls = opts.titleClass ? ` class="${opts.titleClass}"` : "";
  const nameCell = o.recipient_name
    ? `<td class="name">${escapeHtml(o.recipient_name)}</td>`
    : `<td class="name muted">??</td>`;
  return `<tr>
  <td class="order">#${escapeHtml(o.order_number)}</td>
  <td${titleCls}>${escapeHtml(o.product_title || "(no title)")}</td>
  ${nameCell}
  <td class="actions">${actionsHtml}</td>
</tr>`;
}

// ─── outbound email via CF send_email binding ───────────────────

async function sendMail(env: Env, subject: string, html: string): Promise<void> {
  const from = env.FROM_ADDRESS;
  const to = env.MASTER_EMAIL;
  const messageId = `<${crypto.randomUUID()}@${(from.split("@")[1] || "mail")}>`;

  const raw =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n` +
    `\r\n` +
    html;

  const message = new EmailMessage(from, to, raw);
  await env.EMAIL.send(message);
}

// ─── helpers ────────────────────────────────────────────────────

function formatDate(ts: number, tz: string, style: "short" | "full"): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "short"
      ? { timeZone: tz, weekday: "short", day: "2-digit", month: "short" }
      : { timeZone: tz, weekday: "long", day: "2-digit", month: "short", year: "numeric" };
  try {
    return new Date(ts).toLocaleDateString("en-GB", opts);
  } catch {
    return new Date(ts).toISOString();
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
