// «Мозг» навигатора: принимает все источники и выдаёт одну позицию.
//
//   GPS ──► проверка честности (антиподмена) ──┐
//   OBD (скорость колёс) ──────────────────────┤
//   гироскоп (повороты) ───────────────────────┼──► фильтр Калмана ──► позиция
//   сотовые вышки + Wi‑Fi (своя база) ─────────┤
//   «сетевое» место Android (вышки/Wi‑Fi) ─────┤
//   привязка к маршруту ───────────────────────┘
//
// Ядро не знает про React Native: его кормят событиями с метками времени (секунды).
// Поэтому его же гоняет симулятор поездки в Node.

import { CarEKF, IX, IY, ITH, IV, IS, IB } from './ekf.ts';
import type { LatLon, XY } from './geo.ts';
import { LocalFrame, dist, toRad, toDeg, wrapAngle } from './geo.ts';
import { Route } from './route.ts';
import type { ExternalManeuver } from './route.ts';
import { RouteParticles } from './routepf.ts';
import { ContextDetector } from './context.ts';
import type { CellFix, CellId, WifiAp } from './cells.ts';
import { CellDb } from './cells.ts';

export type GpsFix = {
  t: number; lat: number; lon: number;
  accuracy: number;          // м (как отдаёт Android)
  speed?: number | null;     // м/с
  bearing?: number | null;   // градусы
};

export type GpsStatus = 'none' | 'ok' | 'checking' | 'jammed' | 'spoofed';

/** Сводка сигнала спутников за секунду (из GnssStatus / GnssMeasurement). */
export type GnssSignal = {
  used: number;          // спутников в решении
  cn0Top: number;        // средняя сила 4 лучших, дБГц
  cn0Std: number;        // разброс силы между используемыми спутниками, дБ
  agc: number | null;    // усиление приёмника (AGC), дБ, если телефон отдаёт
};

export type NavState = {
  t: number;
  ready: boolean;
  lat: number; lon: number;
  sigma: number;            // оценка ошибки, м (1σ)
  headingDeg: number;
  speedKmh: number;
  gps: GpsStatus;
  gpsReason: string;
  obd: boolean; gyro: boolean; cells: number; onRoute: boolean;
  motion: boolean;          // есть данные акселерометра (стоянки, скорость на поворотах)
  stopped: boolean;         // по вибрации похоже, что стоим
  turnFixes: number;        // сколько раз позиция «встала на место» по повороту
  lastFix: string;          // последняя привязка (для человека)
  signalHint: string;       // что «говорит» сам радиосигнал спутников
  context: string;          // «Пешком», «В машине, телефон в руке» и т.п.
  walking: boolean;
  stepLen: number;          // выученная длина шага, м
  mode: string;             // что сейчас ведёт позицию — для человека
  routeS: number | null;    // пройдено по маршруту, м
  routeLeft: number | null; // осталось, м
  next: { text: string; dist: number; type?: number } | null;
  travelMode: 'car' | 'walk' | 'scooter';
  obdScale: number; gyroBiasDegS: number;
  gnssUsed: number | null;  // спутников в решении (null — неизвестно)
  /** Последняя оценка места по вышкам/Wi‑Fi/сети. */
  coarse: { src: string; accuracy: number; age: number; lat: number; lon: number } | null;
  cellsKnown: number;       // сколько видимых вышек/Wi‑Fi есть в базе
  wifiSeen: number;
};

const CHI2_2DOF = 13.8;   // 99.9%
const CHI2_1DOF = 10.8;

export class NavEngine {
  readonly ekf = new CarEKF();
  frame: LocalFrame | null = null;
  route: Route | null = null;
  pf: RouteParticles | null = null;   // фильтр частиц вдоль маршрута (работает, когда GPS нет)
  readonly ctx = new ContextDetector(); // как держат телефон и едем ли / идём

  // --- пешком: шаги × длина шага, направление по компасу ---
  private stepLen = 0.7;
  private azOffset = 0;            // направление ходьбы − куда смотрит верх телефона (учится по GPS)
  private azOffsetLearned = false;
  private lastGpsBearing: number | null = null;
  usePf = true;
  private routeLatLon: LatLon[] | null = null;
  cellDb: CellDb | null = null;

  private t = 0;
  private startTime = 0;
  private gyroRate: number | null = null;
  private lastGyroT = -Infinity;
  private lastObdT = -Infinity;
  private lastObdMs = 0;
  private lastGpsT = -Infinity;
  private lastGoodGpsT = -Infinity;
  private prevGps: (GpsFix & { xy: XY }) | null = null;
  private lastCell: (CellFix & { t: number; xy: XY }) | null = null;
  private lastCellsN = 0;
  private lastCellsKnown = 0;
  private lastWifiN = 0;
  private gnssUsed: number | null = null;
  private lastCoarse: { src: string; accuracy: number; t: number; lat: number; lon: number } | null = null;
  private cellDisagree = 0;
  private coarseHist: { t: number; xy: XY; acc: number }[] = [];
  private coarseStill = false;   // последние сетевые точки не сдвинулись — стоим

  gpsStatus: GpsStatus = 'none';
  gpsReason = '';
  private badRun = 0;
  private goodRun = 0;
  private coherentRun = 0;

  private routeS: number | null = null;
  private onRoute = true;
  private offRouteRun = 0;
  private lastMatchT = -Infinity;

  // --- без OBD: косвенные признаки скорости ---
  private lastMotionT = -Infinity;
  private gyroSum = 0; private gyroN = 0;
  private stillSince: number | null = null;
  private stopped = false;
  private vibStill = 0; private vibMove = 0;   // уровни тряски «стоим» / «едем», учатся при живом GPS
  private lastGpsSpeed: number | null = null;
  private vibAvg = 0;                          // сглаженная тряска (~5 с)
  private vibTrain: [number, number][] = [];   // пары (тряска, скорость по GPS) для обучения
  private vibModel: { a: number; b: number; sd: number } | null = null;
  private cruise = 0;                          // типичная скорость в пути по GPS
  private cruiseLearned = false;
  private lastWeakSpeedT = -Infinity;
  // «Стояли, когда пропал GPS» — тогда и дальше считаем, что стоим, пока нет доказательств движения
  // (шаги, сдвиг по Wi‑Fi/вышкам, тряска машины). Иначе «обычная скорость» уносит стрелку вперёд.
  private holdStill = false;
  private stillAnchor: XY | null = null;
  private stillMoveVotes = 0;
  private moveVibRun = 0;

  private lastStillT = -Infinity;
  // --- «стоим» по радиоэфиру: набор видимых Wi‑Fi не меняется -> машина/человек не двигается ---
  private wifiHist: { t: number; set: Set<string> }[] = [];
  private radioStillSince: number | null = null;
  private radioMoveRun = 0;
  private holdByRadio = false;
  // --- спутники: когда в решении было 0 (точка при 0 спутников — подделка/кэш) ---
  private gnssZeroSince: number | null = null;
  private gnssSeenT = -Infinity;
  private lastReasonKind: 'net' | 'sensor' | 'signal' | 'jump' | 'other' | '' = '';

  // --- повороты: накопленный курс по гироскопу ---
  private headAcc = 0;
  private headOffset: number | null = null; // курс на местности − накопленный курс гироскопа (учится при GPS)
  private headHist: { t: number; h: number }[] = [];
  private lastTurnT = -Infinity;
  turnFixes = 0;
  lastFix = '';

  // --- сигнал спутников: обычный уровень (пока всё честно) и последние секунды ---
  private sigBase: GnssSignal[] = [];
  private sigRecent: GnssSignal[] = [];
  signalHint: '' | 'jam' | 'spoof' = '';
  private signalWhy = '';

  // --- timing advance: шаг в метрах (телефоны врут в 2 раза — подбираем по GPS) ---
  private taRatios: number[] = [];
  private taStep = 0;

  private routeExt: ExternalManeuver[] | undefined;
  travelMode: 'car' | 'walk' | 'scooter' = 'car';

  setRoute(pts: LatLon[], maneuvers?: ExternalManeuver[]) {
    this.routeLatLon = pts;
    this.routeExt = maneuvers;
    if (!this.frame && pts.length) this.frame = new LocalFrame(pts[0]);
    if (this.frame) { this.route = new Route(pts, this.frame, maneuvers); this.pf = new RouteParticles(this.route); }
    this.routeS = null;
    this.onRoute = true;
  }

  clearRoute() {
    this.route = null; this.routeLatLon = null; this.routeExt = undefined; this.pf = null; this.routeS = null;
  }

  /**
   * Чем едем по плану. Пока GPS не научил «обычной скорости», берём типичную:
   * самокат ~15 км/ч, машина ~60 км/ч. Пешком скорость дают шаги.
   */
  setTravelMode(mode: 'car' | 'walk' | 'scooter') {
    this.travelMode = mode;
    if (!this.cruiseLearned) this.cruise = mode === 'scooter' ? 4.2 : mode === 'car' ? 16.7 : 1.4;
  }

  setCellDb(db: CellDb) { this.cellDb = db; }

  private ensureFrame(p: LatLon) {
    if (!this.frame) {
      this.frame = new LocalFrame(p);
      if (this.routeLatLon) { this.route = new Route(this.routeLatLon, this.frame, this.routeExt); this.pf = new RouteParticles(this.route); }
    }
  }

  /** Довести фильтр до момента t. */
  private advance(t: number) {
    if (t <= this.t) return;
    // Первый вызов (this.t = 0, а t — секунды с 1970 г.) или фильтр ещё не запущен:
    // считать нечего, просто запоминаем время. Иначе цикл ниже шёл бы миллиарды шагов.
    if (this.t === 0 || !this.ekf.initialized) { this.t = t; this.checkGpsTimeout(t); return; }
    // Гироскопу верим только когда телефон лежит и мы едем: в руке он видит повороты руки
    const gyroFresh = t - this.lastGyroT < 1.0 && this.gyroTrusted;
    const dt = t - this.t;
    // Длинные интервалы режем на шаги по 0.2 с — так модель поворота точнее (но не больше 300 шагов)
    const steps = Math.min(300, Math.max(1, Math.ceil(dt / 0.2)));
    for (let i = 0; i < steps; i++) this.ekf.predict(dt / steps, gyroFresh ? this.gyroRate : null);
    if (this.pf?.active) this.pf.predict(dt);
    this.t = t;
    if (t - this.lastMatchT >= 1) { this.lastMatchT = t; this.matchRoute(); this.runParticles(); }
    this.checkGpsTimeout(t);
  }

  private checkGpsTimeout(t: number) {
    if (this.startTime === 0) this.startTime = t;
    // Первые 15 секунд после запуска приложения не считаем за глушение
    if (t - this.startTime < 15) return;
    // Android на месте или в помещении отдаёт точки реже, поэтому ждём 12 с
    if (this.lastGpsT > 0 && t - this.lastGpsT > 12 && this.gpsStatus !== 'spoofed') {
      if (this.gpsStatus !== 'none' || this.ekf.initialized) { this.gpsStatus = 'jammed'; this.gpsReason = 'нет точек от GPS больше 12 с'; }
    }
  }

  // ---------- Входы ----------

  /** Гироскоп, уже пересчитанный в «скорость поворота машины», рад/с по часовой. */
  onGyro(t: number, headingRate: number) {
    const dt = Math.min(0.5, t - this.lastGyroT);
    this.advance(t);
    this.gyroRate = headingRate;
    this.lastGyroT = t;
    this.ekf.hasGyro = true;
    this.gyroSum += headingRate; this.gyroN++;
    if (dt > 0) this.headAcc += (headingRate - this.ekf.x[IB]) * dt;
    const last = this.headHist[this.headHist.length - 1];
    if (!last || t - last.t >= 0.2) {
      this.headHist.push({ t, h: this.headAcc });
      while (this.headHist.length && t - this.headHist[0].t > 30) this.headHist.shift();
      this.detectTurn(t, headingRate - this.ekf.x[IB]);
    }
  }

  /**
   * Акселерометр, раз в секунду: средняя горизонтальная перегрузка (м/с²) и «тряска» (СКО, м/с²).
   * Даёт скорость без OBD двумя способами:
   *   - тряски нет несколько секунд  -> стоим (скорость 0);
   *   - на повороте  v = a / ω  (центростремительное ускорение делим на скорость поворота).
   */
  onMotion(t: number, aHoriz: number, vib: number, tiltRate = 0) {
    this.advance(t);
    this.lastMotionT = t;
    const w = this.gyroN ? Math.abs(this.gyroSum / this.gyroN - this.ekf.x[IB]) : 0;
    this.gyroSum = 0; this.gyroN = 0;
    const gpsLiveNow = this.gpsStatus === 'ok' && this.lastGpsSpeed !== null && t - this.lastGpsT < 2;
    this.ctx.onSecond(t, tiltRate, gpsLiveNow ? this.lastGpsSpeed : null);

    // Wi‑Fi вокруг не меняется давно — значит, стоим (даже если GPS подменён и «едет»)
    if (!gpsLiveNow && this.ekf.initialized && this.ctx.movement !== 'walking') {
      if (this.radioStillSince !== null && t - this.radioStillSince >= 12 && !this.holdStill) {
        this.holdStill = true; this.holdByRadio = true;
        this.stillAnchor = { x: this.ekf.x[IX], y: this.ekf.x[IY] };
        this.stillMoveVotes = 0; this.moveVibRun = 0;
        this.lastFix = 'стоим (Wi‑Fi вокруг не меняется)';
      } else if (this.holdByRadio && this.holdStill && this.radioMoveRun >= 2) {
        this.holdStill = false; this.holdByRadio = false;
        this.lastFix = 'тронулись (Wi‑Fi вокруг сменился)';
      }
    }

    // Пока GPS честный — запоминаем, стоим ли мы (и где)
    if (gpsLiveNow) {
      this.holdByRadio = false;
      this.holdStill = this.lastGpsSpeed! < 1.5;
      if (this.holdStill && this.ekf.initialized) this.stillAnchor = { x: this.ekf.x[IX], y: this.ekf.x[IY] };
      this.stillMoveVotes = 0; this.moveVibRun = 0;
    } else if (this.holdStill && this.ekf.initialized && this.ctx.movement !== 'walking') {
      // Машина тронулась? Сильная тряска (выученная при GPS) 8 с подряд — да
      const learnedVib = this.vibStill > 0 && this.vibMove > 2 * this.vibStill && this.ctx.holding === 'fixed';
      this.moveVibRun = learnedVib && vib > Math.sqrt(this.vibStill * this.vibMove) ? this.moveVibRun + 1 : 0;
      if (this.moveVibRun >= 8) { this.holdStill = false; this.lastFix = 'тронулись (по тряске)'; }
      else {
        this.stopped = true;
        this.speedUpd(0, 0.15);
        return;
      }
    }

    // ---- Пешком: скорость = шаги в секунду × длина шага ----
    if (this.ctx.movement === 'walking' || this.ctx.movement === 'still') {
      this.stopped = this.ctx.movement === 'still';
      if (gpsLiveNow && this.ctx.movement === 'walking' && this.ctx.cadence > 0.8 && this.lastGpsSpeed! > 0.5) {
        const L = this.lastGpsSpeed! / this.ctx.cadence;
        if (L > 0.35 && L < 1.2) this.stepLen = 0.95 * this.stepLen + 0.05 * L;
      }
      if (!gpsLiveNow && this.ekf.initialized) this.speedUpd(this.ctx.movement === 'still' ? 0 : this.ctx.cadence * this.stepLen, 0.3);
      return;
    }

    // ---- Телефон в руке в машине: тряска и повороты — от руки, а не от машины ----
    if (this.ctx.holding === 'hand') {
      this.stopped = false;
      if (gpsLiveNow && this.lastGpsSpeed! > 2 && this.ctx.movement === 'vehicle') {
        this.cruise = this.cruiseLearned ? 0.99 * this.cruise + 0.01 * this.lastGpsSpeed! : this.lastGpsSpeed!; this.cruiseLearned = true;
      }
      if (!this.ekf.initialized || t - this.lastObdT < 3 || gpsLiveNow) return;
      if (t - this.lastWeakSpeedT >= 10 && this.cruise > 3 && this.canGuessSpeed(t)) {
        this.lastWeakSpeedT = t;
        this.speedUpd(this.cruise, 10, CHI2_1DOF * 4);
      }
      return;
    }

    // Учим «тихо/трясёт» по живому GPS: у каждого телефона и машины свой уровень
    if (this.gpsStatus === 'ok' && this.lastGpsSpeed !== null && t - this.lastGpsT < 2) {
      if (this.lastGpsSpeed < 0.3) this.vibStill = this.vibStill ? 0.95 * this.vibStill + 0.05 * vib : vib;
      if (this.lastGpsSpeed > 5) this.vibMove = this.vibMove ? 0.95 * this.vibMove + 0.05 * vib : vib;
    }
    const learned = this.vibStill > 0 && this.vibMove > 2 * this.vibStill;
    const thr = learned ? Math.sqrt(this.vibStill * this.vibMove) : 0.12;

    if (vib < thr) this.stillSince ??= t; else this.stillSince = null;
    this.stopped = this.stillSince !== null && t - this.stillSince >= 3;
    if (this.stopped || this.holdStill || (this.ctx.movement as string) === 'still') this.lastStillT = t;
    this.vibAvg = this.vibAvg ? 0.8 * this.vibAvg + 0.2 * vib : vib;

    // Пока GPS честный — учимся: насколько сильно трясёт на какой скорости
    const gpsLive = this.gpsStatus === 'ok' && this.lastGpsSpeed !== null && t - this.lastGpsT < 2;
    if (gpsLive && this.lastGpsSpeed! > 2 && !this.stopped) {
      this.cruise = this.cruiseLearned ? 0.99 * this.cruise + 0.01 * this.lastGpsSpeed! : this.lastGpsSpeed!; this.cruiseLearned = true;
      this.vibTrain.push([this.vibAvg, this.lastGpsSpeed!]);
      if (this.vibTrain.length > 900) this.vibTrain.shift();
      if (this.vibTrain.length % 30 === 0) this.fitVib();
    }
    if (!this.ekf.initialized || t - this.lastObdT < 3 || gpsLive) return;

    if (this.stopped) {
      this.speedUpd(0, 0.3);
      return;
    }
    if (w > toRad(5) && this.ekf.x[IV] > 2) {
      const v = aHoriz / w;
      if (v > 2 && v < 45) this.speedUpd(v, Math.max(2, 0.3 * v), CHI2_1DOF * 3);
    }
    // Грубая скорость: по тряске (если научились) или «как обычно ехали».
    // Ошибка у неё систематическая (другое покрытие дороги), поэтому подмешиваем
    // редко и с большой погрешностью — иначе фильтр станет самоуверенным.
    if (t - this.lastWeakSpeedT < 10) return;
    this.lastWeakSpeedT = t;
    if (this.vibModel) {
      const v = Math.min(45, Math.max(1, this.vibModel.a + this.vibModel.b * this.vibAvg));
      this.speedUpd(v, Math.max(4, 2 * this.vibModel.sd), CHI2_1DOF * 4);
    } else if (this.cruise > 3 && this.canGuessSpeed(t)) {
      this.speedUpd(this.cruise, 10, CHI2_1DOF * 4);
    }
  }

  /**
   * «Едем как обычно» можно подставлять, только если есть повод считать, что мы вообще едем:
   * скорость уже выучена по честному GPS, либо построен маршрут, либо радио видело движение.
   * Иначе стоящий телефон «уезжает» сам по себе.
   */
  private canGuessSpeed(t: number): boolean {
    if (t - this.startTime < 25 && !this.cruiseLearned) return false;
    if (this.radioStillSince !== null && t - this.radioStillSince >= 12) return false;
    if (this.gpsStatus !== 'ok' && this.coarseStill && this.radioMoveRun < 2) return false;
    return this.cruiseLearned || !!this.route || this.radioMoveRun >= 1;
  }

  /** Гироскоп показывает повороты машины, только если телефон лежит и мы не идём пешком. */
  private get gyroTrusted(): boolean {
    return this.ctx.holding === 'fixed' && this.ctx.movement !== 'walking';
  }

  /** Детектор шагов (из акселерометра). */
  onStep(t: number) {
    this.ctx.onStep(t);
  }

  /**
   * Компас: куда смотрит верх телефона (рад, по часовой от севера), раз в секунду.
   * Пешком телефон обычно держат перед собой, и это почти направление ходьбы.
   * Разницу между ними учим по GPS. В машине компасу не верим: железо кузова его сбивает.
   */
  onAzimuth(t: number, az: number) {
    this.advance(t);
    if (this.ctx.movement !== 'walking') return;
    const gpsLive = this.gpsStatus === 'ok' && t - this.lastGpsT < 2;
    if (gpsLive) {
      if (this.lastGpsBearing !== null && (this.lastGpsSpeed ?? 0) > 0.8) {
        const d = wrapAngle(this.lastGpsBearing - az);
        this.azOffset = this.azOffsetLearned ? this.azOffset + 0.05 * wrapAngle(d - this.azOffset) : d;
        this.azOffsetLearned = true;
      }
      return;
    }
    if (this.ekf.initialized) this.ekf.update(this.ekf.headingMeas(wrapAngle(az + this.azOffset), toRad(20)), CHI2_1DOF * 4);
  }

  private speedUpd(z: number, sigma: number, gate = Infinity) {
    this.ekf.update(this.ekf.speedMeas(z, sigma), gate);
    this.pf?.weightSpeed(z, sigma);
  }

  /**
   * Фильтр частиц: включается, когда GPS пропал, и раз в секунду «судит» гипотезы
   * по совпадению курса гироскопа с направлением дороги. Его оценка уходит в фильтр Калмана.
   */
  private runParticles() {
    const pf = this.pf;
    if (!pf || !this.usePf || !this.route || !this.ekf.initialized) return;
    if (this.gpsStatus === 'ok') {
      pf.active = false;
      // Учим поправку курса гироскопа по GPS (средняя за минуту — точнее одного снимка)
      if (this.ekf.x[IV] > 5) {
        const d = wrapAngle(this.ekf.x[ITH] - this.headAcc);
        this.headOffset = this.headOffset === null ? d : this.headOffset + 0.03 * wrapAngle(d - this.headOffset);
      }
      return;
    }
    if (this.routeS === null || !this.onRoute || this.ctx.movement === 'walking' || this.holdStill) { pf.active = false; return; }
    const v = this.ekf.x[IV];
    if (!pf.active) {
      pf.init(this.routeS, Math.max(30, this.ekf.posSigma), v, Math.sqrt(this.ekf.P[IV][IV]) + 0.5,
        this.headOffset ?? this.ekf.x[ITH] - this.headAcc);
      return;
    }
    if (this.gyroTrusted && this.ekf.hasGyro && this.lastGyroT > this.t - 1) pf.weightHeading(this.headAcc + pf.offset, toRad(12));
    const est = pf.estimate();
    // Телефон в руке: гироскопу не верим, и тогда частицы — главный источник.
    // Машина едет по маршруту, значит позиция = точка маршрута, курс = направление дороги в ней.
    if (!this.gyroTrusted) {
      if (est.std < 3000) {
        const { p } = this.route.pointAt(est.s);
        this.ekf.update(this.ekf.posMeas(p.x, p.y, Math.max(10, est.std)));
        this.ekf.update(this.ekf.headingMeas(pf.roadBearing(est.s), toRad(8)));
        this.routeS = est.s;
      }
      return;
    }
    // Уверены — подстраиваем поправку курса (медленно, против дрейфа гироскопа)
    if (est.std < 60 && v > 5 && this.recentTurnDeg(10) < 5) {
      pf.offset += 0.02 * wrapAngle(pf.roadBearing(est.s) - (this.headAcc + pf.offset));
    }
    // Отдаём оценку фильтру Калмана, только если частицы увереннее его самого:
    // с OBD Калман и так точен, и тогда частицы ему не нужны.
    const sig = Math.max(15, est.std);
    if (est.std < 2000 && sig < 0.7 * this.ekf.posSigma) {
      const { p } = this.route.pointAt(est.s);
      this.ekf.update(this.ekf.posMeas(p.x, p.y, sig));
      this.routeS = est.s;
    }
  }

  /** Перезапуск облака частиц вокруг точки (после ручной привязки и т.п.). */
  private reseedParticles(xy: XY, sigma: number) {
    if (!this.pf || !this.route || this.gpsStatus === 'ok') return;
    const proj = this.route.project(xy, 0, this.route.length);
    if (proj) this.pf.init(proj.s, sigma, this.ekf.x[IV], Math.sqrt(this.ekf.P[IV][IV]) + 1);
  }

  /** Линейная связь «тряска -> скорость» по данным, собранным при честном GPS. */
  private fitVib() {
    const d = this.vibTrain, n = d.length;
    if (n < 60) return;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of d) { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
    const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
    if (vx <= 1e-9 || vy <= 1e-9) return;
    const r = cxy / Math.sqrt(vx * vy);
    if (r < 0.4) { this.vibModel = null; return; }   // связи нет — не выдумываем
    const b = cxy / vx, a = (sy - b * sx) / n;
    let ss = 0;
    for (const [x, y] of d) ss += (y - a - b * x) ** 2;
    this.vibModel = { a, b, sd: Math.sqrt(ss / n) };
  }

  /** На сколько градусов повернули по гироскопу за последние sec секунд. */
  private recentTurnDeg(sec: number): number {
    const old = this.headHist.find((p) => this.t - p.t <= sec);
    return old ? Math.abs(toDeg(this.headAcc - old.h)) : 0;
  }

  /** Резкий поворот закончился? Ищем его на маршруте и ставим позицию на место. */
  private detectTurn(t: number, rate: number) {
    if (!this.gyroTrusted) return;
    if (t - this.lastTurnT < 20 || Math.abs(rate) > toRad(4)) return;
    const old = this.headHist.find((p) => t - p.t <= 15);
    if (!old || t - old.t < 8) return;
    const turnDeg = toDeg(this.headAcc - old.h);
    if (Math.abs(turnDeg) < 35) return;
    this.lastTurnT = t;
    this.matchTurn(turnDeg);
  }

  private matchTurn(turnDeg: number) {
    if (this.pf?.active) return; // поворотами занимается фильтр частиц — он делает это точнее
    if (!this.route || !this.ekf.initialized || this.routeS === null || this.gpsStatus === 'ok') return;
    const v = this.ekf.x[IV];
    const sApex = this.routeS - v * 4; // вершина поворота была ~4 с назад
    const win = 3 * this.ekf.posSigma + 500;
    const cands = this.route.maneuvers
      .filter((m) => Math.sign(m.turnDeg) === Math.sign(turnDeg) && Math.abs(m.turnDeg - turnDeg) < 60 && Math.abs(m.s - sApex) < win)
      .sort((a, b) => Math.abs(a.s - sApex) - Math.abs(b.s - sApex));
    if (!cands.length) return;
    // Два похожих поворота рядом — неоднозначно, лучше не трогать
    if (cands[1] && Math.abs(cands[1].s - sApex) < 1.5 * Math.abs(cands[0].s - sApex) + 100) return;
    const m = cands[0];
    const { p, bearing } = this.route.pointAt(m.s + v * 4);
    this.ekf.update(this.ekf.posMeas(p.x, p.y, 35));
    this.ekf.update(this.ekf.headingMeas(bearing, toRad(10)), CHI2_1DOF * 4);
    this.routeS = m.s + v * 4;
    this.turnFixes++;
    this.lastFix = `поворот: ${m.text.toLowerCase()}`;
  }

  /** Ручная привязка: пассажир показал на карте, где мы. */
  manualFix(t: number, lat: number, lon: number, sigma = 50) {
    this.advance(t);
    this.ensureFrame({ lat, lon });
    const xy = this.frame!.toXY({ lat, lon });
    if (!this.ekf.initialized) this.ekf.init(xy.x, xy.y, sigma ** 2);
    else this.ekf.update(this.ekf.posMeas(xy.x, xy.y, sigma));
    this.routeS = null;
    this.cellDisagree = 0;
    this.lastFix = 'отмечено вручную';
    this.reseedParticles(xy, sigma);
  }

  /** Кнопка «Поворачиваем сейчас»: ставим позицию на ближайший поворот маршрута. */
  snapToManeuver(t: number): string {
    this.advance(t);
    if (!this.route || !this.ekf.initialized || this.routeS === null) return '';
    const s = this.routeS, win = 3 * this.ekf.posSigma + 800;
    const m = this.route.maneuvers.filter((mm) => Math.abs(mm.s - s) < win)
      .sort((a, b) => Math.abs(a.s - s) - Math.abs(b.s - s))[0];
    if (!m) return '';
    const { p, bearing } = this.route.pointAt(m.s);
    this.ekf.update(this.ekf.posMeas(p.x, p.y, 30));
    this.ekf.update(this.ekf.headingMeas(bearing, toRad(15)));
    this.routeS = m.s;
    this.lastFix = `вручную: ${m.text.toLowerCase()}`;
    this.pf?.active && this.pf.init(m.s, 30, this.ekf.x[IV], 3);
    return m.text;
  }

  onObd(t: number, kmh: number) {
    this.advance(t);
    this.lastObdT = t;
    this.lastObdMs = kmh / 3.6;
    if (!this.ekf.initialized) return;
    // Квантование 1 км/ч + задержка опроса — около 0.5 м/с.
    // Погрешность спидометра учим только при честном GPS; без него она «заморожена»,
    // иначе фильтр может начать подгонять спидометр под собственные ошибки.
    if (this.gpsStatus === 'ok') this.ekf.update(this.ekf.obdMeas(kmh / 3.6, 0.5), 25);
    else this.ekf.update(this.ekf.speedMeas(kmh / 3.6 / this.ekf.x[IS], 0.5), 25);
    this.pf?.weightSpeed(kmh / 3.6 / this.ekf.x[IS], 0.6);
  }

  onCells(t: number, cells: CellId[], wifi: WifiAp[] = []) {
    this.advance(t);
    this.lastCellsN = cells.length;
    this.lastWifiN = wifi.length;
    this.trackWifi(t, wifi);
    if (!this.cellDb) { this.lastCellsKnown = 0; return; }
    const fix = this.cellDb.locate(cells, wifi);
    this.lastCellsKnown = fix?.used ?? 0;
    if (!fix) return;
    this.applyCoarseFix(t, fix, fix.wifi ? `Wi‑Fi (${fix.wifi}) + вышки` : `вышки (${fix.used})`);
    this.useTimingAdvance(cells);
  }

  /**
   * Сравниваем набор Wi‑Fi сейчас и ~20 с назад. В машине на ходу набор меняется быстро
   * (за 20 с — сотни метров), на месте — почти тот же. Нужно хотя бы 3 точки.
   */
  private trackWifi(t: number, wifi: WifiAp[]) {
    const set = new Set(wifi.filter((w) => w.dbm > -88).map((w) => w.bssid.toLowerCase()));
    this.wifiHist.push({ t, set });
    while (this.wifiHist.length && t - this.wifiHist[0].t > 60) this.wifiHist.shift();
    if (set.size < 3) { this.radioStillSince = null; this.radioMoveRun = 0; return; }
    const ref = [...this.wifiHist].reverse().find((h) => t - h.t >= 15 && h.set.size >= 3);
    if (!ref) return;
    let inter = 0;
    for (const b of set) if (ref.set.has(b)) inter++;
    const jac = inter / (set.size + ref.set.size - inter);
    if (jac >= 0.6) {
      this.radioMoveRun = 0;
      this.radioStillSince ??= this.wifiHist[0].t;
    } else if (jac < 0.35) {
      this.radioMoveRun++;
      this.radioStillSince = null;
    }
  }

  /**
   * Место от Android «по сети» (NETWORK_PROVIDER: вышки + Wi‑Fi через базу Google/производителя)
   * или от онлайн-сервиса beaconDB. Спутники тут не участвуют, поэтому подмена GPS на них не влияет.
   */
  onNetworkFix(t: number, f: LatLon & { accuracy: number }, src = 'сеть') {
    this.advance(t);
    if (!(f.accuracy > 0) || f.accuracy > 20000) return;
    this.applyCoarseFix(t, { lat: f.lat, lon: f.lon, accuracy: Math.max(20, f.accuracy), used: 1, wifi: 0 }, src);
  }

  /** Грубая точка (вышки / Wi‑Fi / сеть): для антиподмены, для старта и когда GPS нет. */
  private applyCoarseFix(t: number, fix: CellFix, src: string) {
    this.ensureFrame(fix);
    const xy = this.frame!.toXY(fix);
    // Две грубые точки подряд в пределах своей погрешности — на месте (в машине за минуту уезжаем на километр)
    // Сравниваем с точкой не моложе 20 с и только для точных источников (сеть/Wi‑Fi, не вышка на километры).
    this.coarseHist.push({ t, xy, acc: fix.accuracy });
    while (this.coarseHist.length && t - this.coarseHist[0].t > 150) this.coarseHist.shift();
    const refFix = [...this.coarseHist].reverse().find((h) => t - h.t >= 20);
    this.coarseStill = !!refFix && fix.accuracy < 300 && refFix.acc < 300
      && dist(xy, refFix.xy) < 2.5 * Math.max(fix.accuracy, refFix.acc) + 60;
    this.lastCell = { ...fix, t, xy };
    this.lastCoarse = { src, accuracy: fix.accuracy, t, lat: fix.lat, lon: fix.lon };
    // Стоим без GPS, а Wi‑Fi/вышки дважды подряд показывают другое место — значит, едем/идём
    if (this.holdStill && this.stillAnchor && this.gpsStatus !== 'ok') {
      const moved = dist(xy, this.stillAnchor) > 2.5 * fix.accuracy + 60;
      this.stillMoveVotes = moved ? this.stillMoveVotes + 1 : 0;
      if (this.stillMoveVotes >= 2) { this.holdStill = false; this.lastFix = `движемся (по ${src})`; }
    }
    if (!this.ekf.initialized) {
      if (this.gpsStatus === 'ok') return;
      this.ekf.init(xy.x, xy.y, fix.accuracy ** 2);
      this.lastFix = `по ${src}, ±${Math.round(fix.accuracy)} м`;
      return;
    }
    // Грубые источники включаем, только если сами уже «потерялись» сильнее, чем их точность,
    // иначе они больше портят, чем помогают.
    // Грубая точка меряет только место. Скорость из неё не берём: невязка в сотню метров через
    // ковариацию «позиция–скорость» иначе превращается в фальшивые 10–30 км/ч, и стоящий телефон «едет».
    const vBefore = this.ekf.x[IV];
    if (this.ekf.posSigma > fix.accuracy * 0.3) this.ekf.update(this.ekf.posMeas(xy.x, xy.y, fix.accuracy), CHI2_2DOF * 2);
    if (this.gpsStatus !== 'ok') {
      this.ekf.x[IV] = vBefore;
      this.pf?.weightPoint(xy, fix.accuracy * 1.5);
      // Сеть дважды показала то же место, колёс и смены Wi‑Fi нет — стоим: гасим скорость, набранную «по привычке»
      if (this.coarseStill && this.radioMoveRun < 2 && t - this.lastObdT >= 3 && this.ctx.movement !== 'walking') this.speedUpd(0, 0.5);
    }

    // Страховка от «самоуверенного» фильтра: если вышки 30 с подряд говорят, что мы
    // далеко от того места, где фильтр себя считает, — верим вышкам и начинаем заново.
    // Точный источник (Wi‑Fi, ±десятки метров) — хватит расхождения в сотню метров и двух раз подряд;
    // грубая вышка — километр и 6 раз (30 с).
    const d = dist(xy, { x: this.ekf.x[IX], y: this.ekf.x[IY] });
    const precise = fix.accuracy < 200;
    const far = precise ? 3 * fix.accuracy + 80 : 2 * fix.accuracy + 1000;
    this.cellDisagree = d > far && this.gpsStatus !== 'ok' ? this.cellDisagree + 1 : 0;
    if (this.cellDisagree >= (precise ? 2 : 6)) {
      const keep = { th: this.ekf.x[ITH], v: this.ekf.x[IV], b: this.ekf.x[IB], s: this.ekf.x[IS] };
      this.ekf.init(xy.x, xy.y, fix.accuracy ** 2, keep.th, toRad(45) ** 2, keep.v, 100);
      this.ekf.x[IB] = keep.b; this.ekf.x[IS] = keep.s;
      this.routeS = null;
      this.cellDisagree = 0;
      this.reseedParticles(xy, fix.accuracy);
      this.lastFix = `сброс по ${src}`;
      if (this.holdStill) this.stillAnchor = xy;
    }
  }

  /**
   * Сила сигнала спутников (C/N0) и усиление приёмника (AGC) — метод из документации Android:
   *   C/N0 падает и AGC падает  -> глушение (шум забивает эфир);
   *   C/N0 растёт, а AGC падает -> подмена (сильный фальшивый сигнал перекрывает настоящий);
   *   у всех спутников одинаковая сила -> подозрительно: настоящие приходят с разных
   *   высот и направлений, а фальшивые — из одной антенны.
   * Сравниваем последние 10 с с «нормой», накопленной при честном GPS.
   */
  onGnssSignal(t: number, sig: GnssSignal) {
    if (this.startTime === 0) this.startTime = t;
    this.advance(t);
    this.gnssUsed = sig.used;
    this.gnssSeenT = t;
    if (sig.used === 0) this.gnssZeroSince ??= t; else this.gnssZeroSince = null;
    // На холодном старте первые 15 секунд 0 спутников — нормальное явление, не считаем подменой
    if (t - this.startTime < 15 && sig.used === 0) return;
    this.sigRecent.push(sig);
    if (this.sigRecent.length > 10) this.sigRecent.shift();
    if (this.gpsStatus === 'ok' && !this.signalHint && sig.used >= 4) {
      this.sigBase.push(sig);
      if (this.sigBase.length > 120) this.sigBase.shift();
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    let hint: '' | 'jam' | 'spoof' = '', why = '';
    const r = this.sigRecent.filter((x) => x.used > 0);
    if (r.length >= 5 && mean(r.map((x) => x.used)) >= 6 && mean(r.map((x) => x.cn0Std)) < 1.5 && mean(r.map((x) => x.cn0Top)) > 38) {
      hint = 'spoof'; why = 'у всех спутников одинаковая сила сигнала';
    }
    if (this.sigBase.length >= 30 && this.sigRecent.length >= 5) {
      const dC = mean(this.sigRecent.map((x) => x.cn0Top)) - mean(this.sigBase.map((x) => x.cn0Top));
      const ra = this.sigRecent.filter((x) => x.agc !== null), ba = this.sigBase.filter((x) => x.agc !== null);
      const dA = ra.length >= 3 && ba.length >= 10 ? mean(ra.map((x) => x.agc!)) - mean(ba.map((x) => x.agc!)) : null;
      if (dC > 3 && dA !== null && dA < -2) { hint = 'spoof'; why = `сигнал сильнее на ${dC.toFixed(0)} дБ, усиление ниже на ${(-dA).toFixed(0)} дБ`; }
      else if (dC < -6 && (dA === null || dA < -2)) { hint = 'jam'; why = `сигнал слабее нормы на ${(-dC).toFixed(0)} дБ`; }
    }
    this.signalHint = hint;
    this.signalWhy = why;
  }

  /**
   * Timing advance: задержка сигнала до «своей» LTE-вышки = расстояние до неё.
   * Даёт не «где-то в радиусе 3 км», а кольцо вокруг вышки. Шаг TA подбираем по живому GPS.
   */
  private useTimingAdvance(cells: CellId[]) {
    const c = cells.find((x) => x.registered && x.radio === 'LTE' && x.ta != null && x.ta >= 0 && x.ta < 1300);
    if (!c || !this.cellDb || !this.frame || !this.ekf.initialized) return;
    const rec = this.cellDb.lookup(c);
    if (!rec) return;
    const tower = this.frame.toXY(rec);
    const pos = { x: this.ekf.x[IX], y: this.ekf.x[IY] };
    if (this.gpsStatus === 'ok') {
      if (c.ta! >= 3) {
        this.taRatios.push(dist(pos, tower) / c.ta!);
        if (this.taRatios.length > 200) this.taRatios.shift();
        if (this.taRatios.length >= 15) {
          const sorted = [...this.taRatios].sort((a, b) => a - b);
          this.taStep = Math.min(200, Math.max(60, sorted[sorted.length >> 1]));
        }
      }
      return;
    }
    const step = this.taStep || 156; // так отдают большинство телефонов
    const range = (c.ta! + 0.5) * step;
    // В базе координаты вышки — оценка по наблюдениям, ошибка сотни метров
    const sigma = 300 + (this.taStep ? 0.15 : 0.45) * range;
    this.ekf.update(this.ekf.rangeMeas(tower.x, tower.y, range, sigma), CHI2_1DOF * 2);
    this.pf?.weightRange(tower, range, sigma);
  }

  /** Тест: делаем вид, что спутники заглушены (GPS-точки игнорируются, всё остальное работает). */
  simulateJam = false;

  onGps(f: GpsFix) {
    this.advance(f.t);
    if (this.simulateJam) { this.setStatus('jammed', 'тест глушения: GPS отключён вручную'); return; }
    this.lastGpsSpeed = null; this.lastGpsBearing = null; // пока не прошла проверка — не используем
    this.ensureFrame(f);
    const xy = this.frame!.toXY(f);
    let baseAcc = Math.max(3, f.accuracy || 50);
    // Корректируем точность по качеству GNSS сигнала (C/N0, количество спутников, многолучёвость)
    let gnssPenalty = 1.0;
    if (this.sigRecent.length > 0) {
      const lastSig = this.sigRecent[this.sigRecent.length - 1];
      if (f.t - this.lastGpsT < 3.0) {
        if (lastSig.used > 0 && lastSig.used < 5) gnssPenalty *= 1.4;
        if (lastSig.cn0Top > 0 && lastSig.cn0Top < 30) gnssPenalty *= 1.5;
        else if (lastSig.cn0Top > 0 && lastSig.cn0Top < 34) gnssPenalty *= 1.2;
        if (lastSig.cn0Std > 4.5) gnssPenalty *= 1.35;
      }
    }
    const acc = baseAcc * gnssPenalty;
    this.lastGpsT = f.t;

    if (acc > 150) { // такая «точность» — это почти всегда глушение
      // Но если мы ещё вообще не знаем, где мы, грубая точка (Wi‑Fi/сеть) лучше, чем ничего
      if (!this.ekf.initialized && acc <= 5000) {
        this.ekf.init(xy.x, xy.y, acc ** 2, 0, Math.PI ** 2, 0, 4);
        this.setStatus('checking', `грубая точка ±${Math.round(acc)} м (Wi‑Fi/сеть)`);
        this.prevGps = { ...f, xy };
        return;
      }
      this.markBad('jammed', `точность ${Math.round(acc)} м`);
      return;
    }

    const reason = this.integrityCheck(f, xy, acc);

    // Ещё не знаем, где мы, и нет независимой точки (сеть/Wi‑Fi/вышки): первую точку GPS не берём
    // сразу — сеть обычно отвечает за несколько секунд. Подменённая точка иначе увозит стрелку за сотни км.
    // Честная точка всегда идёт минимум с 4 спутниками в решении; меньше — кэш или подделка.
    const fewSats = this.gnssUsed !== null && f.t - this.gnssSeenT < 3 && this.gnssUsed < 4;
    if (!this.ekf.initialized && !reason && !this.lastCoarse && !this.lastCell && fewSats && f.t - this.startTime < 20) {
      this.setStatus('checking', 'ждём сеть, чтобы проверить GPS');
      this.prevGps = { ...f, xy };
      return;
    }

    if (!this.ekf.initialized) {
      if (reason) { this.markBad('spoofed', `GPS подменён — позиция по датчикам (${reason})`); return; }
      const hasBearing = f.bearing != null && (f.speed ?? 0) > 3;
      this.ekf.init(xy.x, xy.y, acc ** 2, hasBearing ? toRad(f.bearing!) : 0,
        hasBearing ? toRad(20) ** 2 : Math.PI ** 2, f.speed ?? this.lastObdMs, 4);
      this.goodRun = 1;
      this.lastGpsSpeed = f.speed ?? null;
      this.lastGpsBearing = f.bearing != null && (f.speed ?? 0) > 0.8 ? toRad(f.bearing) : null;
      this.setStatus('ok', '');
      this.lastGoodGpsT = f.t;
      this.prevGps = { ...f, xy };
      return;
    }

    if (reason) {
      this.markBad('spoofed', `GPS подменён — позиция по датчикам (${reason})`);
      if (acc <= 35 && this.signalHint !== 'spoof') {
        this.reinitFromGps(f, xy, acc);
      }
      return;
    }

    this.lastGpsSpeed = f.speed ?? null;
    this.lastGpsBearing = f.bearing != null && (f.speed ?? 0) > 0.8 ? toRad(f.bearing) : null;
    this.badRun = 0;
    this.goodRun++;
    // После подмены/заглушения проверяем от 8 до 20 честных точек подряд
    const needed = this.gpsStatus === 'ok' ? 1 : (this.badRun > 5 ? 20 : 8);
    if (this.goodRun < needed) { this.setStatus('checking', `проверка ${this.goodRun}/${needed}`); return; }
    this.setStatus('ok', '');
    this.lastGoodGpsT = f.t;
    this.prevGps = { ...f, xy };

    this.ekf.update(this.ekf.posMeas(xy.x, xy.y, acc), CHI2_2DOF * 3);
    if (f.speed != null) this.ekf.update(this.ekf.speedMeas(f.speed, 0.5), CHI2_1DOF * 3);
    if (f.bearing != null && (f.speed ?? 0) > 5) this.ekf.update(this.ekf.headingMeas(toRad(f.bearing), toRad(6)), CHI2_1DOF * 3);
  }

  // ---------- Антиподмена ----------

  private allowedJump(t: number): number {
    const dtGood = this.lastGoodGpsT > 0 ? Math.min(120, Math.max(1, t - this.lastGoodGpsT)) : 1;
    const posSig = this.ekf.initialized ? this.ekf.posSigma : 50;
    return 60 * dtGood + 3 * posSig + 200;
  }

  /** Возвращает причину недоверия или '' если всё сходится. */
  private integrityCheck(f: GpsFix, xy: XY, acc: number): string {
    let reason = '';
    let kind: 'net' | 'sensor' | 'signal' | 'jump' | 'other' | '' = '';
    let coherent = true;
    const t = f.t;

    // 1. Скорость от GPS против колёс машины
    const obdFresh = t - this.lastObdT < 3;
    if (obdFresh && f.speed != null) {
      const vWheel = this.lastObdMs / (this.ekf.initialized ? this.ekf.x[IS] : 1);
      if (Math.abs(f.speed - vWheel) > Math.max(4, 0.25 * vWheel)) {
        reason = `скорость GPS ${Math.round(f.speed * 3.6)} ≠ колёса ${Math.round(vWheel * 3.6)} км/ч`;
        kind = 'sensor';
      }
    }

    // 2. Вышки и сеть: GPS не может отличаться от сетевой точки более чем на 2 км
    const netLoc = this.lastCoarse ?? (this.lastCell ? { lat: this.lastCell.lat, lon: this.lastCell.lon, accuracy: this.lastCell.accuracy, t: this.lastCell.t } : null);
    if (netLoc && t - netLoc.t < 300 && this.frame) {
      const dNet = dist(xy, this.frame.toXY({ lat: netLoc.lat, lon: netLoc.lon }));
      if (dNet > Math.max(1800, 3 * netLoc.accuracy + 500)) {
        reason ||= `GPS в ${(dNet / 1000).toFixed(1)} км от вышек/сети`;
        kind ||= 'net';
        coherent = false;
      }
    }

    // 3. Скачок: сравниваем с последней ХОРОШЕЙ позицией (lastGoodGpsT и позиция фильтра)
    if (this.ekf.initialized && this.lastGoodGpsT > 0) {
      const dtGood = t - this.lastGoodGpsT;
      if (dtGood > 0) {
        const dGood = dist(xy, { x: this.ekf.x[IX], y: this.ekf.x[IY] });
        const maxAllowed = this.allowedJump(t);
        if (dGood > maxAllowed) {
          reason ||= `скачок ${Math.round(dGood)} м за ${dtGood.toFixed(1)} с`;
          kind ||= 'jump';
          coherent = false;
        }
      }
    } else if (this.prevGps) {
      const dt = t - this.prevGps.t;
      if (dt > 0) {
        const dJump = dist(xy, this.prevGps.xy);
        const maxAllowed = this.allowedJump(t);
        if (dJump > maxAllowed) {
          reason ||= `скачок ${Math.round(dJump)} м за ${dt.toFixed(1)} с`;
          kind ||= 'jump';
          coherent = false;
        }
      }
    }

    // 3b. Движение по датчикам: если GPS показывает > 12 км/ч, а телефон стоит
    if ((this.stopped || (this.ctx.movement as string) === 'still') && (f.speed ?? 0) > 3.5) {
      reason ||= `GPS показывает ${Math.round((f.speed ?? 0) * 3.6)} км/ч, но телефон стоит`;
      kind ||= 'sensor';
      coherent = false;
    }

    // 3c. Точка есть, а спутников в решении 0 уже несколько секунд — так не бывает (кэш/подделка)
    if (this.gnssZeroSince !== null && t - this.gnssSeenT < 3 && t - this.gnssZeroSince >= 3 && acc < 100) {
      reason ||= 'точка есть, а спутников в решении 0';
      kind ||= 'signal';
      coherent = false;
    }

    // 3d. Скорость GPS большая, а телефон «стоит» по Wi‑Fi — подмена
    if (this.radioStillSince !== null && t - this.radioStillSince >= 12 && (f.speed ?? 0) > 3.5) {
      reason ||= `GPS ${Math.round((f.speed ?? 0) * 3.6)} км/ч, а Wi‑Fi вокруг не меняется`;
      kind ||= 'sensor';
      coherent = false;
    }

    // 4. Сам радиосигнал похож на подмену (см. onGnssSignal)
    if (this.signalHint === 'spoof') {
      reason ||= `сигнал: ${this.signalWhy}`;
      kind ||= 'signal';
      coherent = false;
    }

    // 5. Статистика фильтра: насколько точка «невероятна» с учётом нашей неопределённости
    if (this.ekf.initialized && !reason) {
      const d2 = this.ekf.mahalanobis(this.ekf.posMeas(xy.x, xy.y, Math.max(acc, 8)));
      if (d2 > CHI2_2DOF * 3) {
        reason = `точка вне ожидаемой области (d²=${d2.toFixed(0)})`;
        kind ||= 'other';
      }
    }

    this.lastReasonKind = reason ? kind : '';
    this.coherentRun = coherent && !(reason && reason.startsWith('скорость')) ? this.coherentRun + 1 : 0;
    return reason;
  }

  private canReinitFromGps(f: GpsFix, xy: XY, acc: number): boolean {
    const t = f.t;
    if (this.lastReasonKind === 'net' || this.lastReasonKind === 'sensor' || this.lastReasonKind === 'signal') return false;
    if (this.stopped || (this.ctx.movement as string) === 'still') return false;
    if (t - this.lastStillT < 20) return false;

    const dtGood = t - this.lastGoodGpsT;
    const isLongPause = dtGood > 120;

    const netLoc = this.lastCoarse ?? (this.lastCell ? { lat: this.lastCell.lat, lon: this.lastCell.lon, accuracy: this.lastCell.accuracy, t: this.lastCell.t } : null);
    const hasNetConfirm = !!(netLoc && t - netLoc.t < 300 && this.frame && dist(xy, this.frame.toXY({ lat: netLoc.lat, lon: netLoc.lon })) <= 3000);

    // Независимое сетевое подтверждение — основание для перезапуска само по себе
    if (hasNetConfirm) return true;

    if (this.coherentRun < 20) return false;

    let distOk = false;
    if (!isLongPause && this.ekf.initialized && this.lastGoodGpsT > 0) {
      const dGood = dist(xy, { x: this.ekf.x[IX], y: this.ekf.x[IY] });
      const maxAllowed = this.allowedJump(t);
      distOk = dGood <= maxAllowed;
    }

    return distOk;
  }

  private reinitFromGps(f: GpsFix, xy: XY, acc: number) {
    if (!this.canReinitFromGps(f, xy, acc)) return;
    const keep = { b: this.ekf.x[IB], s: this.ekf.x[IS] };
    const th = f.bearing != null && (f.speed ?? 0) > 3 ? toRad(f.bearing) : this.ekf.x[ITH];
    this.ekf.init(xy.x, xy.y, acc ** 2, th, toRad(20) ** 2, f.speed ?? this.ekf.x[IV], 4);
    this.ekf.x[IB] = keep.b; this.ekf.x[IS] = keep.s;
    this.routeS = null;
    this.badRun = 0; this.goodRun = 5; this.coherentRun = 0;
    this.setStatus('ok', 'перезапуск по GPS');
  }

  private markBad(st: GpsStatus, reason: string) {
    this.badRun++;
    this.goodRun = 0;
    this.setStatus(st, reason);
  }

  private setStatus(st: GpsStatus, reason: string) { this.gpsStatus = st; this.gpsReason = reason; }

  // ---------- Привязка к маршруту ----------

  private matchRoute() {
    if (!this.route || !this.ekf.initialized || this.route.length < 1) return;
    const p = { x: this.ekf.x[IX], y: this.ekf.x[IY] };
    const sig = this.ekf.posSigma;
    const win = 300 + 3 * sig;
    const proj = this.routeS === null
      ? this.route.project(p, 0, this.route.length)
      : this.route.project(p, this.routeS - win, this.routeS + win);
    if (!proj) return;

    const gpsOk = this.gpsStatus === 'ok';
    const walk = this.ctx.movement === 'walking';
    // Телефон в руке и нет GPS: позицию вдоль маршрута ведёт фильтр частиц (runParticles)
    if (!gpsOk && !walk && !this.gyroTrusted && this.pf?.active && this.usePf) return;
    // С живым GPS разрешаем съезжать с маршрута (объезд, заправка).
    if (gpsOk) {
      this.offRouteRun = Math.abs(proj.offset) > 60 ? this.offRouteRun + 1 : 0;
      if (this.offRouteRun >= 8) this.onRoute = false;
      if (Math.abs(proj.offset) < 25) this.onRoute = true;
    }
    this.routeS = proj.s;
    if (!this.onRoute) return;
    if (gpsOk && Math.abs(proj.offset) > 40) return;

    // Без GPS считаем, что едем по маршруту: дорога «держит» позицию поперёк.
    // У самого излома направление «поперёк» неоднозначно — там не корректируем.
    if (proj.clamped) return;
    // Участок дороги должен идти туда же, куда едем. Иначе это соседний участок за
    // поворотом: «поперёк» него — это «вдоль» нас, и коррекция ошибочно тормозила бы машину.
    // Курс при этом всё равно мягко подтягиваем к дороге (вдали от изломов) — так фильтр
    // сам возвращается, если гироскоп «увёл» стрелку в сторону.
    const misaligned = this.ekf.x[IV] > 2 && Math.abs(wrapAngle(proj.bearing - this.ekf.x[ITH])) > toRad(35);
    if (!misaligned) {
      this.ekf.update(this.ekf.crossTrackMeas(proj.nx, proj.ny, proj.point.x, proj.point.y, walk ? 15 : gpsOk ? 10 : 6),
        gpsOk ? CHI2_1DOF : Infinity);
    }
    // Только что повернули по гироскопу? Тогда дорога «под нами» может быть ещё старым
    // участком (ошибка вдоль пути) — курс не трогаем, поворот разберёт matchTurn.
    if (this.gyroTrusted && this.recentTurnDeg(8) > 20) return;
    if (!walk && proj.distToVertex > 30 && this.ekf.x[IV] > 3) {
      this.ekf.update(this.ekf.headingMeas(proj.bearing, toRad(misaligned ? 20 : gpsOk ? 10 : 6)), misaligned ? Infinity : CHI2_1DOF * 4);
    }
  }

  // ---------- Выход ----------

  getState(t = this.t): NavState {
    this.advance(t);
    const e = this.ekf;
    const ll = this.frame && e.initialized ? this.frame.toLatLon({ x: e.x[IX], y: e.x[IY] }) : { lat: 0, lon: 0 };
    const obd = t - this.lastObdT < 3;
    const gyro = t - this.lastGyroT < 1 && this.gyroTrusted;
    let mode = 'Ожидание сигнала';
    if (e.initialized) {
      if (this.gpsStatus === 'ok') mode = 'GPS';
      else if (this.holdStill && !obd && this.ctx.movement !== 'walking') mode = 'Стоим на месте (ждём движения)';
      else if (obd && gyro) mode = 'Счисление: колёса + гироскоп';
      else if (obd) mode = 'Счисление: колёса';
      else if (this.ctx.movement === 'walking') mode = 'Шаги + компас';
      else if (this.ctx.movement === 'still') mode = 'Стоим (пешком)';
      else if (this.ctx.holding === 'hand' && this.route) mode = 'Маршрут + вышки (телефон в руке)';
      else if (gyro && this.gyroTrusted && t - this.lastMotionT < 3) mode = this.stopped ? 'Стоим (по датчикам)' : 'Счисление: гироскоп + повороты';
      else if (this.lastCoarse && t - this.lastCoarse.t < 30) mode = `Место по ${this.lastCoarse.src}`;
      else mode = 'Прогноз (мало данных)';
      if (this.route && this.onRoute && this.gpsStatus !== 'ok') mode += ' + дорога';
    }
    const next = this.route && this.routeS !== null ? this.route.nextManeuver(this.routeS) : null;
    return {
      t, ready: e.initialized,
      lat: ll.lat, lon: ll.lon,
      sigma: e.initialized ? e.posSigma : Infinity,
      headingDeg: (toDeg(wrapAngle(e.x[ITH])) + 360) % 360,
      speedKmh: e.x[IV] * 3.6,
      gps: this.gpsStatus, gpsReason: this.gpsReason,
      obd, gyro, cells: this.lastCellsN, onRoute: this.onRoute,
      motion: t - this.lastMotionT < 3, stopped: this.stopped,
      turnFixes: this.turnFixes, lastFix: this.lastFix,
      context: this.ctx.label,
      walking: this.ctx.movement === 'walking',
      stepLen: this.stepLen,
      signalHint: this.signalHint ? `${this.signalHint === 'spoof' ? 'похоже на подмену' : 'похоже на глушение'}: ${this.signalWhy}` : '',
      mode,
      routeS: this.routeS,
      routeLeft: this.route && this.routeS !== null ? this.route.length - this.routeS : null,
      next: next ? { text: next.m.text, dist: next.dist, type: next.m.type } : null,
      travelMode: this.travelMode,
      obdScale: e.x[IS], gyroBiasDegS: toDeg(e.x[IB]),
      gnssUsed: this.gnssUsed,
      coarse: this.lastCoarse ? { src: this.lastCoarse.src, accuracy: this.lastCoarse.accuracy, age: t - this.lastCoarse.t, lat: this.lastCoarse.lat, lon: this.lastCoarse.lon } : null,
      cellsKnown: this.lastCellsKnown,
      wifiSeen: this.lastWifiN,
    };
  }

  /** Экспресс-проверка надежности GPS и датчиков перед выездом */
  runSelfTest(): { ok: boolean; score: number; issues: string[]; summary: string } {
    const issues: string[] = [];
    let score = 100;

    if (this.gnssUsed != null) {
      if (this.gnssUsed < 4) { issues.push('Мало спутников в решении'); score -= 30; }
      const lastSig = this.sigRecent[this.sigRecent.length - 1];
      if (lastSig && lastSig.cn0Top < 25) { issues.push('Слабый сигнал C/N0 (глушение?)'); score -= 30; }
    } else {
      issues.push('Нет данных спутников');
      score -= 30;
    }

    if (!this.lastCell || Date.now() / 1000 - this.lastCell.t > 300) {
      issues.push('Нет данных вышек');
      score -= 20;
    }

    if (this.gpsStatus === 'jammed') { issues.push('GPS заглушён'); score -= 50; }
    else if (this.gpsStatus === 'spoofed') { issues.push('Обнаружена подмена GPS'); score -= 50; }

    const ok = score >= 70;
    const summary = ok ? 'Всё готово к выезду. Спутники и датчики в норме.' : `Внимание: ${issues.join(', ')}`;
    return { ok, score, issues, summary };
  }

  /** Позиция в локальных метрах — для симулятора. */
  get xy(): XY { return { x: this.ekf.x[IX], y: this.ekf.x[IY] }; }
}
