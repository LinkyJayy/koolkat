import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db.js';
import { appFilesVersion, createApp } from '../server/app.js';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const exists = (rel) => fs.existsSync(path.join(PUBLIC, rel === './' ? 'index.html' : rel));

let server;
let base;
before(async () => {
  server = createApp({ db: openDatabase(':memory:') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('every file the service worker saves for offline use exists', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(list.length > 10);
  for (const file of list) assert.ok(exists(file), `missing ${file}`);
  // Every script the page loads is saved, so the app opens offline.
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assert.ok(list.includes(src), `${src} not precached`);
  for (const file of fs.readdirSync(path.join(PUBLIC, 'js'))) assert.ok(list.includes(`js/${file}`), `js/${file} not precached`);
  for (const file of fs.readdirSync(path.join(PUBLIC, 'vendor')).filter((f) => /\.m?js$/.test(f))) {
    assert.ok(list.includes(`vendor/${file}`), `vendor/${file} not precached`);
  }
});

test('the manifest is complete and everything it points to exists', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
    assert.ok(m[key], `manifest.${key}`);
  }
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const item of [...m.icons, ...m.screenshots, ...m.shortcuts.flatMap((s) => s.icons)]) {
    assert.ok(exists(item.src), `missing ${item.src}`);
  }
});

test('the server hands out a versioned, never-cached service worker', async () => {
  const res = await fetch(`${base}/sw.js`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.ok(!body.includes('__KOOLKAT_VERSION__'));
  assert.ok(body.includes(`const VERSION = '${appFilesVersion()}'`));
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);
});

test('the version changes whenever an app file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koolkat-pwa-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), 'a');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'worker');
    const first = appFilesVersion(dir);
    fs.writeFileSync(path.join(dir, 'sw.js'), 'worker v2');
    assert.equal(appFilesVersion(dir), first, 'the worker itself is not part of the version');
    fs.writeFileSync(path.join(dir, 'index.html'), 'b');
    assert.notEqual(appFilesVersion(dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
