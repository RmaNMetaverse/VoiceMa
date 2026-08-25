import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, config } from './config.js';

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

/**
 * Two files depend on where the app is mounted, so they are rewritten as they
 * are served rather than being duplicated on disk:
 *
 *   index.html          gets a <base> tag, which every relative URL in the page
 *                       (and every relative fetch) then resolves against
 *   manifest.webmanifest has its root-absolute paths re-pointed at the mount
 *
 * Everything else is static bytes and needs no rewriting.
 */
function rewriteForBasePath(file, body) {
  const base = config.basePath;
  const name = path.basename(file);

  if (name === 'index.html') {
    return body.replace('<head>', `<head>\n    <base href="${base}/" />`);
  }

  if (name === 'manifest.webmanifest') {
    const manifest = JSON.parse(body);
    const point = (p) => (typeof p === 'string' && p.startsWith('/') ? base + p : p);
    manifest.id = base + '/';
    manifest.scope = base + '/';
    manifest.start_url = base + '/?source=pwa';
    manifest.icons = (manifest.icons ?? []).map((i) => ({ ...i, src: point(i.src) }));
    manifest.shortcuts = (manifest.shortcuts ?? []).map((s) => ({
      ...s,
      url: base + '/?channel=general',
      icons: (s.icons ?? []).map((i) => ({ ...i, src: point(i.src) }))
    }));
    return JSON.stringify(manifest, null, 2);
  }

  return null;
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
  const name = path.basename(file);
  const needsRewrite = name === 'index.html' || name === 'manifest.webmanifest';

  // The mount point is part of what these two files say, so it is part of
  // their identity for caching purposes.
  const etag = needsRewrite
    ? (await etagFor(file, stat)).replace(/"$/, `-${Buffer.from(config.basePath).toString('hex')}"`)
    : await etagFor(file, stat);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag }).end();
    return true;
  }

  // The shell must revalidate so a redeploy reaches clients; hashed-ish assets
  // (icons) can sit in cache for a day.
  const cacheControl =
    ext === '.html' || ext === '.webmanifest' || name === 'sw.js'
      ? 'no-cache'
      : ext === '.png' || ext === '.svg' || ext === '.woff2'
        ? 'public, max-age=86400'
        : 'no-cache';

  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': cacheControl,
    ETag: etag,
    // Mic + wake lock are same-origin only; nothing here is embeddable.
    'Permissions-Policy': 'microphone=(self), screen-wake-lock=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  };

  if (needsRewrite) {
    const body = rewriteForBasePath(file, await fsp.readFile(file, 'utf8'));
    const buffer = Buffer.from(body, 'utf8');
    headers['Content-Length'] = buffer.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buffer);
    return true;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);

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
