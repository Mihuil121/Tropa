// Симулятор прогулки: человек идёт по городу с телефоном в руке, по пути зона глушения.
//   node sim/walk.ts
// Телефон: шаги (ритм ~1.9 в секунду), компас с городскими помехами (железо, машины рядом),
// гироскоп «гуляет» вместе с рукой. Сравниваем с обычным навигатором.

import { NavEngine } from '../src/core/engine.ts';
import type { XY } from '../src/core/geo.ts';
import { LocalFrame, toDeg, toRad } from '../src/core/geo.ts';
import { Route } from '../src/core/route.ts';
import { CellDb, cellKey } from '../src/core/cells.ts';

let seed = 4242 + Number(process.env.SIMSEED || 0) * 1000;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const frame = new LocalFrame({ lat: 55.75, lon: 37.62 });

// Городская прогулка: кварталы 150–400 м, повороты на перекрёстках
const pts: XY[] = [{ x: 0, y: 0 }];
let th = 0;
for (let k = 0; k < 16; k++) {
  const len = 150 + rnd() * 250;
  for (let i = 0; i < len / 5; i++) {
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + Math.sin(th) * 5, y: p.y + Math.cos(th) * 5 });
  }
  th += (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 * (0.7 + rnd() * 0.6);
}
const ll = pts.map((p) => frame.toLatLon(p));
const truthRoute = new Route(ll, frame);

// Вышки в городе стоят часто
const db: Record<string, [number, number, number]> = {};
const towers: { xy: XY; id: { mcc: number; mnc: number; area: number; cid: number } }[] = [];
for (let s = 0; s < truthRoute.length; s += 600) {
  const { p } = truthRoute.pointAt(s);
  const xy = { x: p.x + (rnd() - 0.5) * 1200, y: p.y + (rnd() - 0.5) * 1200 };
  const id = { mcc: 250, mnc: 2, area: 100, cid: 5000 + towers.length };
  const dl = frame.toLatLon({ x: xy.x + gauss() * 150, y: xy.y + gauss() * 150 });
  db[cellKey(id)] = [dl.lat, dl.lon, 1000];
  towers.push({ xy, id });
}
const cellDb = CellDb.fromJson(JSON.stringify(db));

const MIN = 60;
const phase = (t: number) => (t < 8 * MIN ? 0 : t < 30 * MIN ? 1 : 2); // честно / глушение / честно

type V = { name: string; naive?: boolean; route?: boolean; cells?: boolean };
const variants: V[] = [
  { name: 'Обычный навигатор (последняя точка GPS)', naive: true },
  { name: 'Тропа: шаги + компас + вышки, без маршрута', cells: true },
  { name: 'Тропа: шаги + компас + вышки + маршрут', cells: true, route: true },
];

function run(v: V) {
  seed = 777 + Number(process.env.SIMSEED || 0) * 1000;
  const eng = new NavEngine();
  if (v.route) eng.setRoute(ll);
  if (v.cells) eng.setCellDb(cellDb);
  const holdOffset = toRad(12);      // телефон держат чуть наискосок
  let magErr = 0;                    // помехи компаса, медленно меняются
  const speed = 1.35, cadence = 1.85; // м/с, шагов/с  -> шаг 0.73 м
  let s = 0, t = 0, nextStep = 0, naive: XY | null = null;
  const errs: number[][] = [[], [], []];
  const dt = 0.05;
  while (s < truthRoute.length - 10) {
    t += dt;
    const stop = t > 14 * MIN && t < 15 * MIN; // постояли на светофоре
    const vNow = stop ? 0 : speed * (1 + 0.05 * Math.sin(t / 30));
    s += vNow * dt;
    const { p: truth, bearing } = truthRoute.pointAt(s);
    if (!stop && t >= nextStep) { eng.onStep(t); nextStep = t + (vNow / speed) ** -1 / cadence + gauss() * 0.02; }
    if (stop) nextStep = t;
    const tick = Math.round(t / dt);
    eng.onGyro(t, gauss() * toRad(15)); // рука
    if (tick % 20 === 0) {
      eng.onMotion(t, Math.abs(gauss()), 0.8 + Math.abs(gauss()) * 0.3, 4 + Math.abs(gauss()) * 3);
      magErr = 0.97 * magErr + gauss() * toRad(3);
      eng.onAzimuth(t, bearing - holdOffset + magErr + gauss() * toRad(10));
      const ph = phase(t);
      if (ph !== 1) {
        const fix = frame.toLatLon({ x: truth.x + gauss() * 4, y: truth.y + gauss() * 4 });
        eng.onGps({ t, lat: fix.lat, lon: fix.lon, accuracy: 6, speed: vNow + gauss() * 0.2, bearing: vNow > 0.5 ? toDeg(bearing) + gauss() * 8 : null });
        naive = frame.toXY(fix);
      }
      if (v.cells && tick % 100 === 0) {
        const vis = towers.map((tw) => ({ tw, d: Math.hypot(tw.xy.x - truth.x, tw.xy.y - truth.y) }))
          .sort((a, b) => a.d - b.d).slice(0, 3)
          .map((o) => ({ ...o.tw.id, dbm: -60 - 20 * Math.log10(Math.max(50, o.d) / 50) + gauss() * 4 }));
        eng.onCells(t, vis);
      }
      const st = eng.getState(t);
      const est = v.naive ? naive : st.ready ? eng.xy : null;
      if (est) errs[ph].push(Math.hypot(est.x - truth.x, est.y - truth.y));
    }
  }
  return { errs, st: eng.getState(t), min: t / 60 };
}

const fmt = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return `${Math.round(m).toString().padStart(5)} м / ${Math.round(Math.max(...a)).toString().padStart(5)} м`;
};
console.log(`Прогулка ${(truthRoute.length / 1000).toFixed(1)} км, глушение с 8-й по 30-ю минуту. Ошибка «средняя / максимальная»:\n`);
for (const v of variants) {
  const r = run(v);
  console.log(`▶ ${v.name}`);
  console.log(`    GPS честный        ${fmt(r.errs[0])}`);
  console.log(`    ГЛУШЕНИЕ           ${fmt(r.errs[1])}`);
  console.log(`    GPS снова честный  ${fmt(r.errs[2])}`);
  if (!v.naive) console.log(`    режим: ${r.st.context}; выучил длину шага ${r.st.stepLen.toFixed(2)} м (правда 0.73)`);
  if (process.env.SUMMARY) console.log(`SUM|${v.name}|${(r.errs[1].reduce((a, b) => a + b, 0) / r.errs[1].length).toFixed(0)}|0|${Math.max(...r.errs[1]).toFixed(0)}`);
  console.log('');
}
