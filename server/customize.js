import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { base64Field, fail, parseUserId } from './http.js';

// KoolKat Unlimited personalisation: app icons, custom badges and BFFs.

export const APP_ICONS = ['default', 'crown', 'glow', 'custom'];
const BUILT_IN_ICONS = {
  crown: 'icons/alt-crown',
  glow: 'icons/alt-glow',
};
const MAX_ICON_BYTES = 1.5 * 1024 * 1024;
const MAX_BADGE_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode a base64 PNG and check its size; returns { bytes, width, height }. */
export function readPng(value, name, { maxBytes, width: wantWidth, height: wantHeight, maxSide, minSide = 1 }) {
  const bytes = base64Field(value, name, { min: 33, max: maxBytes });
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail(400, `${name} must be a PNG image`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (wantWidth && (width !== wantWidth || height !== wantHeight)) fail(400, `${name} must be ${wantWidth}×${wantHeight}`);
  if (maxSide && (width > maxSide || height > maxSide || width < minSide || height < minSide)) {
    fail(400, `${name} must be between ${minSide} and ${maxSide} pixels`);
  }
  return { bytes, width, height };
}

const newPublicId = () => crypto.randomBytes(12).toString('base64url');
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

function sendImage(res, bytes) {
  res.set({
    'Content-Type': 'image/png',
    // Each upload gets a new id, so a given URL never changes.
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(Buffer.from(bytes));
}

export function registerCustomizeRoutes({ api, db, clock, auth, wrap, hasUnlimitedUser, areFriends }) {
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    setIcon: db.prepare('UPDATE users SET app_icon = ? WHERE id = ?'),
    setCustomIcon: db.prepare(
      "UPDATE users SET app_icon = 'custom', app_icon_id = ?, app_icon_512 = ?, app_icon_192 = ? WHERE id = ?"
    ),
    iconById: db.prepare('SELECT app_icon_512, app_icon_192 FROM users WHERE app_icon_id = ?'),
    setBadge: db.prepare('UPDATE users SET badge_id = ?, badge_png = ? WHERE id = ?'),
    badgeById: db.prepare('SELECT badge_png FROM users WHERE badge_id = ?'),
    bffs: db.prepare('SELECT friend_id FROM bffs WHERE user_id = ?'),
    addBff: db.prepare('INSERT OR IGNORE INTO bffs (user_id, friend_id, created_at) VALUES (?, ?, ?)'),
    removeBff: db.prepare('DELETE FROM bffs WHERE user_id = ? AND friend_id = ?'),
  };

  const requireUnlimited = (req, what) => {
    const user = q.user.get(req.user.id);
    if (!hasUnlimitedUser(user)) fail(403, `${what} is part of KoolKat Unlimited`);
    return user;
  };

  // ---------- app icon ----------
  api.post(
    '/me/app-icon',
    auth,
    wrap((req) => {
      const icon = String(req.body?.icon ?? '');
      if (!APP_ICONS.includes(icon)) fail(400, 'Unknown app icon');
      if (icon === 'default') {
        q.setIcon.run(null, req.user.id);
      } else {
        const user = requireUnlimited(req, 'Custom app icons');
        if (icon === 'custom' && req.body?.icon512) {
          const big = readPng(req.body.icon512, 'icon512', { maxBytes: MAX_ICON_BYTES, width: 512, height: 512 });
          const small = readPng(req.body.icon192, 'icon192', { maxBytes: MAX_ICON_BYTES / 4, width: 192, height: 192 });
          q.setCustomIcon.run(newPublicId(), big.bytes, small.bytes, user.id);
        } else if (icon === 'custom') {
          if (!user.app_icon_id) fail(400, 'Upload a picture for your app icon');
          q.setIcon.run('custom', user.id);
        } else {
          q.setIcon.run(icon, user.id);
        }
      }
      const user = q.user.get(req.user.id);
      return { appIcon: { icon: user.app_icon || 'default', customId: user.app_icon_id } };
    })
  );

  api.get('/app-icons/:id/:size.png', (req, res) => {
    const row = ID_RE.test(req.params.id) ? q.iconById.get(req.params.id) : null;
    const bytes = req.params.size === '512' ? row?.app_icon_512 : req.params.size === '192' ? row?.app_icon_192 : null;
    if (!bytes) return res.status(404).json({ error: 'Not found' });
    sendImage(res, bytes);
  });

  // ---------- custom badge ----------
  api.post(
    '/me/badge',
    auth,
    wrap((req) => {
      const user = requireUnlimited(req, 'A custom badge');
      const { bytes } = readPng(req.body?.image, 'image', { maxBytes: MAX_BADGE_BYTES, maxSide: 256, minSide: 16 });
      const id = newPublicId();
      q.setBadge.run(id, bytes, user.id);
      return { badgeUrl: `badges/${id}.png` };
    })
  );

  // "Reset Badge to Default"
  api.delete(
    '/me/badge',
    auth,
    wrap((req) => {
      q.setBadge.run(null, null, req.user.id);
      return { badgeUrl: null };
    })
  );

  api.get('/badges/:id.png', (req, res) => {
    const row = ID_RE.test(req.params.id) ? q.badgeById.get(req.params.id) : null;
    if (!row?.badge_png) return res.status(404).json({ error: 'Not found' });
    sendImage(res, row.badge_png);
  });

  // ---------- BFFs ----------
  api.post(
    '/bffs/:userId',
    auth,
    wrap((req) => {
      requireUnlimited(req, 'BFFs');
      const friend = parseUserId(req.params.userId);
      if (!areFriends(req.user.id, friend)) fail(403, 'Only friends can be BFFs');
      q.addBff.run(req.user.id, friend, clock());
      return { bff: true };
    })
  );

  api.delete(
    '/bffs/:userId',
    auth,
    wrap((req) => {
      q.removeBff.run(req.user.id, parseUserId(req.params.userId));
      return { bff: false };
    })
  );

  /** The ids someone has hearted (empty unless they have Unlimited). */
  const bffSet = (userId) => {
    const user = q.user.get(userId);
    if (!user || !hasUnlimitedUser(user)) return new Set();
    return new Set(q.bffs.all(userId).map((r) => r.friend_id));
  };

  return { bffSet };
}

/**
 * The web app manifest, with the icons swapped for the chosen app icon
 * (?icon=crown, ?icon=glow, or ?icon=custom-<id>). The page points its
 * manifest link here, so installing KoolKat uses that icon.
 */
export function manifestHandler({ publicDir, db, hasUnlimitedUser }) {
  const base = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  const customOwner = db.prepare('SELECT * FROM users WHERE app_icon_id = ?');

  const iconsFor = (choice) => {
    if (BUILT_IN_ICONS[choice]) {
      const prefix = BUILT_IN_ICONS[choice];
      return [
        { src: `${prefix}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${prefix}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${prefix}-maskable-192.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: `${prefix}-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
    }
    const match = /^custom-([A-Za-z0-9_-]{16})$/.exec(choice ?? '');
    const owner = match && customOwner.get(match[1]);
    if (owner && hasUnlimitedUser(owner) && owner.app_icon_512) {
      return [
        { src: `api/app-icons/${match[1]}/192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `api/app-icons/${match[1]}/512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      ];
    }
    return null;
  };

  return (req, res) => {
    const icons = iconsFor(String(req.query.icon ?? ''));
    const manifest = icons
      ? {
          ...base,
          icons,
          shortcuts: base.shortcuts?.map((s) => ({ ...s, icons: [icons[0]] })),
        }
      : base;
    res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.send(JSON.stringify(manifest, null, 2));
  };
}
