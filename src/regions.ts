// Области «без интернета»: скачивание с сервера данных в России, хранение в телефоне
// и подключение к навигатору — карта (.pmtiles), дороги для встроенного Valhalla, поиск адресов.
// Чистая логика — в regionsCore.ts.

import { Directory, File, Paths } from 'expo-file-system';
import ValhallaRouter from '../modules/valhalla-router';
import type { LatLon } from './core/geo';
import { baseOf, parseManifest, regionFor, PARTS, type InstalledRegion, type Manifest, type Part, type RemoteRegion } from './regionsCore';
import { fetchJson } from './net';
import { dlog, dlogError } from './debugLog';
import { setDeviceRouter, setOfflineSearch } from './online';
import { prepare, searchIndex, type SearchIndex } from './offlineSearch';
import { setCellSource } from './cellDownload';

/**
 * Адрес сервера данных по умолчанию — вшивается в APK при сборке из файла .env:
 *   EXPO_PUBLIC_TROPA_DATA_URL=https://github.com/<владелец>/<репозиторий>/releases/download/data/
 * (его печатает сборка данных в GitHub Actions; подойдёт и Yandex Object Storage).
 * Тогда у всех пользователей всё работает без настройки. Поменять можно в
 * «Настройки → Области без интернета → Сервер данных».
 */
export const DEFAULT_DATA_URL: string = process.env.EXPO_PUBLIC_TROPA_DATA_URL ?? '';

const root = new Directory(Paths.document, 'tropa');
const regionsDir = new Directory(root, 'regions');
const registryFile = () => new File(root, 'regions.json');
const manifestCache = () => new File(root, 'manifest-cache.json');

type Registry = { installed: Record<string, InstalledRegion>; cells?: string };
let registry: Registry = { installed: {} };
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
export function subscribeRegions(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

function ensure(dir: Directory) { if (!dir.exists) dir.create({ intermediates: true }); }

export async function loadRegions(): Promise<InstalledRegion[]> {
  if (!loaded) {
    loaded = true;
    try {
      const f = registryFile();
      if (f.exists) registry = JSON.parse(await f.text());
      // файлы могли удалить вручную — проверяем
      for (const r of Object.values(registry.installed)) {
        for (const p of PARTS) if (r.files[p] && !new File(r.files[p]!).exists) delete r.files[p];
      }
      if (registry.cells) setCellSource(registry.cells);
    } catch (e) { dlogError('области: реестр', e); }
    notify();
  }
  return installedRegions();
}

export function installedRegions(): InstalledRegion[] { return Object.values(registry.installed); }

async function saveRegistry() {
  ensure(root);
  registryFile().write(JSON.stringify(registry));
  notify();
}

// ---------- manifest.json ----------

export async function fetchManifest(dataUrl: string): Promise<Manifest> {
  const base = baseOf(dataUrl || DEFAULT_DATA_URL);
  if (!base) throw new Error('Не задан адрес сервера данных');
  try {
    const j = await fetchJson(base + 'manifest.json', { timeoutMs: 10_000 });
    const m = parseManifest(j, base);
    ensure(root);
    manifestCache().write(JSON.stringify({ base, json: j }));
    if (m.cells && m.cells !== registry.cells) { registry.cells = m.cells; setCellSource(m.cells); saveRegistry(); }
    return m;
  } catch (e) {
    // нет сети — покажем последний известный список
    try {
      const c = manifestCache();
      if (c.exists) { const { base: b, json } = JSON.parse(await c.text()); if (b === base) return parseManifest(json, b); }
    } catch {}
    throw e;
  }
}

// ---------- Скачивание ----------

export type InstallProgress = { part: Part; pct: number; note?: string };

/**
 * Скачать файл с «сторожем»: если 60 с нет прогресса — обрываем и пробуем снова (до 3 раз).
 * Качаем во временный .part, по готовности переименовываем — недокачанный файл не подхватится.
 */
async function downloadWithRetry(url: string, dest: File, onPct: (pct: number) => void, signal?: AbortSignal) {
  const part = new File(dest.parentDirectory, dest.name + '.part');
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error('Отменено');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    let lastChange = Date.now();
    const watch = setInterval(() => { if (Date.now() - lastChange > 60_000) ctrl.abort(); }, 5000);
    try {
      if (part.exists) part.delete();
      await File.downloadFileAsync(url, part, {
        idempotent: true, signal: ctrl.signal,
        onProgress: ({ bytesWritten, totalBytes }) => { lastChange = Date.now(); if (totalBytes > 0) onPct((100 * bytesWritten) / totalBytes); },
      });
      if (dest.exists) dest.delete();
      part.move(dest);
      return;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      dlog(`области: попытка ${attempt} не удалась (${String((e as Error)?.message ?? e)})`);
    } finally {
      clearInterval(watch);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  try { if (part.exists) part.delete(); } catch {}
  throw lastErr ?? new Error('не удалось скачать');
}

const FILE_NAME: Record<Part, string> = { map: 'map.pmtiles', roads: 'valhalla.tar', search: 'search.json' };

export async function installRegion(r: RemoteRegion, parts: Part[], onProgress: (p: InstallProgress) => void, signal?: AbortSignal) {
  await loadRegions();
  const dir = new Directory(regionsDir, r.id);
  ensure(dir);
  const cur: InstalledRegion = registry.installed[r.id] ?? { id: r.id, name: r.name, bbox: r.bbox, files: {}, installedAt: Date.now() };
  cur.name = r.name; cur.bbox = r.bbox; cur.version = r.version;
  for (const p of parts) {
    const rf = r[p];
    if (!rf) continue;
    const dest = new File(dir, FILE_NAME[p]);
    onProgress({ part: p, pct: 0 });
    if (p === 'roads') await ValhallaRouter?.close().catch(() => {}); // файл может быть открыт движком
    await downloadWithRetry(rf.url, dest, (pct) => onProgress({ part: p, pct }), signal);
    cur.files[p] = dest.uri;
    if (p === 'search') searchCache.delete(r.id);
    registry.installed[r.id] = cur;
    await saveRegistry();
    dlog(`области: «${r.name}» — ${p} готово`);
  }
  cur.installedAt = Date.now();
  registry.installed[r.id] = cur;
  await saveRegistry();
}

export async function removeRegion(id: string) {
  await loadRegions();
  await ValhallaRouter?.close().catch(() => {});
  try { const d = new Directory(regionsDir, id); if (d.exists) d.delete(); } catch (e) { dlogError('области: удалить', e); }
  delete registry.installed[id];
  searchCache.delete(id);
  await saveRegistry();
}

// ---------- Подключение к навигатору ----------

/** Карта области, где находится точка (для стиля карты). */
export function regionMapFor(p: LatLon | null): string | null {
  if (!p) return null;
  return regionFor(installedRegions(), 'map', [p])?.files.map ?? null;
}

export function deviceRoutingAvailable(): boolean {
  try { return !!ValhallaRouter && ValhallaRouter.isSupported(); } catch { return false; }
}

const searchCache = new Map<string, ReturnType<typeof prepare>>();
async function searchFor(r: InstalledRegion) {
  let s = searchCache.get(r.id);
  if (!s && r.files.search) {
    const idx = JSON.parse(await new File(r.files.search).text()) as SearchIndex;
    s = prepare(idx);
    searchCache.set(r.id, s);
  }
  return s ?? null;
}

/** Подключить встроенный Valhalla и офлайн-поиск к online.ts (вызывается один раз из App). */
export function installDeviceHooks() {
  loadRegions().catch(() => {});

  setDeviceRouter(async (kind, pts, body) => {
    if (!deviceRoutingAvailable()) return null;
    const r = regionFor(installedRegions(), 'roads', pts);
    if (!r?.files.roads) return null;
    const req = JSON.stringify(body);
    const raw = kind === 'route' ? await ValhallaRouter!.route(r.files.roads, req) : await ValhallaRouter!.traceAttributes(r.files.roads, req);
    return JSON.parse(raw);
  });

  setOfflineSearch(async (q, near) => {
    const all = installedRegions().filter((r) => r.files.search);
    // сначала область, где мы находимся, потом остальные
    all.sort((a, b) => Number(!!near && regionFor([b], 'search', [near])) - Number(!!near && regionFor([a], 'search', [near])));
    const out = [];
    for (const r of all.slice(0, 3)) {
      try { const s = await searchFor(r); if (s) out.push(...searchIndex(s, q)); } catch (e) { dlogError(`поиск офлайн: ${r.name}`, e); }
    }
    return out;
  });
}
