/**
 * 生成扩展图标（PNG）。
 * 不依赖任何图形库：自己光栅化 + 手写 PNG 编码。
 * 运行：node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

/* ---------------------------- 几何 ---------------------------- */

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdBox(px, py, cx, cy, hw, hh) {
  const dx = Math.abs(px - cx) - hw;
  const dy = Math.abs(py - cy) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ---------------------------- 渲染 ---------------------------- */

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 超采样倍数

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          // 背景圆角方块
          const dBg = sdRoundRect(u, v, 0.5, 0.5, 0.48, 0.48, 0.22);
          if (dBg > 0.01) continue;

          // 渐变 #FF5C72 → #FF2442（左上 → 右下）
          const t = clamp01((u + v) / 2);
          let cr = mix(0xff, 0xff, t);
          let cg = mix(0x5c, 0x24, t);
          let cb = mix(0x72, 0x42, t);

          // 白色下载图标
          const dStem = sdBox(u, v, 0.5, 0.395, 0.043, 0.185);
          const dChev =
            Math.min(
              sdSegment(u, v, 0.365, 0.475, 0.5, 0.615),
              sdSegment(u, v, 0.5, 0.615, 0.635, 0.475),
            ) - 0.038;
          const dTrayL = sdBox(u, v, 0.325, 0.70, 0.036, 0.10);
          const dTrayR = sdBox(u, v, 0.675, 0.70, 0.036, 0.10);
          const dTrayB = sdBox(u, v, 0.5, 0.765, 0.186, 0.037);
          const dIcon = Math.min(dStem, dChev, dTrayL, dTrayR, dTrayB);

          if (dIcon < 0) {
            cr = 255;
            cg = 255;
            cb = 255;
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      if (a > 0) {
        buf[idx] = Math.round(r / (a / 255));
        buf[idx + 1] = Math.round(g / (a / 255));
        buf[idx + 2] = Math.round(b / (a / 255));
        buf[idx + 3] = Math.round(a / samples);
      }
    }
  }
  return buf;
}

/* ---------------------------- PNG 编码 ---------------------------- */

function crc32(buffer) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(render(size), size);
  writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png (${png.length} bytes)`);
}
