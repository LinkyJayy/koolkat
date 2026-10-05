import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { openDatabase } from './db.js';
import { cleanup, createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const db = openDatabase();
const app = createApp({ db });

// Browsers only allow camera access on https:// or http://localhost.
// To use KoolKat from a phone on your network, provide a certificate.
const { TLS_CERT, TLS_KEY } = process.env;
const server =
  TLS_CERT && TLS_KEY
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
    : http.createServer(app);

cleanup(db);
setInterval(() => cleanup(db), 60 * 60 * 1000).unref();

server.listen(port, host, () => {
  const scheme = TLS_CERT && TLS_KEY ? 'https' : 'http';
  console.log(`KoolKat is running at ${scheme}://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
