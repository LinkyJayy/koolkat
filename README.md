# KoolKat

A private, Snapchat alternative. You take photos in the app with the front or rear camera, add a caption, and send them to friends as **Klicks**. Klicks are **end-to-end encrypted**, can only go to **friends**, and stay saved so you can view them again. Sending each other Klicks every day builds **streaks**, and you can **chat** with friends one-on-one or in groups.

## Features

Photos taken in KoolKat are called **Klicks**.

- **Accounts.** Sign up and sign in with a username and password. Sessions persist across reloads.
- **Friends.** Search by username, send, accept, ignore or cancel requests, and remove friends. Adding someone who already added you accepts their request.
- **Friends-only.** The server refuses to deliver a Klick to anyone who isn't an accepted friend. It also refuses to let a recipient download a Klick after the two of them stop being friends.
- **Camera.** Uses the front or rear camera with a flip button. Selfies are mirrored like a normal selfie camera.
- **Captions.** Tap the photo to add a caption, and tap somewhere else to move it. The caption is encrypted along with the photo.
- **Saved Klicks.** Klicks you receive stay in your inbox, so you can open them again whenever you like. They stay end-to-end encrypted, and only the friends a Klick was sent to can open it. If you unfriend someone, their Klicks are hidden until you're friends again.
- **View your own Klicks.** Each Klick is also encrypted for you, so you can open it again from *Klicks → Sent*. As the sender, deleting a Klick removes it for everyone.
- **Deleting Klicks.** Open a Klick and tap 🗑 to remove it from your inbox. Once every recipient has deleted it, the encrypted data is removed from the server for good.
- **Favorites.** ⭐ Tap the star on any Klick (received or sent) to favorite it. The ★ button on the home screen shows all your favorites.
- **Chats.** 💬 Message any friend from *Chats → New chat*, or the **Message** button on their friend card. Messages are end-to-end encrypted like Klicks: each message has its own key, wrapped for each person in the chat.
- **Group chats.** 👥 *Chats → New group*: pick at least 2 friends and optionally a name. Anyone in the group can rename it, add their own friends, or leave. People who join later only see messages sent after they joined. (The group *name* isn't encrypted; messages are.)
- **Streaks.** 🔥 A streak grows by one for each day both friends send each other a Klick. ⌛ means you'll lose it if you don't both send one today. A missed day resets it.
- **Sent view.** Shows "Delivered" or "Opened" for Klicks you've sent.
- **Push notifications.** 🔔 Get notified about new Klicks, messages, friend requests, accepted requests, and streaks that are about to end. Turn them on from the banner on the Klicks screen or in your profile. Notifications only say *who* sent something, never what.
- **News.** 📣 The megaphone button on the home screen opens News: codes, events and updates posted by admins. Posts can include a code with a one-tap **Redeem** button. A badge shows when there's something new.
- **Light and dark mode.** Choose System, Light or Dark under *Appearance* on the sign-in screen or in your profile. The choice is remembered on that device.

## KoolKat Free vs KoolKat Unlimited

KoolKat is completely free, and so is **KoolKat Unlimited**. Unlimited isn't sold: you get it from an admin.

| | KoolKat Free | KoolKat Unlimited (free, from admins) |
| --- | --- | --- |
| Storage for Klicks you've sent | 512 MB | 2.5 GB |
| Kool badge 👑 next to your name | – | ✓ |
| Kool flair (custom line under your name, default "i have nine lives") | – | ✓ |

Storage counts the Klicks you've sent that still exist. Deleting a sent Klick (it's removed for everyone) frees the space. When it's full, KoolKat asks you to delete some. Badges and flair are shown to your friends in their friend list, your profile, your Klicks and chats.

There are three ways to get Unlimited:

- **Redeem a code** (*Profile → Have a code?*, or the **Redeem** button on a News post).
- **Ask for it**: *Profile → 🎁 Ask an admin for KoolKat Unlimited*, with an optional message. Admins get a notification and can approve or decline. After a decline you can ask again the next day.
- **Get a gift** from an admin.

### Admin tools

The account **`zalith9`** is the admin. Capitalisation doesn't matter, and usernames are unique regardless of capitalisation, so there can only be one zalith9. Set `KOOLKAT_ADMINS` to a comma-separated list to change it. Admins always have **KoolKat Unlimited forever** (it can't expire or be taken away), and get an **Admin tools** button in their profile, where they can:

- **create redeemable codes** with their own text (or a random `KOOL-XXXX-XXXX`), a **usage limit**, an **expiry date**, and how many days of Unlimited they give (or forever). Each person can use a code once;
- see how many times each code has been used, and copy or delete codes;
- **give KoolKat Unlimited to any user** for a number of days, or forever, and take a gift back;
- **approve or decline requests** for Unlimited (the button shows how many are waiting);
- **post to News** (title, text, an optional code, and optionally a notification to everyone), and delete posts.

> Admin rights come from the username. If the database is ever lost (for example, Railway without a volume), whoever registers `zalith9` first becomes admin. Keep a volume attached.

## End-to-end encryption

All encryption runs in the browser with the Web Crypto API (`public/js/crypto.js`). The server never sees your password, your private key, photos or captions.

1. **Your password never leaves your device.** PBKDF2-SHA256 (600,000 iterations) stretches it into two independent keys:
   - an *auth secret*, which is sent to the server to log in and stored there as an scrypt hash;
   - a *vault key*, which never leaves the device and encrypts your private key.
2. **Identity keys.** At sign-up the device generates a P-256 ECDH key pair. The public key is uploaded. The private key is uploaded only after it has been encrypted with the vault key, so you can sign in on another device and nobody else (including the server) can read it. On your device, the key is held as a *non-extractable* `CryptoKey` in IndexedDB.
3. **Each Klick** (photo + caption) is encrypted with a fresh random AES-256-GCM key. That key is then wrapped separately for each recipient: a new ephemeral ECDH key pair is combined with the friend's public key, HKDF turns the result into a wrapping key, and AES-GCM wraps the Klick's key. Only the recipient's private key can unwrap it. The Klick's key is also wrapped for the sender, so they can view it later. Chat messages work the same way, wrapped for every member of the chat.
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
| `KOOLKAT_DB` | `data/koolkat.db` | SQLite database file. On Railway, defaults to the attached volume |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly with this certificate and key |
| `TRUST_PROXY` | `1` on Railway, else off | Number of reverse proxies in front of the server, so rate limiting sees real client IPs |
| `ALLOWED_ORIGINS` | – | Comma-separated sites allowed to use the API from another domain, e.g. `https://linkyjayy.github.io` for GitHub Pages |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web Push keys. If you don't set them, a key pair is generated once and saved in the database. Generate your own with `npx web-push generate-vapid-keys` |
| `KOOLKAT_ADMINS` | `zalith9` | Usernames (any capitalisation, comma-separated) that get admin tools |
| `VAPID_SUBJECT` | repo URL | Contact URL or `mailto:` address sent to push services |

## Deploying to Railway

[Railway](https://railway.com) runs the backend **and** serves the app, so you get one `https://` link that works on phones (camera and notifications included). The repo already has a `railway.json`, so there's nothing to configure in code.

1. **Create the service.** Sign in at railway.com, then go to **New Project → Deploy from GitHub repo** and pick `LinkyJayy/koolkat`. Railway installs and starts it automatically.
2. **Attach a volume. Don't skip this.** Without one, every deploy or restart **deletes all accounts, friends, Klicks and chats**. In the project, right-click the KoolKat service (or press ⌘K / Ctrl+K and type *volume*), choose **Attach volume**, and use the mount path `/data`. KoolKat finds the volume and stores its database there automatically.
3. **Get a link.** Open the service → **Settings → Networking → Generate Domain**. Your app is now at something like `https://koolkat-production.up.railway.app`.
4. **Optional:** in the service's **Variables**, set `VAPID_SUBJECT` to `mailto:you@example.com` so push services can contact you.

Every push to the deployed branch redeploys automatically. The deploy logs show `Database: /data/koolkat.db` once the volume is attached. If you see a WARNING about a missing volume, go back to step 2.

With Railway serving the app, you don't need GitHub Pages. You can turn it off under *Settings → Pages*.

### Using it on your phone

Browsers only allow the camera on `https://` or on `http://localhost`. To use KoolKat from a phone, do one of the following:

- run it behind an HTTPS reverse proxy or tunnel (Caddy, nginx, Cloudflare Tunnel, ngrok…) and set `TRUST_PROXY=1`, **or**
- create a certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert)) and start the server with `TLS_CERT=cert.pem TLS_KEY=key.pem npm start`.

You can then use "Add to Home Screen" to install KoolKat like an app.

### Push notifications

Notifications use the standard Web Push API, so they work without any third-party account:

- **Android, Windows, Mac, Linux:** Chrome, Edge and Firefox work in the browser. Brave needs *Use Google services for push messaging* turned on.
- **iPhone / iPad (iOS 16.4+):** first add KoolKat to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.
- KoolKat must be opened over `https://` (or `localhost`).
- Streak reminders are sent in the last 4 hours before your streak ends (midnight UTC).

## GitHub Pages (optional)

You only need this if you want the app on `github.io` while the backend runs elsewhere. With Railway (above) you can skip it. GitHub Pages can host KoolKat's **web app**, but it only serves static files, so it **can't run the backend**. The backend still has to run somewhere with a public `https://` address: a server, a hosting service like Render, Railway or Fly.io, or your own computer through a tunnel. Then:

1. **Start the backend** and allow your Pages site to talk to it:
   ```bash
   ALLOWED_ORIGINS=https://<your-github-username>.github.io npm start
   ```
2. **Tell the Pages build where the backend is.** In the repo, go to *Settings → Secrets and variables → Actions → Variables* and add `KOOLKAT_API_URL`, for example `https://koolkat-api.example.com`.
3. **Turn on Pages.** Go to *Settings → Pages* and set *Source* to **GitHub Actions**.
4. **Deploy.** Push to the default branch, or run *Actions → Deploy to GitHub Pages → Run workflow*. The site appears at `https://<your-github-username>.github.io/koolkat/`.

The workflow (`.github/workflows/pages.yml`) publishes the `public/` folder and writes the backend address into `js/config.js`. To host the frontend anywhere else, edit `public/js/config.js` by hand.

> Free GitHub accounts can only use Pages on **public** repositories. A private repo needs GitHub Pro, Team or Enterprise.

## Project layout

```
server/
  index.js      HTTP(S) server entry point and periodic jobs
  app.js        Express app and REST API
  auth.js       auth-secret hashing, sessions, rate limiting
  streaks.js    streak rules
  push.js       Web Push: subscriptions, notifications, streak reminders
  plans.js      KoolKat Free / Unlimited, codes, admins
  news.js       News posts (admins write, everyone reads)
  chats.js      direct and group chats (end-to-end encrypted messages)
  http.js       shared request validation helpers
  db.js         SQLite schema
public/
  index.html, css/styles.css
  js/app.js       UI: camera, captions, inbox, viewer, friends
  js/crypto.js    end-to-end encryption (shared with the tests)
  js/api.js       API client
  js/keystore.js  IndexedDB storage for the unlocked private key
  js/push.js      turning notifications on and off
  js/config.js    backend address (for GitHub Pages / separate hosting)
  js/theme.js     light / dark mode
  sw.js           service worker that shows notifications
.github/workflows/pages.yml  GitHub Pages deployment
railway.json                 Railway build / start / health-check settings
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
| GET | `/snaps/inbox?before=` | Received snaps from current friends, newest first (metadata only, 50 per page) |
| GET | `/snaps/sent` | Sent snaps and who has opened them |
| GET | `/snaps/:id` | Download a snap's ciphertext (recipients who are still friends with the sender only) |
| POST | `/snaps/:id/viewed` | Mark as opened, so the sender sees "Opened" |
| DELETE | `/snaps/:id` | Remove a snap from your inbox. The data is deleted once no recipient has it |
| POST | `/me/flair` | `flair`: set your Kool flair (Unlimited; empty = default) |
| POST | `/codes/redeem` | `code`: redeem a KoolKat Unlimited code |
| GET / POST | `/admin/codes` | Admin: list / create codes (`code?, maxUses?, expiresAt?, grantDays?`) |
| DELETE | `/admin/codes/:code` | Admin: delete a code |
| POST | `/admin/grant` / `/admin/revoke` | Admin: give (`username, days?`) or take back gifted Unlimited |
| POST / DELETE | `/snaps/:id/favorite` | Favorite / unfavorite a Klick |
| GET | `/favorites` | Your favorite Klicks |
| GET | `/chats` | Your chats (members with public keys, unread counts) |
| POST | `/chats/direct` | `userId`: open the chat with a friend |
| POST | `/chats/group` | `memberIds` (2+ friends), `name?`: create a group |
| POST | `/chats/:id/members` / `/name` / `/leave` / `/read` | Add friends, rename, leave, mark read |
| GET / POST | `/chats/:id/messages` | Read (`?before=`) / send an encrypted message (`iv, ephemeralPublicKey, ciphertext, keys[]`) |
| POST | `/unlimited/request` | `message?`: ask the admins for KoolKat Unlimited |
| GET | `/admin/requests` | Admin: pending requests |
| POST | `/admin/requests/:id/approve` / `/decline` | Admin: approve (`days?`, blank = forever) or decline |
| GET | `/news` / `/news/unread` | News posts / unread count |
| POST | `/news/seen` | Mark News as read |
| POST / DELETE | `/news` / `/news/:id` | Admin: post (`title, body?, code?, notify?`) / delete |
| GET | `/push/key` | The server's VAPID public key |
| POST | `/push/subscribe` | Save this device's `PushSubscription` (as JSON) |
| POST | `/push/unsubscribe` | `endpoint`: stop notifications for a device |
