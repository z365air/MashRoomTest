#!/usr/bin/env node
/**
 * MashRoom Test - Icon Generator
 * Generates PNG icons without external dependencies using raw PNG format.
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --- PNG encoder ---

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const td = Buffer.concat([t, data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function buildPNG(w, h, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (1 + w * 4) + 1 + x * 4;
      raw[d] = pixels[s]; raw[d+1] = pixels[s+1]; raw[d+2] = pixels[s+2]; raw[d+3] = pixels[s+3];
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', zlib.deflateSync(raw, {level:9})), chunk('IEND', Buffer.alloc(0))]);
}

// --- Drawing helpers ---

function px(buf, w, x, y, r, g, b, a = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= w || y < 0 || y >= buf.length / w / 4) return;
  const i = (y * w + x) * 4;
  const sa = a / 255, da = buf[i+3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa < 0.001) return;
  buf[i]   = Math.round((r * sa + buf[i]   * da * (1 - sa)) / oa);
  buf[i+1] = Math.round((g * sa + buf[i+1] * da * (1 - sa)) / oa);
  buf[i+2] = Math.round((b * sa + buf[i+2] * da * (1 - sa)) / oa);
  buf[i+3] = Math.round(oa * 255);
}

function ellipse(buf, w, h, cx, cy, rx, ry, r, g, b, a = 255) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(h-1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(w-1, Math.ceil(cx + rx)); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx*dx + dy*dy <= 1) px(buf, w, x, y, r, g, b, a);
    }
  }
}

function rect(buf, w, h, x, y, rw, rh, r, g, b, a = 255) {
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(h, Math.ceil(y + rh)); py++)
    for (let px2 = Math.max(0, Math.floor(x)); px2 < Math.min(w, Math.ceil(x + rw)); px2++)
      px(buf, w, px2, py, r, g, b, a);
}

function roundRect(buf, w, h, x, y, rw, rh, radius, r, g, b, a = 255) {
  for (let py = Math.floor(y); py < Math.ceil(y + rh); py++) {
    for (let px2 = Math.floor(x); px2 < Math.ceil(x + rw); px2++) {
      if (py < 0 || py >= h || px2 < 0 || px2 >= w) continue;
      const lx = px2 - x, ly = py - y;
      let inside = true;
      if (lx < radius && ly < radius) {
        const ddx = lx - radius, ddy = ly - radius;
        inside = ddx*ddx + ddy*ddy <= radius*radius;
      } else if (lx > rw - radius && ly < radius) {
        const ddx = lx - (rw - radius), ddy = ly - radius;
        inside = ddx*ddx + ddy*ddy <= radius*radius;
      } else if (lx < radius && ly > rh - radius) {
        const ddx = lx - radius, ddy = ly - (rh - radius);
        inside = ddx*ddx + ddy*ddy <= radius*radius;
      } else if (lx > rw - radius && ly > rh - radius) {
        const ddx = lx - (rw - radius), ddy = ly - (rh - radius);
        inside = ddx*ddx + ddy*ddy <= radius*radius;
      }
      if (inside) px(buf, w, px2, py, r, g, b, a);
    }
  }
}

// --- Icon drawing ---

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const s = size / 128;
  const cx = size / 2;

  // Shadow beneath body
  ellipse(buf, size, size, cx, size*0.92, size*0.28, size*0.045, 150, 100, 60, 60);

  // Body (cream/beige rounded)
  roundRect(buf, size, size,
    cx - size*0.26, size*0.56,
    size*0.52, size*0.35,
    size*0.12,
    240, 220, 185, 255
  );
  // Body bottom ellipse
  ellipse(buf, size, size, cx, size*0.89, size*0.26, size*0.045, 225, 200, 160, 255);
  // Body top ellipse (where cap meets body)
  ellipse(buf, size, size, cx, size*0.58, size*0.26, size*0.055, 240, 220, 185, 255);

  // Mushroom cap (full ellipse - dark red outline)
  ellipse(buf, size, size, cx, size*0.40, size*0.48, size*0.42, 140, 20, 20, 255);
  // Cap fill (red)
  ellipse(buf, size, size, cx, size*0.40, size*0.455, size*0.395, 192, 35, 35, 255);

  // Redraw body on top to clip the lower cap
  roundRect(buf, size, size,
    cx - size*0.26, size*0.57,
    size*0.52, size*0.35,
    size*0.10,
    240, 220, 185, 255
  );
  ellipse(buf, size, size, cx, size*0.89, size*0.26, size*0.045, 225, 200, 160, 255);

  // White spots on cap
  ellipse(buf, size, size, cx,           size*0.20, size*0.085, size*0.075, 255, 252, 235, 245);
  ellipse(buf, size, size, cx - size*0.20, size*0.33, size*0.065, size*0.055, 255, 252, 235, 235);
  ellipse(buf, size, size, cx + size*0.20, size*0.30, size*0.065, size*0.055, 255, 252, 235, 235);
  if (size >= 32) {
    ellipse(buf, size, size, cx + size*0.09, size*0.44, size*0.04, size*0.035, 255, 252, 235, 210);
    ellipse(buf, size, size, cx - size*0.09, size*0.42, size*0.035, size*0.03, 255, 252, 235, 200);
  }

  // Headphone cups (circles on sides of cap)
  if (size >= 32) {
    ellipse(buf, size, size, cx - size*0.44, size*0.42, size*0.06, size*0.065, 140, 20, 20, 255);
    ellipse(buf, size, size, cx + size*0.44, size*0.42, size*0.06, size*0.065, 140, 20, 20, 255);
    ellipse(buf, size, size, cx - size*0.44, size*0.42, size*0.045, size*0.05, 192, 35, 35, 255);
    ellipse(buf, size, size, cx + size*0.44, size*0.42, size*0.045, size*0.05, 192, 35, 35, 255);
  }

  if (size >= 48) {
    // Eyebrows (angry - angled dark lines)
    for (let i = 0; i < 14 * s; i++) {
      const slope = 0.45;
      rect(buf, size, size,
        cx - size*0.19 + i, size*0.555 - i * slope,
        Math.max(1, 2*s), Math.max(1, 2*s),
        60, 15, 15, 255
      );
      rect(buf, size, size,
        cx + size*0.05 + i, size*0.535 + i * slope,
        Math.max(1, 2*s), Math.max(1, 2*s),
        60, 15, 15, 255
      );
    }

    // Eyes (white with dark pupils)
    ellipse(buf, size, size, cx - size*0.10, size*0.615, size*0.065, size*0.055, 255, 245, 225, 255);
    ellipse(buf, size, size, cx + size*0.10, size*0.615, size*0.065, size*0.055, 255, 245, 225, 255);
    ellipse(buf, size, size, cx - size*0.10, size*0.62, size*0.032, size*0.03, 35, 15, 15, 255);
    ellipse(buf, size, size, cx + size*0.10, size*0.62, size*0.032, size*0.03, 35, 15, 15, 255);

    // Crossed microphones
    const micR = [180, 30, 30];
    const micStroke = Math.max(2, Math.round(4 * s));
    // Left mic: goes from lower-left to upper-right
    for (let i = 0; i < Math.round(28 * s); i++) {
      const mx = cx - size*0.27 + i * 0.72;
      const my = size*0.84 - i * 0.55;
      rect(buf, size, size, mx, my, micStroke, micStroke, ...micR, 255);
    }
    // Left mic head (grey mesh ball)
    ellipse(buf, size, size, cx - size*0.09, size*0.695, size*0.045, size*0.05, 160, 160, 160, 255);
    ellipse(buf, size, size, cx - size*0.09, size*0.695, size*0.03, size*0.035, 200, 200, 200, 255);
    // Right mic: goes from lower-right to upper-left area (crossed)
    for (let i = 0; i < Math.round(28 * s); i++) {
      const mx = cx + size*0.08 + i * 0.72;
      const my = size*0.695 + i * 0.55;
      rect(buf, size, size, mx, my, micStroke, micStroke, ...micR, 255);
    }
    // Right mic head
    ellipse(buf, size, size, cx + size*0.27, size*0.845, size*0.045, size*0.05, 160, 160, 160, 255);
    ellipse(buf, size, size, cx + size*0.27, size*0.845, size*0.03, size*0.035, 200, 200, 200, 255);
  }

  return buildPNG(size, size, buf);
}

// Generate all sizes
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const png = drawIcon(size);
  const out = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓ icons/icon${size}.png (${png.length} bytes)`);
}
console.log('Icons generated!');
