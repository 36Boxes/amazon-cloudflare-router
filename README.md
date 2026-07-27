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

## How it plugs into Cloudflare

This Worker is designed to sit behind an Email Routing **catch-all** on
whatever domain you receive Amazon emails on. The catch-all points at
this Worker; the Worker forwards everything to your master Gmail as
normal, and intercepts only the Amazon "arriving today / out for
delivery" emails to re-route them to the tagged destination inbox.

If you don't yet have that catch-all in place, SETUP.md §7 walks you
through pointing it at the Worker.
