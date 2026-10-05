# 🐱 KoolKat

A private, Snapchat-style photo app. You take photos in the app with the front or rear camera, add a caption, and send them to friends. They're **end-to-end encrypted**, can only go to **friends**, disappear after they're opened, and build **streaks** when you and a friend snap each other every day.

## Features

- **Accounts.** Sign up and sign in with a username and password. Sessions persist across reloads.
- **Friends.** Search by username, send, accept, ignore or cancel requests, and remove friends. Adding someone who already added you accepts their request.
- **Friends-only.** The server refuses to deliver a snap to anyone who isn't an accepted friend. It also refuses to let a recipient download a snap after the two of them stop being friends.
- **Camera.** Uses the front or rear camera with a flip button. Selfies are mirrored like a normal selfie camera.
- **Captions.** Tap the photo to add a caption, and tap somewhere else to move it. The caption is encrypted along with the photo.
- **Disappearing snaps.** A snap shows for 10 seconds (or until you tap) and can only be opened once. When every recipient has opened it, the server deletes the encrypted data. Unopened snaps expire after 30 days.
- **Streaks.** 🔥 A streak grows by one for each day both friends snap each other. ⌛ means you'll lose it if you don't both snap today. A missed day resets it.
- **Sent view.** Shows "Delivered" or "Opened" for snaps you've sent.

## End-to-end encryption

All encryption runs in the browser with the Web Crypto API (`public/js/crypto.js`). The server never sees your password, your private key, photos or captions.

1. **Your password never leaves your device.** PBKDF2-SHA256 (600,000 iterations) stretches it into two independent keys:
   - an *auth secret*, which is sent to the server to log in and stored there as an scrypt hash;
   - a *vault key*, which never leaves the device and encrypts your private key.
2. **Identity keys.** At sign-up the device generates a P-256 ECDH key pair. The public key is uploaded. The private key is uploaded only after it has been encrypted with the vault key, so you can sign in on another device and nobody else (including the server) can read it. On your device, the key is held as a *non-extractable* `CryptoKey` in IndexedDB.
3. **Each snap** (photo + caption) is encrypted with a fresh random AES-256-GCM key. That key is then wrapped separately for each recipient: a new ephemeral ECDH key pair is combined with the friend's public key, HKDF turns the result into a wrapping key, and AES-GCM wraps the snap key. Only the recipient's private key can unwrap it.
4. **Safety codes.** Your profile and each friend's page show a fingerprint of the public key. If you and a friend see the same code, no one (not even the server) has swapped in their own key.

> ⚠️ Because KoolKat can't see your password, **it can't reset it.** If you forget your password, you lose your account.

## Running it

Requires **Node.js 22.13+**. It uses the built-in `node:sqlite`, so there are no native modules to compile.

```bash
npm install
npm start            # http://localhost:3000
npm test             # API, streak and encryption tests
```

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `KOOLKAT_DB` | `data/koolkat.db` | SQLite database file |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly with this certificate and key |
| `TRUST_PROXY` | – | Set to `1` when running behind a reverse proxy, so rate limiting sees real client IPs |

### Using it on your phone

Browsers only allow the camera on `https://` or on `http://localhost`. To use KoolKat from a phone, do one of the following:

- run it behind an HTTPS reverse proxy or tunnel (Caddy, nginx, Cloudflare Tunnel, ngrok…) and set `TRUST_PROXY=1`, **or**
- create a certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert)) and start the server with `TLS_CERT=cert.pem TLS_KEY=key.pem npm start`.

You can then use "Add to Home Screen" to install KoolKat like an app.

## Project layout

```
server/
  index.js      HTTP(S) server entry point and periodic cleanup
  app.js        Express app and REST API
  auth.js       auth-secret hashing, sessions, rate limiting
  streaks.js    streak rules
  db.js         SQLite schema
public/
  index.html, css/styles.css
  js/app.js       UI: camera, captions, inbox, viewer, friends
  js/crypto.js    end-to-end encryption (shared with the tests)
  js/api.js       API client
  js/keystore.js  IndexedDB storage for the unlocked private key
test/api.test.js  end-to-end API tests, including real encrypt/decrypt
```

## API

All endpoints are under `/api` and take and return JSON. Authenticated endpoints need `Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create account: `username, displayName, authSecret, publicKey, encryptedPrivateKey, privateKeyIv` |
| POST | `/auth/login` | `username, authSecret` → token + encrypted private key |
| POST | `/auth/logout` | Revoke the current session |
| GET | `/me` | Current user |
| GET | `/users/search?q=` | Find users by username prefix |
| GET | `/friends` | Friends (with public keys and streaks), incoming and outgoing requests |
| POST | `/friends/request` | `username`: send a request (or accept theirs) |
| POST | `/friends/:id/accept` | Accept a request |
| DELETE | `/friends/:id` | Decline, cancel or unfriend |
| POST | `/snaps` | Send an encrypted snap: `iv, ephemeralPublicKey, ciphertext, recipients[{userId, wrappedKey, wrapIv}]` |
| GET | `/snaps/inbox` | Received snaps (metadata only) |
| GET | `/snaps/sent` | Sent snaps and who has opened them |
| GET | `/snaps/:id` | Download an unopened snap's ciphertext (recipient and friend only) |
| POST | `/snaps/:id/viewed` | Mark as opened. The data is deleted once everyone has opened it |
