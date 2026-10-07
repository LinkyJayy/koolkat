import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { defaultDatabasePath, openDatabase, storageStatus } from './db.js';
import { cleanup, createApp } from './app.js';
import { createPusher } from './push.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const dbPath = defaultDatabasePath();
const storage = storageStatus(dbPath);
if (!storage.persistent) {
  const message =
    `KoolKat's database would be lost on the next update: ${storage.reason}.\n` +
    'Fix: in Railway, right-click the KoolKat service → Attach volume → mount path /data, then redeploy.';
  if (!process.env.KOOLKAT_ALLOW_TEMPORARY_STORAGE) {
    // Refuse to start, so this update never goes live with an empty database.
    // Railway keeps the previous version running until a volume is attached.
    console.error(`\n${'='.repeat(72)}\nSTOPPED: ${message}\n${'='.repeat(72)}\n`);
    process.exit(1);
  }
  console.warn(`WARNING: ${message}`);
}
console.log(`Database: ${dbPath} (${storage.reason})`);
const db = openDatabase(dbPath);
const pusher = createPusher({ db });
const app = createApp({ db, pusher, storage });

// Browsers only allow camera access on https:// or http://localhost.
// To use KoolKat from a phone on your network, provide a certificate.
const { TLS_CERT, TLS_KEY } = process.env;
const server =
  TLS_CERT && TLS_KEY
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
    : http.createServer(app);

cleanup(db);
setInterval(() => cleanup(db), 60 * 60 * 1000).unref();
// Streak reminders go out in the last hours of each (UTC) day.
setInterval(() => pusher.runStreakReminders().catch((err) => console.error(err)), 10 * 60 * 1000).unref();
// Calls: end ones where a phone disappeared without hanging up.
setInterval(() => app.locals.sweepCalls(), 5000).unref();

server.listen(port, host, () => {
  const scheme = TLS_CERT && TLS_KEY ? 'https' : 'http';
  const version = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.KOOLKAT_VERSION || 'dev').slice(0, 7);
  console.log(`KoolKat ${version} is running at ${scheme}://localhost:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
