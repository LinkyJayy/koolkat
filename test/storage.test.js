import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageStatus } from '../server/db.js';

const SERVER = path.join(import.meta.dirname, '..', 'server', 'index.js');
const railway = { RAILWAY_ENVIRONMENT: 'production' };

test('storageStatus knows when the database would be wiped by an update', () => {
  assert.equal(storageStatus('data/koolkat.db', {}).persistent, true, 'own computer');
  assert.equal(storageStatus('data/koolkat.db', railway).persistent, false, 'Railway, no volume');
  assert.equal(storageStatus('/data/koolkat.db', { ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data' }).persistent, true);
  const outside = storageStatus('/app/data/koolkat.db', { ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data' });
  assert.equal(outside.persistent, false, 'KOOLKAT_DB pointing outside the volume');
  assert.match(outside.reason, /outside the volume/);
  assert.equal(storageStatus('/database/x.db', { ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/data' }).persistent, false, 'prefix trick');
});

/** Start the real server with extra environment; resolves with its exit code or first health response. */
function start(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
      env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', ...env },
    });
    let out = '';
    const onData = async (chunk) => {
      out += chunk;
      const m = out.match(/running at http:\/\/localhost:(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        const health = await (await fetch(`http://127.0.0.1:${m[1]}/api/health`)).json();
        child.kill();
        resolve({ started: true, health, out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ started: false, code, out }));
  });
}

test('on Railway without a volume the update refuses to start (so no accounts are wiped)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koolkat-storage-'));
  try {
    const res = await start({ ...railway, KOOLKAT_DB: path.join(tmp, 'k.db') });
    assert.equal(res.started, false);
    assert.equal(res.code, 1);
    assert.match(res.out, /STOPPED: KoolKat's database would be lost/);
    assert.match(res.out, /Attach volume/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('with a volume it starts and stores the database there', async () => {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'koolkat-volume-'));
  try {
    const res = await start({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: volume });
    assert.equal(res.started, true, res.out);
    assert.equal(res.health.storage, 'permanent');
    assert.ok(fs.existsSync(path.join(volume, 'koolkat.db')));
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('the check can be overridden on purpose, and then says storage is temporary', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koolkat-storage-'));
  try {
    const res = await start({ ...railway, KOOLKAT_DB: path.join(tmp, 'k.db'), KOOLKAT_ALLOW_TEMPORARY_STORAGE: '1' });
    assert.equal(res.started, true, res.out);
    assert.equal(res.health.storage, 'temporary');
    assert.match(res.out, /WARNING/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('admins (only) are warned in the app when storage is temporary', async () => {
  const { openDatabase } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { createIdentity, deriveKeysFromPassword } = await import('../public/js/crypto.js');
  const server = createApp({
    db: openDatabase(':memory:'),
    admins: ['boss'],
    serveStatic: false,
    storage: { persistent: false, reason: 'no Railway volume is attached' },
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const register = async (username) => {
    const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
    const id = await createIdentity(vaultKey);
    const res = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv }),
    });
    return (await res.json()).token;
  };
  const me = async (token) => (await (await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } })).json()).plan;
  try {
    assert.match((await me(await register('boss'))).storageWarning, /no Railway volume/);
    assert.equal((await me(await register('pat'))).storageWarning, null);
    assert.equal((await (await fetch(`${base}/health`)).json()).storage, 'temporary');
  } finally {
    server.close();
  }
});
