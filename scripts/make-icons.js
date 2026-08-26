'use strict';
/**
 * Generates the PWA icons as real PNGs using only node:zlib.
 * Avoids adding an image dependency for three static files.
 *
 *   node scripts/make-icons.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'src', 'server', 'static');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** @param {number} size @param {(x:number,y:number)=>[number,number,number,number]} shade */
function png(size, shade) {
  const stride = size * 4 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = shade(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, used for crisp edges. */
function roundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay) - r;
}

/** Distance from a point to a line segment — used to draw the checkmark. */
function segDist(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cxp = x1 + t * vx - px, cyp = y1 + t * vy - py;
  return Math.sqrt(cxp * cxp + cyp * cyp);
}

function makeIcon(size) {
  const s = size / 192; // design at 192 and scale
  const cx = size / 2, cy = size / 2;

  return png(size, (x, y) => {
    // Sample at pixel centre.
    const px = x + 0.5, py = y + 0.5;

    // Rounded-square background (#0d1117 with a subtle blue lift at the top).
    const dBg = roundRect(px, py, cx, cy, size / 2, size / 2, 42 * s);
    if (dBg > 0.8) return [0, 0, 0, 0];
    const t = py / size;
    let br = Math.round(13 + 10 * (1 - t));
    let bg = Math.round(17 + 16 * (1 - t));
    let bb = Math.round(23 + 30 * (1 - t));
    let ba = dBg > 0 ? Math.round(255 * (1 - dBg / 0.8)) : 255;

    // Shield outline.
    const shieldTop = 40 * s, shieldBot = 156 * s, shieldHalf = 46 * s;
    // Width tapers to a point at the bottom.
    const prog = (py - shieldTop) / (shieldBot - shieldTop);
    let inShield = false, edge = 0;
    if (prog >= 0 && prog <= 1) {
      const taper = prog < 0.62 ? 1 : 1 - (prog - 0.62) / 0.38;
      const halfW = shieldHalf * Math.max(taper, 0);
      const dx = Math.abs(px - cx);
      edge = halfW - dx;
      inShield = edge > 0;
    }

    if (inShield) {
      // Shield fill: accent blue, brighter toward the top.
      const k = 1 - prog * 0.35;
      let r = Math.round(88 * k), g = Math.round(166 * k), b = Math.round(255 * k);

      // Checkmark in the shield, drawn in near-black for contrast.
      const d = Math.min(
        segDist(px, py, cx - 22 * s, cy - 6 * s, cx - 6 * s, cy + 12 * s),
        segDist(px, py, cx - 6 * s, cy + 12 * s, cx + 24 * s, cy - 20 * s)
      );
      const stroke = 8 * s;
      if (d < stroke) {
        const aa = Math.min(1, (stroke - d) / (1.2 * s));
        r = Math.round(r * (1 - aa) + 4 * aa);
        g = Math.round(g * (1 - aa) + 18 * aa);
        b = Math.round(b * (1 - aa) + 37 * aa);
      }
      // Antialias the shield border against the background.
      const aa = Math.min(1, edge / (1.2 * s));
      return [
        Math.round(r * aa + br * (1 - aa)),
        Math.round(g * aa + bg * (1 - aa)),
        Math.round(b * aa + bb * (1 - aa)),
        255,
      ];
    }

    return [br, bg, bb, ba];
  });
}

for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log('wrote', path.relative(process.cwd(), file), fs.statSync(file).size + ' bytes');
}
