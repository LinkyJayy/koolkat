import crypto from 'node:crypto';
import { DAY_MS } from './streaks.js';

// ---------- plans ----------
export const FREE_STORAGE = 512 * 1024 * 1024; // 512 MB
export const UNLIMITED_STORAGE = 2.5 * 1024 * 1024 * 1024; // 2.5 GB
export const UNLIMITED_PRICE_CENTS = 499; // $4.99 / month
export const DEFAULT_FLAIR = 'i have nine lives';
export const MAX_FLAIR_LENGTH = 40;
// plan_until value meaning "never ends" (gifts and codes can be forever).
export const FOREVER = Number.MAX_SAFE_INTEGER;

/** Admins are matched by username, ignoring case (default: zalith9). */
export function adminUsernames(env = process.env) {
  return (env.KOOLKAT_ADMINS || 'zalith9')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
}

export const isAdmin = (username, admins = adminUsernames()) =>
  typeof username === 'string' && admins.includes(username.toLowerCase());

/** When a user's Unlimited ends (ms), from gifts/codes or a paid subscription. 0 = free. */
export const unlimitedUntil = (u) => Math.max(u.plan_until ?? 0, u.sub_until ?? 0);
export const hasUnlimited = (u, now) => unlimitedUntil(u) > now;

/** The badge and flair other people see next to a user's name. */
export function perks(u, now) {
  if (!hasUnlimited(u, now)) return { badge: false, flair: null };
  return { badge: true, flair: u.flair || DEFAULT_FLAIR };
}

export function cleanFlair(value) {
  if (typeof value !== 'string') return null;
  // Strip control characters and collapse whitespace.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, MAX_FLAIR_LENGTH).join('');
}

/** Normalise a redeem code: case and spaces don't matter. */
export const normaliseCode = (code) => String(code ?? '').replace(/\s+/g, '').toUpperCase();
export const CODE_RE = /^[A-Z0-9-]{4,32}$/;

export function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `KOOL-${pick()}-${pick()}`;
}

// ---------- Stripe ----------
// Payments are optional: without STRIPE_SECRET_KEY the upgrade button explains
// that payments aren't set up yet, and codes / gifts still work.

export function stripeConfig(env = process.env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    priceId: env.STRIPE_PRICE_ID || null,
  };
}

/** Flatten {a: {b: 1}} into Stripe's form encoding: a[b]=1 */
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export function createStripeClient(config, fetchImpl = fetch) {
  return async function stripeRequest(method, path, params) {
    const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params ? formEncode(params).toString() : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
    return data;
  };
}

/** Verify a Stripe-Signature header (HMAC-SHA256 over "timestamp.body"). */
export function verifyStripeSignature(rawBody, header, secret, now = Date.now(), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2 && p[0] === 't')
  );
  const signatures = String(header)
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return signatures.some((sig) => {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/** When a Stripe subscription's paid period ends, in ms (handles old and new API shapes). */
export function subscriptionPeriodEnd(sub) {
  const end = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return Number.isFinite(end) ? end * 1000 : null;
}

export const SUBSCRIPTION_GRACE_MS = DAY_MS; // keep perks a day past period end while renewal settles
