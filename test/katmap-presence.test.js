import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createIdentity, deriveKeysFromPassword } from '../public/js/crypto.js';

const db = openDatabase(':memory:');
let now = Date.now();
let server;
let app;
let base;
before(async () => {
  app = createApp({
    db,
    admins: ['boss'],
    clock: () => now,
    env: { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'secret', LASTFM_API_KEY: 'lfm' },
    fetchImpl: (url, init) => fakeFetch(url, init),
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

async function register(username) {
  const { authSecret, vaultKey } = await deriveKeysFromPassword(username, 'password123', 1000);
  const id = await createIdentity(vaultKey);
  const res = await call('POST', '/auth/register', {
    body: { username, displayName: username, authSecret, publicKey: id.publicKey, encryptedPrivateKey: id.encryptedPrivateKey, privateKeyIv: id.privateKeyIv },
  });
  return { ...res.body.user, token: res.body.token };
}

let boss, ann, ben, cat;
const me = async (u) => (await call('GET', '/me', { token: u.token })).body;
before(async () => {
  [boss, ann, ben, cat] = [await register('boss'), await register('ann'), await register('ben'), await register('cat')];
  for (const [a, b] of [[ann, ben], [ann, boss]]) {
    await call('POST', '/friends/request', { token: a.token, body: { username: b.username } });
    await call('POST', `/friends/${a.id}/accept`, { token: b.token });
  }
  await call('POST', '/admin/grant', { token: boss.token, body: { username: 'ann' } });
  await call('POST', '/admin/grant', { token: boss.token, body: { username: 'ben' } });
});



// ---------- fake Spotify / Last.fm ----------
const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers });
let spotifyPlaying = null;
let spotifyLeft = 1000;
let lastfmPlaying = true;
const spotifyCalls = [];
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.href === 'https://accounts.spotify.com/api/token') {
    const params = new URLSearchParams(init.body);
    spotifyCalls.push(params.get('grant_type'));
    if (params.get('grant_type') === 'authorization_code') {
      if (params.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'acc1', refresh_token: 'ref1', expires_in: 3600 });
    }
    if (params.get('refresh_token') === 'revoked') return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'acc2', expires_in: 3600 });
  }
  if (u.href === 'https://api.spotify.com/v1/me/player/currently-playing') {
    if (!spotifyPlaying) return json(204, null);
    return json(200, {
      is_playing: true,
      currently_playing_type: 'track',
      progress_ms: 100_000,
      item: {
        name: spotifyPlaying,
        duration_ms: 100_000 + spotifyLeft,
        artists: [{ name: 'Daft Punk' }],
        album: { name: 'Discovery', images: [{ url: 'https://i.scdn.co/image/640', width: 640 }, { url: 'https://i.scdn.co/image/300', width: 300 }, { url: 'https://evil.example/x', width: 64 }] },
        external_urls: { spotify: 'https://open.spotify.com/track/1' },
      },
    });
  }
  if (u.hostname === 'ws.audioscrobbler.com') {
    const user = u.searchParams.get('user');
    if (user === 'ghost') return json(404, { error: 6, message: 'User not found' });
    if (u.searchParams.get('method') === 'user.getinfo') return json(200, { user: { name: user } });
    const track = { name: 'Old song', artist: { '#text': 'Someone' }, album: { '#text': '' }, image: [], url: 'https://www.last.fm/music/x' };
    const playing = { name: 'Espresso', artist: { '#text': 'Sabrina Carpenter' }, album: { '#text': 'Short n Sweet' }, image: [{ size: 'large', '#text': 'https://lastfm.freetls.fastly.net/i/u/174s/a.png' }], url: 'https://www.last.fm/music/Sabrina', '@attr': { nowplaying: 'true' } };
    return json(200, { recenttracks: { track: lastfmPlaying ? [playing, track] : [track] } });
  }
  throw new Error(`unexpected fetch ${url}`);
}

describe('admin reset', () => {
  test('admins can clear an Activity Bubble', async () => {
    await call('POST', '/me/activity', { token: ann.token, body: { emoji: '🎮', text: 'rude words' } });
    const res = await call('POST', '/admin/reset-customization', { token: boss.token, body: { username: 'ann', activity: true } });
    assert.deepEqual(res.body.reset, ['activity']);
    assert.equal((await me(ann)).plan.activity, null);
    const again = await call('POST', '/admin/reset-customization', { token: boss.token, body: { username: 'ann', badge: true, icon: true, activity: true } });
    assert.deepEqual(again.body.reset, []);
    assert.equal((await call('POST', '/admin/reset-customization', { token: ann.token, body: { username: 'ann', activity: true } })).status, 403);
  });
});

describe('Kat Map', () => {
  const here = { lat: 40.7128, lng: -74.006, accuracy: 12 };
  test('Unlimited only, and nobody is shared until they turn it on', async () => {
    assert.equal((await call('GET', '/map', { token: cat.token })).status, 403);
    assert.equal((await call('POST', '/map/settings', { token: cat.token, body: { mode: 'friends' } })).status, 403);
    assert.equal((await call('POST', '/map/settings', { token: ann.token, body: { mode: 'everyone' } })).status, 400);
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: here })).status, 409, 'sharing is off');
    const map = await call('GET', '/map', { token: ben.token });
    assert.deepEqual(map.body, { mode: 'off', location: null, friends: [] });
  });

  test('friends see where you are; BFF-only and off hide you', async () => {
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'friends' } });
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: { lat: 200, lng: 0 } })).status, 400);
    assert.equal((await call('POST', '/map/location', { token: ann.token, body: here })).status, 200);
    const mine = (await call('GET', '/map', { token: ann.token })).body;
    assert.equal(mine.mode, 'friends');
    assert.equal(mine.location.lat, here.lat);

    let seen = (await call('GET', '/map', { token: ben.token })).body.friends;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].username, 'ann');
    assert.equal(seen[0].location.lng, here.lng);
    // boss is ann's friend too (admins have Unlimited); cat isn't her friend.
    assert.equal((await call('GET', '/map', { token: boss.token })).body.friends.length, 1);
    await call('POST', '/admin/grant', { token: boss.token, body: { username: 'cat' } });
    assert.equal((await call('GET', '/map', { token: cat.token })).body.friends.length, 0, 'not friends');

    // Only BFFs: ann makes ben a BFF, so ben still sees her but boss doesn't.
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'bffs' } });
    await call('POST', `/bffs/${ben.id}`, { token: ann.token });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 1);
    assert.equal((await call('GET', '/map', { token: boss.token })).body.friends.length, 0);

    // Old locations disappear.
    now += 25 * 60 * 60 * 1000;
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 0);
    await call('POST', '/map/location', { token: ann.token, body: here });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 1);

    // Turning it off deletes the location.
    await call('POST', '/map/settings', { token: ann.token, body: { mode: 'off' } });
    assert.equal((await call('GET', '/map', { token: ben.token })).body.friends.length, 0);
    const row = db.prepare('SELECT map_lat, map_at FROM users WHERE id = ?').get(ann.id);
    assert.equal(row.map_lat, null);
  });
});

describe('Rich Presence', () => {
  test('connect Spotify and friends see what is playing', async () => {
    assert.equal((await call('POST', '/presence/spotify/start', { token: cat.token, body: {} })).status, 200, 'cat has Unlimited now');
    const start = await call('POST', '/presence/spotify/start', { token: ann.token, body: { returnTo: 'https://evil.example/' } });
    const url = new URL(start.body.url);
    assert.equal(url.hostname, 'accounts.spotify.com');
    assert.equal(url.searchParams.get('scope'), 'user-read-currently-playing');
    assert.match(url.searchParams.get('redirect_uri'), /\/api\/presence\/spotify\/callback$/);
    const state = url.searchParams.get('state');

    const bad = await fetch(`${base}/api/presence/spotify/callback?code=good-code&state=wrong`, { redirect: 'manual' });
    assert.equal(bad.headers.get('location'), '/#presence/expired');

    spotifyPlaying = 'One More Time';
    const cb = await fetch(`${base}/api/presence/spotify/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    assert.equal(cb.status, 303);
    assert.equal(cb.headers.get('location'), '/#presence/spotify', 'never sent to another site');
    const reused = await fetch(`${base}/api/presence/spotify/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    assert.equal(reused.headers.get('location'), '/#presence/expired', 'state works once');

    const mine = (await call('GET', '/presence', { token: ann.token })).body;
    assert.equal(mine.source, 'spotify');
    assert.equal(mine.nowPlaying.title, 'One More Time');
    assert.equal(mine.nowPlaying.art, 'https://i.scdn.co/image/300');
    const friend = (await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.username === 'ann');
    assert.equal(friend.nowPlaying.artist, 'Daft Punk');
    assert.equal(db.prepare('SELECT spotify_refresh FROM users WHERE id = ?').get(ann.id).spotify_refresh, 'ref1');

    // The server's timer keeps it up to date (and refreshes the token when it runs out).
    spotifyPlaying = null;
    now += 2 * 60 * 60 * 1000;
    await app.locals.pollPresence();
    assert.ok(spotifyCalls.includes('refresh_token'));
    assert.equal((await call('GET', '/presence', { token: ann.token })).body.nowPlaying, null, 'nothing playing');

    // Nothing has played for hours, so it's only checked every 30 seconds.
    spotifyPlaying = 'Digital Love';
    now += 10_000;
    await app.locals.pollPresence();
    assert.equal((await call('GET', '/presence', { token: ann.token })).body.nowPlaying, null, 'not due yet');
    now += 20_000;
    await app.locals.pollPresence();
    assert.equal((await call('GET', '/presence', { token: ann.token })).body.nowPlaying.title, 'Digital Love');
    // The cheap endpoint friends' apps check every few seconds.
    const quick = (await call('GET', '/presence/friends', { token: ben.token })).body.playing;
    assert.equal(quick[ann.id].title, 'Digital Love');
    assert.equal(quick[ann.id].msLeft, undefined, 'time left is not stored');
    assert.deepEqual((await call('GET', '/presence/friends', { token: cat.token })).body.playing, {}, 'not friends');

    // While playing, it's checked again within 5 seconds, or when the song ends if sooner.
    const due = () => db.prepare('SELECT presence_retry_at FROM users WHERE id = ?').get(ann.id).presence_retry_at - now;
    assert.equal(due(), 2000, 'song ends in 1s (+1s)');
    spotifyLeft = 60_000;
    now += 2_000;
    await app.locals.pollPresence();
    assert.equal(due(), 5000);

    // Right after music stops, it's checked every 10 seconds (not 30).
    spotifyPlaying = null;
    now += 5_000;
    await app.locals.pollPresence();
    assert.equal(due(), 10_000);
    spotifyPlaying = 'Digital Love';
    now += 10_000;
    await app.locals.pollPresence();

    // Stale songs disappear if checks stop.
    assert.equal((await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.username === 'ann').nowPlaying.title, 'Digital Love');
    now += 5 * 60 * 1000;
    assert.equal((await call('GET', '/friends', { token: ben.token })).body.friends.find((f) => f.username === 'ann').nowPlaying, null);

    // Revoked access disconnects.
    db.prepare("UPDATE users SET spotify_refresh = 'revoked', spotify_expires = 0 WHERE id = ?").run(ann.id);
    await app.locals.pollPresence();
    assert.equal((await call('GET', '/presence', { token: ann.token })).body.source, null);
  });

  test('Last.fm by username (Apple Music and others)', async () => {
    assert.equal((await call('POST', '/presence/lastfm', { token: ann.token, body: { username: 'no spaces' } })).status, 400);
    assert.equal((await call('POST', '/presence/lastfm', { token: ann.token, body: { username: 'ghost' } })).status, 404);
    const ok = await call('POST', '/presence/lastfm', { token: ann.token, body: { username: 'annmusic' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source, 'lastfm');
    assert.equal(ok.body.nowPlaying.title, 'Espresso');
    assert.equal(ok.body.nowPlaying.art, 'https://lastfm.freetls.fastly.net/i/u/174s/a.png');
    lastfmPlaying = false;
    now += 20_000;
    assert.equal((await call('POST', '/presence/refresh', { token: ann.token })).body.nowPlaying, null);
    await call('DELETE', '/presence', { token: ann.token });
    assert.equal((await call('GET', '/presence', { token: ann.token })).body.source, null);
  });

  test('without keys the server says it is not set up', async () => {
    const plain = createApp({ db, admins: ['boss'], env: {} }).listen(0);
    await new Promise((r) => plain.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${plain.address().port}/api/presence`, { headers: { authorization: `Bearer ${ann.token}` } });
    const body = await res.json();
    assert.equal(body.spotifyAvailable, false);
    assert.equal(body.lastfmAvailable, false);
    plain.close();
  });
});
