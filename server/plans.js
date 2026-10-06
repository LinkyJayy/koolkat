import crypto from 'node:crypto';

// ---------- plans ----------
export const FREE_STORAGE = 512 * 1024 * 1024; // 512 MB
export const UNLIMITED_STORAGE = 2.5 * 1024 * 1024 * 1024; // 2.5 GB
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

/**
 * When a user's Unlimited ends (ms). KoolKat Unlimited is free, but only
 * comes from admins: a gift, an approved request, or a redeemed code.
 * Admins always have it. 0 = KoolKat Free.
 */
export const unlimitedUntil = (u, admins = adminUsernames()) => (isAdmin(u.username, admins) ? FOREVER : u.plan_until ?? 0);
export const hasUnlimited = (u, now, admins) => unlimitedUntil(u, admins) > now;

/** The badge and flair other people see next to a user's name. */
export function perks(u, now, admins) {
  if (!hasUnlimited(u, now, admins)) return { badge: false, flair: null, badgeUrl: null };
  // badgeUrl: a custom badge picture (relative to /api/), or null for the default crown.
  return { badge: true, flair: u.flair || DEFAULT_FLAIR, badgeUrl: u.badge_id ? `badges/${u.badge_id}.png` : null };
}

/**
 * Tidy user-written text: strip control characters, collapse spaces, trim,
 * and cut to `max` characters. With `multiline`, single line breaks are kept
 * (and runs of blank lines shortened). Returns null for non-strings.
 */
export function cleanText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  let text;
  if (multiline) {
    text = value
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    text = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  }
  return [...text].slice(0, max).join('');
}

export const cleanFlair = (value) => cleanText(value, MAX_FLAIR_LENGTH);

/** Normalise a redeem code: case and spaces don't matter. */
export const normaliseCode = (code) => String(code ?? '').replace(/\s+/g, '').toUpperCase();
export const CODE_RE = /^[A-Z0-9-]{4,32}$/;

export function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `KOOL-${pick()}-${pick()}`;
}
