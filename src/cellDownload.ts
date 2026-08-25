// Скачивание вышек заранее — прямо в телефоне, без ключа.
//
// Источник: база OpenCelliD (CC-BY-SA 4.0), выложенная проектом UN Smart Maps одним файлом
// PMTiles (≈530 МБ). Целиком его качать не нужно: PMTiles устроен так, что можно взять только
// «плитки» вдоль маршрута или вокруг города (HTTP Range-запросы). В каждой плитке — точки вышек
// с полями OpenCelliD: radio, mcc, net (mnc), area (LAC/TAC), cell (CID), range.
//
// Названия полей в файле заранее не проверены, поэтому разбираем гибко и пишем в журнал
// поля первой вышки — если что-то не так, будет видно в 🐞.

import { PMTiles, Compression, type DecompressFunc, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { gunzipSync } from 'fflate';
import type { LatLon } from './core/geo.ts';
import { dlog, dlogError } from './debugLog.ts';

export const OCID_PMTILES = 'https://data.source.coop/smartmaps/opencellid/cellid.pmtiles';

type Bounds = [number, number, number, number]; // запад, юг, восток, север
export type CellRecords = Record<string, [number, number, number]>; // ключ mcc-mnc-area-cid → [lat, lon, радиус]

const decompress: DecompressFunc = async (buf, c) => {
  if (c === Compression.None || c === Compression.Unknown) return buf;
  if (c === Compression.Gzip) {
    const u = gunzipSync(new Uint8Array(buf));
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  }
  throw new Error(`сжатие ${c} не поддерживается`);
};

/**
 * Источник с таймаутом на каждый кусок (Range-запрос). Обычный FetchSource библиотеки ждёт
 * бесконечно, а из России без VPN зарубежный сервер часто «замирает» посреди ответа.
 */
class TimeoutSource implements Source {
  private url: string;
  private timeoutMs: number;
  constructor(url: string, timeoutMs = 20_000) { this.url = url; this.timeoutMs = timeoutMs; }
  getKey() { return this.url; }
  async getBytes(offset: number, length: number, signal?: AbortSignal, _etag?: string) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const headers: Record<string, string> = { Range: `bytes=${offset}-${offset + length - 1}` };
      const r = await fetch(this.url, { headers, signal: ctrl.signal });
      if (r.status !== 206 && r.status !== 200) throw new Error(`источник вышек ответил ${r.status}`);
      const data = await r.arrayBuffer(); // тоже под таймаутом
      return { data, etag: r.headers.get('ETag') ?? undefined, cacheControl: r.headers.get('Cache-Control') ?? undefined, expires: r.headers.get('Expires') ?? undefined };
    } catch (e: any) {
      if (ctrl.signal.aborted && !signal?.aborted) {
        const { markHostBad } = await import('./net.ts');
        markHostBad(this.url, 60_000);
        throw new Error('источник вышек не ответил вовремя (часто так без VPN)');
      }
      throw e;
    } finally {
      clearTimeout(tm);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

let archive: PMTiles | null = null;
let source: string | Source = OCID_PMTILES;
const getArchive = () => (archive ??= new PMTiles(typeof source === 'string' ? new TimeoutSource(source) : source, undefined, decompress));
/** Другой источник (свой файл/сервер; для тестов). */
export function setCellSource(src: string | Source) { source = src; archive = null; }
/** Откуда сейчас качаются вышки (для проверки доступности). */
export function cellSourceUrl(): string { return typeof source === 'string' ? source : OCID_PMTILES; }

const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Прямоугольники ±rKm вокруг точек маршрута через каждые ~2 км. */
export function routeBoxes(pts: LatLon[], rKm = 4): Bounds[] {
  const out: Bounds[] = [];
  let acc = 2000;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += Math.hypot((pts[i].lat - pts[i - 1].lat) * 111320, (pts[i].lon - pts[i - 1].lon) * 111320 * Math.cos((pts[i].lat * Math.PI) / 180));
    if (acc < 2000 && i !== pts.length - 1) continue;
    acc = 0;
    const dLat = rKm / 111.32, dLon = rKm / (111.32 * Math.cos((pts[i].lat * Math.PI) / 180));
    out.push([pts[i].lon - dLon, pts[i].lat - dLat, pts[i].lon + dLon, pts[i].lat + dLat]);
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const pick = (p: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) { const v = num(p[k]); if (Number.isFinite(v)) return v; }
  return NaN;
};

/** Сколько плиток придётся скачать (для подсказки «≈ N запросов»). */
export async function cellTilesFor(boxes: Bounds[]): Promise<{ z: number; tiles: [number, number][] }> {
  const h = await getArchive().getHeader();
  const z = h.maxZoom; // на максимальном масштабе лежат все вышки, на мелких часть могла быть отброшена
  const set = new Set<string>();
  for (const b of boxes) {
    for (let x = tileX(b[0], z); x <= tileX(b[2], z); x++)
      for (let y = tileY(b[3], z); y <= tileY(b[1], z); y++) set.add(`${x}/${y}`);
  }
  return { z, tiles: [...set].map((k) => k.split('/').map(Number) as [number, number]) };
}

/**
 * Скачать вышки для прямоугольников. Возвращает записи для базы и сколько нашлось.
 * Качаем по 6 плиток одновременно; ошибки отдельных плиток пропускаем.
 */
export async function downloadCells(boxes: Bounds[], onProgress: (pct: number, found: number) => void, signal?: AbortSignal): Promise<{ records: CellRecords; count: number; fields: string[] }> {
  const pm = getArchive();
  const h = await pm.getHeader();
  const { tileType, minZoom, maxZoom, minLon, minLat, maxLon, maxLat } = h;
  const typeNames = ['Unknown', 'Mvt', 'Png', '', 'Webp'];
  const tName = tileType >= 0 && tileType < typeNames.length ? typeNames[tileType] : `код ${tileType}`;
  dlog(`вышки: заголовок PMTiles — тип плиток ${tName}, масштаб ${minZoom}–${maxZoom}, охват [${minLon.toFixed(2)}..${maxLon.toFixed(2)}, ${minLat.toFixed(2)}..${maxLat.toFixed(2)}]`);

  // Какие плитки нужны (начинаем с maxZoom)
  let z = maxZoom;
  const tilesAt = (zoom: number) => {
    const set = new Set<string>();
    for (const b of boxes) {
      for (let x = tileX(b[0], zoom); x <= tileX(b[2], zoom); x++)
        for (let y = tileY(b[3], zoom); y <= tileY(b[1], zoom); y++) set.add(`${x}/${y}`);
    }
    return [...set].map((k) => k.split('/').map(Number) as [number, number]);
  };
  let tiles = tilesAt(z);
  dlog(`вышки: плиток ${tiles.length} на масштабе ${z}`);

  const records: CellRecords = {};
  let done = 0, count = 0, fails = 0, logged = false, tileLogged = 0;
  let fields: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      if (signal?.aborted) return;
      const [x, y] = tiles[next++];
      try {
        const r = await pm.getZxy(z, x, y, signal);
        if (r?.data) {
          const vt = new VectorTile(new Pbf(new Uint8Array(r.data)));
          const layerNames = Object.keys(vt.layers);
          if (tileLogged < 3) {
            tileLogged++;
            const summary = layerNames.map((name) => `${name}:${vt.layers[name].length}`).join(', ');
            dlog(`вышки: плитка ${z}/${x}/${y} — ${r.data.byteLength} байт, слои [${summary}]`);
          }
          for (const name of layerNames) {
            const layer = vt.layers[name];
            for (let i = 0; i < layer.length; i++) {
              const f = layer.feature(i);
              const p = f.properties as Record<string, unknown>;
              if (!logged) { logged = true; fields = Object.keys(p); dlog(`вышки: слой «${name}», поля первой: ${JSON.stringify(p)}`); }
              const mcc = pick(p, 'mcc', 'MCC');
              const mnc = pick(p, 'net', 'mnc', 'MNC');
              const area = pick(p, 'area', 'lac', 'tac', 'LAC', 'TAC');
              const cid = pick(p, 'cell', 'cid', 'cellid', 'CID');
              if (![mcc, mnc, area, cid].every(Number.isFinite)) continue;
              const g = f.toGeoJSON(x, y, z).geometry;
              if (g.type !== 'Point') continue;
              const [lon, lat] = g.coordinates as [number, number];
              const range = pick(p, 'range', 'RANGE');
              records[`${mcc}-${mnc}-${area}-${cid}`] = [+lat.toFixed(5), +lon.toFixed(5), Math.round(Number.isFinite(range) && range > 0 ? range : 2000)];
              count++;
            }
          }
        }
      } catch (e) {
        if (signal?.aborted) return;
        if (++fails <= 3) dlogError(`вышки: плитка ${z}/${x}/${y}`, e);
      }
      done++;
      if (done % 5 === 0 || done === tiles.length) onProgress((100 * done) / tiles.length, count);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (fails > tiles.length / 2) throw new Error(`не удалось скачать ${fails} из ${tiles.length} плиток — нет интернета или источник недоступен`);

  // Если ничего не нашли на maxZoom, пробуем ниже (возможно, в этом файле вышки лежат на меньших масштабах)
  if (count === 0 && z > minZoom) {
    dlog(`вышки: на масштабе ${z} ничего нет, пробуем ${z - 1}…`);
    z--;
    tiles = tilesAt(z);
    next = 0; done = 0; fails = 0;
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  dlog(`вышки: готово, ${count} вышек (ошибок плиток: ${fails})${count === 0 && fields.length ? `; поля в файле: ${fields.join(', ')}` : ''}`);
  if (count === 0) {
    // Если охват не пересекается с нашей областью — сообщим честно
    const ourLon = boxes.map((b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    const inBounds = ourLon.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
    if (!inBounds) dlog(`вышки: наша область не покрыта этим файлом (файл: [${minLon.toFixed(1)}..${maxLon.toFixed(1)}, ${minLat.toFixed(1)}..${maxLat.toFixed(1)}], мы: [${ourLon[0][0].toFixed(1)},${ourLon[0][1].toFixed(1)}])`);
  }

  return { records, count, fields };
}
