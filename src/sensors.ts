// Датчики телефона -> то, что нужно навигатору. Работает при любом положении телефона:
// в руке, на сиденье, в держателе, в кармане при ходьбе.
//
// 1) Скорость поворота (гироскоп), спроецированная на вертикаль:
//      поворот = -(ω · ĝ)   (минус: курс по часовой, гироскоп — против)
//    Ядро само решает, верить ли ей (в руке — нет).
// 2) Раз в секунду — сводка акселерометра:
//      aHoriz   — средняя горизонтальная перегрузка (скорость на поворотах: v = a / ω);
//      vib      — «тряска» (стоим/едем);
//      tiltRate — как быстро меняется направление «вниз», °/с: в руке оно всё время гуляет,
//                 у лежащего телефона почти постоянно. Так ядро понимает, как держат телефон.
// 3) Шаги — ритмичные пики ускорения при ходьбе.
// 4) Компас: куда смотрит верх телефона (раз в секунду, среднее). Нужен пешком.

import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { toRad, wrapAngle } from './core/geo';
import { oldDevice } from './device';

type Sub = { remove(): void };
type V3 = { x: number; y: number; z: number };
const G = 9.81;

export type SensorCallbacks = {
  onRate: (t: number, headingRate: number) => void;
  onMotion: (t: number, aHoriz: number, vib: number, tiltRate: number) => void;
  onStep: (t: number) => void;
  onAzimuth: (t: number, az: number) => void;
};

export class MotionSensors {
  private g: V3 = { x: 0, y: 0, z: 1 };      // медленная гравитация (~1 с) — для проекций
  private gFast: V3 = { x: 0, y: 0, z: 1 };  // быстрая (~0.3 с) — для наклонов
  private gPrev: V3 | null = null;
  private sign = -1;
  private subs: Sub[] = [];
  private lastRate = 0;
  private rateSum = 0; private rateN = 0;
  private prevBearing: { t: number; b: number } | null = null;
  private corr = 0;

  // сводка за секунду
  private secStart = 0;
  private hSum = 0; private mSum = 0; private mSq = 0; private n = 0;
  private azSin = 0; private azCos = 0; private azN = 0;

  // шаги
  private magLp = 1;
  private armed = true;
  private lastStepT = 0;

  async start(cb: SensorCallbacks): Promise<boolean> {
    const ok = (await Gyroscope.isAvailableAsync()) && (await Accelerometer.isAvailableAsync());
    if (!ok) return false;
    // На старых телефонах — 20 Гц вместо 25: шагам и поворотам хватает, а JS-поток разгружается
    const dt = oldDevice ? 50 : 40;
    Accelerometer.setUpdateInterval(dt);
    Gyroscope.setUpdateInterval(dt);

    this.subs.push(Accelerometer.addListener((a) => {
      const t = Date.now() / 1000;
      const k = 0.02, kf = 0.12;
      this.g = { x: this.g.x + k * (a.x - this.g.x), y: this.g.y + k * (a.y - this.g.y), z: this.g.z + k * (a.z - this.g.z) };
      this.gFast = { x: this.gFast.x + kf * (a.x - this.gFast.x), y: this.gFast.y + kf * (a.y - this.gFast.y), z: this.gFast.z + kf * (a.z - this.gFast.z) };

      const gn = Math.hypot(this.g.x, this.g.y, this.g.z) || 1;
      const ux = this.g.x / gn, uy = this.g.y / gn, uz = this.g.z / gn;
      const lx = (a.x - this.g.x) * G, ly = (a.y - this.g.y) * G, lz = (a.z - this.g.z) * G;
      const up = lx * ux + ly * uy + lz * uz;
      const horiz = Math.hypot(lx - up * ux, ly - up * uy, lz - up * uz);
      const magG = Math.hypot(a.x, a.y, a.z);
      const mag = magG * G;
      this.hSum += horiz; this.mSum += mag; this.mSq += mag * mag; this.n++;

      // Шаг: сглаженный модуль ускорения поднялся выше 1.12 g после провала ниже 1.0 g
      this.magLp = this.magLp + 0.35 * (magG - this.magLp);
      if (this.armed && this.magLp > 1.12 && t - this.lastStepT > 0.3) {
        this.armed = false;
        this.lastStepT = t;
        cb.onStep(t);
      } else if (!this.armed && this.magLp < 1.0) {
        this.armed = true;
      }

      if (!this.secStart) this.secStart = t;
      if (t - this.secStart >= 1 && this.n > 5) {
        const mean = this.mSum / this.n;
        const vib = Math.sqrt(Math.max(0, this.mSq / this.n - mean * mean));
        // наклон: угол между «вниз» сейчас и секунду назад
        const fn = Math.hypot(this.gFast.x, this.gFast.y, this.gFast.z) || 1;
        const cur = { x: this.gFast.x / fn, y: this.gFast.y / fn, z: this.gFast.z / fn };
        let tilt = 0;
        if (this.gPrev) {
          const dot = Math.min(1, Math.max(-1, cur.x * this.gPrev.x + cur.y * this.gPrev.y + cur.z * this.gPrev.z));
          tilt = (Math.acos(dot) * 180) / Math.PI / (t - this.secStart);
        }
        this.gPrev = cur;
        cb.onMotion(t, this.hSum / this.n, vib, tilt);
        if (this.azN > 3) cb.onAzimuth(t, Math.atan2(this.azSin, this.azCos));
        this.secStart = t; this.hSum = 0; this.mSum = 0; this.mSq = 0; this.n = 0;
        this.azSin = 0; this.azCos = 0; this.azN = 0;
      }
    }));

    this.subs.push(Gyroscope.addListener((w) => {
      const n = Math.hypot(this.g.x, this.g.y, this.g.z) || 1;
      const up = (w.x * this.g.x + w.y * this.g.y + w.z * this.g.z) / n;
      const rate = this.sign * up;
      this.lastRate = rate;
      this.rateSum += rate; this.rateN++;
      cb.onRate(Date.now() / 1000, rate);
    }));

    // Компас с поправкой на наклон: восток = магнитное поле × вверх, север = вверх × восток.
    // Азимут верха телефона (оси Y) = atan2(восток·Y, север·Y).
    if (await Magnetometer.isAvailableAsync()) {
      Magnetometer.setUpdateInterval(100);
      this.subs.push(Magnetometer.addListener((m) => {
        const A = this.g;
        const E = { x: m.y * A.z - m.z * A.y, y: m.z * A.x - m.x * A.z, z: m.x * A.y - m.y * A.x };
        const en = Math.hypot(E.x, E.y, E.z);
        if (en < 1e-6) return;
        E.x /= en; E.y /= en; E.z /= en;
        const an = Math.hypot(A.x, A.y, A.z) || 1;
        const Ax = A.x / an, Ay = A.y / an, Az = A.z / an;
        const Ny = Az * E.x - Ax * E.z; // (вверх × восток)·Y
        const az = Math.atan2(E.y, Ny);
        this.azSin += Math.sin(az); this.azCos += Math.cos(az); this.azN++;
      }));
    }
    return true;
  }

  /** Сверка знака гироскопа по GPS: если систематически крутит «не туда» — переворачиваем. */
  feedGps(t: number, bearingDeg: number | null, speed: number | null) {
    const meanRate = this.rateN ? this.rateSum / this.rateN : this.lastRate;
    this.rateSum = 0; this.rateN = 0;
    if (bearingDeg == null || speed == null || speed < 6) { this.prevBearing = null; return; }
    const b = toRad(bearingDeg);
    if (this.prevBearing && t - this.prevBearing.t < 2.5) {
      const gpsRate = wrapAngle(b - this.prevBearing.b) / (t - this.prevBearing.t);
      if (Math.abs(gpsRate) > toRad(3)) this.corr += Math.sign(gpsRate) * Math.sign(meanRate);
      if (this.corr < -15) { this.sign = -this.sign; this.corr = 0; }
      if (this.corr > 50) this.corr = 50;
    }
    this.prevBearing = { t, b };
  }

  stop() { this.subs.forEach((s) => s.remove()); this.subs = []; }
}
