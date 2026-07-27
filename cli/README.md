# cli/

Python CLI for driving the Worker. Talks to the Worker's admin HTTPS API
using a bearer token.

## Install

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Configure

Once the Worker is deployed (see `../SETUP.md`):

```powershell
python orders.py init
```

Prompts for the Worker URL and the `ADMIN_TOKEN`. Writes
`~/.config/orders/config.json` (Windows: `%USERPROFILE%\.config\orders\config.json`).

Override the config path with `$env:ORDERS_CONFIG = "path\to\config.json"`
if you want to keep it elsewhere.

## Commands

See `../USAGE.md` for the full reference. Cheat sheet:

```
orders now <dest>                Activate session
orders stop                      Clear session
orders status                    What's active + recent counts
orders dest add|rm|list          Manage destinations
orders retag <order#> <dest>     Correct a tag
orders untagged                  Orders needing tags
orders history [--dest] [--days] Audit trail
orders review                    Trigger digest now
```
