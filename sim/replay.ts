// Прогон настоящего журнала поездки через ядро — чтобы подбирать настройки на реальных данных.
//
//   node sim/replay.ts trip.jsonl [route.gpx] [cells.json] > track.gpx
//
// Журнал телефон пишет сам: папка приложения tropa/logs/*.jsonl.
// На выходе — GPX с двумя треками: «как вёл навигатор» и «что говорил GPS» (открывается в любом картографе).

import { readFileSync } from 'node:fs';
import { NavEngine } from '../src/core/engine.ts';
import { CellDb } from '../src/core/cells.ts';
import { parseGeoJson, parseGpx } from '../src/core/route.ts';

const [logPath, routePath, cellsPath] = process.argv.slice(2);
if (!logPath) { console.error('Использование: node sim/replay.ts trip.jsonl [route.gpx] [cells.json]'); process.exit(1); }

const eng = new NavEngine();
if (routePath) {
  const t = readFileSync(routePath, 'utf8');
  eng.setRoute(/<gpx|<trkpt|<rtept/i.test(t) ? parseGpx(t) : parseGeoJson(t));
}
if (cellsPath) eng.setCellDb(CellDb.fromJson(readFileSync(cellsPath, 'utf8')));

const fused: string[] = [], raw: string[] = [];
let lastOut = 0, lastStatus = '';
const iso = (t: number) => new Date(t * 1000).toISOString();
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const ev = JSON.parse(line);
  if (ev.e === 'gps') { eng.onGps(ev); raw.push(`<trkpt lat="${ev.lat}" lon="${ev.lon}"><time>${iso(ev.t)}</time></trkpt>`); }
  if (ev.e === 'obd') eng.onObd(ev.t, ev.kmh);
  if (ev.e === 'gyro') eng.onGyro(ev.t, ev.r);
  if (ev.e === 'cells') eng.onCells(ev.t, ev.cells);
  if (ev.e === 'motion') eng.onMotion(ev.t, ev.aH, ev.vib, ev.tilt ?? 0);
  if (ev.e === 'step') eng.onStep(ev.t);
  if (ev.e === 'az') eng.onAzimuth(ev.t, ev.az);
  if (ev.e === 'gnss') eng.onGnssSignal(ev.t, ev);
  if (ev.e === 'manual') eng.manualFix(ev.t, ev.lat, ev.lon);
  if (ev.e === 'turnNow') eng.snapToManeuver(ev.t);
  if (ev.t - lastOut >= 1) {
    lastOut = ev.t;
    const s = eng.getState(ev.t);
    if (s.ready) fused.push(`<trkpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}"><time>${iso(ev.t)}</time></trkpt>`);
    const st = `${s.gps} | ${s.mode}`;
    if (st !== lastStatus) { console.error(`${iso(ev.t)}  GPS: ${s.gps} ${s.gpsReason}  | ${s.mode}  ±${Math.round(s.sigma)} м`); lastStatus = st; }
  }
}
console.log(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="tropa-replay">` +
  `<trk><name>Навигатор</name><trkseg>${fused.join('')}</trkseg></trk>` +
  `<trk><name>Сырой GPS</name><trkseg>${raw.join('')}</trkseg></trk></gpx>`);
