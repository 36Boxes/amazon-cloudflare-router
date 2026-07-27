#!/usr/bin/env python3
"""orders — CLI for auto-amazon-destination-forwarding.

Talks to the Cloudflare Worker admin API. Reads config from
~/.config/orders/config.json (or $ORDERS_CONFIG), or ORDERS_API_URL +
ORDERS_API_TOKEN env vars if set.

Usage
-----
Run `python orders.py init` once, then:

    orders now <dest>          activate session for a batch
    orders now                 show current session
    orders stop                clear session
    orders status              session + last-24h counts
    orders dest add|rm|list    manage destinations
    orders retag <n> <dest>    correct a tag
    orders untag <n>           remove destination tag
    orders cancel <n>          mark cancelled manually
    orders uncancel <n>        undo a cancellation
    orders refund <n>          mark a cancelled order refunded
    orders awaiting-refund     list all cancelled-not-refunded orders
    orders untagged            orders needing tagging
    orders history             audit trail
    orders review              trigger digest now
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import requests

# Windows console defaults to cp1252 which can't render ✓/→/⚠. Force
# stdout/stderr to UTF-8 so our output is portable.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ─── config ─────────────────────────────────────────────────────

def get_config_path() -> Path:
    override = os.environ.get("ORDERS_CONFIG")
    if override:
        return Path(override)
    return Path.home() / ".config" / "orders" / "config.json"


def load_config() -> dict[str, str]:
    """Load config: prefer env vars, else config file."""
    env_url = os.environ.get("ORDERS_API_URL")
    env_tok = os.environ.get("ORDERS_API_TOKEN")
    if env_url and env_tok:
        return {"api_url": env_url, "api_token": env_tok}
    p = get_config_path()
    if not p.is_file():
        sys.exit(
            f"ERROR: no config at {p}\n"
            f"Run:  python orders.py init\n"
            f"Or export ORDERS_API_URL and ORDERS_API_TOKEN."
        )
    with p.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("api_url") or not cfg.get("api_token"):
        sys.exit(f"ERROR: {p} missing api_url or api_token")
    return {"api_url": cfg["api_url"], "api_token": cfg["api_token"]}


# ─── HTTP ───────────────────────────────────────────────────────

def api(method: str, path: str, body: Optional[dict] = None) -> Any:
    cfg = load_config()
    url = cfg["api_url"].rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {cfg['api_token']}",
        "Content-Type": "application/json",
    }
    try:
        r = requests.request(method, url, headers=headers, json=body, timeout=30)
    except requests.RequestException as e:
        sys.exit(f"ERROR: request failed: {e}")
    if not r.ok:
        try:
            msg = r.json().get("error", r.text)
        except ValueError:
            msg = r.text or f"HTTP {r.status_code}"
        sys.exit(f"ERROR [{r.status_code}]: {msg}")
    if not r.content:
        return None
    try:
        return r.json()
    except ValueError:
        return r.text


# ─── commands ───────────────────────────────────────────────────

def cmd_init(_args: argparse.Namespace) -> None:
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        ans = input(f"{path} exists. Overwrite? [y/N] ").strip().lower()
        if ans != "y":
            print("Aborted.")
            return
    print("Paste the Worker URL (e.g. https://request-email-filter.<sub>.workers.dev):")
    url = input("> ").strip().rstrip("/")
    print("Paste the ADMIN_TOKEN (from `wrangler secret put ADMIN_TOKEN`):")
    token = input("> ").strip()
    if not url or not token:
        sys.exit("ERROR: both fields required")
    with path.open("w", encoding="utf-8") as f:
        json.dump({"api_url": url, "api_token": token}, f, indent=2)
    print(f"✓ Wrote {path}")

    # Verify by calling /admin/session with the just-written config
    os.environ["ORDERS_API_URL"] = url
    os.environ["ORDERS_API_TOKEN"] = token
    try:
        s = api("GET", "/admin/session") or {}
        code = s.get("destination_code")
        print(f"✓ Connected. Current session: {code or '(none)'}")
    except SystemExit as e:
        print(f"⚠ Could not verify: {e}", file=sys.stderr)


def cmd_now(args: argparse.Namespace) -> None:
    if not args.dest:
        s = api("GET", "/admin/session") or {}
        code = s.get("destination_code")
        if not code:
            print("No active session.")
            return
        exp = s.get("expires_at")
        tail = ""
        if exp:
            tail = f" (expires {datetime.fromtimestamp(exp / 1000).strftime('%Y-%m-%d %H:%M')})"
        print(f"Active: {code}{tail}")
        return

    body: dict[str, Any] = {"destination_code": args.dest}
    if args.for_:
        secs = parse_duration(args.for_)
        body["expires_at"] = int(time.time() * 1000 + secs * 1000)
    res = api("PUT", "/admin/session", body) or {}
    label = res.get("display_name") or res.get("destination_code")
    print(f"✓ Active: {label}")


def cmd_stop(_args: argparse.Namespace) -> None:
    api("DELETE", "/admin/session")
    print("✓ Session cleared.")


def cmd_status(_args: argparse.Namespace) -> None:
    s = api("GET", "/admin/session") or {}
    code = s.get("destination_code")
    print(f"Session: {code or '(none)'}")
    since = int((time.time() - 86400) * 1000)
    orders = api("GET", f"/admin/orders?since={since}&limit=500") or []
    tagged = [o for o in orders if o.get("destination_code")]
    untagged = [o for o in orders if not o.get("destination_code")]
    forwarded = [o for o in orders if o.get("forwarded_at")]
    awaiting = api("GET", "/admin/orders/awaiting-refund?limit=500") or []
    print(
        f"Last 24h: {len(orders)} placed  ·  {len(tagged)} tagged  ·  "
        f"{len(untagged)} untagged  ·  {len(forwarded)} forwarded"
    )
    print(f"Awaiting refund (all-time): {len(awaiting)}")


def cmd_dest_add(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"code": args.code, "email": args.email}
    if args.name:
        body["display_name"] = args.name
    api("POST", "/admin/destinations", body)
    print(f"✓ Added destination {args.code} → {args.email}")


def cmd_dest_rm(args: argparse.Namespace) -> None:
    api("DELETE", f"/admin/destinations/{args.code}")
    print(f"✓ Removed destination {args.code}")


def cmd_dest_list(_args: argparse.Namespace) -> None:
    rows = api("GET", "/admin/destinations") or []
    if not rows:
        print("(no destinations)")
        return
    w_code = max((len(r["code"]) for r in rows), default=4) + 2
    w_email = max((len(r["email"]) for r in rows), default=8) + 2
    print(f"{'CODE':<{w_code}}{'EMAIL':<{w_email}}DISPLAY NAME")
    print("-" * (w_code + w_email + 20))
    for d in rows:
        print(f"{d['code']:<{w_code}}{d['email']:<{w_email}}{d.get('display_name') or ''}")


def cmd_untagged(_args: argparse.Namespace) -> None:
    rows = api("GET", "/admin/orders?untagged=true&limit=200") or []
    if not rows:
        print("(no untagged orders)")
        return
    print(f"{'ORDER':<24}{'PLACED':<20}NAME   PRODUCT")
    print("-" * 90)
    for o in rows:
        placed = datetime.fromtimestamp(o["placed_at"] / 1000).strftime("%Y-%m-%d %H:%M")
        title = (o.get("product_title") or "")[:50]
        name = o.get("recipient_name") or "?"
        print(f"{o['order_number']:<24}{placed:<20}{name:<6} {title}")


def cmd_retag(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"destination_code": args.dest}
    if args.force:
        body["force"] = True
    api("POST", f"/admin/orders/{args.order}/retag", body)
    print(f"✓ Retagged {args.order} → {args.dest}")


def cmd_untag(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {}
    if args.force:
        body["force"] = True
    api("POST", f"/admin/orders/{args.order}/untag", body)
    print(f"✓ Untagged {args.order}")


def cmd_cancel(args: argparse.Namespace) -> None:
    api("POST", f"/admin/orders/{args.order}/cancel", {})
    print(f"✓ Marked {args.order} as cancelled")


def cmd_uncancel(args: argparse.Namespace) -> None:
    api("POST", f"/admin/orders/{args.order}/uncancel", {})
    print(f"✓ Cleared cancelled state on {args.order}")


def cmd_refund(args: argparse.Namespace) -> None:
    api("POST", f"/admin/orders/{args.order}/refund", {})
    print(f"✓ Marked {args.order} as refunded")


def cmd_awaiting_refund(_args: argparse.Namespace) -> None:
    rows = api("GET", "/admin/orders/awaiting-refund?limit=500") or []
    if not rows:
        print("(no orders awaiting refund)")
        return
    print(f"{'ORDER':<24}{'DEST':<14}{'CANCELLED':<18}NAME  PRODUCT")
    print("-" * 100)
    for o in rows:
        cancelled = (
            datetime.fromtimestamp(o["cancelled_at"] / 1000).strftime("%Y-%m-%d %H:%M")
            if o.get("cancelled_at")
            else "?"
        )
        dest = o.get("destination_code") or "-"
        title = (o.get("product_title") or "")[:40]
        name = o.get("recipient_name") or "?"
        print(f"{o['order_number']:<24}{dest:<14}{cancelled:<18}{name}  {title}")


def cmd_history(args: argparse.Namespace) -> None:
    since = int((time.time() - args.days * 86400) * 1000)
    q = f"since={since}&limit=200"
    if args.dest:
        q += f"&dest={args.dest}"
    rows = api("GET", f"/admin/orders?{q}") or []
    if not rows:
        print("(no orders in window)")
        return
    print(f"{'ORDER':<24}{'DEST':<14}{'PLACED':<18}{'F':<2}{'C':<2}{'R':<2} NAME  PRODUCT")
    print("-" * 100)
    for o in rows:
        placed = datetime.fromtimestamp(o["placed_at"] / 1000).strftime("%m-%d %H:%M")
        dest = o.get("destination_code") or "-"
        fwd = "✓" if o.get("forwarded_at") else " "
        cxl = "✗" if o.get("cancelled_at") else " "
        rfd = "$" if o.get("refunded_at") else " "
        title = (o.get("product_title") or "")[:40]
        name = o.get("recipient_name") or "?"
        print(f"{o['order_number']:<24}{dest:<14}{placed:<18}{fwd:<2}{cxl:<2}{rfd:<2} {name}  {title}")


def cmd_review(_args: argparse.Namespace) -> None:
    api("POST", "/admin/review")
    print("✓ Digest triggered.")


# ─── helpers ────────────────────────────────────────────────────

def parse_duration(s: str) -> int:
    """Parse '2h', '30m', '3600' into seconds."""
    s = s.strip().lower()
    try:
        if s.endswith("h"):
            return int(float(s[:-1]) * 3600)
        if s.endswith("m"):
            return int(float(s[:-1]) * 60)
        if s.endswith("s"):
            return int(float(s[:-1]))
        return int(s)
    except ValueError:
        sys.exit(f"ERROR: bad duration '{s}' — try 30m, 2h, 3600")


# ─── argparse wiring ────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="orders",
        description="Amazon destination forwarding CLI.",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init", help="First-time config: prompt for URL + token.")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("now", help="Set/show the active destination session.")
    sp.add_argument("dest", nargs="?", help="Destination code (omit to show current).")
    sp.add_argument("--for", dest="for_", help="Auto-expire after this duration (e.g. 2h, 30m).")
    sp.set_defaults(func=cmd_now)

    sp = sub.add_parser("stop", help="Clear the active session.")
    sp.set_defaults(func=cmd_stop)

    sp = sub.add_parser("status", help="Session + last-24h summary.")
    sp.set_defaults(func=cmd_status)

    dp = sub.add_parser("dest", help="Manage destinations.")
    dsub = dp.add_subparsers(dest="dest_cmd", required=True)

    dsp = dsub.add_parser("add", help="Add a destination.")
    dsp.add_argument("code")
    dsp.add_argument("email")
    dsp.add_argument("--name", help="Human-readable display name.")
    dsp.set_defaults(func=cmd_dest_add)

    dsp = dsub.add_parser("rm", help="Remove a destination.")
    dsp.add_argument("code")
    dsp.set_defaults(func=cmd_dest_rm)

    dsp = dsub.add_parser("list", help="List destinations.")
    dsp.set_defaults(func=cmd_dest_list)

    sp = sub.add_parser("untagged", help="Show orders without a destination.")
    sp.set_defaults(func=cmd_untagged)

    sp = sub.add_parser("retag", help="Change an order's destination.")
    sp.add_argument("order", help="Order number, e.g. 202-1234567-1234567")
    sp.add_argument("dest", help="Destination code")
    sp.add_argument("--force", action="store_true", help="Retag even if already forwarded.")
    sp.set_defaults(func=cmd_retag)

    sp = sub.add_parser("untag", help="Remove an order's destination (moves it to Untagged).")
    sp.add_argument("order", help="Order number, e.g. 202-1234567-1234567")
    sp.add_argument("--force", action="store_true", help="Untag even if already forwarded.")
    sp.set_defaults(func=cmd_untag)

    sp = sub.add_parser("cancel", help="Manually mark an order as cancelled.")
    sp.add_argument("order", help="Order number, e.g. 202-1234567-1234567")
    sp.set_defaults(func=cmd_cancel)

    sp = sub.add_parser("uncancel", help="Undo a cancellation (also clears refunded).")
    sp.add_argument("order", help="Order number, e.g. 202-1234567-1234567")
    sp.set_defaults(func=cmd_uncancel)

    sp = sub.add_parser("refund", help="Mark a cancelled order as refunded.")
    sp.add_argument("order", help="Order number, e.g. 202-1234567-1234567")
    sp.set_defaults(func=cmd_refund)

    sp = sub.add_parser("awaiting-refund", help="List cancelled orders awaiting refund.")
    sp.set_defaults(func=cmd_awaiting_refund)

    sp = sub.add_parser("history", help="Show recent orders.")
    sp.add_argument("--dest", help="Filter by destination code.")
    sp.add_argument("--days", type=int, default=7, help="Days back (default 7).")
    sp.set_defaults(func=cmd_history)

    sp = sub.add_parser("review", help="Trigger the daily digest now.")
    sp.set_defaults(func=cmd_review)

    return ap


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
