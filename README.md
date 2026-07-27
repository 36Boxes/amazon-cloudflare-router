# Auto Amazon Destination Forwarding

Automatically forward Amazon **"out for delivery"** / **"arriving today"**
emails to the right household, while your master Gmail continues to receive
everything unchanged.

You place all your Amazon orders as guest checkout and set a **session** before
each batch. The system tags each order with its destination, then routes only
the delivery notifications to that destination's inbox — days later, hands-off.

## The two-second summary

```
$ orders now D1                          # before you order for London
                                         # ... place a batch of orders ...
$ orders now D2                          # switch to Parents' house
                                         # ... place next batch ...
```

That's it. Delivery emails auto-forward days later, master Gmail keeps every
Amazon email, daily digest lands at 09:00 with a name check.

## Read next

- **[CHEATSHEET.md](CHEATSHEET.md)** — day-to-day quick reference (start/stop
  session, add destination). Read this first.
- **[SPEC.md](SPEC.md)** — the full definitive spec (data model, flows,
  Amazon patterns, failure modes, scale).
- **[SETUP.md](SETUP.md)** — one-time deployment (Worker + D1 + routing).
- **[USAGE.md](USAGE.md)** — full CLI reference and troubleshooting.

## Repo layout

```
worker/     Cloudflare Email Worker (TypeScript)
  src/      Worker source
  schema.sql D1 schema
  wrangler.toml
cli/        Python CLI (orders.py)
SPEC.md     Definitive specification
SETUP.md    One-time deployment
USAGE.md    Day-to-day usage
```

## Requirements

- Cloudflare account with at least one zone using Email Routing
- Cloudflare Workers subscription — free tier is enough for hundreds of orders
- Python 3.9+ for the CLI
- Node.js 18+ (only for `wrangler` deploy)

## Companion repos

Pairs cleanly with your existing
[`cloudflare-subdomain-adder`](../cloudflare-subdomain-adder/) which
provisions the Email Routing DNS records for subdomains. This project uses
address-level routing rules and does **not** replace your existing catch-all
Worker.
