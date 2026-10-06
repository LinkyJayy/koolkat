# KoolKat

A private, Snapchat alternative. You take photos in the app with the front or rear camera, add a caption, and send them to friends as **Klicks**. Klicks are **end-to-end encrypted**, can only go to **friends**, and stay saved so you can view them again. Sending each other Klicks every day builds **streaks**, and you can **chat** with friends one-on-one or in groups.

## Features

Photos taken in KoolKat are called **Klicks**.

- **Accounts.** Sign up and sign in with a username and password. Sessions persist across reloads.
- **Friends.** Search by username, send, accept, ignore or cancel requests, and remove friends. Adding someone who already added you accepts their request.
- **QR code friending.** 🔳 *Friends → My QR code* (or *Profile → My QR code*) shows your code. A friend taps *Friends → Scan QR*, or points their phone's normal camera at it, and you're friends straight away, with no request to accept. The code changes every few minutes and stops working after 10, so an old screenshot can't be used to add you.
- **Nearby.** 📍 *Friends → Nearby* lists people about 150 m from you who have Nearby open at the same moment; tap **Add** to send a request. It uses your phone's location (Bluetooth isn't available to web apps). Your location is only sent while the screen is open, is held in the server's memory for at most 2 minutes, is never saved, and is never shown to anyone: others only see your name.
- **Friends-only.** The server refuses to deliver a Klick to anyone who isn't an accepted friend. It also refuses to let a recipient download a Klick after the two of them stop being friends.
- **Camera.** Uses the front or rear camera with a flip button. Selfies are mirrored like a normal selfie camera.
- **KatCam.** 😺 The two-camera button on the camera screen puts both cameras in one Klick: the back camera fills the picture and your selfie sits in the corner (flip swaps them). If the phone can run both cameras at once you see both live. Most phones can't, so KatCam takes the second picture right after the first ("Now smile! 📸"). It's sent as one normal, end-to-end encrypted Klick.
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
- **Installable app (PWA).** KoolKat installs like a normal app, with its own icon, full screen and no browser bars. On Android and desktop, use *Profile → Install KoolKat*. On iPhone, use Safari's *Share → Add to Home Screen*. Long-press the icon for shortcuts to the camera, Klicks and Chats. It opens even offline, and when a new version is deployed it shows *"A new version of KoolKat is ready → Reload"*.
- **Light and dark mode.** Choose System, Light or Dark under *Appearance* on the sign-in screen or in your profile. The choice is remembered on that device.

## KoolKat Free vs KoolKat Unlimited

KoolKat is completely free, and so is **KoolKat Unlimited**. Unlimited isn't sold: you get it from an admin.

| | KoolKat Free | KoolKat Unlimited (free, from admins) |
| --- | --- | --- |
| Storage for Klicks you've sent | 512 MB | 2.5 GB |
| Kool badge 👑 next to your name | – | ✓ |
| Kool flair (custom line under your name, default "i have nine lives") | – | ✓ |
| Custom app icon: Classic, Crown, Glow, or your own picture | – | ✓ |
| Custom badge picture (with *Reset Badge to Default*) | – | ✓ |
| BFFs 💙: heart friends to pin them to the top of your friends and chats | – | ✓ |
| Chat themes: background (presets, any colour, or your own picture) and bubble colour | – | ✓ |
| Activity Bubbles 🫧: show friends what you're up to | – | ✓ |
| Kat Map 🗺: see where your friends are | – | ✓ |
| Rich Presence 🎵: show what you're listening to (Spotify or Last.fm) | – | ✓ |
| QR friending, Nearby, KatCam | ✓ | ✓ |

Storage counts the Klicks you've sent that still exist. Deleting a sent Klick (it's removed for everyone) frees the space. When it's full, KoolKat asks you to delete some. Badges and flair are shown to your friends in their friend list, your profile, your Klicks and chats.

**Customising (Profile → KoolKat Unlimited):**

- **App icon.** Pick *Crown* or *Glow*, or *Upload a picture from your gallery* (cropped to a square). The browser tab icon changes straight away, and installing KoolKat uses your icon. Browsers don't let a website change an icon that's already on the home screen, so to switch there, remove KoolKat and install it again. (Chrome on Android may also update it by itself after a while.)
- **Kool badge.** *Choose from gallery* replaces the crown next to your name with your own picture, for everyone who sees your name. *Reset Badge to Default* brings the crown back. Uploaded badge and icon pictures are served from unguessable links so browsers can show them.
- **Chat themes.** Pick a background (Midnight, Sunset, Ocean, Forest, Candy, any colour, or a picture from your gallery) and the colour of your own message bubbles. The text colour adjusts automatically so it stays readable. Themes change how chats look for you; your background picture is only ever sent to you.
- **Activity Bubbles.** Choose an emoji, write what you're doing (up to 40 characters), and show it until you clear it or for 1, 4, 8 or 24 hours. Your friends see it in their friends list, on your friend card, and at the top of your chat; you see it on your profile. People who aren't your friends never see it.
- **Kat Map.** *Friends → 🗺* shows you and your friends on a map (OpenStreetMap). Sharing is **off (👻 Ghost)** until you pick **💙 BFFs** (only friends you've made BFFs) or **👥 Friends**. Tap a friend in the list to fly to them, or their pin to open their card. KoolKat sends your location while it's open on your screen (every 30 seconds, or sooner when you move); friends see your last spot with how long ago it was, and spots older than 24 hours disappear. Going back to Ghost deletes your location from the server. Both people need Unlimited. **Background:** websites and installed web apps can't get your location while they're in the background or closed (browsers block it), so your friends see where you were when you last had KoolKat open. Live background tracking would need a native app from the app stores.
- **Rich Presence.** *Profile → Rich Presence* shows friends what you're listening to: in their friends list, on your friend card, and at the top of your chat, with the album art and a link to the song. Songs disappear when you stop playing.
  - **Spotify:** tap *Connect Spotify* and approve. The server keeps checking even when KoolKat is closed. While a song plays it works out when the song ends and doesn't ask Spotify again until then, so there's about one request per song. When nothing is playing it checks every 10 seconds just after you stop, then every 30 seconds. Friends never see how far into a song you are. If you skip or pause partway through, friends see the change when the old song would have ended, or straight away when you open your own profile. Friends looking at their friends list or your chat see changes within about 4 seconds of the server.
  - **Apple Music (and others) via Last.fm (optional):** Apple doesn't let other apps see what you're playing in Apple Music. Instead, connect a scrobbler app (like Marvis Pro or QuietScrob on iPhone) to Last.fm, then enter your Last.fm username. Spotify users can link Last.fm too (in Spotify's settings). KoolKat looks up each song's length on Last.fm once, then waits for it to end in the same way.
  - The admin has to set this up first (see *Rich Presence setup* below).
- **BFFs.** Open a friend's card and tap **Make BFF**. BFFs get their own section at the top of *Friends*, and their chats are pinned to the top of *Chats*, with the 💙 heart. Only you see who your BFFs are. Unfriending someone removes the heart.

There are three ways to get Unlimited:

- **Redeem a code** (*Profile → Have a code?*, or the **Redeem** button on a News post).
- **Ask for it**: *Profile → 🎁 Ask an admin for KoolKat Unlimited*, with an optional message. Admins get a notification and can approve or decline. After a decline you can ask again the next day.
- **Get a gift** from an admin.

### Admin tools

The account **`zalith9`** is the admin. Capitalisation doesn't matter, and usernames are unique regardless of capitalisation, so there can only be one zalith9. Set `KOOLKAT_ADMINS` to a comma-separated list to change it. Admins always have **KoolKat Unlimited forever** (it can't expire or be taken away), and get an **Admin tools** button in their profile, where they can:

- **create redeemable codes** with their own text (or a random `KOOL-XXXX-XXXX`), a **usage limit**, an **expiry date**, and how many days of Unlimited they give (or forever). Each person can use a code once;
- see how many times each code has been used, and copy or delete codes;
- **give KoolKat Unlimited to any user** for a number of days, or forever, and take a gift back;
- **reset someone's badge, app icon, Activity Bubble, or all of them** (*Reset badge, icon or activity*), for example if they upload an inappropriate picture or write something rude. Uploaded pictures are deleted, and they get a notification;
- **approve or decline requests** for Unlimited (the button shows how many are waiting);
- **post to News** (title, text, an optional code, and optionally a notification to everyone), and delete posts.

> Admin rights come from the username. If the database is ever lost (for example, Railway without a volume), whoever registers `zalith9` first becomes admin. Keep a volume attached.

### Rich Presence setup

Both are free, and you can set up either one, both, or neither. Put the keys in Railway → your service → **Variables** (never in the code or a chat):

- **Spotify:** go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), *Create app*, choose *Web API*, and add the redirect URI `https://kool-kat.com/api/presence/spotify/callback`. Copy the *Client ID* and *Client secret* into `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. **Limit:** new Spotify apps are in *Development mode*, where only up to 25 people you add under *User Management* (their Spotify email) can connect. Spotify only lifts that limit for large companies, so for everyone else Last.fm is the way. If someone connects but isn't on that list, KoolKat tells them in their profile ("Spotify won't share your music with KoolKat yet") with a **Try again** button, and the Railway logs show `Spotify refused this account … for KoolKat user <name>` so you know who to add.
- **Last.fm (optional):** skip this and Rich Presence is Spotify-only; the Last.fm option doesn't appear in the app. If you set it up, it shows as a folded *Use Last.fm instead* option under *Connect Spotify*. Removing the key later switches it off again (people connected through Last.fm just stop showing a song). To set it up, create an API account at [last.fm/api/account/create](https://www.last.fm/api/account/create) and put the *API key* in `LASTFM_API_KEY`. There's no user limit.

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
| `KOOLKAT_DB` | `data/koolkat.db` | SQLite database file. On Railway, defaults to the attached volume; don't set it there |
| `KOOLKAT_ALLOW_TEMPORARY_STORAGE` | – | Set to `1` to let KoolKat start on Railway without a volume (data is wiped on every update; only for testing) |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly with this certificate and key |
| `TRUST_PROXY` | `1` on Railway, else off | Number of reverse proxies in front of the server, so rate limiting sees real client IPs |
| `ALLOWED_ORIGINS` | – | Comma-separated sites allowed to use the API from another domain, e.g. `https://linkyjayy.github.io` for GitHub Pages |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web Push keys. If you don't set them, a key pair is generated once and saved in the database. Generate your own with `npx web-push generate-vapid-keys` |
| `CANONICAL_HOST` | – | The app's own domain, e.g. `kool-kat.com`. Visits to the `….up.railway.app` address redirect there |
| `KOOLKAT_ADMINS` | `zalith9` | Usernames (any capitalisation, comma-separated) that get admin tools |
| `VAPID_SUBJECT` | repo URL | Contact URL or `mailto:` address sent to push services |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | – | Turns on *Connect Spotify* for Rich Presence |
| `SPOTIFY_REDIRECT_URI` | `https://<CANONICAL_HOST>/api/presence/spotify/callback` | Only needed if it differs from that |
| `LASTFM_API_KEY` | – | Optional: turns on Last.fm (Apple Music) for Rich Presence |

## Deploying to Railway

[Railway](https://railway.com) runs the backend **and** serves the app, so you get one `https://` link that works on phones (camera and notifications included). The repo already has a `railway.json`, so there's nothing to configure in code.

1. **Create the service.** Sign in at railway.com, then go to **New Project → Deploy from GitHub repo** and pick `LinkyJayy/koolkat`. Railway installs and starts it automatically.
2. **Attach a volume. Don't skip this.** Without one, every deploy or restart **deletes all accounts, friends, Klicks and chats**. In the project, right-click the KoolKat service (or press ⌘K / Ctrl+K and type *volume*), choose **Attach volume**, and use the mount path `/data`. KoolKat finds the volume and stores its database there automatically.
3. **Get a link.** Open the service → **Settings → Networking → Generate Domain**. Your app is now at something like `https://koolkat-production.up.railway.app`.
4. **Optional:** in the service's **Variables**, set `VAPID_SUBJECT` to `mailto:you@example.com` so push services can contact you.

Every push to the deployed branch redeploys automatically. The deploy logs show `Database: /data/koolkat.db (Railway volume at /data)` once the volume is attached, and `https://<your-domain>/api/health` shows `"storage":"permanent"`.

**KoolKat won't start on Railway without a volume.** An update without one would start with an empty database and wipe every account, so the deploy stops instead with `STOPPED: KoolKat's database would be lost…` in the logs, and Railway keeps the previous version running. Attach the volume (step 2) and redeploy. Admins also see a red warning in their profile if storage is ever temporary.

With Railway serving the app, you don't need GitHub Pages. You can turn it off under *Settings → Pages*.

### Custom domain (kool-kat.com on Squarespace)

1. **Squarespace:** go to **Domains → kool-kat.com → DNS** and apply the **Railway** preset. It points the bare domain at Railway.
2. **Railway:** open the KoolKat service → **Settings → Networking → + Custom Domain**, enter `kool-kat.com`, and pick port `8080` (or the port in your deploy logs). Wait for the green ✓. Railway issues the HTTPS certificate automatically. Until then, browsers show "connection is not private".
3. **Railway variables:** add `CANONICAL_HOST=kool-kat.com`. Visits to the old `….up.railway.app` address are then redirected to the domain.
4. **Optional `www`:** also add `www.kool-kat.com` as a custom domain in Railway, and create the CNAME record Railway shows for `www` in Squarespace's DNS.

Sign-ins, saved keys and notification settings are stored per website address, so people who used the old Railway address sign in once more on the new domain (and turn notifications on again).

### Using it on your phone

Browsers only allow the camera on `https://` or on `http://localhost`. To use KoolKat from a phone, do one of the following:

- run it behind an HTTPS reverse proxy or tunnel (Caddy, nginx, Cloudflare Tunnel, ngrok…) and set `TRUST_PROXY=1`, **or**
- create a certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert)) and start the server with `TLS_CERT=cert.pem TLS_KEY=key.pem npm start`.

You can then use "Add to Home Screen" to install KoolKat like an app.

### Installable app (PWA) details

- `public/manifest.webmanifest`: name, icons (including padded "maskable" ones for Android's round icons), shortcuts, and screenshots for the install dialog.
- `public/sw.js`: the service worker. It saves the app's files on the device so KoolKat opens instantly and offline, and never caches `/api/` (Klicks and messages are always fetched live and stay end-to-end encrypted). The server fills in its version from a hash of the app's files, so every deploy that changes them is picked up as an update. The page then offers a reload instead of switching under you.
- If you add a new file to `public/js/`, also add it to `PRECACHE` in `sw.js`. A test checks this.

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
  customize.js  Unlimited app icons, custom badges, BFFs, per-icon manifest
  social.js     QR friend codes, Nearby, Activity Bubbles, chat themes
  katmap.js     Kat Map sharing settings and friends' locations
  presence.js   Rich Presence: Spotify / Last.fm connections and polling
  chats.js      direct and group chats (end-to-end encrypted messages)
  http.js       shared request validation helpers
  db.js         SQLite schema
public/
  index.html, css/styles.css
  js/app.js       UI: camera, captions, inbox, viewer, friends
  js/crypto.js    end-to-end encryption (shared with the tests)
  js/qr.js        drawing and scanning friend QR codes
  js/katcam.js    KatCam: both cameras in one Klick
  vendor/         qrcode-generator (MIT), jsQR (Apache-2.0) and Leaflet (BSD-2), served locally
  js/api.js       API client
  js/keystore.js  IndexedDB storage for the unlocked private key
  js/push.js      turning notifications on and off
  js/config.js    backend address (for GitHub Pages / separate hosting)
  js/theme.js     light / dark mode
  sw.js           service worker: offline app shell, updates, notifications
  manifest.webmanifest, icons/, screenshots/  installable-app metadata
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
| POST | `/me/app-icon` | `icon`: `default` / `crown` / `glow` / `custom` (+ `icon512`, `icon192` PNGs to upload) |
| POST / DELETE | `/me/badge` | Upload a custom badge (`image` PNG) / reset to the default |
| GET | `/app-icons/:id/:size.png`, `/badges/:id.png` | Uploaded icon / badge pictures |
| POST / DELETE | `/bffs/:userId` | Heart / un-heart a friend |
| POST | `/admin/reset-customization` | Admin: `username`, `badge?`, `icon?`: reset their badge and/or app icon |
| POST | `/unlimited/request` | `message?`: ask the admins for KoolKat Unlimited |
| GET | `/admin/requests` | Admin: pending requests |
| POST | `/admin/requests/:id/approve` / `/decline` | Admin: approve (`days?`, blank = forever) or decline |
| GET | `/friend-code` | Your current QR friend code (`code, expiresAt`) |
| POST | `/friends/qr` | `code`: become friends with the code's owner |
| POST / DELETE | `/nearby` | `lat, lng, accuracy`: check in and list people nearby / leave Nearby |
| POST / DELETE | `/me/activity` | Unlimited: set (`emoji, text, hours?`) / clear your Activity Bubble |
| POST | `/me/chat-theme` | Unlimited: `background, color?, bubble?, image?` (JPEG base64) |
| GET | `/me/chat-background` | Your own chat background picture |
| POST | `/map/settings` | Unlimited: `mode` = `off` (deletes your location), `bffs` or `friends` |
| POST | `/map/location` | Unlimited: `lat, lng, accuracy` while sharing |
| GET | `/map` | Unlimited: your sharing mode and location, and friends sharing with you |
| GET / DELETE | `/presence` | Your Rich Presence connection / disconnect |
| POST | `/presence/spotify/start` | Unlimited: `returnTo`; returns the Spotify approval link |
| GET | `/presence/spotify/callback` | Where Spotify sends you back |
| POST | `/presence/lastfm` | Unlimited: `username` |
| POST | `/presence/refresh` | Check what you're playing now |
| GET | `/presence/friends` | What your friends are playing (the app checks this every 4 seconds) |
| GET | `/news` / `/news/unread` | News posts / unread count |
| POST | `/news/seen` | Mark News as read |
| POST / DELETE | `/news` / `/news/:id` | Admin: post (`title, body?, code?, notify?`) / delete |
| GET | `/push/key` | The server's VAPID public key |
| POST | `/push/subscribe` | Save this device's `PushSubscription` (as JSON) |
| POST | `/push/unsubscribe` | `endpoint`: stop notifications for a device |
