// Готовит базу вышек для телефона: из большой базы OpenCelliD (вся Россия)
// оставляет только вышки в коридоре вдоль маршрута.
//
//   node tools/build-cells.ts 250.csv.gz route.gpx cells.json [коридор_км=15]
//
// 250.csv.gz скачивается с opencellid.org (бесплатная регистрация -> токен ->
// Downloads -> Russian Federation, MCC 250). Формат: radio,mcc,net,area,cell,unit,lon,lat,range,...

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { LocalFrame } from '../src/core/geo.ts';
import { Route, parseGeoJson, parseGpx } from '../src/core/route.ts';

const [csvPath, routePath, outPath, corridorArg] = process.argv.slice(2);
if (!csvPath || !routePath || !outPath) {
  console.error('Использование: node tools/build-cells.ts 250.csv.gz route.gpx cells.json [коридор_км]');
  process.exit(1);
}
const corridor = (Number(corridorArg) || 15) * 1000;

const text = readFileSync(routePath, 'utf8');
const pts = /<gpx|<trkpt|<rtept/i.test(text) ? parseGpx(text) : parseGeoJson(text);
if (pts.length < 2) throw new Error('В файле маршрута нет линии');
const frame = new LocalFrame(pts[0]);
const route = new Route(pts, frame);

// Сетка 5 км: в какие клетки попадает коридор — для быстрого отсева
const CELL = 5000;
const grid = new Set<string>();
const r = Math.ceil(corridor / CELL);
for (let s = 0; s <= route.length; s += CELL / 2) {
  const { p } = route.pointAt(s);
  const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) grid.add(`${gx + dx}:${gy + dy}`);
}

const out: Record<string, [number, number, number]> = {};
let total = 0, kept = 0;
const input = csvPath.endsWith('.gz') ? createReadStream(csvPath).pipe(createGunzip()) : createReadStream(csvPath);
const rl = createInterface({ input, crlfDelay: Infinity });
for await (const line of rl) {
  const f = line.split(',');
  if (f.length < 9 || f[0] === 'radio') continue;
  total++;
  const lon = +f[6], lat = +f[7];
  if (!isFinite(lat) || !isFinite(lon)) continue;
  const p = frame.toXY({ lat, lon });
  if (!grid.has(`${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`)) continue;
  const proj = route.project(p, 0, route.length);
  if (!proj || Math.hypot(p.x - proj.point.x, p.y - proj.point.y) > corridor) continue;
  out[`${+f[1]}-${+f[2]}-${+f[3]}-${+f[4]}`] = [+lat.toFixed(5), +lon.toFixed(5), Math.round(+f[8] || 2000)];
  kept++;
}
writeFileSync(outPath, JSON.stringify(out));
console.log(`Всего вышек в базе: ${total}. Вдоль маршрута (±${corridor / 1000} км): ${kept}. Записано в ${outPath}`);
