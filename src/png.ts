// Маленький декодер PNG на чистом JS (без нативных модулей): нужен, чтобы читать цвет пикселей
// плиток пробок. Поддерживает 8-битные RGBA/RGB/серые и палитровые (1/2/4/8 бит, с прозрачностью tRNS).

import { unzlibSync } from 'fflate';

export type Img = { w: number; h: number; rgba: Uint8Array };

export function decodePng(buf: ArrayBuffer | Uint8Array): Img {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('не PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p < b.length) {
    const len = dv.getUint32(p); const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('PNG с чересстрочностью не поддерживается');
  const total = idat.reduce((a, x) => a + x.length, 0);
  const z = new Uint8Array(total); let o = 0;
  for (const x of idat) { z.set(x, o); o += x.length; }
  const raw = unzlibSync(z); // данные PNG — поток zlib (с заголовком)
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : 1;
  const bpp = Math.max(1, (ch * depth) >> 3);              // байт на пиксель (для фильтров)
  const stride = Math.ceil((w * ch * depth) / 8);
  const px = new Uint8Array(stride * h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4, row = y * stride;
    if (ctype === 6) { const s = row + x * 4; rgba[q] = px[s]; rgba[q + 1] = px[s + 1]; rgba[q + 2] = px[s + 2]; rgba[q + 3] = px[s + 3]; }
    else if (ctype === 2) { const s = row + x * 3; rgba[q] = px[s]; rgba[q + 1] = px[s + 1]; rgba[q + 2] = px[s + 2]; rgba[q + 3] = 255; }
    else if (ctype === 4) { const s = row + x * 2; rgba[q] = rgba[q + 1] = rgba[q + 2] = px[s]; rgba[q + 3] = px[s + 1]; }
    else {
      const per = 8 / depth, byte = px[row + Math.floor(x / per)];
      const idx = depth === 8 ? byte : (byte >> (8 - depth * ((x % per) + 1))) & ((1 << depth) - 1);
      if (ctype === 3 && palette) {
        rgba[q] = palette[idx * 3]; rgba[q + 1] = palette[idx * 3 + 1]; rgba[q + 2] = palette[idx * 3 + 2];
        rgba[q + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else { const g = depth === 8 ? idx : Math.round((idx * 255) / ((1 << depth) - 1)); rgba[q] = rgba[q + 1] = rgba[q + 2] = g; rgba[q + 3] = 255; }
    }
  }
  return { w, h, rgba };
}
