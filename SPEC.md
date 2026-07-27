# SPEC — Auto Amazon Destination Forwarding

Definitive specification for the system. Read this end-to-end before making
changes. Section headings correspond to modules in the code.

---

## 1. Problem

You place Amazon guest-checkout orders on behalf of several people who each
live at their own **destination** (a delivery address that has an associated
email inbox). Every Amazon email currently lands in one master Gmail. You want
to:

- Continue receiving **every** Amazon email in your master Gmail unchanged
  (order confirmations, dispatched, invoices, refunds, cancellations, etc.)
- Automatically forward **only** the "out for delivery" / "arriving today"
  notifications to the destination's inbox so the household there knows a
  parcel is coming.
- Keep everything else private to you.

The Amazon email itself does not carry the shipping address or a recipient
name that reliably identifies the destination, so the system needs a way to
**pre-associate each order number with a destination** at ordering time, and
then use that association days later when the delivery email arrives.

---

## 2. Core model

- **Destination** — a stable address with an inbox to notify. Identified by a
  short code you choose (`D1`, `london`, `parents`, …). Has an `email` and a
  human-readable `display_name`.
- **Session** — a single-slot marker on the server saying "orders placed now
  are for destination X". You set it via CLI before placing a batch of orders
  and clear (or switch) it when done.
- **Order** — an Amazon order number extracted from a confirmation email.
  Stored with its destination code, the extracted recipient first name, the
  product title, timestamps for placement / tagging / delivery / forwarding /
  cancellation.

Names of recipients at a destination are **not modelled** — they change
constantly. Names are only extracted from emails and shown to you in the
daily digest as a visual sanity check.

---

## 3. Typical day

```
09:00 ─ Yesterday's digest email lands in Gmail.
10:15 ─ You need to order for the London flat.
        $ orders now D1
        ✓ Active: D1
10:20 ─ Place 4 Amazon guest-checkout orders shipping to London.
15:40 ─ Switch destinations.
        $ orders now D2
        ✓ Switched: D1 → D2
15:45 ─ Place 3 more orders shipping to Parents' house.
17:00 ─ (Optional) $ orders stop

Days later:
──── ─ "Arriving today" for one of London's orders lands.
     ─ London family inbox also receives it automatically. Untouched by you.
```

You never run anything reactively. The only recurring action is `orders now
<dest>` before a batch.

---

## 4. Architecture

```
                                          ┌────────────────────────────┐
                                          │       Your Gmail           │
                                          │   (unchanged — sees all)   │
                                          └─────────────▲──────────────┘
                                                        │ always forwarded
                                                        │
                     ┌──────────────────────────────────┼──────────────────────────┐
                     │       Cloudflare Email Worker    │                          │
Amazon email  ──────►│    (request-email-filter)        │                          │
(any lifecycle       │                                  │                          │
 email)              │  parses subject + body           │                          │
                     │                                  │                          │
                     │  ┌──────────────────────────┐   ┌───────────────────────┐  │
                     │  │ Is it a CONFIRMATION?    │   │ Is it a DELIVERY      │  │
                     │  │ (from auto-confirm@amaz.)│   │  notification?        │  │
                     │  │                          │   │                       │  │
                     │  │ ▸ read session.current   │   │ ▸ extract order#      │  │
                     │  │ ▸ extract order#, name,  │   │ ▸ look up in D1       │  │
                     │  │   product title          │   │ ▸ dedup check         │  │
                     │  │ ▸ INSERT INTO orders(…)  │   │ ▸ forward to dest     │──┼──► london@…, parents@… etc
                     │  └──────────────────────────┘   └───────────────────────┘  │
                     │                                                             │
                     │  ┌──────────────────────────┐   ┌───────────────────────┐  │
                     │  │ Is it a CANCELLATION?    │   │ Retag click           │  │
                     │  │ ▸ UPDATE cancelled_at    │   │ (HTTPS /retag?…)      │  │
                     │  └──────────────────────────┘   │ ▸ verify HMAC         │  │
                     │                                  │ ▸ UPDATE orders      │  │
                     │  ┌──────────────────────────┐   └───────────────────────┘  │
                     │  │ Cron 09:00 daily         │                              │
                     │  │ ▸ build + send digest    │──┼──► your Gmail (digest)    │
                     │  └──────────────────────────┘                              │
                     │                                                             │
                     │            D1 database (SQLite on CF)                       │
                     │  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
                     │  │destinations │  │ orders   │  │ session  │  │  audit   │ │
                     │  └─────────────┘  └──────────┘  └──────────┘  └──────────┘ │
                     └─────────────────────────────────────────────────────────────┘

                     ▲
                     │  CLI on your machine (Python, in /cli):
                     │
                     │    orders now D1           ◄── your only recurring action
                     │    orders now / stop
                     │    orders dest add / rm / list
                     │    orders retag <n> <dest>
                     │    orders untagged / history / review
                     │
                     └── talks to Worker /admin endpoint over HTTPS + bearer token
```

Components:

- **Cloudflare Email Worker** (`worker/`) — one script, deployed as
  `request-email-filter`. Runs three entry points:
  - `email(message, env, ctx)` — every incoming email routed to it (all
    catch-alls across every zone)
  - `fetch(request, env, ctx)` — admin API for CLI + HMAC retag link handler
  - `scheduled(event, env, ctx)` — daily cron for digest and auto-expire
- **D1 database** — SQLite on Cloudflare. Schema in `worker/schema.sql`.
- **Python CLI** (`cli/orders.py`) — talks to the Worker admin API.

This deployment is a **drop-in replacement** for the previous
`request-email-filter` Worker (the same name, deployed over the top). It
preserves the previous Worker's silent-drop rule for Amazon "invitation
request received" emails and adds all destination-forwarding logic on top.
Because the Worker name is unchanged, **no catch-all routing rules need to
change** — every zone that already points its catch-all at
`request-email-filter` will keep working without further action.

---

## 5. Email routing

The Worker takes over as the catch-all target on every zone that already
points its catch-all at `request-email-filter` (as configured by
`cloudflare-subdomain-adder/set_email_worker_catchall.py`). No per-address
rules are required — Amazon can send to any address on any of your
catch-all-enabled zones and the Worker will pick it up.

Recommended conventions (not enforced):

| Address                        | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `amazon@<yourdomain>`          | The address to put on your Amazon account            |
| `unrouted@<yourdomain>`        | Fallback for delivery emails with no matching order tag |
| `digest@<yourdomain>`          | Sender identity for the daily digest email           |

The delivery-forwarding step uses Cloudflare's `send_email` binding, which
requires each **destination inbox** to be a verified destination address in
Cloudflare Email Routing. This is a one-time click-to-verify per new
destination.

Only `amazon@...` and `unrouted@...` are required for the MVP. The other two
are reserved so we can grow into them without changing routing.

---

## 6. Data model

Full schema in `worker/schema.sql`.

```sql
CREATE TABLE destinations (
  code          TEXT PRIMARY KEY,        -- e.g. 'D1', 'london', 'parents'
  email         TEXT NOT NULL,           -- verified destination inbox
  display_name  TEXT,
  created_at    INTEGER NOT NULL         -- epoch millis
);

CREATE TABLE orders (
  order_number     TEXT PRIMARY KEY,     -- e.g. '202-1234567-1234567'
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  recipient_name   TEXT,                 -- first name extracted from email
  product_title    TEXT,                 -- extracted from email
  placed_at        INTEGER NOT NULL,
  tagged_at        INTEGER,              -- when destination_code was set
  forwarded_at     INTEGER,              -- when delivery email was forwarded
  cancelled_at     INTEGER,              -- when Amazon cancellation email seen
  refunded_at      INTEGER,              -- when user marked refunded (CLI or digest button)
  account_email    TEXT                  -- which Amazon inbox this order arrived on (message.to)
);

CREATE INDEX idx_orders_placed_at        ON orders(placed_at);
CREATE INDEX idx_orders_dest             ON orders(destination_code);
CREATE INDEX idx_orders_account_email    ON orders(account_email);
CREATE INDEX idx_orders_active           ON orders(cancelled_at)
  WHERE cancelled_at IS NULL;
CREATE INDEX idx_orders_awaiting_refund  ON orders(cancelled_at)
  WHERE cancelled_at IS NOT NULL AND refunded_at IS NULL;
CREATE INDEX idx_orders_refunded_at      ON orders(refunded_at)
  WHERE refunded_at IS NOT NULL;

CREATE TABLE session (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  destination_code TEXT REFERENCES destinations(code) ON DELETE SET NULL,
  set_at           INTEGER,
  expires_at       INTEGER               -- NULL = no auto-expire
);

CREATE TABLE audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  action        TEXT NOT NULL,           -- 'session-set','session-stop',
                                         -- 'order-tagged','order-retagged','order-untagged',
                                         -- 'delivery-forwarded','order-cancelled',
                                         -- 'order-uncancelled','order-refunded',
                                         -- 'delivery-unrouted','digest-sent'
  order_number  TEXT,
  from_dest     TEXT,
  to_dest       TEXT,
  actor         TEXT,                    -- 'worker' | 'worker-account-hold' | 'cli' | 'retag-link' | 'refund-link' | 'cron'
  note          TEXT
);
```

**Retention**: `orders` rows auto-purged after 90 days
(configurable via `RETENTION_DAYS` env var), **except** orders that are
cancelled but not yet refunded — those persist indefinitely so they keep
appearing in the digest's Awaiting-refund section until the user marks
them refunded. `audit` kept for 180 days.

**Migrations**: baseline schema in `worker/schema.sql`; incremental changes
live under `worker/migrations/` and are applied with `npm run
db:migrate:remote` (wraps `wrangler d1 migrations apply`).

---

## 7. Amazon email detection

### 7.1 Confirmation email

Match all of:

- `From:` header matches `/(?:auto-confirm|order-update)@amazon\./i`
- Subject contains "order" (any locale)
- Body contains an order number matching `\b\d{3}-\d{7}-\d{7}\b`

On match:

1. Extract order number.
2. Extract recipient first name (see 7.4).
3. Extract product title (see 7.5).
4. Read current session.
5. `INSERT` into `orders` with `destination_code = session.destination_code`
   (may be `NULL` — that's the "untagged" case).
6. Always forward original message to master Gmail.

### 7.2 Delivery-notification email

Match subject against:

```
/out for delivery/i
/arriving today/i
/will be delivered today/i
/your (?:package|parcel) is on its way/i        (some locales)
```

On match:

1. Extract order number.
2. `SELECT destination_code, forwarded_at FROM orders WHERE order_number = ?
   AND cancelled_at IS NULL`.
3. If no row / no destination / already forwarded → forward original to
   `unrouted@` (only if truly no row/destination; dedup silently otherwise).
4. Else → forward to `destinations.email`, set `forwarded_at = now()`.
5. Always forward original message to master Gmail.

### 7.3 Cancellation email (per-order)

Match subject against:

```
/order.*(?:has been|was) (?:cancelled|canceled)/i
/cancellation of your.*order/i
```

On match:

1. Extract order number.
2. `UPDATE orders SET cancelled_at = now() WHERE order_number = ?`.
3. Always forward original to master Gmail.

### 7.3b Account-hold email (per-account bulk cancellation)

Amazon periodically sends a single "Account Protection Services" email
that cancels every pending order on the target account without listing
which. Detection is sender-name-only (we rely on Cloudflare's edge
SPF/DKIM/DMARC to reject forgeries before the Worker sees them):

```
/Amazon Account Protection Services/i     (matched against parsed.from.name
                                           AND the raw "From:" header)
```

On match:

1. Read `message.to` — the routed recipient address, which uniquely
   identifies which Amazon account/inbox this hold email is for.
2. `UPDATE orders SET cancelled_at = now() WHERE placed_at >= now() -
   36h AND forwarded_at IS NULL AND cancelled_at IS NULL AND
   LOWER(account_email) = LOWER(?) RETURNING …` — 36-hour window,
   scoped by account so hold emails for one account can never touch
   orders belonging to another account routed through the same Worker.
   Already-forwarded orders (delivery notification already sent) are
   left alone.
3. Audit-log each flipped row with `action = 'order-cancelled'`,
   `actor = 'worker-account-hold'`, `note = "bulk-cancelled by
   account-hold email to <account>"`.
4. Always forward original to master Gmail.

`account_email` is populated when an order-confirmation email is first
seen (from `message.to`). Rows created before migration 0003 have
`account_email = NULL` and are naturally excluded from bulk-cancel.

To undo a false positive: `orders uncancel <order#>`.

### 7.3c Refund (user-driven)

There is no email pattern for refunds — Amazon's refund emails aren't
reliable enough to trust. Refunds are recorded when the user acts:

- Digest button `[✓ Mark refunded]` on any awaiting-refund row →
  `GET /refund?…` → HMAC-verified → `markOrderRefunded`.
- CLI: `orders refund <order#>` → `POST /admin/orders/{n}/refund`.

Both paths audit `action = 'order-refunded'` with `actor = 'refund-link'`
or `'cli'`.

### 7.4 Recipient-name extraction

Try in order, return first hit:

```
/Delivering to:\s*([A-Z][a-z]+)/
/Ship(?:ping)? to:\s*([A-Z][a-z]+)/
/Deliver(?:ing|y) to:\s*([A-Z][a-z]+)/i
```

If none match, store `NULL` (digest shows `??`). We deliberately do **not**
fall back to the "Hello X" greeting because that's the account holder, not
the recipient.

### 7.5 Product-title extraction

Try in order:

```
/Your Amazon(?:\.\w+)? order of\s+"([^"]+)"/i
/Order details?:[^\n]*\n\s*([^\n]{5,120})/i
/^\s*"([^"]{5,120})"\s*$/m                       (first quoted line in body)
```

Trim to 120 chars for the digest. Not required for routing — informational.

---

## 8. Daily digest

### 8.1 Trigger

Cron `0 9 * * *` in Europe/London (adjust in `wrangler.toml`).

### 8.2 Content — grouped, HTML

- Header: date, active session (if any).
- One section per destination that had activity in the last 24h. Each order
  shown as: `#order  product_title  → recipient_name  [Retag…]`.
- **Untagged** section: orders with `destination_code IS NULL`.
- **Awaiting refund** section: every order with
  `cancelled_at IS NOT NULL AND refunded_at IS NULL`, all-time (persists
  every digest until the user marks it refunded). Each row has a signed
  `[✓ Mark refunded]` button.
- **Refunded in last 24h** section: read-only confirmation of everything
  the user (or refund-link handler) marked refunded since the last digest.
- **Forwarded** section: orders where `forwarded_at` in the last 24h.

Every non-cancelled order card (in both tagged and untagged sections) also
has a signed `[✗ cancel]` button, useful when Amazon cancels an order
silently or the cancellation email is missed. Clicking it hits
`/cancel?order=…&exp=…&sig=…` with signed data `${order}:cancel:${exp}`.

Each `[Retag]` / `[Tag X]` button is a signed HTTPS link:
`https://<worker>/retag?order=<n>&dest=<code>&exp=<ts>&sig=<hmac>`.
Refund buttons use the same signing scheme:
`https://<worker>/refund?order=<n>&exp=<ts>&sig=<hmac>` with signed data
`${order}:refund:${exp}`.

### 8.3 Delivery

Sent from the Worker via the `send_email` binding to `MASTER_EMAIL`. The
subject is `Amazon summary — <date>`.

### 8.4 On-demand

`orders review` from the CLI POSTs `/admin/review` to trigger a digest
immediately outside the cron schedule.

---

## 9. Correction workflows

- **Digest retag button** — one-tap in Gmail. Signed HMAC link → Worker
  updates `destination_code`, writes audit row.
- **CLI retag** — `orders retag <order#> <dest>`.
- **Mid-session mistake** — switch destinations (`orders now D2`) or just
  retag the affected order after the fact. Order confirmation is already
  written; the tag just changes.

Both correction paths refuse to retag an order whose delivery email has
already been forwarded — the client at the old destination will already have
seen the notification, and re-forwarding to a new destination creates
confusion. The CLI overrides this with `--force`.

---

## 10. Security

- **Admin API** authenticated with a static bearer token
  (`ADMIN_TOKEN` — long random string, stored as a Worker secret).
- **Retag links** signed with HMAC-SHA256 using `HMAC_SECRET` (separate
  secret). Tokens embed `(order_number, dest_code, expiry_epoch_ms)` and
  expire 7 days after digest send.
- **No public state exposure** — all admin endpoints require the bearer.
- **Address verification** — Cloudflare requires each destination inbox to
  click-verify once before it can receive forwarded mail. This is Cloudflare
  Email Routing's own safeguard, not ours.

---

## 11. Scale

- **Storage**: ~180 bytes / order. 100k orders ≈ 18 MB, well inside D1's
  500 MB free tier.
- **Workers requests**: free tier 100k/day.
- **KV writes**: not used (we use D1).
- **D1 writes**: free tier 100k/day. Each order costs ~3 writes.
- **Practical ceiling on free tier**: ~30 orders/day sustained is fine;
  a few hundred/day bursts fine; hundreds/day sustained → move to paid
  Workers plan ($5/mo).

Auto-expire (`RETENTION_DAYS`, default 90) keeps `orders` size steady.

---

## 12. Failure modes

| Failure                                | Consequence                        | Recovery                          |
| -------------------------------------- | ---------------------------------- | --------------------------------- |
| Forgot `orders now` before ordering    | Order stored, `destination_code = NULL` | Digest shows in Untagged. Tap tag button, or `orders retag`. |
| Set wrong destination                  | Order tagged wrong                 | Retag in digest, or `orders retag`. Before delivery email. |
| Amazon uses new email subject phrasing | Delivery not detected              | Digest shows no forward that day. Add pattern to `amazon.ts`. |
| Amazon changes order-number format     | Nothing extracted                  | Same as above.                    |
| Destination inbox not verified in CF   | Forward fails                      | Cloudflare bounces to Worker; worker logs to audit + forwards to `unrouted@`. |
| Worker throws                          | Message dropped                    | `email_worker` retries per CF policy. Persistent failure → forwards do not happen; master Gmail still receives Amazon original. |
| Per-order cancellation email missed    | Dead tag persists                  | Auto-expires after `RETENTION_DAYS`. No harm — delivery email never comes for cancelled orders. |
| Account-hold email false-positives an order | Only orders on the same Amazon inbox as the hold email are affected (`account_email` match), scoped to last 36h + unforwarded. False positive shown in Awaiting-refund. | `orders uncancel <order#>` — clears both `cancelled_at` and `refunded_at`. |
| Attacker spoofs "Amazon Account Protection Services" From header | Cancels last 36h of pending orders **on the spoofed account only** (not other accounts routed through the same Worker) | Cloudflare edge SPF/DKIM/DMARC reject un-signed forgeries before Worker sees them. If one leaks, `orders uncancel` per order. |
| User forgets a cancelled order → never marks refunded | Row persists in Awaiting-refund forever (exempt from purge) | Feature, not bug. When Amazon credits you, `orders refund <order#>` or tap digest button. |
| Delivery email arrives before order confirmation (rare) | No lookup possible | Falls through to `unrouted@`. Tag after the fact; won't help this delivery but tag is correct for any follow-up email. |

---

## 13. Configuration (Worker secrets & env)

Set via `wrangler secret put` or `.dev.vars` for local dev:

| Name                | Type      | Description                                        |
| ------------------- | --------- | -------------------------------------------------- |
| `ADMIN_TOKEN`       | secret    | Bearer token for CLI → Worker admin API.           |
| `HMAC_SECRET`       | secret    | Signing key for retag links.                       |
| `MASTER_EMAIL`      | var       | Your Gmail address, receives everything + digest.  |
| `UNROUTED_EMAIL`    | var       | Fallback address for orphan deliveries.            |
| `FROM_ADDRESS`      | var       | The address the Worker sends digest FROM (must be a verified sender in CF Email Routing; e.g. `notify@orders.example.com`). |
| `RETENTION_DAYS`    | var       | Order row TTL, default 90.                         |
| `DIGEST_TIMEZONE`   | var       | For date labels in digest (e.g. `Europe/London`).  |

Bindings (in `wrangler.toml`):

- `DB`  — D1 database binding
- `EMAIL` — send_email binding for outbound (digest, if using CF's outbound; forwards use `message.forward`)

---

## 14. CLI

Python 3.9+, one file (`cli/orders.py`), no external state — reads config
from `~/.config/orders/config.json` (or `$ORDERS_CONFIG`):

```json
{
  "api_url": "https://request-email-filter.<your-subdomain>.workers.dev",
  "api_token": "<same value as ADMIN_TOKEN>"
}
```

Commands:

```
orders now <dest> [--for <duration>]      # activate session
orders now                                # show current
orders stop                               # clear session
orders status                             # show session + counts + awaiting-refund

orders dest add <code> <email> [--name "..."]
orders dest rm <code>
orders dest list

orders retag <order#> <dest> [--force]
orders untag <order#> [--force]           # remove destination tag
orders cancel <order#>                    # manually mark cancelled
orders uncancel <order#>                  # undo cancellation (also clears refunded)
orders refund <order#>                    # mark a cancelled order refunded
orders awaiting-refund                    # list all cancelled-not-refunded

orders untagged
orders history [--dest CODE] [--days N]
orders review                             # trigger digest now
```

All output plain-text, table-formatted where sensible. Exit non-zero on
errors.

---

## 15. Deployment (one-time)

See `SETUP.md`. Broadly:

1. Create D1 database, apply schema via `npm run db:migrate:remote`
   (uses `worker/migrations/` — recommended) or apply `worker/schema.sql`
   directly in one shot.
2. Deploy the Worker with `wrangler deploy`.
3. Set secrets: `ADMIN_TOKEN`, `HMAC_SECRET`.
4. Set vars: `MASTER_EMAIL`, `UNROUTED_EMAIL`, `FROM_ADDRESS`,
   `DIGEST_TIMEZONE`, `RETENTION_DAYS`.
5. Add the four routing rules (`amazon@`, `tag@`, `admin@`, `unrouted@`) on
   your Email Routing zone → route to Worker `request-email-filter`.
6. In Cloudflare Email Routing → Destination Addresses, add + verify each
   destination inbox once.
7. Point Amazon's account email at `amazon@orders.example.com`.
8. Configure the CLI (`cli/orders.py --init`).
9. Add your destinations: `orders dest add london london@family.com`.

---

## 16. Non-goals

- **Multi-user access** — single-operator system.
- **Web dashboard** — the CLI + digest email cover all interactions. A
  dashboard is a possible v2.
- **Full inbox mirroring for destinations** — clients get delivery emails
  only, by design.
- **Reply routing** — clients can't reply through the system; if they do,
  the reply goes back to Amazon since we don't rewrite `Reply-To`.
- **Non-Amazon retailers** — patterns are Amazon-specific. Extensible but
  not built in.
