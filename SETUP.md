# SETUP — One-time deployment

Complete deployment from a fresh Cloudflare account and a fresh clone of this
repo. Do this once per environment. All commands assume you're at the repo
root.

## 0. Prerequisites

- **Cloudflare account** with a zone that has **Email Routing** enabled
- **Cloudflare Workers** — free tier is fine
- **Node.js 18+** and **npm** (for `wrangler`)
- **Python 3.9+** (for the CLI)
- A Cloudflare **API token** with:
  - `Account` → `Workers Scripts` → `Edit`
  - `Account` → `Workers KV Storage` → `Edit` (unused today; reserved)
  - `Account` → `D1` → `Edit`
  - `Zone` → `Email Routing Rules` → `Edit`
  - `Zone` → `Email Routing Addresses` → `Edit`

## 1. Install Wrangler

```powershell
cd worker
npm install
```

(Installs `wrangler` and `postal-mime` locally. No global install required.)

Authenticate wrangler once:

```powershell
npx wrangler login
```

Or set `CLOUDFLARE_API_TOKEN` in your shell environment (matches your
`cloudflare-subdomain-adder` repo convention).

## 2. Create the D1 database

```powershell
npx wrangler d1 create amazon-destination-forwarder
```

Copy the `database_id` from the output. Paste it into `worker/wrangler.toml`
under `[[d1_databases]]`.

Then apply the schema. Fresh installs use the migration system (idempotent
and future-proof — new migration files added later will apply in order):

```powershell
npm run db:migrate:remote
```

Or, if you prefer to apply the baseline schema in one shot without the
migration bookkeeping:

```powershell
npx wrangler d1 execute amazon-destination-forwarder --file=./schema.sql --remote
```

Existing deployments upgrading to add the `refunded_at` column (refund
tracking) just run the migrate command — wrangler will apply only the
migrations that haven't run yet:

```powershell
cd worker
npm run db:migrate:remote
```

## 3. Set secrets

Two secrets. Generate long random strings for both — 32+ characters each.

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put HMAC_SECRET
```

Save `ADMIN_TOKEN` — the CLI needs it in step 8.

## 4. Set vars

`worker/wrangler.toml` is gitignored (it holds your real domain + D1
database ID). Start from the tracked template:

```powershell
cd worker
Copy-Item wrangler.toml.example wrangler.toml
```

Then edit `worker/wrangler.toml` under `[vars]`:

```toml
[vars]
MASTER_EMAIL     = "you@gmail.com"
UNROUTED_EMAIL   = "unrouted@orders.example.com"
FROM_ADDRESS     = "notify@orders.example.com"
DIGEST_TIMEZONE  = "Europe/London"
RETENTION_DAYS   = "90"
```

`FROM_ADDRESS` **must** be a verified sender address in Cloudflare Email
Routing → **Destination Addresses** (yes, Cloudflare uses the same list for
outbound-from). You'll verify it in step 6.

## 5. Deploy the Worker

```powershell
npx wrangler deploy
```

Worker name: `request-email-filter` — same name as your existing Worker, so
this deployment **overwrites** it in place. Because every zone's catch-all
already points to `request-email-filter`, no routing rules need to change.
Note the workers.dev URL from the output — you'll need it in step 8.

## 6. Verify destination addresses

Cloudflare Email Routing requires every address the Worker forwards **to**
(via `message.forward()`) and every address `send_email` targets to be a
verified destination address.

Go to **Cloudflare dashboard → Your zone → Email → Routing → Destination
Addresses** and add + verify:

| Address                          | Why                                              |
| -------------------------------- | ------------------------------------------------ |
| Your master Gmail                | Every email is forwarded here + digest lands here |
| Each destination inbox           | e.g. `london@family.com`, `parents@example.com`  |

Each address gets a verification email — click the link once, done.

**Not required to verify:**

- **`FROM_ADDRESS`** (e.g. `digest@yourdomain.com`) — the sender identity
  for the digest email. The `send_email` binding just needs it to be on a
  domain with Email Routing enabled, which every zone in your account
  already is.
- **`UNROUTED_EMAIL`** — if you use `unrouted@<yourdomain>` where
  `<yourdomain>` already has a catch-all pointing at the Worker (or at
  Gmail), no extra setup is needed. The catch-all rule catches it.

## 7. Add routing rules (probably nothing to do)

Because this Worker is a **drop-in replacement** for your existing
`request-email-filter` script, every zone's catch-all rule already routes
to it. The step-5 deploy overwrote the script; the routing rules are
unchanged and still point to the same Worker name.

**Nothing to do at Cloudflare in this step** unless:

- You want to add a specific `amazon@yourdomain.com` rule so it's obvious
  in the dashboard which address you registered on Amazon. Optional and
  cosmetic — the catch-all handles it anyway.
- You have a zone that *doesn't* have Email Routing enabled and you want
  to include it. Run `python cloudflare-subdomain-adder/add_cf_subdomains.py`
  and `set_email_worker_catchall.py --worker request-email-filter --apply`
  to enable and point it.

## 8. Configure the CLI

```powershell
cd ..\cli
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

python orders.py init
```

`init` writes `~/.config/orders/config.json` with the Worker URL and admin
token. Or you can create it by hand:

```json
{
  "api_url": "https://request-email-filter.<subdomain>.workers.dev",
  "api_token": "<the ADMIN_TOKEN from step 3>"
}
```

Sanity-check:

```powershell
python orders.py status
```

Should print `No active session` (which is correct).

## 8b. (Optional) Add a `zon-tagger` shell alias

The CHEATSHEET assumes you've aliased `python orders.py` to `zon-tagger`
so day-to-day commands stay short (`zon-tagger now london` vs.
`python orders.py now london`). Set it up once — the alias should point at
the venv's Python so you never need to activate the venv manually.

**PowerShell** — append to your `$PROFILE` (create it if it doesn't exist:
`New-Item -Path $PROFILE -ItemType File -Force`):

```powershell
function zon-tagger {
    & "C:\path\to\repo\cli\.venv\Scripts\python.exe" `
      "C:\path\to\repo\cli\orders.py" @args
}
```

Reload: `. $PROFILE`. Test: `zon-tagger status`.

**bash / zsh** — append to `~/.bashrc` or `~/.zshrc`:

```bash
alias zon-tagger='/path/to/repo/cli/.venv/bin/python /path/to/repo/cli/orders.py'
```

Reload: `source ~/.bashrc`. Test: `zon-tagger status`.

Skip this step if you'd rather type `python orders.py …` every time —
every `zon-tagger` in CHEATSHEET.md maps 1:1 to `python orders.py`.

## 9. Add your destinations

```powershell
python orders.py dest add D1 london@family.com --name "London flat"
python orders.py dest add D2 parents@example.com --name "Parents' house"
python orders.py dest list
```

Each destination email must already be verified (step 6). If it isn't, the
CLI will refuse and tell you.

## 10. Point Amazon at your inbox

On your Amazon account (or per guest-checkout), use
`amazon@orders.example.com` as the email address.

This is the only piece of state on Amazon's side. Everything else lives in
Cloudflare.

## 11. Smoke test

Place a real, cheap order (a few pounds) as guest checkout, using one of
your destinations. In a separate terminal:

```powershell
python orders.py now D1
```

- Within a minute or two, the Amazon confirmation should land in your Gmail.
- Then run `python orders.py history --days 1` — you should see the order
  row with `destination_code = D1`.
- Days later, when Amazon sends the "arriving today" email, check that it
  also lands at `london@family.com`.

If any step fails, see the troubleshooting table in `USAGE.md`.

## 12. Rollback

Everything is in one Worker script and one D1 database. To fully remove:

```powershell
npx wrangler delete request-email-filter
npx wrangler d1 delete amazon-destination-forwarder
```

And delete the two routing rules from step 7. Your master Gmail continues to
receive Amazon emails as before — nothing else was changed.
