// Недавние места «Куда поедем?»: последние 15, без повторов (ближе 50 м считается тем же местом).
// Лежат в tropa/recent.json рядом с остальными файлами приложения.

import { Directory, File, Paths } from 'expo-file-system';
import type { Place } from './online';
import { dlogError } from './debugLog';

export type RecentPlace = Place & { usedAt: number };

const MAX = 15;
const dir = new Directory(Paths.document, 'tropa');
const file = () => new File(dir, 'recent.json');
let cache: RecentPlace[] | null = null;

function ensureDir() { if (!dir.exists) dir.create({ intermediates: true }); }

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111320;
  const dLon = (a.lon - b.lon) * 111320 * Math.cos((b.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

async function save(list: RecentPlace[]) {
  try { ensureDir(); await file().write(JSON.stringify(list)); } catch (e) { dlogError('recent.json: запись', e); }
}

export async function loadRecent(): Promise<RecentPlace[]> {
  if (cache) return cache;
  ensureDir();
  let list: RecentPlace[] = [];
  const f = file();
  if (f.exists) {
    try {
      const j = JSON.parse(await f.text());
      if (Array.isArray(j)) list = j.filter((p) => p && typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.name === 'string');
    } catch (e) { dlogError('recent.json: чтение', e); }
  }
  cache = list.slice(0, MAX);
  return cache;
}

export async function addRecent(p: Place): Promise<RecentPlace[]> {
  const list = await loadRecent();
  const { distKm: _unused, ...rest } = p;
  const item: RecentPlace = { ...rest, usedAt: Date.now() };
  cache = [item, ...list.filter((x) => distM(x, p) >= 50)].slice(0, MAX);
  await save(cache);
  return cache;
}

export async function removeRecent(p: RecentPlace): Promise<RecentPlace[]> {
  const list = await loadRecent();
  cache = list.filter((x) => !(x.usedAt === p.usedAt && x.lat === p.lat && x.lon === p.lon));
  await save(cache);
  return cache;
}

export async function clearRecent(): Promise<RecentPlace[]> {
  cache = [];
  await save(cache);
  return cache;
}
