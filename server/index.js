import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { defaultDatabasePath, openDatabase } from './db.js';
import { cleanup, createApp } from './app.js';
import { createPusher } from './push.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const dbPath = defaultDatabasePath();
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.KOOLKAT_DB) {
  console.warn(
    'WARNING: no Railway volume is attached, so all accounts, friends and Klicks will be ' +
      'lost on the next deploy or restart. Attach a volume to this service (any mount path, e.g. /data).'
  );
}
console.log(`Database: ${dbPath}`);
const db = openDatabase(dbPath);
const pusher = createPusher({ db });
const app = createApp({ db, pusher });

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

server.listen(port, host, () => {
  const scheme = TLS_CERT && TLS_KEY ? 'https' : 'http';
  const version = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.KOOLKAT_VERSION || 'dev').slice(0, 7);
  console.log(`KoolKat ${version} is running at ${scheme}://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
