import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  serverName: 'VoiceMa',
  httpsPort: 8443,
  httpRedirectPort: 8080,
  password: '',
  maxUsersPerChannel: 12,
  allowUserChannels: true,
  channels: [{ id: 'general', name: 'General', description: 'Everyone lands here' }]
};

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
  password: process.env.VOICEMA_PASSWORD ?? fileConfig.password ?? ''
};

/** Every non-internal IPv4 this host answers on — printed at boot so people can find it. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}
