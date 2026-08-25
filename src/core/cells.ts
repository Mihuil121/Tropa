// Определение места по сотовым вышкам и Wi‑Fi, без интернета.
// Телефон видит идентификаторы вышек (MCC-MNC-LAC/TAC-CID) и точек Wi‑Fi (BSSID),
// а координаты берём из трёх источников:
//   1) заранее скачанная база OpenCelliD (вдоль маршрута — несколько МБ);
//   2) своя база, которую телефон учит сам: пока GPS честный, запоминаем, где видели
//      какую вышку и какой Wi‑Fi (CellLearner ниже). На обратной дороге это уже работает офлайн;
//   3) онлайн-ответы beaconDB (если есть интернет) — тоже сохраняются в свою базу.

import type { LatLon } from './geo.ts';
import { haversine } from './geo.ts';

export type CellId = {
  mcc: number; mnc: number; area: number; cid: number;
  dbm?: number; radio?: string;
  registered?: boolean; // вышка, через которую сейчас идёт связь
  ta?: number | null;    // timing advance (только LTE, только «своя» вышка): шаги задержки сигнала
};
export type WifiAp = { bssid: string; dbm: number };
export type CellRecord = { lat: number; lon: number; range: number };
export type CellFix = LatLon & { accuracy: number; used: number; wifi: number };

export const cellKey = (c: { mcc: number; mnc: number; area: number; cid: number }) =>
  `${c.mcc}-${c.mnc}-${c.area}-${c.cid}`;
export const wifiKey = (w: { bssid: string }) => `w:${w.bssid.toLowerCase()}`;

export class CellDb {
  private map = new Map<string, CellRecord>();

  /** Компактный формат: { "250-1-7840-200719106": [lat, lon, range], "w:aa:bb:..": [...] } */
  static fromJson(text: string): CellDb {
    const db = new CellDb();
    db.addJson(text);
    return db;
  }

  addJson(text: string) {
    const j = JSON.parse(text) as Record<string, [number, number, number]>;
    for (const k in j) this.map.set(k, { lat: j[k][0], lon: j[k][1], range: j[k][2] });
  }

  /** Добавить/обновить запись (своя база имеет приоритет, только если она точнее). */
  put(key: string, rec: CellRecord, onlyIfBetter = true) {
    const old = this.map.get(key);
    if (onlyIfBetter && old && old.range <= rec.range) return;
    this.map.set(key, rec);
  }

  get size() { return this.map.size; }

  /** Вышки рядом с точкой (для показа на карте). Wi‑Fi не берём. */
  near(p: LatLon, rKm: number, limit = 1500): { key: string; rec: CellRecord }[] {
    const dLat = rKm / 111.32, dLon = rKm / (111.32 * Math.cos((p.lat * Math.PI) / 180));
    const out: { key: string; rec: CellRecord; d: number }[] = [];
    for (const [key, rec] of this.map) {
      if (key.startsWith('w:')) continue;
      const a = Math.abs(rec.lat - p.lat), b = Math.abs(rec.lon - p.lon);
      if (a < dLat && b < dLon) out.push({ key, rec, d: a * a + b * b });
    }
    return out.sort((x, y) => x.d - y.d).slice(0, limit);
  }

  has(key: string) { return this.map.has(key); }
  lookup(c: CellId) { return this.map.get(cellKey(c)); }
  get(key: string) { return this.map.get(key); }

  /**
   * Оценка места по видимым вышкам и Wi‑Fi: взвешенный центр.
   * Вес растёт с уровнем сигнала и падает с радиусом покрытия.
   * Wi‑Fi «бьёт» на десятки метров, вышка — на сотни/тысячи, поэтому Wi‑Fi почти всегда главнее.
   */
  locate(cells: CellId[], wifi: WifiAp[] = []): CellFix | null {
    let sw = 0, sLat = 0, sLon = 0, sR = 0, used = 0, nWifi = 0;
    const add = (r: CellRecord, dbm: number | undefined, minR: number, maxR: number, defR: number) => {
      const range = Math.max(minR, Math.min(r.range || defR, maxR));
      const sig = dbm !== undefined ? Math.pow(10, (dbm + 120) / 20) : 1; // -60 dBm >> -110 dBm
      const w = sig / range;
      sw += w; sLat += w * r.lat; sLon += w * r.lon; sR += w * range; used++;
    };
    for (const c of cells) { const r = this.lookup(c); if (r) add(r, c.dbm, 200, 20000, 2000); }
    for (const a of wifi) { const r = this.get(wifiKey(a)); if (r) { add(r, a.dbm, 30, 300, 80); nWifi++; } }
    if (!used) return null;
    const meanRange = sR / sw;
    // Одна вышка — точность ~ её радиус; несколько — лучше
    const accuracy = Math.max(Math.min(300, meanRange * 0.5), (meanRange / Math.sqrt(used)) * 0.8);
    return { lat: sLat / sw, lon: sLon / sw, accuracy, used, wifi: nWifi };
  }
}

// ---------------- Своя база: учимся, пока GPS честный ----------------

type Obs = { n: number; sw: number; lat: number; lon: number; far: number; t: number };

/**
 * Каждый раз, когда GPS точный и ему можно верить, отмечаем: «здесь видна такая-то вышка
 * (с таким-то сигналом) и такие-то Wi‑Fi». Положение источника — взвешенный центр точек,
 * где его видели (сильный сигнал = ближе = больший вес). Радиус — самое дальнее наблюдение.
 */
export class CellLearner {
  private obs = new Map<string, Obs>();
  dirty = false;

  static fromJson(text: string): CellLearner {
    const l = new CellLearner();
    l.load(text);
    return l;
  }

  load(text: string) {
    try {
      const j = JSON.parse(text) as Record<string, [number, number, number, number, number]>;
      for (const k in j) { const [lat, lon, far, n, sw] = j[k]; this.obs.set(k, { lat, lon, far, n, sw: sw || n, t: 0 }); }
    } catch {}
  }

  get size() { return this.obs.size; }
  clear() { this.obs.clear(); this.dirty = false; }

  /** Наблюдение при хорошем GPS. Возвращает, сколько источников обновилось. */
  observe(t: number, at: LatLon, acc: number, cells: CellId[], wifi: WifiAp[] = []): number {
    if (acc > 40) return 0;
    let k = 0;
    const one = (key: string, dbm: number | undefined, isWifi: boolean) => {
      const o = this.obs.get(key);
      if (o && t - o.t < 4) return; // не чаще раза в 4 с на источник — иначе стоянка «перевесит»
      const w = Math.pow(10, ((dbm ?? (isWifi ? -75 : -95)) + 120) / 20) / 100;
      if (!o) { this.obs.set(key, { n: 1, sw: w, lat: at.lat, lon: at.lon, far: 0, t }); k++; return; }
      const d = haversine(o, at);
      if (d > (isWifi ? 1000 : 40000)) return; // явно не тот источник (переехал / совпадение id)
      o.sw += w;
      o.lat += (w / o.sw) * (at.lat - o.lat);
      o.lon += (w / o.sw) * (at.lon - o.lon);
      o.far = Math.max(o.far * 0.995, d);
      o.n++; o.t = t; k++;
    };
    for (const c of cells) one(cellKey(c), c.dbm, false);
    for (const a of wifi) one(wifiKey(a), a.dbm, true);
    if (k) this.dirty = true;
    return k;
  }

  /** Записи, достаточно надёжные для определения места. */
  records(): [string, CellRecord][] {
    const out: [string, CellRecord][] = [];
    for (const [key, o] of this.obs) {
      const wifi = key.startsWith('w:');
      if (o.n < (wifi ? 2 : 3)) continue;
      // Видели мало и рядом — радиус занижен; поднимаем до разумного минимума
      const range = wifi ? Math.max(50, o.far * 1.2) : Math.max(600, o.far * 1.2);
      out.push([key, { lat: o.lat, lon: o.lon, range }]);
    }
    return out;
  }

  /** Подмешать в базу. */
  applyTo(db: CellDb) {
    for (const [k, r] of this.records()) db.put(k, r);
  }

  /** Записать результат онлайн-поиска (beaconDB) как готовую запись. */
  putKnown(key: string, rec: CellRecord) {
    if (this.obs.has(key)) return;
    this.obs.set(key, { n: 3, sw: 1, lat: rec.lat, lon: rec.lon, far: rec.range / 1.2, t: 0 });
    this.dirty = true;
  }

  toJson(): string {
    const j: Record<string, number[]> = {};
    for (const [k, o] of this.obs) j[k] = [+o.lat.toFixed(6), +o.lon.toFixed(6), Math.round(o.far), o.n, +o.sw.toPrecision(4)];
    return JSON.stringify(j);
  }
}
