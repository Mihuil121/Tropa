// Симулятор поездки: синтетическая трасса ~75 км, честные «датчики» с ошибками,
// и зоны помех: глушение (спутников нет) и подмена (GPS «стоит в аэропорту»).
// Запуск:  node sim/drive.ts

import { NavEngine } from '../src/core/engine.ts';
import type { XY } from '../src/core/geo.ts';
import { LocalFrame, wrapAngle, toDeg, toRad } from '../src/core/geo.ts';
import { Route } from '../src/core/route.ts';
import type { CellId } from '../src/core/cells.ts';
import { CellDb, cellKey } from '../src/core/cells.ts';

// ---------- Случайные числа с фиксированным зерном (результат повторяем) ----------
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// ---------- Трасса: прямые, плавные дуги и перекрёстки ----------
const origin = { lat: 55.75, lon: 37.62 };
const frame = new LocalFrame(origin);

function buildTrack(): XY[] {
  const pts: XY[] = [{ x: 0, y: 0 }];
  let th = 0; // на север
  const plan: Array<[string, number, number?]> = [
    ['line', 4000], ['turn', 90], ['line', 2500], ['arc', 12000, 40], ['line', 9000],
    ['turn', -90], ['line', 3000], ['arc', 8000, -60], ['line', 7000], ['turn', 90],
    ['line', 1500], ['turn', -45], ['line', 6000], ['arc', 10000, 70], ['line', 5000],
    ['turn', 90], ['line', 2000], ['turn', -90], ['line', 8000], ['arc', 6000, -50], ['line', 4000],
  ];
  const step = 20;
  const go = (len: number, dTh = 0) => {
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      th += dTh / n;
      const p = pts[pts.length - 1];
      pts.push({ x: p.x + Math.sin(th) * (len / n), y: p.y + Math.cos(th) * (len / n) });
    }
  };
  for (const [kind, a, b] of plan) {
    if (kind === 'line') go(a);
    if (kind === 'arc') go(a, (b! * Math.PI) / 180);
    if (kind === 'turn') go(30, (a * Math.PI) / 180); // перекрёсток: поворот на ~30 м
  }
  return pts;
}

// Вторая трасса — извилистая дорога (как большинство областных): SIMTRACK=winding
function buildWinding(): XY[] {
  const pts: XY[] = [{ x: 0, y: 0 }];
  let th = 0, total = 0;
  const step = 20;
  while (total < 85000) {
    const len = 300 + rnd() * 900;
    const dTh = (rnd() - 0.5) * (rnd() < 0.15 ? Math.PI : Math.PI / 2.5); // изгибы и иногда перекрёстки
    const n = Math.round(len / step);
    for (let i = 0; i < n; i++) {
      th += dTh / n;
      const p = pts[pts.length - 1];
      pts.push({ x: p.x + Math.sin(th) * step, y: p.y + Math.cos(th) * step });
    }
    total += len;
  }
  return pts;
}

const trackXY = process.env.SIMTRACK === 'winding' ? buildWinding() : buildTrack();
const trackLL = trackXY.map((p) => frame.toLatLon(p));
const truthRoute = new Route(trackLL, frame);
// Маршрут в телефоне чуть отличается от реальной дороги (как OSM от реальности): ±3 м
// Ошибка карты плавная (вся дорога чуть сдвинута), а не «зубцы» на каждой точке —
// зубцы удлиняют маршрут и искажают пройденное расстояние, как настоящая карта не делает.
let mapOff = { x: 0, y: 0 };
const navRouteLL = trackXY.map((p) => {
  mapOff = { x: 0.98 * mapOff.x + gauss() * 0.4, y: 0.98 * mapOff.y + gauss() * 0.4 };
  return frame.toLatLon({ x: p.x + mapOff.x, y: p.y + mapOff.y });
});

// ---------- Вышки вдоль трассы ----------
type Tower = { xy: XY; id: CellId; rec: [number, number, number] };
const towers: Tower[] = [];
for (let s = 0; s < truthRoute.length; s += 2500) {
  const { p } = truthRoute.pointAt(s);
  const xy = { x: p.x + (rnd() - 0.5) * 4000, y: p.y + (rnd() - 0.5) * 4000 };
  const id = { mcc: 250, mnc: 1, area: 7000 + Math.floor(s / 20000), cid: 100000 + towers.length };
  const dbLL = frame.toLatLon({ x: xy.x + gauss() * 300, y: xy.y + gauss() * 300 }); // база неточная
  towers.push({ xy, id, rec: [dbLL.lat, dbLL.lon, 3000] });
}
const dbJson: Record<string, [number, number, number]> = {};
for (const tw of towers) dbJson[cellKey(tw.id)] = tw.rec;
const cellDb = CellDb.fromJson(JSON.stringify(dbJson));

// ---------- Сценарий: скорость и зоны помех ----------
const MIN = 60;
const HAND = process.env.SIMHOLD === 'hand';
const phases = [
  { name: 'GPS честный', from: 0, to: 8 * MIN },
  { name: 'ГЛУШЕНИЕ (нет спутников)', from: 8 * MIN, to: 33 * MIN },
  { name: 'ПОДМЕНА (GPS «в аэропорту»)', from: 33 * MIN, to: 43 * MIN },
  { name: 'GPS снова честный', from: 43 * MIN, to: Infinity },
];
const phaseAt = (t: number) => phases.findIndex((p) => t >= p.from && t < p.to);
const spoofPoint = frame.toXY({ lat: 55.97, lon: 37.41 }); // ~ «аэропорт» в 25 км от трассы

// Целевая скорость: 90 км/ч на прямых, медленнее перед поворотами, иногда пробки
function targetSpeed(s: number, t: number): number {
  let v = 25; // м/с
  for (const m of truthRoute.maneuvers) {
    const d = m.s - s;
    if (d > -60 && d < 400) v = Math.min(v, 8 + Math.max(0, d) * 0.04);
  }
  if (t > 15 * MIN && t < 17 * MIN) v = Math.min(v, 4); // пробка внутри зоны глушения
  if (t > 25 * MIN && t < 25.5 * MIN) v = 0;            // постояли на светофоре/КПП
  return v;
}

// ---------- Прогон ----------
type Variant = { name: string; obd: boolean; gyro: boolean; cells: boolean; route: boolean; motion?: boolean; ta?: boolean; pf?: boolean; sig?: boolean; naive?: boolean };
const variants: Variant[] = [
  { name: 'Обычный телефонный навигатор (верит GPS)', obd: false, gyro: false, cells: false, route: false, naive: true },
  { name: 'Без OBD, было: гироскоп + вышки + маршрут', obd: false, gyro: true, cells: true, route: true },
  { name: 'Без OBD: + стоянки, скорость на поворотах, повороты, TA (без частиц)', obd: false, gyro: true, cells: true, route: true, motion: true, ta: true, pf: false },
  { name: 'Без OBD, стало: всё + фильтр частиц по форме дороги', obd: false, gyro: true, cells: true, route: true, motion: true, ta: true, pf: true },
  { name: 'Без OBD, стало + монитор сигнала спутников (C/N0, AGC)', obd: false, gyro: true, cells: true, route: true, motion: true, ta: true, pf: true, sig: true },
  { name: 'С OBD: всё вместе', obd: true, gyro: true, cells: true, route: true, motion: true, ta: true, sig: true },
];

function run(v: Variant) {
  seed = 777 + Number(process.env.SIMSEED || 0) * 1000; // одинаковые «датчики» для всех вариантов
  const eng = new NavEngine();
  eng.usePf = v.pf !== false;
  if (v.route) eng.setRoute(navRouteLL);
  if (v.cells) eng.setCellDb(cellDb);

  const dt = 0.1;
  let s = 0, vel = 0, t = 0;
  let prevTh = truthRoute.pointAt(0).bearing;
  let gpsErr = { x: 0, y: 0 };
  const gyroBias = toRad(0.25);      // типичный дрейф телефонного гироскопа
  const obdScale = 1.04;             // спидометр завышает на 4%
  let naive: XY | null = null;
  let rateSum = 0, rateN = 0, prevVel = 0, handRate = 0;

  const errs: number[][] = phases.map(() => []);
  const statusLog: string[] = [];
  let lastStatus = '';

  while (s < truthRoute.length - 50) {
    t += dt;
    const vt = targetSpeed(s, t);
    vel += Math.max(-3, Math.min(1.5, (vt - vel) / 3)) * dt;
    vel = Math.max(0, vel);
    s += vel * dt;
    const tp = truthRoute.pointAt(s);
    const truth = tp.p;
    const th = tp.bearing;
    const rate = wrapAngle(th - prevTh) / dt;
    prevTh = th;
    const ph = phaseAt(t);

    // Гироскоп 10 Гц
    // Телефон в руке (SIMHOLD=hand): к поворотам машины добавляются повороты руки
    if (HAND) {
      handRate = 0.9 * handRate + gauss() * toRad(6);
      if (rnd() < 0.002) handRate += (rnd() - 0.5) * toRad(200); // переложил руку / посмотрел в окно
    }
    if (v.gyro) eng.onGyro(t, rate * 1.01 + gyroBias + gauss() * toRad(0.5) + handRate);
    rateSum += rate; rateN++;

    const tick = Math.round(t * 10);

    // Акселерометр, сводка раз в секунду: горизонтальная перегрузка и тряска
    if (tick % 10 === 0) {
      const w = rateSum / Math.max(1, rateN);
      const along = (vel - prevVel) / 1.0;
      prevVel = vel; rateSum = 0; rateN = 0;
      if (v.motion) {
        let aH = Math.hypot(vel * w, along) + Math.abs(gauss()) * 0.25;
        let vib = vel < 0.1 ? 0.05 + Math.abs(gauss()) * 0.01 : 0.15 + 0.012 * vel + Math.abs(gauss()) * 0.05;
        let tilt = 0.3 + Math.abs(gauss()) * 0.3;
        if (HAND) { aH = Math.abs(gauss()) * 1.2 + 0.3; vib = 0.4 + Math.abs(gauss()) * 0.25; tilt = 3 + Math.abs(gauss()) * 4; }
        eng.onMotion(t, aH, vib, tilt);
      }
    }
    // OBD 2 Гц
    if (v.obd && tick % 5 === 0) eng.onObd(t, Math.round(vel * obdScale * 3.6));

    // GPS 1 Гц
    if (tick % 10 === 0) {
      gpsErr = { x: gpsErr.x * 0.9 + gauss() * 1.5, y: gpsErr.y * 0.9 + gauss() * 1.5 };
      let fix: { xy: XY; acc: number; speed: number | null; bearing: number | null } | null = null;
      if (ph === 0 || ph === 3) fix = { xy: { x: truth.x + gpsErr.x, y: truth.y + gpsErr.y }, acc: 5, speed: vel + gauss() * 0.3, bearing: vel > 2 ? toDeg(th) + gauss() * 3 : null };
      if (ph === 2 && process.env.SIMSPOOF !== 'drag') fix = { xy: { x: spoofPoint.x + gauss() * 2, y: spoofPoint.y + gauss() * 2 }, acc: 4, speed: 0, bearing: null };
      // «Умная» подмена: позиция настоящая, но плавно уводится в сторону на 1.5 м/с, скорость правдоподобная
      if (ph === 2 && process.env.SIMSPOOF === 'drag') {
        const k = (t - phases[2].from) * 1.5;
        fix = { xy: { x: truth.x + k * 0.8 + gpsErr.x, y: truth.y + k * 0.6 + gpsErr.y }, acc: 5, speed: vel + gauss() * 0.3, bearing: vel > 2 ? toDeg(th) + gauss() * 3 : null };
      }
      // Сила сигнала спутников: честные — разная сила, подмена — одинаковая и сильнее при меньшем усилении
      if (v.sig) {
        const sp = ph === 2, jam = ph === 1;
        eng.onGnssSignal(t, jam ? { used: 0, cn0Top: 18 + gauss(), cn0Std: 3, agc: 40 + gauss() * 0.5 }
          : { used: sp ? 10 : 9, cn0Top: (sp ? 48 : 44) + gauss(), cn0Std: sp ? 0.8 + Math.abs(gauss()) * 0.2 : 5 + gauss() * 0.5, agc: (sp ? 44 : 50) + gauss() * 0.3 });
      }
      if (fix) {
        const ll = frame.toLatLon(fix.xy);
        eng.onGps({ t, lat: ll.lat, lon: ll.lon, accuracy: fix.acc, speed: fix.speed, bearing: fix.bearing });
        naive = fix.xy;
      }
    }

    // Вышки раз в 5 с
    if (v.cells && tick % 50 === 0) {
      const vis = towers
        .map((tw) => ({ tw, d: Math.hypot(tw.xy.x - truth.x, tw.xy.y - truth.y) }))
        .filter((o) => o.d < 8000).sort((a, b) => a.d - b.d).slice(0, 3)
        .map((o, i) => ({ ...o.tw.id, dbm: -60 - 20 * Math.log10(Math.max(100, o.d) / 100) + gauss() * 4,
          radio: 'LTE', registered: i === 0, ta: v.ta && i === 0 ? Math.floor(o.d / 156) : null }));
      eng.onCells(t, vis);
    }

    // Ошибка раз в секунду
    if (tick % 10 === 0) {
      const st = eng.getState(t);
      const est = v.naive ? naive : (st.ready ? eng.xy : null);
      if (est) errs[ph].push(Math.hypot(est.x - truth.x, est.y - truth.y));
      if (process.env.DEBUG && v.name.includes('стало') && tick % 600 === 0 && est) console.log(`dbg ${(t/60).toFixed(0)} мин err=${Math.round(Math.hypot(est.x - truth.x, est.y - truth.y))} σ=${Math.round(st.sigma)} v=${(st.speedKmh).toFixed(0)}/${(vel*3.6).toFixed(0)} sEst=${Math.round(st.routeS ?? -1)} sTrue=${Math.round(s)}`);
      if (!v.naive) {
        const line = `${st.gps}${st.gpsReason ? ' (' + st.gpsReason.replace(/\d+(\.\d+)?/g, '#') + ')' : ''}`;
        if (line !== lastStatus) {
          statusLog.push(`  ${(t / 60).toFixed(1).padStart(5)} мин  GPS: ${st.gps}${st.gpsReason ? ' — ' + st.gpsReason : ''}  | режим: ${st.mode}`);
          lastStatus = line;
        }
      }
    }
  }

  const eng2 = eng.getState(t);
  return { errs, statusLog, final: eng2, minutes: t / 60 };
}

const fmt = (a: number[]) => {
  if (!a.length) return '   —      —   ';
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const max = Math.max(...a);
  const km = (m: number) => (m >= 1000 ? (m / 1000).toFixed(1) + ' км' : Math.round(m) + ' м');
  return `${km(mean).padStart(7)} / ${km(max).padStart(7)}`;
};

console.log(`Трасса: ${(truthRoute.length / 1000).toFixed(1)} км, поворотов: ${truthRoute.maneuvers.length}, вышек в базе: ${cellDb.size}\n`);
const results = variants.map((v) => ({ v, r: run(v) }));
console.log(`Поездка: ${results[0].r.minutes.toFixed(0)} мин. Ошибка позиции «средняя / максимальная» по фазам:\n`);
for (const { v, r } of results) {
  console.log(`▶ ${v.name}`);
  phases.forEach((p, i) => console.log(`    ${p.name.padEnd(30)} ${fmt(r.errs[i])}`));
  if (!v.naive && !v.obd) console.log(`    привязок по поворотам: ${r.final.turnFixes}`);
  if (v.obd) console.log(`    выучил: спидометр ×${r.final.obdScale.toFixed(3)} (правда 1.040), дрейф гироскопа ${r.final.gyroBiasDegS.toFixed(2)}°/с (правда 0.25)`);
  console.log('');
}
console.log('Журнал состояний GPS (полный вариант):');
console.log(results[5].r.statusLog.slice(0, 40).join("\n"));
if (process.env.DEBUG) console.log("\nБез OBD:\n" + results[3].r.statusLog.slice(0, 60).join("\n"));

if (process.env.SUMMARY) {
  for (const { v, r } of results) {
    const m = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    console.log(`SUM|${v.name}|${m(r.errs[1]).toFixed(0)}|${m(r.errs[2]).toFixed(0)}|${Math.max(...r.errs[1], ...r.errs[2]).toFixed(0)}`);
  }
}
