/**
 * Amazon email detection and extraction.
 *
 * Pure functions only — no side effects, no I/O. Everything here is easily
 * unit-testable by pasting fixture text.
 *
 * Patterns are designed to be conservative — false negatives (an email
 * misclassified as `other`) are recoverable via manual retag; false
 * positives (something misclassified as delivery) could cause the wrong
 * email to reach a destination.
 */

// ─── Sender / subject classifiers ──────────────────────────────────

/**
 * Amazon top-level domains — used to gate all Amazon-specific handling.
 * A message is only considered Amazon-y if its From-domain matches one of
 * these (or a subdomain). Same list your previous `request-email-filter`
 * used, so the drop rule + our classifier stay consistent.
 */
export const AMAZON_DOMAINS: string[] = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.co.jp",
  "amazon.se",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.nl",
];

/** Localparts we care about, mapped to how we handle the email. */
const CONFIRMATION_LOCALPARTS = new Set(["auto-confirm"]);
const SHIPPING_UPDATE_LOCALPARTS = new Set(["order-update", "shipment-tracking"]);

/**
 * Cancellation detection is still subject-based because Amazon uses the
 * same shipping-update sender for both cancellations and normal shipping
 * events. Used *within* the shipping-update handler to also mark
 * `cancelled_at` in the DB so post-cancel glitchy "arriving today" emails
 * don't get forwarded. The cancellation email itself is still forwarded
 * to the destination.
 */
export const CANCELLATION_SUBJECT_PATTERNS: RegExp[] = [
  /order .*(?:has been|was) (?:cancelled|canceled)/i,
  /cancellation of your .*order/i,
  /your .*order .*(?:cancelled|canceled)/i,
];

/**
 * Account-hold detection: fires on the "Amazon Account Protection Services"
 * email that Amazon sends when the whole account is temporarily locked and
 * all pending orders are cancelled en masse. The email contains no order
 * number, so we can't process it via the normal per-order path.
 *
 * When detected, `email.ts` bulk-cancels every order placed in the last 36h
 * that has not already been forwarded (delivered orders can't be cancelled).
 * The original email is still forwarded to `MASTER_EMAIL` unchanged.
 *
 * Match is intentionally narrow: only the specific sender-name string. If
 * Amazon uses another display name for this kind of notice, add a pattern
 * here — do NOT loosen to substring matches on the body, which would risk
 * bulk-cancelling on legitimate per-order emails that mention "cancelled".
 */
export const ACCOUNT_HOLD_SENDER_PATTERNS: RegExp[] = [
  /Amazon Account Protection Services/i,
];

export const ORDER_NUMBER_REGEX = /\b\d{3}-\d{7}-\d{7}\b/;

export type AmazonEmailKind =
  | "confirmation"      // auto-confirm@amazon.* → tag under session
  | "shipping-update"   // order-update@ or shipment-tracking@ → forward to destination
  | "other";            // just goes to master (unchanged)

function localpartOf(from: string): string {
  return (from.toLowerCase().split("@")[0] ?? "").trim();
}

function domainOf(from: string): string {
  return (from.toLowerCase().split("@")[1] ?? "").trim();
}

export function isAmazonDomain(domain: string): boolean {
  if (!domain) return false;
  return AMAZON_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

/**
 * Classify an incoming email by its `From:` address (localpart + domain).
 *
 * Simple exact string matches on the localpart, gated by an Amazon-domain
 * check on the right-hand side. No regex, so no surprises from encoding /
 * subject-line drift across Amazon locales.
 */
export function classifyAmazonEmail(from: string, _subject?: string): AmazonEmailKind {
  const local = localpartOf(from);
  const domain = domainOf(from);
  if (!isAmazonDomain(domain)) return "other";

  if (SHIPPING_UPDATE_LOCALPARTS.has(local)) return "shipping-update";
  if (CONFIRMATION_LOCALPARTS.has(local)) return "confirmation";
  return "other";
}

export function isCancellationSubject(subject: string): boolean {
  return CANCELLATION_SUBJECT_PATTERNS.some((r) => r.test(subject));
}

/**
 * True when the `From:` display-name (or full header value) matches the
 * account-hold sender pattern. Callers should pass the display-name portion
 * when available (e.g. `parsed.from.name`), falling back to the raw header
 * value if the parser didn't split it out.
 */
export function isAccountHoldEmail(fromDisplayOrHeader: string): boolean {
  if (!fromDisplayOrHeader) return false;
  return ACCOUNT_HOLD_SENDER_PATTERNS.some((r) => r.test(fromDisplayOrHeader));
}

// ─── Extractors ────────────────────────────────────────────────────

export function extractOrderNumber(text: string): string | null {
  const m = text.match(ORDER_NUMBER_REGEX);
  return m ? m[0] : null;
}

const RECIPIENT_NAME_PATTERNS: RegExp[] = [
  // Amazon UK plaintext format: line reading "Willie – GRAVESEND" (en-dash + city in caps)
  /^\s*([A-Z][a-z]+)\s+[–—-]\s+[A-Z]{2,}\s*$/m,
  // Explicit "Delivering to:" / "Ship to:" style
  /Delivering to:\s*([A-Z][a-z]+)/,
  /Ship(?:ping)? to:\s*([A-Z][a-z]+)/,
  /Deliver(?:ing|y) to:\s*([A-Z][a-z]+)/i,
];

/**
 * Extract the first-name of the shipping recipient from an Amazon email.
 *
 * We deliberately do NOT fall back to the account-holder greeting
 * ("Hello Josh") because that's the same for every order and would give
 * false confidence in the digest sanity-check column.
 */
export function extractRecipientName(text: string): string | null {
  for (const p of RECIPIENT_NAME_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

const PRODUCT_TITLE_PATTERNS: RegExp[] = [
  /Your Amazon(?:\.\w+)?\s+order of\s+"([^"]+)"/i,
  /Order details?:[^\n]*\n\s*([^\n]{5,120})/i,
];

const SUBJECT_TITLE_STRIP =
  /^(?:order(?:ed)?\s*(?:confirmation|of|for)?|arriving\s+\w+|out for delivery|will be delivered\s+\w+)[:\s-]+/i;

/**
 * Extract a product title for display in the digest. Informational only —
 * never used for routing.
 */
export function extractProductTitle(text: string, subject: string): string | null {
  for (const p of PRODUCT_TITLE_PATTERNS) {
    const m = text.match(p);
    if (m) return truncate(m[1].trim(), 120);
  }
  // Fallback: strip the routing-prefix off the subject line
  const stripped = subject.replace(SUBJECT_TITLE_STRIP, "").trim();
  if (stripped && stripped !== subject) return truncate(stripped, 120);
  // Last resort: return the subject itself, trimmed
  return subject ? truncate(subject, 120) : null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
