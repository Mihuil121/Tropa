// Фильтр частиц вдоль маршрута — «где на дороге мы сейчас».
//
// Идея та же, что у профессиональной привязки к карте (map matching):
// у каждой «частицы» своя гипотеза — пройдено s метров по маршруту и скорость v.
// Частицы едут вперёд, а потом их «судят»:
//   - курс по гироскопу должен совпадать с направлением дороги в точке s
//     (так позиция ловится не только на резких поворотах, но и на любых изгибах);
//   - скорость — с косвенными оценками (тряска, повороты, стоянки, OBD);
//   - точка s — с вышками и timing advance.
// Неправдоподобные частицы отмирают, правдоподобные размножаются.
// В отличие от фильтра Калмана, здесь можно держать сразу несколько гипотез
// («мы до поворота или уже после?») и ни одну не терять раньше времени.

import type { XY } from './geo.ts';
import { bearingXY, wrapAngle } from './geo.ts';
import type { Route } from './route.ts';

let seed = 987654321;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

export class RouteParticles {
  active = false;
  private s: Float64Array;
  private v: Float64Array;
  private w: Float64Array;
  /** Поправка: курс гироскопа + offset = курс на местности. Подстраивается, когда уверены. */
  offset = 0;

  private route: Route;
  private n: number;

  constructor(route: Route, n = 400) {
    this.route = route;
    this.n = n;
    this.s = new Float64Array(n);
    this.v = new Float64Array(n);
    this.w = new Float64Array(n).fill(1 / n);
  }

  init(s0: number, sSig: number, v0: number, vSig: number, offset?: number) {
    for (let i = 0; i < this.n; i++) {
      this.s[i] = Math.min(this.route.length, Math.max(0, s0 + gauss() * sSig));
      this.v[i] = Math.max(0, v0 + gauss() * vSig);
      this.w[i] = 1 / this.n;
    }
    if (offset !== undefined) this.offset = offset;
    this.active = true;
  }

  predict(dt: number) {
    if (!this.active || dt <= 0) return;
    const q = Math.sqrt(0.3 * dt); // изменение скорости: ~0.55 м/с за секунду
    for (let i = 0; i < this.n; i++) {
      this.s[i] = Math.min(this.route.length, this.s[i] + this.v[i] * dt);
      this.v[i] = Math.max(0, this.v[i] + gauss() * q);
    }
  }

  /** Направление дороги в точке s, сглаженное на ±30 м (неровности геометрии карты). */
  roadBearing(s: number): number {
    return bearingXY(this.route.pointAt(s - 30).p, this.route.pointAt(s + 30).p);
  }

  private apply(lik: (i: number) => number) {
    let sum = 0;
    for (let i = 0; i < this.n; i++) { this.w[i] *= lik(i); sum += this.w[i]; }
    if (!(sum > 1e-300)) { this.w.fill(1 / this.n); return; } // все невероятны — не рушим облако
    for (let i = 0; i < this.n; i++) this.w[i] /= sum;
    this.resampleIfNeeded();
  }

  /** Курс по гироскопу (абсолютный, уже с offset). Хвост 15% — защита от выбросов. */
  weightHeading(theta: number, sigma: number) {
    if (!this.active) return;
    const k = -0.5 / (sigma * sigma);
    this.apply((i) => 0.15 + Math.exp(k * wrapAngle(this.roadBearing(this.s[i]) - theta) ** 2));
  }

  weightSpeed(z: number, sigma: number) {
    if (!this.active) return;
    const k = -0.5 / (sigma * sigma);
    // Если ни одна частица не похожа на измерение (резко затормозили), взвешивание
    // ничего не даст — тогда просто переносим их скорости к измеренной.
    let best = 0;
    for (let i = 0; i < this.n; i++) best = Math.max(best, Math.exp(k * (this.v[i] - z) ** 2));
    if (best < 1e-3) {
      for (let i = 0; i < this.n; i++) this.v[i] = Math.max(0, z + gauss() * sigma);
      return;
    }
    this.apply((i) => 0.05 + Math.exp(k * (this.v[i] - z) ** 2));
  }

  /** Точка (например, позиция по вышкам) с её погрешностью. */
  weightPoint(p: XY, sigma: number) {
    if (!this.active) return;
    const k = -0.5 / (sigma * sigma);
    this.apply((i) => {
      const q = this.route.pointAt(this.s[i]).p;
      return 0.05 + Math.exp(k * ((q.x - p.x) ** 2 + (q.y - p.y) ** 2));
    });
  }

  /** Расстояние до точки (timing advance до вышки). */
  weightRange(p: XY, range: number, sigma: number) {
    if (!this.active) return;
    const k = -0.5 / (sigma * sigma);
    this.apply((i) => {
      const q = this.route.pointAt(this.s[i]).p;
      return 0.05 + Math.exp(k * (Math.hypot(q.x - p.x, q.y - p.y) - range) ** 2);
    });
  }

  private resampleIfNeeded() {
    let ess = 0;
    for (let i = 0; i < this.n; i++) ess += this.w[i] * this.w[i];
    if (1 / ess > this.n / 2) return;
    // Систематический ресэмплинг + небольшое «встряхивание», чтобы облако не схлопнулось
    const ns = new Float64Array(this.n), nv = new Float64Array(this.n);
    const step = 1 / this.n;
    let u = rnd() * step, c = this.w[0], j = 0;
    for (let i = 0; i < this.n; i++) {
      while (u > c && j < this.n - 1) { j++; c += this.w[j]; }
      ns[i] = Math.min(this.route.length, Math.max(0, this.s[j] + gauss() * 3));
      nv[i] = Math.max(0, this.v[j] + gauss() * 0.15);
      u += step;
    }
    this.s = ns; this.v = nv;
    this.w.fill(1 / this.n);
  }

  /** Средняя позиция и разброс. Разброс большой — значит, гипотез несколько. */
  estimate(): { s: number; std: number; v: number } {
    let ms = 0, mv = 0;
    for (let i = 0; i < this.n; i++) { ms += this.w[i] * this.s[i]; mv += this.w[i] * this.v[i]; }
    let vs = 0;
    for (let i = 0; i < this.n; i++) vs += this.w[i] * (this.s[i] - ms) ** 2;
    return { s: ms, std: Math.sqrt(vs), v: mv };
  }
}
