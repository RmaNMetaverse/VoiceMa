import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { config, lanAddresses, ROOT } from './config.js';
import { serveStatic, serveCA } from './static.js';
import { Hub } from './signaling.js';

const CERT_DIR = path.join(ROOT, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CRT_FILE = path.join(CERT_DIR, 'server.crt');

/**
 * Plain HTTP mode, for trying the app on the machine that runs it.
 * http://localhost is a secure context, so the microphone and the service
 * worker both work — but only for "localhost". Phones on the LAN reach the
 * server by IP, which is NOT a secure context, so they still need HTTPS.
 */
const HTTP_ONLY = process.argv.includes('--http') || process.env.VOICEMA_HTTP_ONLY === '1';

if (!HTTP_ONLY && (!fs.existsSync(KEY_FILE) || !fs.existsSync(CRT_FILE))) {
  console.error('\nNo TLS certificate found.\n');
  console.error('  Run:  npm run cert\n');
  console.error('HTTPS is not optional here: browsers block microphone access and');
  console.error('service workers on plain http:// LAN addresses.\n');
  process.exit(1);
}

const BASE = config.basePath;

const handler = async (req, res) => {
    // Everything below works in app-relative terms; the mount point is peeled
    // off here so a reverse proxy can pass the full path through untouched.
    if (BASE) {
      const raw = req.url ?? '/';
      if (raw === BASE) {
        // Without the trailing slash every relative URL would resolve one
        // level too high, so send the browser to the canonical form.
        res.writeHead(301, { Location: BASE + '/' }).end();
        return;
      }
      if (raw.startsWith(BASE + '/') || raw.startsWith(BASE + '?')) {
        req.url = raw.slice(BASE.length) || '/';
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
    }

    const url = (req.url ?? '/').split('?')[0];

    if (url === '/ca.crt' || url === '/voicema-ca.crt') return serveCA(req, res);

    if (url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          name: config.serverName,
          requiresPassword: !!config.password,
          allowUserChannels: config.allowUserChannels !== false,
          users: hub.users.size
        })
      );
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    if (await serveStatic(req, res)) return;

    // Unknown path inside an installed PWA: hand back the shell.
    req.url = '/index.html';
    if (await serveStatic(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
};

const server = HTTP_ONLY
  ? http.createServer(handler)
  : https.createServer(
      { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) },
      handler
    );

const hub = new Hub(server);
const scheme = HTTP_ONLY ? 'http' : 'https';

/**
 * In HTTP mode the redirect listener is not running, so we borrow its port.
 * That keeps `npm run dev` from colliding with a live HTTPS instance.
 * An explicit VOICEMA_PORT always wins.
 */
const PORT =
  HTTP_ONLY && !process.env.VOICEMA_PORT
    ? config.httpRedirectPort || config.httpsPort
    : config.httpsPort;

// Bound to loopback means something else is terminating TLS in front of us.
const BEHIND_PROXY = ['127.0.0.1', '::1', 'localhost'].includes(config.bindAddress);

server.listen(PORT, config.bindAddress, () => {
  const lan = lanAddresses();
  const line = '─'.repeat(58);
  console.log(`\n\x1b[35m${line}\x1b[0m`);
  console.log(`  \x1b[1m${config.serverName}\x1b[0m — LAN voice chat`);
  console.log(`\x1b[35m${line}\x1b[0m`);

  if (BEHIND_PROXY) {
    console.log(`  Upstream   ${scheme}://${config.bindAddress}:${PORT}${BASE}/`);
    console.log('\n  \x1b[36mBehind a reverse proxy.\x1b[0m Reach it on the public address');
    console.log('  the proxy serves; TLS and the LAN address belong to that layer.');
  } else {
    console.log(`  Local      ${scheme}://localhost:${PORT}${BASE}/`);
    for (const { name, address } of lan) {
      console.log(
        `  ${name.padEnd(10).slice(0, 10)} \x1b[36m${scheme}://${address}:${PORT}${BASE}/\x1b[0m`
      );
    }

    if (HTTP_ONLY) {
      console.log('\n  \x1b[33mHTTP mode — microphone works on localhost only.\x1b[0m');
      console.log('  Phones and other machines need HTTPS: restart without --http.');
    } else {
      console.log('\n  Trust the CA once per device:');
      for (const { address } of lan) {
        console.log(`             https://${address}:${PORT}${BASE}/ca.crt`);
      }
    }
  }

  if (BASE) console.log(`\n  Mounted at ${BASE}/`);
  if (config.password) console.log('\n  \x1b[33mPassword protection is ON\x1b[0m');
  console.log(`\n  Channels   ${hub.channels.map((c) => c.name).join(', ')}`);
  console.log(`\x1b[35m${line}\x1b[0m\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error('Change "httpsPort" in config.json or set VOICEMA_PORT.\n');
    process.exit(1);
  }
  throw err;
});

// Courtesy redirect so a typed http:// address still lands people in the app.
if (!HTTP_ONLY && config.httpRedirectPort > 0) {
  const redirect = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    res.writeHead(301, { Location: `https://${host}:${config.httpsPort}${req.url}` }).end();
  });
  redirect.on('error', (err) => {
    console.warn(`http redirect disabled (${err.code})`);
  });
  redirect.listen(config.httpRedirectPort, config.bindAddress);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down…');
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
