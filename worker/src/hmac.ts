/**
 * HMAC-SHA256 signing helpers, used by digest retag links.
 *
 * A retag link embeds `(order, dest, exp)` and a base64url signature over
 * `order:dest:exp`. On click, the Worker recomputes the signature and
 * compares in constant time; expired links (past `exp`) are rejected.
 */

const enc = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function sign(secret: string, data: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

export async function verify(secret: string, data: string, signature: string): Promise<boolean> {
  const expected = await sign(secret, data);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export interface RetagPayload {
  order: string;
  dest: string;
  exp: number;
}

export function retagPayloadToString(p: RetagPayload): string {
  return `${p.order}:${p.dest}:${p.exp}`;
}

export async function makeRetagUrl(
  baseUrl: string,
  secret: string,
  payload: RetagPayload
): Promise<string> {
  const data = retagPayloadToString(payload);
  const sig = await sign(secret, data);
  const u = new URL(baseUrl.replace(/\/+$/, "") + "/retag");
  u.searchParams.set("order", payload.order);
  u.searchParams.set("dest", payload.dest);
  u.searchParams.set("exp", String(payload.exp));
  u.searchParams.set("sig", sig);
  return u.toString();
}

export interface UntagPayload {
  order: string;
  exp: number;
}

export function untagPayloadToString(p: UntagPayload): string {
  return `${p.order}:untag:${p.exp}`;
}

export async function makeUntagUrl(
  baseUrl: string,
  secret: string,
  payload: UntagPayload
): Promise<string> {
  const data = untagPayloadToString(payload);
  const sig = await sign(secret, data);
  const u = new URL(baseUrl.replace(/\/+$/, "") + "/untag");
  u.searchParams.set("order", payload.order);
  u.searchParams.set("exp", String(payload.exp));
  u.searchParams.set("sig", sig);
  return u.toString();
}

export interface RefundPayload {
  order: string;
  exp: number;
}

export function refundPayloadToString(p: RefundPayload): string {
  return `${p.order}:refund:${p.exp}`;
}

export async function makeRefundUrl(
  baseUrl: string,
  secret: string,
  payload: RefundPayload
): Promise<string> {
  const data = refundPayloadToString(payload);
  const sig = await sign(secret, data);
  const u = new URL(baseUrl.replace(/\/+$/, "") + "/refund");
  u.searchParams.set("order", payload.order);
  u.searchParams.set("exp", String(payload.exp));
  u.searchParams.set("sig", sig);
  return u.toString();
}

export interface CancelPayload {
  order: string;
  exp: number;
}

export function cancelPayloadToString(p: CancelPayload): string {
  return `${p.order}:cancel:${p.exp}`;
}

export async function makeCancelUrl(
  baseUrl: string,
  secret: string,
  payload: CancelPayload
): Promise<string> {
  const data = cancelPayloadToString(payload);
  const sig = await sign(secret, data);
  const u = new URL(baseUrl.replace(/\/+$/, "") + "/cancel");
  u.searchParams.set("order", payload.order);
  u.searchParams.set("exp", String(payload.exp));
  u.searchParams.set("sig", sig);
  return u.toString();
}
