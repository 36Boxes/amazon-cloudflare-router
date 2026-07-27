# Cheatsheet

The three commands you'll use 95% of the time.

> **Note:** commands below use `zon-tagger` as shorthand for the CLI.
> Set that up as a shell alias for `python orders.py` — see
> [SETUP.md § 8b](SETUP.md#8b-optional-add-a-zon-tagger-shell-alias).
> If you skip the alias, substitute `python orders.py` in every command
> below.

## Before you place an order — start a session

```
zon-tagger now <destination-code>
```

Example:

```
zon-tagger now london
✓ Active: London flat
```

Any Amazon order confirmation that arrives while this is active gets
auto-tagged for that destination. Shipping updates (dispatched, out for
delivery, arriving today, delivered) will later forward to that
destination's inbox automatically.

Check what's active:

```
zon-tagger now             # or:  zon-tagger status
```

## When you're done placing orders — stop the session

```
zon-tagger stop
```

You **don't have to** stop it — orders you place next don't have to be for
this destination. But if you stop, any Amazon confirmations that arrive
after will land in the "untagged" bucket (visible in the daily digest with
tag buttons, or fix with `zon-tagger retag`).

Common flow:

```
zon-tagger now london
# ... place orders on Amazon shipping to London ...
zon-tagger now parents    # switch to another destination
# ... place orders shipping to Parents' house ...
zon-tagger stop           # done for the day
```

## Adding a new destination — 2 steps

### Step 1 — Verify the destination inbox in Cloudflare

1. Open <https://dash.cloudflare.com> → your account → **Email → Email Routing**
2. Any zone with Email Routing enabled works (destination addresses are
   account-wide). `your-domain.example` is a good default.
3. **Destination Addresses** tab → **Add destination address**
4. Enter the destination's real inbox → Cloudflare sends a verification link
   → recipient clicks it → status becomes ✅ Verified.

Only do this **once per new email address** — verifications are permanent.

### Step 2 — Register it in the system

```
zon-tagger dest add <code> <email> --name "Display Name"
```

Example:

```
zon-tagger dest add london london@family.com --name "London flat"
✓ Added destination london → london@family.com
```

Rules for `<code>`:

- Pick something short and memorable — `london`, `parents`, `office`, `home`
- One word, no spaces (URL-safe)
- Case-insensitive by convention (I've been using lowercase)

Display name is optional but nice — it's what shows in the digest.

## Handy extras

```
zon-tagger dest list                        # all destinations
zon-tagger status                           # session + 24h counts + awaiting-refund
zon-tagger untagged                         # orders needing a destination
zon-tagger retag <order#> <dest>            # fix a wrong tag
zon-tagger untag <order#>                   # remove a tag (order → Untagged)
zon-tagger cancel <order#>                  # mark cancelled manually
zon-tagger uncancel <order#>                # undo a cancellation
zon-tagger refund <order#>                  # mark a cancelled order refunded
zon-tagger awaiting-refund                  # list all cancelled-not-refunded
zon-tagger history --days 7                 # recent orders
zon-tagger history --dest london --days 30   # filter to one destination
zon-tagger review                           # trigger digest email now
```

Tab-completion works on all subcommands. **After adding a new command, open
a fresh PowerShell window** so the completion list refreshes.

The daily digest email also has tap-through links:

- Every tagged order shows `→ <destination>` buttons (retag), a red
  `✕ untag` button (removes the tag), and a red `✗ cancel` button.
- Every untagged order shows `Tag <destination>` buttons plus `✗ cancel`.
- Every cancelled order awaiting a refund shows a `✓ Mark refunded` button.

Links expire 7 days after the digest is sent — after that, use the CLI.

## Automatic cancellation

If Amazon sends an "Account Protection Services" bulk-cancellation email
(sender name contains "Amazon Account Protection Services"), the worker
auto-marks every order **on that Amazon account** (i.e. received on the
same inbox as the hold email) **placed in the last 36 hours that hasn't
already been forwarded** as cancelled. Orders on other accounts routed
through the same Worker are untouched. Those orders then appear in the
digest's **Awaiting refund** section (persists all-time until you mark
them refunded).

To undo a false-positive bulk cancel, run `zon-tagger uncancel <order#>`.

## The full reference

See `USAGE.md` for every option and troubleshooting. See `SPEC.md` for how
the whole system works under the hood.
