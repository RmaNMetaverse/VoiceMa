import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.crt': 'application/x-x509-ca-cert',
  '.txt': 'text/plain; charset=utf-8'
};

const etagCache = new Map();

async function etagFor(file, stat) {
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  const hit = etagCache.get(file);
  if (hit && hit.key === key) return hit.etag;
  const etag = '"' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '"';
  etagCache.set(file, { key, etag });
  return etag;
}

/**
 * Resolves a URL path inside public/ without escaping it.
 * Returns null when the request tries to traverse out of the directory.
 */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = path.normalize(decoded).replace(/^([/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, clean);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

export async function serveStatic(req, res) {
  let file = resolveSafe(req.url === '/' ? '/index.html' : req.url);
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file);
    }
  } catch {
    return false;
  }

  const ext = path.extname(file).toLowerCase();
  const etag = await etagFor(file, stat);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag }).end();
    return true;
  }

  // The shell must revalidate so a redeploy reaches clients; hashed-ish assets
  // (icons) can sit in cache for a day.
  const cacheControl =
    ext === '.html' || ext === '.webmanifest' || file.endsWith('sw.js')
      ? 'no-cache'
      : ext === '.png' || ext === '.svg' || ext === '.woff2'
        ? 'public, max-age=86400'
        : 'no-cache';

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    ETag: etag,
    // Mic + wake lock are same-origin only; nothing here is embeddable.
    'Permissions-Policy': 'microphone=(self), screen-wake-lock=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

/** Hands out the local CA so a phone can trust this origin in one tap. */
export function serveCA(req, res) {
  const file = path.join(ROOT, 'certs', 'ca.crt');
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('CA not generated yet — run: npm run cert');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="voicema-ca.crt"',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}
