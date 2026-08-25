// Ранжирование результатов поиска — «логистика», как в Яндексе и 2ГИС.
//
// Главная идея: разным видам мест расстояние важно по-разному.
//   - Улица, дом, кафе, аптека: почти всегда нужен ближайший вариант.
//     «Улица Ленина» в Севастополе — это улица Ленина в Севастополе, а не в Москве.
//   - Достопримечательность, вокзал, аэропорт, музей: ищут конкретное известное место,
//     даже если оно за тысячу километров («Красная площадь» из Севастополя — это Москва).
//   - Город, посёлок, район: тоже почти не зависят от расстояния.
//
// Чистая функция без сети — проверяется тестами.

import type { LatLon } from './core/geo.ts';
import { haversine } from './core/geo.ts';

export type PlaceKind = 'address' | 'poi' | 'landmark' | 'settlement';

export type RawPlace = {
  name: string;
  detail: string;
  lat: number; lon: number;
  osmKey?: string; osmValue?: string; layer?: string;
  fromLocal: boolean;   // пришёл из поиска «рядом с вами»
  order: number;        // позиция в выдаче сервиса (0 — лучший по тексту)
};

export type RankedPlace = RawPlace & { kind: PlaceKind; distKm: number | null; score: number };

const LANDMARK_KEYS = new Set(['tourism', 'historic', 'aeroway', 'natural', 'waterway', 'heritage', 'memorial']);
const LANDMARK_VALUES = new Set([
  'station', 'aerodrome', 'terminal', 'museum', 'theatre', 'stadium', 'university', 'zoo', 'park',
  'attraction', 'viewpoint', 'monument', 'castle', 'cathedral', 'beach', 'peak', 'lighthouse', 'port',
]);
const SETTLEMENT_VALUES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'municipality', 'district', 'county', 'state', 'region', 'country', 'island']);
const ADDRESS_LAYERS = new Set(['house', 'street']);
const SETTLEMENT_LAYERS = new Set(['city', 'district', 'locality', 'county', 'state', 'country']);

export function classify(p: Pick<RawPlace, 'osmKey' | 'osmValue' | 'layer'>): PlaceKind {
  const k = p.osmKey ?? '', v = p.osmValue ?? '', l = p.layer ?? '';
  if (k === 'place' && SETTLEMENT_VALUES.has(v)) return 'settlement';
  if (k === 'boundary' || SETTLEMENT_LAYERS.has(l)) return 'settlement';
  if (LANDMARK_KEYS.has(k) || LANDMARK_VALUES.has(v)) return 'landmark';
  if (k === 'highway' || k === 'building' || (k === 'place' && v === 'house') || ADDRESS_LAYERS.has(l)) return 'address';
  return 'poi'; // магазины, кафе, аптеки, остановки — ищем рядом
}

/** Насколько сильно расстояние «штрафует» вид места (log10 от расстояния в км). */
function distancePenalty(kind: PlaceKind, d: number): number {
  switch (kind) {
    case 'address': return 1.2 * Math.log10(1 + d / 2);   // 1 км: −0.2, 10 км: −0.9, 1500 км: −3.8
    case 'poi': return 1.0 * Math.log10(1 + d / 2);
    case 'settlement': return 0.25 * Math.log10(1 + d / 20);
    case 'landmark': return 0.35 * Math.log10(1 + d / 10);
  }
}

const STOP = new Set(['улица', 'ул', 'проспект', 'пр', 'т', 'переулок', 'пер', 'площадь', 'пл', 'бульвар', 'б', 'р', 'шоссе', 'ш', 'набережная', 'наб', 'проезд', 'г', 'город']);

/** Насколько название совпадает с запросом (без учёта «ул.», регистра и т.п.). */
function textBonus(name: string, q: string): number {
  // (\b в JS не работает с кириллицей, поэтому сначала режем на слова, потом выкидываем «улица», «ул» и т.п.)
  const norm = (x: string) => x.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w && !STOP.has(w));
  const qt = norm(q), nt = new Set(norm(name));
  if (!qt.length) return 0;
  const hit = qt.filter((t) => [...nt].some((w) => w.startsWith(t))).length / qt.length;
  return 0.4 * hit;
}

export function rankPlaces(items: RawPlace[], q: string, near?: LatLon): RankedPlace[] {
  // Убираем повторы: одно и то же место из обоих запросов
  const seen = new Map<string, RawPlace>();
  for (const it of items) {
    const key = `${it.name.toLowerCase()}|${it.lat.toFixed(3)}|${it.lon.toFixed(3)}`;
    const prev = seen.get(key);
    if (!prev || it.order < prev.order) seen.set(key, { ...it, fromLocal: it.fromLocal || !!prev?.fromLocal });
  }
  const out: RankedPlace[] = [...seen.values()].map((it) => {
    const kind = classify(it);
    const distKm = near ? haversine(near, it) / 1000 : null;
    let score = 1 - 0.04 * it.order + textBonus(it.name, q);
    if (distKm !== null) score -= distancePenalty(kind, distKm);
    if (it.fromLocal && (kind === 'address' || kind === 'poi')) score += 0.15;
    return { ...it, kind, distKm, score };
  });
  return out.sort((a, b) => b.score - a.score);
}

/** Прямоугольник ±r км вокруг точки — для поиска «рядом с вами». */
export function bboxAround(p: LatLon, rKm: number): [number, number, number, number] {
  const dLat = rKm / 111.32;
  const dLon = rKm / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  return [p.lon - dLon, p.lat - dLat, p.lon + dLon, p.lat + dLat];
}
