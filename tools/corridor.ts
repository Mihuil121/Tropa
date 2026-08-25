// Делает область вдоль маршрута для вырезки офлайн-карты.
//
//   node tools/corridor.ts route.gpx corridor.geojson [ширина_км=10]
//   pmtiles extract https://build.protomaps.com/<дата>.pmtiles map.pmtiles --region=corridor.geojson
//
// Карта только коридора весит в разы меньше карты целых областей.

import { readFileSync, writeFileSync } from 'node:fs';
import { LocalFrame } from '../src/core/geo.ts';
import { Route, parseGeoJson, parseGpx } from '../src/core/route.ts';

const [routePath, outPath, widthArg] = process.argv.slice(2);
if (!routePath || !outPath) {
  console.error('Использование: node tools/corridor.ts route.gpx corridor.geojson [ширина_км]');
  process.exit(1);
}
const half = (Number(widthArg) || 10) * 1000;
const text = readFileSync(routePath, 'utf8');
const pts = /<gpx|<trkpt|<rtept/i.test(text) ? parseGpx(text) : parseGeoJson(text);
const frame = new LocalFrame(pts[0]);
const route = new Route(pts, frame);

// Покрываем маршрут квадратами сетки (размер = ширина коридора) и сливаем их в MultiPolygon
const S = half;
const cells = new Set<string>();
for (let s = 0; s <= route.length; s += S / 3) {
  const { p } = route.pointAt(s);
  const gx = Math.floor(p.x / S), gy = Math.floor(p.y / S);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(`${gx + dx}:${gy + dy}`);
}
const polys = [...cells].map((k) => {
  const [gx, gy] = k.split(':').map(Number);
  const c = [[gx, gy], [gx + 1, gy], [gx + 1, gy + 1], [gx, gy + 1], [gx, gy]].map(([x, y]) => {
    const ll = frame.toLatLon({ x: x * S, y: y * S });
    return [+ll.lon.toFixed(5), +ll.lat.toFixed(5)];
  });
  return [c];
});
writeFileSync(outPath, JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } }));
console.log(`Маршрут ${(route.length / 1000).toFixed(0)} км, квадратов ${cells.size} (по ${S / 1000} км). Записано в ${outPath}`);
