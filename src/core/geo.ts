// Геометрия: перевод широта/долгота <-> локальные метры (x = восток, y = север).
// Для поездки в пределах ~1000 км равнопромежуточная проекция с опорой
// в точке старта даёт ошибку меньше 0.1%, этого хватает для навигации.

export type LatLon = { lat: number; lon: number };
export type XY = { x: number; y: number };

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export class LocalFrame {
  readonly origin: LatLon;
  private readonly kx: number;
  private readonly ky: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    this.ky = R_EARTH * DEG;
    this.kx = R_EARTH * DEG * Math.cos(origin.lat * DEG);
  }

  toXY(p: LatLon): XY {
    let dLon = p.lon - this.origin.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    return { x: dLon * this.kx, y: (p.lat - this.origin.lat) * this.ky };
  }

  toLatLon(p: XY): LatLon {
    return { lat: this.origin.lat + p.y / this.ky, lon: this.origin.lon + p.x / this.kx };
  }
}

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Курс в радианах по часовой от севера, как в навигации. */
export function bearingXY(a: XY, b: XY): number {
  return Math.atan2(b.x - a.x, b.y - a.y);
}

/** Приводит угол к диапазону (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const toRad = (d: number) => d * DEG;
export const toDeg = (r: number) => r / DEG;
