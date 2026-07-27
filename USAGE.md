# USAGE — Day-to-day

Everything you do after setup is one of a handful of CLI commands or a tap
in the daily digest email.

## The essential loop

```
$ orders now D1              # before a batch of orders for D1
  ... place orders on Amazon ...
$ orders now D2              # switch
  ... place next batch ...
$ orders stop                # optional, safe to leave running
```

That's the entire day-to-day. Everything below is for edge cases and
maintenance.

## CLI reference

All commands read config from `~/.config/orders/config.json`
(override with `$ORDERS_CONFIG`). All output is plain text; exit non-zero on
error.

### Session

```
orders now                          Show current session (empty if none)
orders now <dest>                   Activate a session for destination
orders now <dest> --for 2h          Auto-expire after 2h
orders stop                         Clear the session
orders status                       Session + short summary of today
```

### Destinations

```
orders dest add <code> <email> [--name "Display name"]
orders dest rm <code>
orders dest list
```

Adding a destination checks that `<email>` is a verified destination in your
Cloudflare Email Routing account. If it isn't, the CLI tells you and stops.
Verify it in the dashboard and try again.

### Orders

```
orders untagged                     List orders needing a destination
orders retag <order#> <dest>        Fix a tag (before delivery is forwarded)
orders retag <order#> <dest> --force  Retag even after delivery was forwarded
orders untag <order#>               Remove destination (moves order to Untagged)
orders cancel <order#>              Manually mark cancelled
orders uncancel <order#>            Undo a cancellation (also clears refunded)
orders refund <order#>              Mark a cancelled order refunded
orders awaiting-refund              List all cancelled-not-refunded orders
orders history                      Last 20 orders
orders history --dest D1            Filter by destination
orders history --days 30            Widen the window
```

### Digest

```
orders review                       Send the digest right now (bypass cron)
```

## The daily digest

Lands in your Gmail every morning at the time set by `DIGEST_TIMEZONE`. Skim
when you can be bothered. Each order line looks like:

```
#202-1234-5678  Sony WH-1000XM5 Headphones     → John    [Retag D2] [Retag D3]
```

Tap a `[Retag …]` link to move the order to a different destination. Links
are signed and expire 7 days after the digest is sent, after which they
return `Expired` and you use the CLI instead.

## Common scenarios

### I forgot to set the session before ordering

- The order lands in the **Untagged** section of tomorrow's digest.
- Tap a `[Tag …]` button, or `orders retag <order#> <dest>`.
- If you notice **before** the delivery email arrives, no harm done.
- If the delivery email already went to `unrouted@`, you'll need to forward
  it manually to the destination this once. Future emails for that order
  will route correctly.

### I set the wrong destination

Same fix: `orders retag <order#> <dest>` or the digest button.

### I want to place one order for a different destination mid-batch

```
orders now D2         # switch
  ... place that one order ...
orders now D1         # switch back
```

Sessions have no batch state — they're just a single-slot "current
destination" marker. Switch as many times as you like.

### An order was cancelled

Nothing to do. When Amazon sends the cancellation email:

- Master Gmail gets the email as always.
- The Worker marks the order `cancelled_at = now()`.
- No "arriving today" will ever come for this order.
- If one does (Amazon glitch), the Worker refuses to forward it because
  `cancelled_at IS NOT NULL`.
- The order appears in every digest under **Awaiting refund** until you
  mark it refunded (`orders refund <order#>` or the digest button).

### Amazon sent an "Account Protection Services" account-hold email

Amazon occasionally sends a **bulk** cancellation email (subject often
"Important Message About Your Account and Recent Orders", sender name
"Amazon Account Protection Services") without listing which specific
orders were cancelled. The Worker handles this per-account:

- The hold email arrived at a specific inbox (`message.to`) — that
  address identifies which Amazon account was affected.
- Every order in the DB whose `account_email` matches, placed in the
  **last 36 hours**, that hasn't yet been forwarded (delivery
  notification not yet sent), is auto-cancelled.
- Orders on other Amazon accounts routed through the same Worker are
  **not** touched.
- Already-forwarded orders are left alone — they're likely already
  delivered and can't be un-delivered.
- Each auto-cancellation is audited with `actor = "worker-account-hold"`
  and `note = "bulk-cancelled by account-hold email to <account>"` so
  you can tell them apart from per-order Amazon cancellations later.
- The master Gmail still receives the original email untouched.

If Amazon later confirms that a specific order **wasn't** actually
cancelled, undo it with:

```
orders uncancel <order#>
```

**Note:** orders placed before you deployed the per-account tracking
feature (migration 0003) have `account_email = NULL` and are naturally
excluded from bulk-cancel. Only orders created after that migration
carry the account address.

### Marking cancelled orders refunded

Cancelled orders stay in the digest's **Awaiting refund** section
indefinitely — they're exempt from `RETENTION_DAYS` purge. Once Amazon
credits you, mark them refunded so they drop out of the digest:

```
orders refund <order#>              # or tap [✓ Mark refunded] in the digest
orders awaiting-refund              # list everything still awaiting
```

Refunded orders show up in the **Refunded in last 24h** confirmation
section of the very next digest, then age out normally.

### Destination isn't receiving delivery emails

Check in order:

1. `orders history --dest D1 --days 7` — is the order there with a
   `destination_code`? If not, it's untagged; fix and wait for the next
   delivery email.
2. `orders history` will also show `forwarded_at` per row — if that's set,
   we forwarded it. Check the destination's spam / promotions folders.
3. Cloudflare dashboard → Email Routing → **Destination Addresses** — is the
   destination still verified? Sometimes CF re-requests verification after a
   long silence.
4. Check Worker logs: `npx wrangler tail request-email-filter` and
   place a test order.

### Client's email address changes

```
orders dest add <code> <new-email> --name "..."
orders dest rm <old-code>
```

(There's no in-place edit — add-new / remove-old is cleaner and creates a
clean audit trail.)

### I want to see everything for one destination

```
orders history --dest D1 --days 30
```

## Troubleshooting table

| Symptom                                                | Likely cause                                    | Fix                                                          |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `orders now` returns `Unauthorized`                    | Token wrong in config                           | Regenerate `ADMIN_TOKEN` with `wrangler secret put ADMIN_TOKEN` and update `~/.config/orders/config.json` |
| Retag link says `Invalid or expired`                   | Digest is > 7 days old                          | Use `orders retag …` from the CLI                            |
| Master Gmail stopped receiving Amazon emails           | Routing rule mis-configured                     | Confirm rule `amazon@…` → Worker exists and is enabled       |
| Destination not receiving anything                     | Destination address unverified                  | Cloudflare dashboard → Email Routing → Destination Addresses |
| Digest never arrives                                   | `FROM_ADDRESS` isn't a verified destination     | Add + verify it                                              |
| Worker logs `SendEmail failed: address not verified`   | Same                                            | Same                                                         |
| Order confirmation doesn't get tagged                  | Amazon changed subject/sender                   | Update patterns in `worker/src/amazon.ts` and redeploy       |
| Order stuck in Untagged even though session was set    | Session expired (`--for X`) between order + confirmation | Retag manually; consider not using `--for`                    |

## Logs

```
npx wrangler tail request-email-filter --format=pretty
```

Every incoming email prints a one-line summary (`confirmation | delivery |
cancellation | unrouted | ignored`) plus the extracted order number.

## Manual D1 queries

Handy for debugging:

```
npx wrangler d1 execute amazon-destination-forwarder --command="SELECT * FROM session"
npx wrangler d1 execute amazon-destination-forwarder --command="SELECT * FROM orders WHERE placed_at > strftime('%s','now','-1 day') * 1000"
npx wrangler d1 execute amazon-destination-forwarder --command="SELECT * FROM audit ORDER BY id DESC LIMIT 20"
```

## Weekly hygiene (optional)

- `orders untagged` — clean up anything you missed
- Scan the digest properly at least once a week; the name column catches
  drift you might otherwise miss for months.
