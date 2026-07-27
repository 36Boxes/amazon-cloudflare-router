/**
 * Admin HTTP API — the CLI's only interlocutor with the Worker.
 *
 * Auth: static bearer token in `ADMIN_TOKEN` (Worker secret). Every route
 * requires it; there are no public routes here.
 */

import * as db from "./db";
import { sendDigest } from "./digest";
import type { Env } from "./types";

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin/, "") || "/";
  const method = request.method;

  try {
    // ─── session ─────────────────────────────────────────
    if (path === "/session" && method === "GET") {
      const s = await db.getSession(env.DB);
      if (s?.destination_code && s.expires_at && Date.now() > s.expires_at) {
        await db.setSession(env.DB, null, null);
        return json({ destination_code: null, set_at: null, expires_at: null, expired: true });
      }
      return json(s ?? { destination_code: null, set_at: null, expires_at: null });
    }

    if (path === "/session" && method === "PUT") {
      const body = (await request.json()) as {
        destination_code: string;
        expires_at?: number | null;
      };
      if (!body?.destination_code) return json({ error: "destination_code required" }, 400);
      const dest = await db.getDestination(env.DB, body.destination_code);
      if (!dest) return json({ error: `unknown destination: ${body.destination_code}` }, 404);
      await db.setSession(env.DB, dest.code, body.expires_at ?? null);
      await db.auditLog(env.DB, "session-set", { toDest: dest.code, actor: "cli" });
      return json({ ok: true, destination_code: dest.code, display_name: dest.display_name });
    }

    if (path === "/session" && method === "DELETE") {
      await db.setSession(env.DB, null, null);
      await db.auditLog(env.DB, "session-stop", { actor: "cli" });
      return json({ ok: true });
    }

    // ─── destinations ─────────────────────────────────────
    if (path === "/destinations" && method === "GET") {
      return json(await db.listDestinations(env.DB));
    }

    if (path === "/destinations" && method === "POST") {
      const body = (await request.json()) as {
        code: string;
        email: string;
        display_name?: string | null;
      };
      if (!body?.code || !body?.email) {
        return json({ error: "code and email required" }, 400);
      }
      const existing = await db.getDestination(env.DB, body.code);
      if (existing) return json({ error: `destination ${body.code} already exists` }, 409);
      await db.addDestination(env.DB, body.code, body.email, body.display_name ?? null);
      return json({ ok: true, code: body.code });
    }

    if (path.startsWith("/destinations/") && method === "DELETE") {
      const code = decodeURIComponent(path.split("/")[2] ?? "");
      if (!code) return json({ error: "code required" }, 400);
      await db.removeDestination(env.DB, code);
      return json({ ok: true });
    }

    // ─── orders ───────────────────────────────────────────
    if (path === "/orders" && method === "GET") {
      const since = url.searchParams.get("since");
      const dest = url.searchParams.get("dest");
      const untagged = url.searchParams.get("untagged") === "true";
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const rows = await db.listOrders(env.DB, {
        since: since ? parseInt(since, 10) : undefined,
        destCode: dest || undefined,
        untaggedOnly: untagged,
        limit,
      });
      return json(rows);
    }

    if (path === "/orders/awaiting-refund" && method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 200, 1, 500);
      return json(await db.listOrdersAwaitingRefund(env.DB, limit));
    }

    if (path.startsWith("/orders/") && path.endsWith("/retag") && method === "POST") {
      const orderNum = decodeURIComponent(path.split("/")[2] ?? "");
      const body = (await request.json()) as {
        destination_code: string;
        force?: boolean;
      };
      if (!orderNum) return json({ error: "order required" }, 400);
      if (!body?.destination_code) return json({ error: "destination_code required" }, 400);

      const order = await db.getOrder(env.DB, orderNum);
      if (!order) return json({ error: `order ${orderNum} not found` }, 404);
      if (order.forwarded_at && !body.force) {
        return json({ error: "already forwarded — use --force to override" }, 409);
      }
      const dest = await db.getDestination(env.DB, body.destination_code);
      if (!dest) return json({ error: `unknown destination: ${body.destination_code}` }, 404);

      await db.updateOrderDestination(env.DB, orderNum, dest.code);
      await db.auditLog(env.DB, "order-retagged", {
        orderNumber: orderNum,
        fromDest: order.destination_code ?? undefined,
        toDest: dest.code,
        actor: "cli",
      });
      return json({ ok: true, order_number: orderNum, destination_code: dest.code });
    }

    if (path.startsWith("/orders/") && path.endsWith("/untag") && method === "POST") {
      const orderNum = decodeURIComponent(path.split("/")[2] ?? "");
      const body = (await request.json().catch(() => ({}))) as { force?: boolean };
      if (!orderNum) return json({ error: "order required" }, 400);

      const order = await db.getOrder(env.DB, orderNum);
      if (!order) return json({ error: `order ${orderNum} not found` }, 404);
      if (order.forwarded_at && !body?.force) {
        return json({ error: "already forwarded — use --force to override" }, 409);
      }

      const fromDest = order.destination_code;
      await db.clearOrderDestination(env.DB, orderNum);
      await db.auditLog(env.DB, "order-untagged", {
        orderNumber: orderNum,
        fromDest: fromDest ?? undefined,
        actor: "cli",
      });
      return json({ ok: true, order_number: orderNum, destination_code: null });
    }

    if (path.startsWith("/orders/") && path.endsWith("/cancel") && method === "POST") {
      const orderNum = decodeURIComponent(path.split("/")[2] ?? "");
      if (!orderNum) return json({ error: "order required" }, 400);

      const order = await db.getOrder(env.DB, orderNum);
      if (!order) return json({ error: `order ${orderNum} not found` }, 404);
      if (order.cancelled_at) {
        return json({ error: "already cancelled" }, 409);
      }

      await db.markOrderCancelled(env.DB, orderNum);
      await db.auditLog(env.DB, "order-cancelled", {
        orderNumber: orderNum,
        fromDest: order.destination_code ?? undefined,
        actor: "cli",
      });
      return json({ ok: true, order_number: orderNum, cancelled_at: Date.now() });
    }

    if (path.startsWith("/orders/") && path.endsWith("/uncancel") && method === "POST") {
      const orderNum = decodeURIComponent(path.split("/")[2] ?? "");
      if (!orderNum) return json({ error: "order required" }, 400);

      const order = await db.getOrder(env.DB, orderNum);
      if (!order) return json({ error: `order ${orderNum} not found` }, 404);
      if (!order.cancelled_at) {
        return json({ error: "order is not cancelled" }, 409);
      }

      await db.clearOrderCancelled(env.DB, orderNum);
      await db.auditLog(env.DB, "order-uncancelled", {
        orderNumber: orderNum,
        fromDest: order.destination_code ?? undefined,
        actor: "cli",
      });
      return json({ ok: true, order_number: orderNum, cancelled_at: null });
    }

    if (path.startsWith("/orders/") && path.endsWith("/refund") && method === "POST") {
      const orderNum = decodeURIComponent(path.split("/")[2] ?? "");
      if (!orderNum) return json({ error: "order required" }, 400);

      const order = await db.getOrder(env.DB, orderNum);
      if (!order) return json({ error: `order ${orderNum} not found` }, 404);
      if (!order.cancelled_at) {
        return json({ error: "order is not cancelled — cancel it first" }, 409);
      }
      if (order.refunded_at) {
        return json({ error: "already refunded" }, 409);
      }

      const changed = await db.markOrderRefunded(env.DB, orderNum);
      if (!changed) return json({ error: "could not mark refunded" }, 500);
      await db.auditLog(env.DB, "order-refunded", {
        orderNumber: orderNum,
        fromDest: order.destination_code ?? undefined,
        actor: "cli",
      });
      return json({ ok: true, order_number: orderNum, refunded_at: Date.now() });
    }

    // ─── digest ───────────────────────────────────────────
    if (path === "/review" && method === "POST") {
      await sendDigest(env, "on-demand");
      return json({ ok: true });
    }

    // ─── health ───────────────────────────────────────────
    if ((path === "/" || path === "") && method === "GET") {
      return json({ ok: true, service: "request-email-filter" });
    }

    return json({ error: "not found", path, method }, 404);
  } catch (e) {
    console.error("[admin] error:", e);
    return json({ error: String(e) }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clampInt(s: string | null, fallback: number, lo: number, hi: number): number {
  if (!s) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
