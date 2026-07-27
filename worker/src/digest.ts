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
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Amazon summary</title>
<style>
:root{
  --bg:#f4f6f8;
  --surface:#ffffff;
  --border:#e3e7ec;
  --border-strong:#d0d7de;
  --text:#0f172a;
  --text-2:#475569;
  --text-3:#94a3b8;
  --accent:#0369a1;
  --success:#15803d;
  --success-bg:#dcfce7;
  --warn:#a16207;
  --warn-bg:#fef3c7;
  --danger:#b91c1c;
  --danger-bg:#fee2e2;
  --info:#6d28d9;
  --info-bg:#ede9fe;
  --radius:12px;
  --shadow:0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
body{
  margin:0;padding:24px 12px 40px;
  background:var(--bg);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;line-height:1.5;color:var(--text);
  -webkit-font-smoothing:antialiased;
  text-size-adjust:100%;
}
a{color:inherit}
.wrap{max-width:640px;margin:0 auto}
.header{margin:0 4px 20px}
.header h1{
  margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:-.4px;
  display:flex;align-items:center;gap:8px;
}
.header .date{font-size:14px;color:var(--text-2);margin:0}
.session{
  margin:14px 0 0;padding:10px 14px;
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  font-size:13px;color:var(--text-2);
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
}
.session .dot{width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block;flex-shrink:0}
.session .dot.off{background:var(--text-3)}
.session b{color:var(--text);font-weight:600}
.section{margin-top:26px}
.section-head{
  display:flex;align-items:baseline;justify-content:space-between;
  padding:0 4px 8px;gap:8px;
}
.section-head .title{
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;
  color:var(--text-2);
}
.section-head .title.warn{color:var(--warn)}
.section-head .title.danger{color:var(--danger)}
.section-head .title.info{color:var(--info)}
.section-head .subtitle{color:var(--text-3);font-size:12px;font-weight:500;margin-top:2px}
.section-head .count{
  font-size:12px;font-weight:600;color:var(--text-2);
  background:rgba(15,23,42,.06);padding:2px 9px;border-radius:20px;
}
.card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 16px;margin-bottom:8px;box-shadow:var(--shadow);
}
.card + .card{margin-top:0}
.card .title{
  margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.35;
  overflow-wrap:anywhere;color:var(--text);
}
.card .meta{
  margin:0 0 10px;font-size:12.5px;color:var(--text-2);
  display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;
}
.card .meta .order{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:11.5px;color:var(--text-3);
}
.card .meta .name{
  display:inline-flex;align-items:center;gap:4px;font-weight:600;color:var(--text);
}
.card .meta .name::before{content:"👤";font-size:11px;opacity:.7}
.card .meta .dest-badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:1px 8px;border-radius:20px;
  background:var(--success-bg);color:var(--success);
  font-weight:600;font-size:11.5px;
}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.btn{
  display:inline-flex;align-items:center;gap:4px;
  padding:6px 11px;border:1px solid var(--border-strong);border-radius:8px;
  text-decoration:none;font-size:12.5px;font-weight:500;
  color:var(--text);background:#fff;
  white-space:nowrap;line-height:1;
}
.btn:hover{background:#f6f8fa}
.btn.tag{background:var(--success-bg);border-color:#86efac;color:var(--success)}
.btn.tag:hover{background:#bbf7d0}
.btn.untag{background:var(--danger-bg);border-color:#fca5a5;color:var(--danger)}
.btn.untag:hover{background:#fecaca}
.btn-arrow{opacity:.55;margin-right:1px}
.forwarded-line{
  display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);
  padding:2px 0;
}
.forwarded-line .arrow{color:var(--info)}
.empty{
  padding:32px 20px;text-align:center;
  background:var(--surface);border:1px dashed var(--border-strong);
  border-radius:var(--radius);color:var(--text-2);
}
.empty .em{font-size:28px;display:block;margin-bottom:6px}
.foot{
  margin-top:36px;padding-top:18px;
  border-top:1px solid var(--border);
  color:var(--text-3);font-size:11.5px;text-align:center;line-height:1.6;
}
.foot code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:rgba(15,23,42,.06);padding:1px 6px;border-radius:4px;color:var(--text-2);
}
@media (max-width:520px){
  body{padding:14px 8px 30px;font-size:14px}
  .header h1{font-size:19px}
  .card{padding:12px 13px}
  .card .title{font-size:14px}
  .btn{font-size:12px;padding:5px 10px}
  .section{margin-top:22px}
}
@media (prefers-color-scheme:dark){
  /* Kept light — most email clients ignore this. Included for future-proofing. */
}
</style>
</head><body><div class="wrap">`);

  // ─── header ──────────────────────────────────────────
  parts.push(`<div class="header">
  <h1>📦 Amazon summary</h1>
  <p class="date">${escapeHtml(formatDate(now, env.DIGEST_TIMEZONE, "full"))}</p>`);

  if (activeSession) {
    const d = destByCode.get(activeSession);
    parts.push(
      `<div class="session"><span class="dot"></span>Active session: <b>${escapeHtml(d?.display_name || activeSession)}</b> <span style="color:var(--text-3)">→ ${escapeHtml(d?.email || "?")}</span></div>`
    );
  } else {
    parts.push(`<div class="session"><span class="dot off"></span>No active session</div>`);
  }
  parts.push(`</div>`);

  // ─── tagged, grouped by destination ─────────────────
  const codesInUse = Array.from(byDest.keys()).sort();
  for (const code of codesInUse) {
    const dest = destByCode.get(code);
    const orders = byDest.get(code)!;
    parts.push(`<div class="section">
  <div class="section-head">
    <div>
      <div class="title">${escapeHtml(dest?.display_name || code)}</div>
      <div class="subtitle">${escapeHtml(dest?.email || code)}</div>
    </div>
    <span class="count">${orders.length}</span>
  </div>`);
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
          return `<a class="btn" href="${escapeHtml(href)}"><span class="btn-arrow">→</span>${escapeHtml(d.display_name || d.code)}</a>`;
        })
      );
      let untagBtn = "";
      let cancelBtn = "";
      if (workerBase) {
        const untagHref = await hmac.makeUntagUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        untagBtn = `<a class="btn untag" href="${escapeHtml(untagHref)}" title="Remove tag">✕ untag</a>`;
        const cancelHref = await hmac.makeCancelUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        cancelBtn = `<a class="btn untag" href="${escapeHtml(cancelHref)}" title="Mark as cancelled">✗ cancel</a>`;
      }
      parts.push(orderCard(o, retagLinks.join("") + untagBtn + cancelBtn));
    }
    parts.push(`</div>`);
  }

  // ─── untagged ────────────────────────────────────────
  if (untagged.length > 0) {
    parts.push(`<div class="section">
  <div class="section-head">
    <div class="title warn">⚠ Untagged (Going to my house)</div>
    <span class="count">${untagged.length}</span>
  </div>`);
    for (const o of untagged) {
      const tagLinks = await Promise.all(
        destinations.map(async (d) => {
          if (!workerBase) return "";
          const href = await hmac.makeRetagUrl(workerBase, env.HMAC_SECRET, {
            order: o.order_number,
            dest: d.code,
            exp,
          });
          return `<a class="btn tag" href="${escapeHtml(href)}">Tag ${escapeHtml(d.display_name || d.code)}</a>`;
        })
      );
      let cancelBtn = "";
      if (workerBase) {
        const cancelHref = await hmac.makeCancelUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        cancelBtn = `<a class="btn untag" href="${escapeHtml(cancelHref)}" title="Mark as cancelled">✗ cancel</a>`;
      }
      parts.push(orderCard(o, tagLinks.join("") + cancelBtn));
    }
    parts.push(`</div>`);
  }

  // ─── forwarded ───────────────────────────────────────
  if (forwarded.length > 0) {
    parts.push(`<div class="section">
  <div class="section-head">
    <div class="title info">📬 Delivery emails forwarded</div>
    <span class="count">${forwarded.length}</span>
  </div>`);
    for (const o of forwarded) {
      const d = o.destination_code ? destByCode.get(o.destination_code) : undefined;
      parts.push(`<div class="card">
  <p class="title">${escapeHtml(o.product_title || "(no title)")}</p>
  <p class="meta">
    <span class="order">#${escapeHtml(o.order_number)}</span>
    ${o.recipient_name ? `<span class="name">${escapeHtml(o.recipient_name)}</span>` : ""}
    <span class="dest-badge">→ ${escapeHtml(d?.display_name || o.destination_code || "?")}</span>
  </p>
  <div class="forwarded-line"><span class="arrow">➜</span> Sent to <b>${escapeHtml(d?.email || "?")}</b></div>
</div>`);
    }
    parts.push(`</div>`);
  }

  // ─── awaiting refund (persistent, all-time) ─────────
  if (awaitingRefund.length > 0) {
    parts.push(`<div class="section">
  <div class="section-head">
    <div class="title danger">❌ Awaiting refund</div>
    <span class="count">${awaitingRefund.length}</span>
  </div>`);
    for (const o of awaitingRefund) {
      const d = o.destination_code ? destByCode.get(o.destination_code) : undefined;
      let refundBtn = "";
      if (workerBase) {
        const href = await hmac.makeRefundUrl(workerBase, env.HMAC_SECRET, {
          order: o.order_number,
          exp,
        });
        refundBtn = `<a class="btn tag" href="${escapeHtml(href)}" title="Mark refunded">✓ Mark refunded</a>`;
      }
      const cancelledDate = o.cancelled_at
        ? escapeHtml(formatDate(o.cancelled_at, env.DIGEST_TIMEZONE, "short"))
        : "?";
      parts.push(`<div class="card">
  <p class="title" style="text-decoration:line-through;color:var(--text-2)">${escapeHtml(o.product_title || "(no title)")}</p>
  <p class="meta">
    <span class="order">#${escapeHtml(o.order_number)}</span>
    ${o.recipient_name ? `<span class="name">${escapeHtml(o.recipient_name)}</span>` : ""}
    ${d ? `<span class="dest-badge">→ ${escapeHtml(d.display_name || o.destination_code || "?")}</span>` : ""}
    <span style="color:var(--text-3)">cancelled ${cancelledDate}</span>
  </p>
  ${refundBtn ? `<div class="actions">${refundBtn}</div>` : ""}
</div>`);
    }
    parts.push(`</div>`);
  }

  // ─── refunded in last 24h (confirmation section) ────
  if (refundedRecent.length > 0) {
    parts.push(`<div class="section">
  <div class="section-head">
    <div class="title" style="color:var(--success)">✅ Refunded in last 24h</div>
    <span class="count">${refundedRecent.length}</span>
  </div>`);
    for (const o of refundedRecent) {
      parts.push(`<div class="card">
  <p class="title" style="color:var(--text-2)">${escapeHtml(o.product_title || "(no title)")}</p>
  <p class="meta">
    <span class="order">#${escapeHtml(o.order_number)}</span>
    ${o.recipient_name ? `<span class="name">${escapeHtml(o.recipient_name)}</span>` : ""}
  </p>
</div>`);
    }
    parts.push(`</div>`);
  }

  // ─── nothing happened empty state ────────────────────
  const nothingHappened =
    codesInUse.length === 0 &&
    untagged.length === 0 &&
    awaitingRefund.length === 0 &&
    refundedRecent.length === 0 &&
    forwarded.length === 0;
  if (nothingHappened) {
    parts.push(`<div class="section"><div class="empty">
  <span class="em">💤</span>
  Quiet in the last 24 hours — nothing to report.
</div></div>`);
  }

  // ─── footer ──────────────────────────────────────────
  const workerNote = workerBase
    ? `Retag/untag links expire ${escapeHtml(new Date(exp).toLocaleDateString("en-GB", { timeZone: env.DIGEST_TIMEZONE, day: "2-digit", month: "short" }))}`
    : `⚠ <code>WORKER_BASE_URL</code> not set — buttons omitted. Use the CLI: <code>zon-tagger retag &lt;order&gt; &lt;dest&gt;</code>`;
  parts.push(`<div class="foot">
  ${workerNote}<br>
  Generated by <code>request-email-filter</code>
</div>`);

  parts.push(`</div></body></html>`);
  return parts.join("");
}

function orderCard(o: Order, actionsHtml: string): string {
  return `<div class="card">
  <p class="title">${escapeHtml(o.product_title || "(no title)")}</p>
  <p class="meta">
    <span class="order">#${escapeHtml(o.order_number)}</span>
    ${o.recipient_name ? `<span class="name">${escapeHtml(o.recipient_name)}</span>` : `<span style="color:var(--text-3)">no name</span>`}
  </p>
  ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ""}
</div>`;
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
