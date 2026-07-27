/**
 * Cloudflare Worker entry point.
 *
 *   email      — every incoming Amazon email (via CF Email Routing rules)
 *   fetch      — admin API (for the CLI) + HMAC retag link handler
 *   scheduled  — daily cron: digest + retention prune
 */

import { handleAdmin } from "./admin";
import * as db from "./db";
import { sendDigest } from "./digest";
import { handleEmail } from "./email";
import { handleCancel, handleRefund, handleRetag, handleUntag } from "./retag";
import type { Env } from "./types";

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(handleEmail(message, env).catch((e) => console.error("[email] top-level:", e)));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/retag") return handleRetag(request, env);
    if (url.pathname === "/untag") return handleUntag(request, env);
    if (url.pathname === "/refund") return handleRefund(request, env);
    if (url.pathname === "/cancel") return handleCancel(request, env);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }
    if (url.pathname === "/") {
      return new Response("request-email-filter\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        sendDigest(env, "cron").catch((e) => console.error("[cron] digest:", e)),
        pruneRetention(env).catch((e) => console.error("[cron] prune:", e)),
      ]).then(() => undefined)
    );
  },
} satisfies ExportedHandler<Env>;

async function pruneRetention(env: Env): Promise<void> {
  const days = parseInt(env.RETENTION_DAYS || "90", 10);
  const cutoff = Date.now() - days * 86400 * 1000;
  const n = await db.pruneOrders(env.DB, cutoff);
  if (n > 0) {
    console.log(`[retention] pruned ${n} orders older than ${days} days`);
    await db.auditLog(env.DB, "retention-prune", {
      actor: "cron",
      note: `pruned=${n} days=${days}`,
    });
  }
}
