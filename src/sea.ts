// Море и Крымский мост: не даём навигатору слать «напрямую» через воду.
// Полигон Крыма упрощённый — для маршрутизации, не для кадастра.

import { haversine, type LatLon } from './core/geo.ts';

/** [широта, долгота], по часовой, берег Крыма. */
const CRIMEA: [number, number][] = [
  [46.17, 33.55], [45.98, 33.35], [45.78, 32.85], [45.40, 32.48],
  [45.18, 32.49], [44.85, 33.52], [44.58, 33.37], [44.50, 33.48],
  [44.386, 33.74], [44.39, 34.10], [44.50, 34.38], [44.73, 34.92],
  [44.90, 35.28], [45.03, 35.42], [45.20, 36.02], [45.12, 36.42],
  [45.20, 36.58], [45.36, 36.66], [45.47, 36.55], [45.39, 36.18],
  [45.72, 35.20], [45.92, 34.92], [46.17, 34.90],
];

/** Керчь → Тамань по мосту (не паром). */
const BRIDGE_KERCH: LatLon = { lat: 45.308, lon: 36.515 };
const BRIDGE_MID: LatLon = { lat: 45.281, lon: 36.555 };
const BRIDGE_TAMAN: LatLon = { lat: 45.251, lon: 36.675 };

function inRing(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function distToSeg(p: LatLon, a: LatLon, b: LatLon): number {
  const dx = b.lon - a.lon, dy = b.lat - a.lat;
  const l2 = dx * dx + dy * dy || 1e-12;
  let t = ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return haversine(p, { lat: a.lat + t * dy, lon: a.lon + t * dx });
}

export function inCrimea(p: LatLon): boolean {
  return inRing(p.lat, p.lon, CRIMEA);
}

/** На полотне Крымского моста (±450 м) — это дорога, не море. */
export function onCrimeanBridge(p: LatLon): boolean {
  return distToSeg(p, BRIDGE_KERCH, BRIDGE_MID) < 450 || distToSeg(p, BRIDGE_MID, BRIDGE_TAMAN) < 450;
}

function inTaman(p: LatLon): boolean {
  return p.lat >= 45.12 && p.lat <= 45.48 && p.lon >= 36.68 && p.lon <= 37.35;
}

/** Суша Кавказа/Кубани восточнее пролива (Анапа–Сочи и материк). */
function inCaucasusLand(p: LatLon): boolean {
  if (p.lat < 43.2 || p.lat > 47.6) return false;
  if (p.lon > 39.6) return p.lat > 43.35;
  if (p.lon > 37.2 && p.lat >= 44.7) return true; // Анапа и восточнее по берегу
  if (p.lon > 37.6 && p.lat >= 43.4) return true;
  return false;
}

/**
 * Открытая вода Чёрного и Азовского морей. Берег, Крым, мост и Тамань — не вода.
 * Намеренно грубо: лучше отбросить морской кусок, чем проложить паром.
 */
export function isOpenWater(lat: number, lon: number): boolean {
  const p = { lat, lon };
  if (onCrimeanBridge(p) || inCrimea(p) || inTaman(p) || inCaucasusLand(p)) return false;
  const black = lat >= 41.6 && lat <= 46.75 && lon >= 27.6 && lon <= 41.4;
  const azov = lat >= 45.22 && lat <= 47.35 && lon >= 34.6 && lon <= 39.4;
  if (!black && !azov) return false;
  if (lat > 46.45 && lon < 33.4) return false; // суша севернее Перекопа / Херсон
  if (lat < 41.45) return false;
  return true;
}

/** Идём из Крыма на материк РФ (или обратно) — без моста сервер часто предлагает паром. */
export function needsKerchBridge(from: LatLon, to: LatLon): boolean {
  const a = inCrimea(from), b = inCrimea(to);
  if (a === b) return false;
  const other = a ? to : from;
  return other.lon > 36.15 || other.lat > 46.2;
}

export function kerchVias(from: LatLon, to: LatLon): LatLon[] {
  if (!needsKerchBridge(from, to)) return [];
  return inCrimea(from) ? [BRIDGE_KERCH, BRIDGE_MID, BRIDGE_TAMAN] : [BRIDGE_TAMAN, BRIDGE_MID, BRIDGE_KERCH];
}

/** Есть ли на линии непрерывный кусок открытой воды длиннее minSeaM. */
export function routeCrossesSea(points: LatLon[], minSeaM = 3500): boolean {
  if (points.length < 2) return false;
  let seaRun = 0;
  const step = 1200;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = haversine(a, b);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lon = a.lon + (b.lon - a.lon) * f;
      if (isOpenWater(lat, lon)) {
        seaRun += d / n;
        if (seaRun >= minSeaM) return true;
      } else seaRun = 0;
    }
  }
  return false;
}

/** Ближайшая суша рядом с точкой, которая попала в воду: ищем в растущем радиусе,
 * пока не выйдем из открытого моря. Пригождается, чтобы не вести маршрут «прямо по морю»
 * там, где по сути едут по прибрежной дороге. */
export function snapToLand(p: LatLon, maxRadiusM = 4000): LatLon {
  if (!isOpenWater(p.lat, p.lon)) return p;
  for (let r = 200; r <= maxRadiusM; r += 200) {
    const steps = Math.max(8, Math.floor((2 * Math.PI * r) / 100));
    for (let k = 0; k < steps; k++) {
      const f = (k / steps) * 2 * Math.PI;
      const dlat = (r / 111320) * Math.cos(f);
      const dlon = (r / (111320 * Math.cos((p.lat * Math.PI) / 180) || 1)) * Math.sin(f);
      const cand = { lat: p.lat + dlat, lon: p.lon + dlon };
      if (!isOpenWater(cand.lat, cand.lon)) return cand;
    }
  }
  return p;
}
