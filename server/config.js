import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  serverName: 'VoiceMa',
  httpsPort: 8443,
  httpRedirectPort: 8080,
  bindAddress: '0.0.0.0',
  basePath: '',
  password: '',
  maxUsersPerChannel: 12,
  allowUserChannels: true,
  channels: [{ id: 'general', name: 'General', description: 'Everyone lands here' }]
};

/**
 * Normalises a mount point to either '' (root) or '/Something' — leading
 * slash, no trailing slash. Everything else in the server builds on that shape.
 */
export function normalizeBasePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '';
  return ('/' + raw.replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/');
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`config: ignoring ${file} (${err.message})`);
    return {};
  }
}

const fileConfig = readJSON(path.join(ROOT, 'config.json'));

/** Env wins over config.json, which wins over defaults. */
export const config = {
  ...DEFAULTS,
  ...fileConfig,
  serverName: process.env.VOICEMA_NAME ?? fileConfig.serverName ?? DEFAULTS.serverName,
  httpsPort: Number(process.env.VOICEMA_PORT ?? fileConfig.httpsPort ?? DEFAULTS.httpsPort),
  httpRedirectPort: Number(
    process.env.VOICEMA_HTTP_PORT ?? fileConfig.httpRedirectPort ?? DEFAULTS.httpRedirectPort
  ),
  bindAddress: process.env.VOICEMA_BIND ?? fileConfig.bindAddress ?? DEFAULTS.bindAddress,
  basePath: normalizeBasePath(process.env.VOICEMA_BASE_PATH ?? fileConfig.basePath ?? ''),
  password: process.env.VOICEMA_PASSWORD ?? fileConfig.password ?? ''
};

/**
 * Every non-internal IPv4 this host answers on — printed at boot so people can
 * find the server.
 *
 * Enumerating interfaces needs an AF_NETLINK socket on Linux, which a
 * sandboxed service may be forbidden from opening. That must never be fatal:
 * this is a convenience banner, not a dependency, so a failure degrades to an
 * empty list.
 */
export function lanAddresses() {
  const out = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch (err) {
    console.warn(`config: could not list network interfaces (${err.code ?? err.message})`);
    return out;
  }
  for (const [name, list] of Object.entries(interfaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}
