// Маршрут, проложенный заранее (дома, по интернету) и сохранённый в телефон.
// Нужен для двух вещей:
//   1) привязка к дороге: машина не едет сквозь поле, это сильно гасит ошибку счисления;
//   2) подсказки манёвров: «через 800 м поверните направо».

import type { LatLon, XY } from './geo.ts';
import { LocalFrame, bearingXY, wrapAngle, toDeg } from './geo.ts';

export type Projection = {
  s: number;          // пройдено вдоль маршрута, м
  point: XY;          // ближайшая точка на маршруте
  nx: number; ny: number; // нормаль к участку
  bearing: number;    // курс участка
  offset: number;     // поперечное расстояние до маршрута, м (со знаком)
  distToVertex: number; // до ближайшего излома, м
  seg: number;
  clamped: boolean;     // ближайшая точка — сам излом (нормаль неоднозначна)
};

export type Maneuver = {
  s: number;          // где по маршруту
  turnDeg: number;    // + направо, - налево
  text: string;
  type?: number;      // тип манёвра Valhalla (для стрелки), если маршрут от маршрутизатора
};

/** Манёвр от маршрутизатора: индекс точки маршрута, тип и готовый текст. */
export type ExternalManeuver = { idx: number; type: number; text: string };

/** Примерный угол поворота по типу манёвра Valhalla (нужен для узнавания поворотов гироскопом). */
function turnFromType(type: number): number {
  const right: Record<number, number> = { 9: 30, 10: 90, 11: 135, 12: 180, 18: 30, 20: 30, 23: 20 };
  const left: Record<number, number> = { 13: 180, 14: 135, 15: 90, 16: 30, 19: 30, 21: 30, 24: 20 };
  return right[type] ?? (left[type] !== undefined ? -left[type] : 0);
}

/** Текст манёвра по типу Valhalla — если сервер не прислал свой. */
export function textFromType(type: number): string {
  switch (type) {
    case 4: case 5: case 6: return 'Вы приехали';
    case 9: return 'Плавно направо';
    case 10: return 'Поверните направо';
    case 11: return 'Резко направо';
    case 12: case 13: return 'Развернитесь';
    case 14: return 'Резко налево';
    case 15: return 'Поверните налево';
    case 16: return 'Плавно налево';
    case 18: case 20: case 23: return 'Держитесь правее';
    case 19: case 21: case 24: return 'Держитесь левее';
    case 26: return 'Въезд на круговое движение';
    case 27: return 'Съезд с кругового движения';
    case 17: case 22: return 'Прямо';
    default: return 'Продолжайте движение';
  }
}

export class Route {
  readonly pts: XY[];
  readonly cum: number[]; // накопленная длина
  readonly length: number;
  readonly maneuvers: Maneuver[];

  constructor(latlons: LatLon[], frame: LocalFrame, external?: ExternalManeuver[]) {
    // Убираем дубликаты подряд (и запоминаем, куда сдвинулись индексы — для манёвров)
    const raw = latlons.map((p) => frame.toXY(p));
    const map: number[] = [];
    this.pts = [];
    raw.forEach((p, i) => {
      const prev = this.pts[this.pts.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) this.pts.push(p);
      map[i] = this.pts.length - 1;
    });
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    this.length = this.cum[this.cum.length - 1] ?? 0;
    this.maneuvers = external && external.length
      ? external
        .filter((m) => m.type > 3) // «Начните движение…» не показываем как поворот
        .map((m) => ({ s: this.cum[map[Math.min(m.idx, map.length - 1)]] ?? 0, turnDeg: turnFromType(m.type), text: (m.text ?? '').replace(/\s*\/\s*[^/.,;]*[іїєґІЇЄҐ][^/.,;]*/g, '').trim() || textFromType(m.type), type: m.type }))
      : this.findManeuvers();
  }

  /** Точка на маршруте по пройденному расстоянию. */
  pointAt(s: number): { p: XY; bearing: number } {
    s = Math.max(0, Math.min(this.length, s));
    let i = this.segIndex(s);
    const a = this.pts[i], b = this.pts[i + 1] ?? a;
    const L = this.cum[i + 1] - this.cum[i] || 1;
    const t = (s - this.cum[i]) / L;
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, bearing: bearingXY(a, b) };
  }

  private segIndex(s: number): number {
    let lo = 0, hi = this.cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /**
   * Проекция точки на маршрут, но только в окне [sMin, sMax] вокруг текущего положения.
   * Окно не даёт «перепрыгнуть» на соседний участок, если дорога петляет рядом сама с собой.
   */
  project(p: XY, sMin: number, sMax: number): Projection | null {
    if (this.pts.length < 2) return null;
    const i0 = this.segIndex(Math.max(0, sMin));
    const i1 = this.segIndex(Math.min(this.length, sMax));
    let best: Projection | null = null;
    let bestD = Infinity;
    for (let i = i0; i <= i1 && i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) {
        bestD = d;
        const L = Math.sqrt(L2);
        const nx = -dy / L, ny = dx / L; // нормаль (влево от направления)
        const s = this.cum[i] + t * L;
        best = {
          s, point: q, nx, ny,
          bearing: bearingXY(a, b),
          offset: (p.x - q.x) * nx + (p.y - q.y) * ny,
          distToVertex: Math.min(s - this.cum[i], this.cum[i + 1] - s),
          seg: i,
          clamped: t <= 0 || t >= 1,
        };
      }
    }
    return best;
  }

  /** Ищет повороты: смена курса больше 25° на отрезке ~40 м. */
  private findManeuvers(): Maneuver[] {
    const out: Maneuver[] = [];
    const step = 20;
    let lastS = -Infinity;
    for (let s = 40; s < this.length - 40; s += step) {
      const before = this.pointAt(s - 40).p, at = this.pointAt(s).p, after = this.pointAt(s + 40).p;
      const turn = toDeg(wrapAngle(bearingXY(at, after) - bearingXY(before, at)));
      if (Math.abs(turn) >= 25 && s - lastS > 120) {
        out.push({ s, turnDeg: turn, text: turnText(turn) });
        lastS = s;
      }
    }
    return out;
  }

  nextManeuver(s: number): { m: Maneuver; dist: number } | null {
    const m = this.maneuvers.find((mm) => mm.s > s + 5);
    return m ? { m, dist: m.s - s } : null;
  }
}

function turnText(deg: number): string {
  const a = Math.abs(deg);
  const side = deg > 0 ? 'направо' : 'налево';
  if (a > 150) return 'Разворот';
  if (a > 100) return `Резко ${side}`;
  if (a > 45) return `Поверните ${side}`;
  return `Держитесь ${side}`;
}

// ---------- Загрузка маршрута из файла ----------

/** GPX (trk/rte) — простой разбор без XML-библиотек. */
export function parseGpx(text: string): LatLon[] {
  const out: LatLon[] = [];
  const tag = /<(?:trkpt|rtept)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    const lat = /\blat\s*=\s*["']([-\d.]+)["']/.exec(m[1]);
    const lon = /\blon\s*=\s*["']([-\d.]+)["']/.exec(m[1]);
    if (lat && lon) out.push({ lat: +lat[1], lon: +lon[1] });
  }
  return out;
}

/** GeoJSON с LineString / MultiLineString (так отдают OSRM, GraphHopper, BRouter). */
export function parseGeoJson(text: string): LatLon[] {
  const j = JSON.parse(text);
  const out: LatLon[] = [];
  const pushLine = (coords: number[][]) => coords.forEach(([lon, lat]) => out.push({ lat, lon }));
  const visit = (g: any) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach((f: any) => visit(f));
    else if (g.type === 'Feature') visit(g.geometry);
    else if (g.type === 'LineString') pushLine(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(pushLine);
    else if (g.routes) visit(g.routes[0]?.geometry); // ответ OSRM
    else if (g.paths) visit(g.paths[0]?.points);     // ответ GraphHopper
  };
  visit(j);
  return out;
}
