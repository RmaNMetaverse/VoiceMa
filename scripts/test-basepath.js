#!/usr/bin/env node
/**
 * Verifies the app behaves correctly when mounted under a sub-path, which is
 * how it is deployed behind a reverse proxy (e.g. https://host/VoiceMa).
 *
 * Boots its own server on a spare port, checks it, and shuts it down.
 *   node scripts/test-basepath.js
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = '/TestMount';
const PORT = 8931;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain GET that never follows redirects, so we can assert on them. */
function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(ORIGIN + pathname, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body })
      );
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get(`${MOUNT}/health`);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

const server = spawn(
  process.execPath,
  [path.join(ROOT, 'server', 'index.js')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      VOICEMA_HTTP_ONLY: '1',
      VOICEMA_PORT: String(PORT),
      VOICEMA_BIND: '127.0.0.1',
      VOICEMA_BASE_PATH: MOUNT,
      VOICEMA_NAME: 'BasePath Test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d));
server.stderr.on('data', (d) => (serverOutput += d));

const shutdown = () => {
  if (!server.killed) server.kill();
};
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(1);
});

async function run() {
  console.log(`\nSub-path test — mounted at ${MOUNT}\n`);

  if (!(await waitForServer())) {
    console.error('server did not start:\n' + serverOutput);
    process.exit(1);
  }

  // --- routing under the mount ---------------------------------
  const index = await get(`${MOUNT}/`);
  check('index is served at the mount', index.status === 200);

  check(
    'a <base> tag pins every relative URL to the mount',
    index.body.includes(`<base href="${MOUNT}/" />`),
    (index.body.match(/<base[^>]*>/) ?? ['none'])[0]
  );

  // The injected <base> is the one tag that must carry an absolute path.
  const withoutBaseTag = index.body.replace(/<base[^>]*>/g, '');
  const stragglers = [...withoutBaseTag.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  check(
    'no root-absolute asset links survive (they would escape the mount)',
    stragglers.length === 0,
    stragglers.join(', ')
  );

  const noSlash = await get(MOUNT);
  check(
    'the mount without a trailing slash redirects',
    noSlash.status === 301 && noSlash.headers.location === `${MOUNT}/`,
    `${noSlash.status} -> ${noSlash.headers.location}`
  );

  for (const asset of ['js/app.js', 'js/vad-processor.js', 'css/style.css', 'sw.js', 'icons/icon-192.png']) {
    const r = await get(`${MOUNT}/${asset}`);
    check(`asset ${asset}`, r.status === 200, String(r.status));
  }

  const api = await get(`${MOUNT}/api/info`);
  check('api responds under the mount', api.status === 200 && JSON.parse(api.body).name === 'BasePath Test');

  // --- nothing is served outside the mount ---------------------
  for (const outside of ['/', '/js/app.js', '/api/info', '/index.html']) {
    const r = await get(outside);
    check(`outside the mount: ${outside} is 404`, r.status === 404, String(r.status));
  }

  // --- manifest is rewritten -----------------------------------
  const manifest = JSON.parse((await get(`${MOUNT}/manifest.webmanifest`)).body);
  check('manifest scope points at the mount', manifest.scope === `${MOUNT}/`, manifest.scope);
  check('manifest start_url points at the mount', manifest.start_url.startsWith(`${MOUNT}/`), manifest.start_url);
  check(
    'manifest icons point at the mount',
    manifest.icons.every((i) => i.src.startsWith(`${MOUNT}/`)),
    manifest.icons[0].src
  );
  check(
    'manifest shortcut points at the mount',
    manifest.shortcuts.every((s) => s.url.startsWith(`${MOUNT}/`)),
    manifest.shortcuts[0]?.url
  );
  check('manifest still requests fullscreen', manifest.display === 'fullscreen');

  // --- the service worker resolves its own base ----------------
  const sw = (await get(`${MOUNT}/sw.js`)).body;
  check(
    'service worker derives its base from its own location',
    sw.includes("new URL('./', self.location)") && !/'\/index\.html'/.test(sw)
  );

  // --- the signalling socket lives under the mount -------------
  const connected = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${MOUNT}/ws`);
    const done = (v) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', name: 'Mounted' }));
    });
    ws.on('message', (d) => done(JSON.parse(d).t === 'welcome'));
    ws.on('error', () => done(false));
    setTimeout(() => done(false), 4000);
  });
  check('WebSocket connects at <mount>/ws', connected);

  const rejectedAtRoot = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      ws.close();
      resolve(false);
    });
    ws.on('error', () => resolve(true));
    setTimeout(() => resolve(true), 3000);
  });
  check('WebSocket is not served at the root', rejectedAtRoot);

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}\n`);
  shutdown();
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\ntest error:', err.message);
  console.error(serverOutput);
  shutdown();
  process.exit(1);
});
