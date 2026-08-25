// Прокладывает маршрут по названиям и сохраняет его в GPX (для подготовки вышек на компьютере).
//   node tools/plan-route.ts "Севастополь" "Москва" route.gpx
import { writeFileSync } from 'node:fs';
import { planRoute, searchPlaces } from '../src/online.ts';

const [from, to, out = 'route.gpx'] = process.argv.slice(2);
if (!from || !to) { console.error('Использование: node tools/plan-route.ts "Откуда" "Куда" route.gpx'); process.exit(1); }

async function place(q: string) {
  const m = /^\s*(-?\d+(\.\d+)?)\s*[, ]\s*(-?\d+(\.\d+)?)\s*$/.exec(q); // можно и координаты «44.6, 33.5»
  if (m) return { name: q, lat: +m[1], lon: +m[3] };
  const r = await searchPlaces(q);
  const p = r.find((x) => x.kind === 'settlement') ?? r[0];
  if (!p) throw new Error(`Не нашёл «${q}»`);
  return p;
}

const a = await place(from), b = await place(to);
console.log(`Откуда: ${a.name} (${a.lat.toFixed(4)}, ${a.lon.toFixed(4)})\nКуда:   ${b.name} (${b.lat.toFixed(4)}, ${b.lon.toFixed(4)})`);
const r = await planRoute(a, b, 'car');
const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Tropa"><trk><name>${from} — ${to}</name><trkseg>\n` +
  r.points.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"/>`).join('\n') + '\n</trkseg></trk></gpx>\n';
writeFileSync(out, gpx);
console.log(`Маршрут: ${(r.lengthM / 1000).toFixed(0)} км, ~${Math.round(r.timeS / 3600)} ч. Записан в ${out}`);
