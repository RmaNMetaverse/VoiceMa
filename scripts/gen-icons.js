#!/usr/bin/env node
/**
 * Renders the PWA icon set with no image dependencies: signed-distance-field
 * drawing into an RGBA buffer, supersampled, encoded as PNG via zlib.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');
const ifMissing = process.argv.includes('--if-missing');

const TARGETS = [
  { file: 'icon-32.png', size: 32, maskable: false },
  { file: 'icon-180.png', size: 180, maskable: false },
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-1024.png', size: 1024, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true }
];

if (ifMissing && TARGETS.every((t) => fs.existsSync(path.join(outDir, t.file)))) {
  console.log('icons: already present, skipping');
  process.exit(0);
}

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- drawing helpers (all in 0..1 unit space) ----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Distance to a rounded rectangle centred at (cx,cy). Negative = inside. */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a circular ring, used for the mic cradle. */
function sdRing(x, y, cx, cy, radius, thickness) {
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - thickness;
}

const coverage = (d, aa) => clamp01(0.5 - d / aa);

/** The glyph: capsule + open cradle + stem + base, as one alpha mask. */
function micAlpha(x, y, aa) {
  const capsule = sdRoundRect(x, y, 0.5, 0.415, 0.108, 0.205, 0.108);

  let cradle = sdRing(x, y, 0.5, 0.44, 0.215, 0.035);
  if (y < 0.44) cradle = 0.5; // keep only the lower half of the ring
  const stem = sdRoundRect(x, y, 0.5, 0.705, 0.026, 0.06, 0.026);
  const base = sdRoundRect(x, y, 0.5, 0.775, 0.115, 0.028, 0.028);

  return coverage(Math.min(capsule, cradle, stem, base), aa);
}

function render(size, maskable) {
  const ss = size >= 512 ? 3 : 4; // supersample factor
  const S = size * ss;
  const buf = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(size * size * 4);
  const aa = 1.5 / S;

  // Glyph occupies a smaller share on maskable icons to survive circle cropping.
  const glyphScale = maskable ? 0.62 : 0.78;

  for (let py = 0; py < S; py++) {
    const y = (py + 0.5) / S;
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / S;

      // Backdrop: rounded squircle plate (full bleed when maskable).
      const plate = maskable ? -1 : sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.2237);
      const plateA = coverage(plate, aa);
      if (plateA <= 0) continue;

      // Diagonal indigo -> violet gradient with a soft specular sheen.
      const t = clamp01((x * 0.6 + y * 0.75) / 1.35);
      let r = mix(0x4f, 0x9b, t);
      let g = mix(0x7a, 0x59, t);
      let b = mix(0xff, 0xf6, t);

      const sheen = Math.max(0, 1 - Math.hypot(x - 0.26, y - 0.16) / 0.62) ** 2.4;
      r = mix(r, 255, sheen * 0.42);
      g = mix(g, 255, sheen * 0.42);
      b = mix(b, 255, sheen * 0.42);

      // Deeper pool toward the bottom-right keeps the plate from looking flat.
      const pool = Math.max(0, 1 - Math.hypot(x - 0.72, y - 0.94) / 0.7) ** 3;
      r = mix(r, 0x2b, pool * 0.3);
      g = mix(g, 0x1c, pool * 0.3);
      b = mix(b, 0x7a, pool * 0.3);

      // Glyph, centred and scaled inside the plate.
      const gx = (x - 0.5) / glyphScale + 0.5;
      const gy = (y - 0.5) / glyphScale + 0.5;
      const ga =
        gx < -0.2 || gx > 1.2 || gy < -0.2 || gy > 1.2 ? 0 : micAlpha(gx, gy, aa / glyphScale);

      r = mix(r, 255, ga);
      g = mix(g, 255, ga);
      b = mix(b, 255, ga);

      const o = (Math.floor(py / ss) * size + Math.floor(px / ss)) * 4;
      acc[o] += r * plateA;
      acc[o + 1] += g * plateA;
      acc[o + 2] += b * plateA;
      acc[o + 3] += 255 * plateA;
    }
  }

  const n = ss * ss;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const a = acc[o + 3] / n;
    // Un-premultiply so edges stay clean over any backdrop.
    const f = a > 0.5 ? 255 / a : 0;
    buf[o] = Math.min(255, Math.round((acc[o] / n) * f));
    buf[o + 1] = Math.min(255, Math.round((acc[o + 1] / n) * f));
    buf[o + 2] = Math.min(255, Math.round((acc[o + 2] / n) * f));
    buf[o + 3] = Math.round(a);
  }
  return encodePNG(buf, size);
}

fs.mkdirSync(outDir, { recursive: true });
for (const { file, size, maskable } of TARGETS) {
  fs.writeFileSync(path.join(outDir, file), render(size, maskable));
  console.log('icons: ' + file + ' (' + size + 'px' + (maskable ? ', maskable' : '') + ')');
}

// A vector copy for favicon / high-DPI use.
const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
  '  <defs>',
  '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
  '      <stop offset="0" stop-color="#4F7AFF"/><stop offset="1" stop-color="#9B59F6"/>',
  '    </linearGradient>',
  '    <radialGradient id="s" cx="0.26" cy="0.16" r="0.62">',
  '      <stop offset="0" stop-color="#fff" stop-opacity="0.42"/>',
  '      <stop offset="1" stop-color="#fff" stop-opacity="0"/>',
  '    </radialGradient>',
  '  </defs>',
  '  <rect width="512" height="512" rx="114.5" fill="url(#g)"/>',
  '  <rect width="512" height="512" rx="114.5" fill="url(#s)"/>',
  '  <g transform="translate(256 256) scale(0.78) translate(-256 -256)">',
  '    <rect x="200.7" y="107.5" width="110.6" height="210" rx="55.3" fill="#fff"/>',
  '    <path d="M145.2 225.3a110.8 110.8 0 0 0 221.6 0" fill="none" stroke="#fff" stroke-width="35.8" stroke-linecap="round"/>',
  '    <path d="M256 330.5v56" fill="none" stroke="#fff" stroke-width="26.6" stroke-linecap="round"/>',
  '    <rect x="197.1" y="382.3" width="117.8" height="28.7" rx="14.3" fill="#fff"/>',
  '  </g>',
  '</svg>',
  ''
].join('\n');
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);
console.log('icons: icon.svg');
