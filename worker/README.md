# worker/

Cloudflare Email Worker deployed as `request-email-filter` — the same script
name your Cloudflare zones' catch-all rules already point to (as set up by
`cloudflare-subdomain-adder/set_email_worker_catchall.py`). This is a
**drop-in replacement** for your previous `request-email-filter`: it
preserves the "silently drop Amazon *invitation request received*" rule and
adds all the destination-forwarding logic on top.

Everything lives in `src/`, one script deployed as one Worker. Cloudflare
runs three entry points:

- `email(message, env, ctx)` — every incoming Amazon email is dispatched
  here by Cloudflare's routing rules.
- `fetch(request, env, ctx)` — HTTPS API used by the CLI (`/admin/*`) and by
  the signed retag links in the daily digest (`/retag`).
- `scheduled(event, env, ctx)` — cron: daily digest + retention cleanup.

## File map

| File               | Responsibility                                                        |
| ------------------ | --------------------------------------------------------------------- |
| `src/index.ts`     | Worker entry — three handlers dispatch to modules below.              |
| `src/email.ts`     | Dispatches inbound email to confirmation / delivery / cancellation.   |
| `src/amazon.ts`    | Pure functions: detect email type, extract order#, name, product.     |
| `src/db.ts`        | All D1 queries — destinations, orders, session, audit.                |
| `src/admin.ts`     | Admin API for the CLI. Bearer-token authenticated.                    |
| `src/retag.ts`     | Handles HMAC-signed `/retag?…` links from the digest email.           |
| `src/digest.ts`    | Builds and sends the daily digest email.                              |
| `src/hmac.ts`      | Web-Crypto HMAC signing helpers (retag tokens).                       |
| `src/types.ts`     | Shared types + `Env` shape.                                           |
| `schema.sql`       | D1 schema — apply once with `wrangler d1 execute … --file=./schema.sql`. |
| `wrangler.toml`    | Worker + D1 + cron + vars binding.                                    |
| `.dev.vars.example` | Template for `.dev.vars` (local dev secrets — gitignored).           |

## Local development

```powershell
npm install
npx wrangler dev
```

`wrangler dev` runs the Worker locally, but note:

- **Email dispatch is a paid-plan feature for local `dev`** — for MVP,
  develop by unit-testing pure functions in `src/amazon.ts` and using the
  admin API against a deployed dev-Worker.

## Deploy

```powershell
npx wrangler deploy
```

See `../SETUP.md` for the full first-time deployment.
