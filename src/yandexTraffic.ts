// НЕОФИЦИАЛЬНЫЙ источник (для себя): пробки Яндекса — без наложения плиток.
//
// Как это работает:
//   1. Скачиваем «плитки пробок» Яндекса только вдоль нашего маршрута (на ~40 км вперёд), в фоне.
//      Плитки не показываем — это просто картинки с покрашенными дорогами.
//   2. У Яндекса другая проекция (эллипсоидная Меркатора, EPSG:3395), поэтому плитки нельзя
//      положить поверх нашей карты — уедут. Но формулу мы знаем: для каждой точки маршрута
//      считаем, в какой пиксель какой плитки Яндекса она попадает.
//   3. Читаем цвет пикселей под нашей линией: зелёный — свободно, жёлтый — плотно,
//      красный — пробка, бордовый — стоим. Сглаживаем (медиана по соседним точкам).
//   4. Рисуем своей линией и используем для объездов.
//
// Адрес неофициальный — может поменяться. Его можно поправить в настройках; ошибки — в журнале 🐞.

import type { LatLon } from './core/geo.ts';
import type { TrafficColor, TrafficSeg } from './online.ts';
import { decodePng, type Img } from './png.ts';

export const YANDEX_TILE_URL = 'https://core-jams-rdr-cache.maps.yandex.net/1.1/tiles?trf&l=trf&lang=ru_RU&x={x}&y={y}&z={z}&scale=1&tm={tm}';
export const YANDEX_STAMP_URL = 'https://api-maps.yandex.ru/services/coverage/v2/layers_stamps?lang=ru_RU&l=trf';
const HEADERS = { Referer: 'https://yandex.ru/maps/', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36' };

const E = 0.0818191908426; // эксцентриситет эллипсоида WGS-84

/** Пиксель в мире плиток Яндекса (EPSG:3395) на масштабе z (плитки 256 px). */
export function yandexPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 256 * 2 ** z;
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const es = E * Math.sin(phi);
  const yM = Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - es) / (1 + es)) ** (E / 2));
  return { x: ((lon + 180) / 360) * n, y: ((1 - yM / Math.PI) / 2) * n };
}

/** Тот же пиксель в обычной (сферической) проекции — чтобы показать, насколько уехали бы плитки. */
export function webPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 256 * 2 ** z, phi = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * n };
}

/** Цвет пикселя → уровень загруженности (или null — не дорога/прозрачно). По оттенку, а не по точным RGB. */
export function classifyColor(r: number, g: number, b: number, a: number): TrafficColor | null {
  if (a < 90) return null;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
  if (sat < 0.35 || v < 0.25) return null; // серые/белые обводки и подписи
  let hue = 0;
  if (mx === r) hue = ((g - b) / (mx - mn)) * 60; else if (mx === g) hue = (2 + (b - r) / (mx - mn)) * 60; else hue = (4 + (r - g) / (mx - mn)) * 60;
  if (hue < 0) hue += 360;
  if (hue >= 75 && hue <= 170) return 'fast';
  if (hue >= 38 && hue < 75) return 'normal';
  if (hue < 38 || hue >= 330) return v < 0.75 ? 'jam' : 'slow';
  return null;
}

const RANK: Record<TrafficColor, number> = { none: -1, fast: 0, normal: 1, slow: 2, jam: 3 };
const BY_RANK: TrafficColor[] = ['fast', 'normal', 'slow', 'jam'];

/** Цвет «под точкой»: ищем ближайший цветной пиксель в радиусе r px (линия дороги ~3–6 px). */
function sample(img: Img, px: number, py: number, r = 3): TrafficColor | null {
  let best: TrafficColor | null = null, bd = Infinity;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(px) + dx, y = Math.round(py) + dy;
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const q = (y * img.w + x) * 4;
    const c = classifyColor(img.rgba[q], img.rgba[q + 1], img.rgba[q + 2], img.rgba[q + 3]);
    const d = dx * dx + dy * dy;
    if (c && d < bd) { bd = d; best = c; }
  }
  return best;
}

let stampCache: { tm: string; at: number } | null = null;

/** Версия слоя пробок (Яндекс обновляет её раз в несколько минут). Нет — работаем без неё. */
export async function fetchStamp(signal?: AbortSignal): Promise<string> {
  if (stampCache && Date.now() - stampCache.at < 120_000) return stampCache.tm;
  try {
    const r = await fetch(YANDEX_STAMP_URL, { headers: HEADERS, signal });
    const t = await r.text();
    const m = /"trf"\s*:\s*\{[^}]*"version"\s*:\s*"?(\d+)/.exec(t) ?? /"version"\s*:\s*"?(\d{6,})/.exec(t);
    const tm = m?.[1] ?? '';
    stampCache = { tm, at: Date.now() };
    return tm;
  } catch {
    return String(Math.floor(Date.now() / 1000 / 60) * 60);
  }
}

export type YandexResult = { segs: TrafficSeg[]; tiles: number; failed: number; samples: number; colored: number; stats: Record<string, number>; tm: string };

/**
 * Пробки Яндекса вдоль маршрута: points[fromIdx..] на aheadM вперёд.
 * Точки через ~25 м, масштаб 14 (≈7 м на пиксель), сглаживание медианой по 5 точкам.
 */
export async function yandexAlongRoute(points: LatLon[], fromIdx: number, aheadM = 40_000,
  opts: { z?: number; urlTemplate?: string; signal?: AbortSignal; _retry?: boolean } = {}): Promise<YandexResult> {
  const z = opts.z ?? 14;
  // 1) точки маршрута через ~25 м
  const pts: LatLon[] = [];
  let acc = 0, last: LatLon | null = null;
  for (let i = Math.max(0, fromIdx); i < points.length && acc <= aheadM; i++) {
    const p = points[i];
    if (last) {
      const d = Math.hypot((p.lat - last.lat) * 111320, (p.lon - last.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180));
      const n = Math.floor(d / 25);
      for (let k = 1; k <= n; k++) pts.push({ lat: last.lat + ((p.lat - last.lat) * k) / (n + 1), lon: last.lon + ((p.lon - last.lon) * k) / (n + 1) });
      acc += d;
    }
    pts.push(p); last = p;
  }
  // 2) какие плитки нужны
  const pix = pts.map((p) => yandexPixel(p.lat, p.lon, z));
  const need = new Map<string, [number, number]>();
  for (const q of pix) { const tx = Math.floor(q.x / 256), ty = Math.floor(q.y / 256); need.set(`${tx}/${ty}`, [tx, ty]); }
  // 3) скачиваем (по 4 сразу) и расшифровываем
  const tm = await fetchStamp(opts.signal);
  const tpl = opts.urlTemplate || YANDEX_TILE_URL;
  const imgs = new Map<string, Img>();
  let failed = 0;
  const keys = [...need.keys()];
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const k = keys[next++];
      const [tx, ty] = need.get(k)!;
      const url = tpl.replace('{x}', String(tx)).replace('{y}', String(ty)).replace('{z}', String(z)).replace('{tm}', tm);
      try {
        const r = await fetch(url, { headers: HEADERS, signal: opts.signal });
        if (r.status === 204 || r.status === 404) continue; // пустая плитка — пробок нет данных
        if (!r.ok) { failed++; continue; }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length < 60) continue;
        imgs.set(k, decodePng(buf));
      } catch (e: any) { if (e?.name === 'AbortError') throw e; failed++; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed && failed === keys.length) {
    // Все плитки упали — повторная попытка через 25 с (один раз)
    if (!opts._retry) {
      await new Promise((r) => setTimeout(r, 25_000));
      if (opts.signal?.aborted) throw new Error('AbortError');
      return yandexAlongRoute(points, fromIdx, aheadM, { ...opts, _retry: true });
    }
    throw new Error(`Яндекс не отдал ни одной плитки (${failed})`);
  }
  // 4) цвет под каждой точкой
  const raw: (TrafficColor | null)[] = pix.map((q) => {
    const tx = Math.floor(q.x / 256), ty = Math.floor(q.y / 256);
    const img = imgs.get(`${tx}/${ty}`);
    return img ? sample(img, q.x - tx * 256, q.y - ty * 256) : null;
  });
  // 5) сглаживание: медиана по 5 точкам (только по цветным)
  const smooth: (TrafficColor | null)[] = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 2), i + 3).filter((c): c is TrafficColor => !!c && c !== 'none').map((c) => RANK[c]).sort((a, b) => a - b);
    return w.length >= 2 ? BY_RANK[w[Math.floor(w.length / 2)]] : null;
  });
  // 6) участки одного цвета → линии
  const segs: TrafficSeg[] = [];
  const stats: Record<string, number> = {};
  let colored = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = smooth[i];
    if (c) { colored++; stats[c] = (stats[c] ?? 0) + 1; }
    const prev = segs[segs.length - 1];
    if (c && prev && prev.color === c && prev.pts.length && i > 0 && smooth[i - 1] === c) prev.pts.push(pts[i]);
    else if (c) segs.push({ color: c, raw: 'yandex', pts: i > 0 ? [pts[i - 1], pts[i]] : [pts[i]] });
  }
  return { segs: segs.filter((s) => s.pts.length >= 2), tiles: keys.length, failed, samples: pts.length, colored, stats, tm };
}

/** Красные/бордовые участки длиннее 300 м → «пробка впереди» с оценкой задержки. */
export function yandexJams(segs: TrafficSeg[]): { at: LatLon; lengthM: number; delayS: number; level: TrafficColor; startPt: LatLon }[] {
  const out = [];
  for (const s of segs) {
    if (s.color !== 'slow' && s.color !== 'jam') continue;
    let L = 0;
    for (let i = 1; i < s.pts.length; i++) L += Math.hypot((s.pts[i].lat - s.pts[i - 1].lat) * 111320, (s.pts[i].lon - s.pts[i - 1].lon) * 111320 * Math.cos((s.pts[i].lat * Math.PI) / 180));
    if (L < 300) continue;
    const vJam = s.color === 'jam' ? 6 / 3.6 : 15 / 3.6, vFree = 45 / 3.6;
    out.push({ at: s.pts[Math.floor(s.pts.length / 2)], startPt: s.pts[0], lengthM: L, delayS: L / vJam - L / vFree, level: s.color });
  }
  return out;
}
