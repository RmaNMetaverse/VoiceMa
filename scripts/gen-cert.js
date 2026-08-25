#!/usr/bin/env node
/**
 * Generates a local Certificate Authority and a server certificate covering
 * every LAN address this machine currently has.
 *
 * Why a CA and not a bare self-signed cert: browsers refuse to register a
 * service worker (and therefore refuse to install the PWA) on an origin with
 * certificate errors. Installing ca.crt once per device makes the origin fully
 * trusted, which unlocks install-to-homescreen, offline shell and background
 * audio behaviour.
 */
import forge from 'node-forge';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certDir = path.join(root, 'certs');
const ifMissing = process.argv.includes('--if-missing');

const files = {
  caKey: path.join(certDir, 'ca.key'),
  caCrt: path.join(certDir, 'ca.crt'),
  key: path.join(certDir, 'server.key'),
  crt: path.join(certDir, 'server.crt')
};

if (ifMissing && Object.values(files).every((f) => fs.existsSync(f))) {
  console.log('certs: already present, skipping');
  process.exit(0);
}

/** Every IPv4/IPv6 address this host answers on, so one cert covers all NICs. */
export function localAddresses() {
  const out = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (!ni.internal) out.add(ni.address.replace(/%.*$/, ''));
    }
  }
  return [...out];
}

function hostNames() {
  const names = new Set(['localhost', os.hostname().toLowerCase()]);
  names.add(`${os.hostname().toLowerCase()}.local`);
  // Allow an operator-pinned hostname, e.g. VOICEMA_HOSTS=voice.office.lan,pbx
  for (const extra of (process.env.VOICEMA_HOSTS ?? '').split(',')) {
    const t = extra.trim();
    if (t) names.add(t.toLowerCase());
  }
  return [...names];
}

const isIPv4 = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
const isIP = (s) => isIPv4(s) || s.includes(':');

function keypair(bits = 2048) {
  return forge.pki.rsa.generateKeyPair({ bits, workers: -1 });
}

function baseCert(publicKey, serialSeed) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '00' + forge.util.bytesToHex(forge.random.getBytesSync(8)) + serialSeed;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
  return cert;
}

console.log('certs: generating local CA (RSA-2048, this takes a few seconds)…');
const caKeys = keypair();
const caAttrs = [
  { name: 'commonName', value: 'VoiceMa Local CA' },
  { name: 'organizationName', value: 'VoiceMa Self-Hosted' },
  { shortName: 'OU', value: 'LAN Voice' }
];
const ca = baseCert(caKeys.publicKey, '01');
ca.setSubject(caAttrs);
ca.setIssuer(caAttrs);
ca.setExtensions([
  { name: 'basicConstraints', cA: true, critical: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
  { name: 'subjectKeyIdentifier' }
]);
ca.sign(caKeys.privateKey, forge.md.sha256.create());

const addresses = localAddresses();
const names = hostNames();
const altNames = [
  ...names.map((value) => ({ type: 2, value })),
  ...addresses.map((value) => (isIPv4(value) ? { type: 7, ip: value } : { type: 2, value }))
];

console.log('certs: signing server certificate…');
const srvKeys = keypair();
const srvAttrs = [
  { name: 'commonName', value: names[1] || 'voicema.local' },
  { name: 'organizationName', value: 'VoiceMa Self-Hosted' }
];
const srv = baseCert(srvKeys.publicKey, '02');
srv.setSubject(srvAttrs);
srv.setIssuer(caAttrs);
srv.setExtensions([
  { name: 'basicConstraints', cA: false, critical: true },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
  { name: 'extKeyUsage', serverAuth: true },
  { name: 'subjectAltName', altNames },
  { name: 'subjectKeyIdentifier' }
]);
srv.sign(caKeys.privateKey, forge.md.sha256.create());

fs.mkdirSync(certDir, { recursive: true });
fs.writeFileSync(files.caKey, forge.pki.privateKeyToPem(caKeys.privateKey));
fs.writeFileSync(files.caCrt, forge.pki.certificateToPem(ca));
fs.writeFileSync(files.key, forge.pki.privateKeyToPem(srvKeys.privateKey));
fs.writeFileSync(files.crt, forge.pki.certificateToPem(srv));
fs.writeFileSync(
  path.join(certDir, 'meta.json'),
  JSON.stringify({ generated: new Date().toISOString(), hosts: names, addresses }, null, 2)
);

console.log('certs: wrote certs/ca.crt, certs/server.crt, certs/server.key');
console.log('certs: valid for ' + [...names, ...addresses].join(', '));
console.log('\nInstall certs/ca.crt on every client device once (see README) so the');
console.log('PWA installs cleanly and background audio is allowed.');
