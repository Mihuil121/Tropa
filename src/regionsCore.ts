// Области «без интернета» — чистая логика (без expo): разбор manifest.json с сервера
// данных и выбор области под точку/маршрут. Ввод-вывод — в regions.ts.
//
// Сервер данных — любое хранилище файлов в России (Yandex Object Storage, Selectel S3, свой
// nginx). В корне лежит manifest.json, рядом — файлы областей. Готовит их tools/region/.
//
// manifest.json:
// {
//   "version": 1, "updated": "2026-10-20",
//   "cells": "cellid.pmtiles",                    // копия базы вышек (необязательно)
//   "regions": [{
//     "id": "crimea", "name": "Крым", "bbox": [32.4, 44.3, 36.7, 46.3],   // запад, юг, восток, север
//     "map":    { "url": "crimea/map.pmtiles",    "bytes": 123456789 },  // карта (Protomaps)
//     "roads":  { "url": "crimea/valhalla.tar",   "bytes": 98765432 },   // дороги для встроенного Valhalla
//     "search": { "url": "crimea/search.json",    "bytes": 4567890 }     // поиск адресов
//   }]
// }
// Ссылки — относительно manifest.json или полные.

import type { LatLon } from './core/geo.ts';

export type Part = 'map' | 'roads' | 'search';
export const PARTS: Part[] = ['map', 'roads', 'search'];
export const PART_LABEL: Record<Part, string> = { map: 'карта', roads: 'дороги', search: 'поиск адресов' };

export type RemoteFile = { url: string; bytes: number };
export type RemoteRegion = { id: string; name: string; bbox: [number, number, number, number]; version?: string } & Partial<Record<Part, RemoteFile>>;
export type Manifest = { version: number; updated?: string; cells?: string; regions: RemoteRegion[] };

export type InstalledRegion = {
  id: string; name: string; bbox: [number, number, number, number]; version?: string;
  files: Partial<Record<Part, string>>; // uri файлов в телефоне
  installedAt: number;
};

/** Базовый адрес: «https://x/y» → «https://x/y/». */
export function baseOf(url: string): string {
  const u = url.trim();
  if (!u) return '';
  if (/manifest\.json$/i.test(u)) return u.replace(/manifest\.json$/i, '');
  return u.endsWith('/') ? u : u + '/';
}

export function resolveUrl(base: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return base + url.replace(/^\.?\//, '');
}

/** Проверить и привести manifest.json к полным ссылкам. Битые записи пропускаем. */
export function parseManifest(json: any, base: string): Manifest {
  if (!json || !Array.isArray(json.regions)) throw new Error('manifest.json: нет списка regions');
  const regions: RemoteRegion[] = [];
  for (const r of json.regions) {
    if (!r?.id || !r?.name || !Array.isArray(r.bbox) || r.bbox.length !== 4 || !r.bbox.every((x: any) => Number.isFinite(+x))) continue;
    const out: RemoteRegion = { id: String(r.id), name: String(r.name), bbox: r.bbox.map(Number) as RemoteRegion['bbox'], version: r.version ? String(r.version) : json.updated };
    for (const p of PARTS) {
      const f = r[p];
      if (f?.url) out[p] = { url: resolveUrl(base, String(f.url)), bytes: Number(f.bytes) || 0 };
    }
    if (PARTS.some((p) => out[p])) regions.push(out);
  }
  return { version: Number(json.version) || 1, updated: json.updated, cells: json.cells ? resolveUrl(base, String(json.cells)) : undefined, regions };
}

export function inBbox(b: [number, number, number, number], p: LatLon, marginDeg = 0): boolean {
  return p.lon >= b[0] - marginDeg && p.lon <= b[2] + marginDeg && p.lat >= b[1] - marginDeg && p.lat <= b[3] + marginDeg;
}

/** Установленная область с нужной частью, в которой лежат ВСЕ точки (самая маленькая из подходящих). */
export function regionFor(installed: InstalledRegion[], part: Part, pts: LatLon[]): InstalledRegion | null {
  let best: InstalledRegion | null = null, bestArea = Infinity;
  for (const r of installed) {
    if (!r.files[part]) continue;
    if (!pts.every((p) => inBbox(r.bbox, p))) continue;
    const area = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]);
    if (area < bestArea) { best = r; bestArea = area; }
  }
  return best;
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace('.', ',')} ГБ`;
  return `${Math.max(1, Math.round(b / 1e6))} МБ`;
}
