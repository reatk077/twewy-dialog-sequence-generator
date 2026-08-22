// gen_placeholders.js — generates simple placeholder character sprites.
// Usage: node tools/gen_placeholders.js [outdir]
// Output: assets/sprites/{id}{n}.png  (id = actor id, n = expression 1..count)
//
// Placeholders are procedurally drawn silhouettes (head + torso) so you can
// run the demo immediately. Drop your own PNGs into assets/sprites/ following
// the same {id}{n}.png naming (or point !actor patterns elsewhere) to replace
// them — no code changes needed.

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- minimal PNG encoder ----------
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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba /* Uint8Array w*h*4 */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    src.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- drawing helpers (raster into RGBA buffer) ----------
function makeCanvas(w, h) {
  return { w, h, buf: new Uint8Array(w * h * 4) };
}
function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  // simple src-over blend
  const da = c.buf[i + 3] / 255, sa = a / 255;
  c.buf[i] = Math.round(r * sa + c.buf[i] * (1 - sa));
  c.buf[i + 1] = Math.round(g * sa + c.buf[i + 1] * (1 - sa));
  c.buf[i + 2] = Math.round(b * sa + c.buf[i + 2] * (1 - sa));
  c.buf[i + 3] = Math.round(255 * (sa + da * (1 - sa)));
}
function fillEllipse(c, cx, cy, rx, ry, r, g, b, a) {
  const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(c, x, y, r, g, b, a);
    }
}
function fillRoundRect(c, x0, y0, x1, y1, rad, r, g, b, a) {
  const minX = Math.max(0, Math.floor(x0)), maxX = Math.min(c.w - 1, Math.ceil(x1));
  const minY = Math.max(0, Math.floor(y0)), maxY = Math.min(c.h - 1, Math.ceil(y1));
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      // distance to nearest edge (rounded corners)
      let dx = 0, dy = 0;
      if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad);
      if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rad) setPx(c, x, y, r, g, b, a);
    }
}

function drawPerson(c, cx, bodyTop, bodyH, bodyW, headR, bodyColor, headColor, outline) {
  // torso
  fillRoundRect(c, cx - bodyW / 2, bodyTop, cx + bodyW / 2, bodyTop + bodyH, bodyW * 0.22, bodyColor[0], bodyColor[1], bodyColor[2], 255);
  // head
  fillEllipse(c, cx, bodyTop - headR * 0.9, headR, headR * 1.1, headColor[0], headColor[1], headColor[2], 255);
  if (outline) {
    // dark silhouette overlay on the left edge to fake shading
    fillEllipse(c, cx - headR * 0.55, bodyTop - headR * 0.9, headR * 0.35, headR * 1.1, outline[0], outline[1], outline[2], 90);
  }
}

function shadeColor(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((n & 255) * factor));
  return [r, g, b];
}

// ---------- sprite generation ----------
const ACTORS = [
  { id: 'alice', base: '#3b82f6', head: '#f8d8b0', name: 'Alice' },   // blue
  { id: 'bravo', base: '#ef4444', head: '#f0c8a0', name: 'Bravo' },   // red
  { id: 'chloe', base: '#22c55e', head: '#f4d4b4', name: 'Chloe' },   // green
];

const W = 240, H = 360;

function main(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const actor of ACTORS) {
    for (let expr = 1; expr <= 3; expr++) {
      const c = makeCanvas(W, H);
      const sway = expr === 2 ? -6 : expr === 3 ? 8 : 0; // expression 2/3 shift body a bit
      const cx = W / 2 + sway;
      const bodyH = H * 0.42;
      const bodyW = W * 0.52;
      const bodyTop = H * 0.5;
      const headR = W * 0.19;
      const base = shadeColor(actor.base, expr === 3 ? 0.75 : 1);
      const head = shadeColor(actor.head, expr === 3 ? 0.8 : 1);
      const dark = shadeColor(actor.base, 0.5);
      drawPerson(c, cx, bodyTop, bodyH, bodyW, headR, base, head, dark);
      // legs
      fillRoundRect(c, cx - bodyW * 0.32, bodyTop + bodyH, cx - bodyW * 0.08, bodyTop + bodyH + H * 0.09, 8, dark[0], dark[1], dark[2], 255);
      fillRoundRect(c, cx + bodyW * 0.08, bodyTop + bodyH, cx + bodyW * 0.32, bodyTop + bodyH + H * 0.09, 8, dark[0], dark[1], dark[2], 255);
      const file = path.join(outDir, `${actor.id}${expr}.png`);
      fs.writeFileSync(file, encodePNG(W, H, c.buf));
      console.log('wrote', file);
    }
  }
  console.log('done. add your own art by replacing these PNGs (or point !actor patterns elsewhere).');
}

main(process.argv[2] || path.join(__dirname, '..', 'assets', 'sprites'));
