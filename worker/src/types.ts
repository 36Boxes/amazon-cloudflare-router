/**
 * Shared types + environment shape.
 *
 * `Env` mirrors the bindings in wrangler.toml and the secrets set via
 * `wrangler secret put`.
 */

export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;

  ADMIN_TOKEN: string;
  HMAC_SECRET: string;

  MASTER_EMAIL: string;
  UNROUTED_EMAIL: string;
  FROM_ADDRESS: string;
  DIGEST_TIMEZONE: string;
  RETENTION_DAYS: string;
  WORKER_BASE_URL: string;
}

export interface Destination {
  code: string;
  email: string;
  display_name: string | null;
  created_at: number;
}

export interface Order {
  order_number: string;
  destination_code: string | null;
  recipient_name: string | null;
  product_title: string | null;
  placed_at: number;
  tagged_at: number | null;
  forwarded_at: number | null;
  cancelled_at: number | null;
  refunded_at: number | null;
  account_email: string | null;
}

export interface Session {
  singleton: 1;
  destination_code: string | null;
  set_at: number | null;
  expires_at: number | null;
}

export type AuditAction =
  | "session-set"
  | "session-stop"
  | "order-tagged"
  | "order-retagged"
  | "order-untagged"
  | "delivery-forwarded"
  | "delivery-unrouted"
  | "order-cancelled"
  | "order-uncancelled"
  | "order-refunded"
  | "digest-sent"
  | "retention-prune";

export interface AuditOptions {
  orderNumber?: string;
  fromDest?: string;
  toDest?: string;
  actor?: string;
  note?: string;
}
