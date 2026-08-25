// Расширенный фильтр Калмана для машины.
//
// Состояние (6):
//   0 x     — восток, м
//   1 y     — север, м
//   2 th    — курс, рад, по часовой от севера
//   3 v     — скорость, м/с
//   4 bias  — дрейф гироскопа, рад/с (фильтр сам его вычисляет, пока есть GPS)
//   5 scale — коэффициент спидометра OBD (машины обычно завышают на 2-7%)
//
// Прогноз: машина едет по курсу th со скоростью v, курс меняется по гироскопу.
// Коррекции: GPS, OBD-скорость, сотовые вышки, привязка к маршруту.

import type { Mat } from './matrix.ts';
import { eye, mul, transpose, add, sub, invSmall, symmetrize, zeros } from './matrix.ts';
import { wrapAngle } from './geo.ts';

export const IX = 0, IY = 1, ITH = 2, IV = 3, IB = 4, IS = 5;
const N = 6;

export type Measurement = {
  z: number[];
  h: number[];         // предсказанное значение
  H: Mat;              // якобиан
  R: Mat;              // шум измерения
  angleIdx?: number[]; // индексы компонент-углов (для правильного «заворачивания»)
};

export type UpdateResult = { accepted: boolean; d2: number };

export class CarEKF {
  x: number[] = [0, 0, 0, 0, 0, 1];
  P: Mat = zeros(N, N);
  initialized = false;
  hasGyro = false;

  // Шумы процесса (подобраны под телефонный гироскоп и обычную езду)
  q = {
    pos: 0.05,      // м²/с, «проскальзывание» модели
    gyro: 0.003,    // (рад/с)² — шум гироскопа
    headNoGyro: 0.05, // (рад/с)² — если гироскопа нет, курс «гуляет» сильнее
    accel: 1.5,     // (м/с²)² — изменение скорости
    bias: 1e-8,
    scale: 1e-9,
  };

  init(x: number, y: number, posVar: number, th = 0, thVar = Math.PI ** 2, v = 0, vVar = 100) {
    this.x = [x, y, th, v, 0, 1];
    this.P = zeros(N, N);
    this.P[IX][IX] = posVar;
    this.P[IY][IY] = posVar;
    this.P[ITH][ITH] = thVar;
    this.P[IV][IV] = vVar;
    this.P[IB][IB] = (0.02) ** 2;
    this.P[IS][IS] = (0.05) ** 2;
    this.initialized = true;
  }

  /** Шаг прогноза. headingRate — скорость поворота по гироскопу (рад/с, по часовой), или null. */
  predict(dt: number, headingRate: number | null) {
    if (!this.initialized || dt <= 0) return;
    if (dt > 5) dt = 5; // защита от «провала» во времени
    const [x, y, th, v, b, s] = this.x;
    const st = Math.sin(th), ct = Math.cos(th);
    const w = headingRate === null ? 0 : headingRate - b;

    this.x = [x + v * st * dt, y + v * ct * dt, wrapAngle(th + w * dt), Math.max(0, v), b, s];

    const F = eye(N);
    F[IX][ITH] = v * ct * dt;
    F[IX][IV] = st * dt;
    F[IY][ITH] = -v * st * dt;
    F[IY][IV] = ct * dt;
    if (headingRate !== null) F[ITH][IB] = -dt;

    const Q = zeros(N, N);
    Q[IX][IX] = this.q.pos * dt;
    Q[IY][IY] = this.q.pos * dt;
    Q[ITH][ITH] = (headingRate === null ? this.q.headNoGyro : this.q.gyro) * dt;
    Q[IV][IV] = this.q.accel * dt;
    Q[IB][IB] = this.q.bias * dt;
    Q[IS][IS] = this.q.scale * dt;

    this.P = symmetrize(add(mul(mul(F, this.P), transpose(F)), Q));
  }

  /** Расстояние Махаланобиса (d²) без применения — для проверки «правдоподобности» измерения. */
  mahalanobis(m: Measurement): number {
    const y = this.innovation(m);
    const S = add(mul(mul(m.H, this.P), transpose(m.H)), m.R);
    const Si = invSmall(S);
    let d2 = 0;
    for (let i = 0; i < y.length; i++) for (let j = 0; j < y.length; j++) d2 += y[i] * Si[i][j] * y[j];
    return d2;
  }

  /** Коррекция. gate — порог d² (chi²); если превышен, измерение отбрасывается. */
  update(m: Measurement, gate = Infinity): UpdateResult {
    if (!this.initialized) return { accepted: false, d2: NaN };
    const y = this.innovation(m);
    const Ht = transpose(m.H);
    const S = add(mul(mul(m.H, this.P), Ht), m.R);
    const Si = invSmall(S);
    let d2 = 0;
    for (let i = 0; i < y.length; i++) for (let j = 0; j < y.length; j++) d2 += y[i] * Si[i][j] * y[j];
    if (d2 > gate) return { accepted: false, d2 };

    const K = mul(mul(this.P, Ht), Si);
    const dx = mul(K, y.map((v) => [v]));
    for (let i = 0; i < N; i++) this.x[i] += dx[i][0];
    this.x[ITH] = wrapAngle(this.x[ITH]);
    if (this.x[IV] < 0) this.x[IV] = 0;
    this.x[IS] = Math.min(1.2, Math.max(0.85, this.x[IS]));

    // Форма Джозефа — устойчивее обычной (I-KH)P
    const IKH = sub(eye(N), mul(K, m.H));
    this.P = symmetrize(add(mul(mul(IKH, this.P), transpose(IKH)), mul(mul(K, m.R), transpose(K))));
    return { accepted: true, d2 };
  }

  private innovation(m: Measurement): number[] {
    const y = m.z.map((z, i) => z - m.h[i]);
    for (const i of m.angleIdx ?? []) y[i] = wrapAngle(y[i]);
    return y;
  }

  // ---------- Готовые измерения ----------

  posMeas(x: number, y: number, sigma: number): Measurement {
    const H = zeros(2, N);
    H[0][IX] = 1;
    H[1][IY] = 1;
    return { z: [x, y], h: [this.x[IX], this.x[IY]], H, R: [[sigma ** 2, 0], [0, sigma ** 2]] };
  }

  speedMeas(v: number, sigma: number): Measurement {
    const H = zeros(1, N);
    H[0][IV] = 1;
    return { z: [v], h: [this.x[IV]], H, R: [[sigma ** 2]] };
  }

  headingMeas(th: number, sigma: number): Measurement {
    const H = zeros(1, N);
    H[0][ITH] = 1;
    return { z: [th], h: [this.x[ITH]], H, R: [[sigma ** 2]], angleIdx: [0] };
  }

  /** Скорость по OBD: машина показывает v·scale. */
  obdMeas(vObd: number, sigma: number): Measurement {
    const H = zeros(1, N);
    H[0][IV] = this.x[IS];
    H[0][IS] = this.x[IV];
    return { z: [vObd], h: [this.x[IV] * this.x[IS]], H, R: [[sigma ** 2]] };
  }

  /** Поперечное смещение от дороги: n·p должно равняться n·p_дороги. */
  crossTrackMeas(nx: number, ny: number, px: number, py: number, sigma: number): Measurement {
    const H = zeros(1, N);
    H[0][IX] = nx;
    H[0][IY] = ny;
    return { z: [nx * px + ny * py], h: [nx * this.x[IX] + ny * this.x[IY]], H, R: [[sigma ** 2]] };
  }

  /** Расстояние до точки (например, до вышки по timing advance). */
  rangeMeas(tx: number, ty: number, range: number, sigma: number): Measurement {
    const dx = this.x[IX] - tx, dy = this.x[IY] - ty;
    const r = Math.max(1, Math.hypot(dx, dy));
    const H = zeros(1, N);
    H[0][IX] = dx / r;
    H[0][IY] = dy / r;
    return { z: [range], h: [r], H, R: [[sigma ** 2]] };
  }

  get posSigma(): number {
    return Math.sqrt(Math.max(this.P[IX][IX], this.P[IY][IY]));
  }
}
