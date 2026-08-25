// Индекс поиска адресов для области (search.json) — из выгрузки OSM в GeoJSONSeq.
//
//   osmium tags-filter region.osm.pbf nwr/name nwr/addr:housenumber -o named.osm.pbf --overwrite
//   osmium export named.osm.pbf -f geojsonseq -o named.geojsonseq --overwrite
//   node tools/build-search-index.ts named.geojsonseq search.json
//
// Что попадает: населённые пункты, улицы (по одной записи на улицу в каждом месте),
// места с названием (магазины, кафе, аптеки, АЗС, вокзалы, музеи…), дома с адресом.

import fs from 'node:fs';
import readline from 'node:readline';

type Item = [string, string, number, number, string, string];

const KEYS = ['place', 'amenity', 'shop', 'tourism', 'leisure', 'historic', 'railway', 'aeroway', 'office', 'healthcare', 'craft', 'public_transport', 'natural', 'building'];
const PLACE_OK = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'locality', 'isolated_dwelling', 'island']);
const STREET = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service|road|track)$/;

/** Центр геометрии (среднее вершин — для поиска хватает). */
function center(g: any): [number, number] | null {
  if (!g) return null;
  let sx = 0, sy = 0, n = 0;
  const walk = (c: any) => {
    if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; return; }
    for (const x of c) walk(x);
  };
  walk(g.coordinates);
  return n ? [+(sy / n).toFixed(5), +(sx / n).toFixed(5)] : null; // lat, lon
}

const ruName = (t: Record<string, string>) => t['name:ru'] || t.name;

export async function buildIndex(lines: AsyncIterable<string> | Iterable<string>) {
  const places: { name: string; lat: number; lon: number; rank: number }[] = [];
  const pois: Item[] = [];
  const streetsRaw = new Map<string, [number, number][]>();
  const housesRaw: { street: string; hn: string; lat: number; lon: number; city?: string }[] = [];

  for await (const raw of lines as AsyncIterable<string>) {
    const line = raw.replace(/^\x1e/, '').trim(); // GeoJSONSeq: записи могут начинаться с RS
    if (!line) continue;
    let f: any;
    try { f = JSON.parse(line); } catch { continue; }
    const t: Record<string, string> = f.properties ?? {};
    const c = center(f.geometry);
    if (!c) continue;
    const [lat, lon] = c;
    const name = ruName(t);

    if (t['addr:housenumber'] && t['addr:street']) {
      housesRaw.push({ street: t['addr:street'], hn: t['addr:housenumber'], lat, lon, city: t['addr:city'] });
      if (!name) continue;
    }
    if (!name) continue;
    if (t.place && PLACE_OK.has(t.place)) {
      const rank = t.place === 'city' ? 4 : t.place === 'town' ? 3 : t.place === 'village' ? 2 : 1;
      places.push({ name, lat, lon, rank });
      pois.push([name, '', lat, lon, 'place', t.place]);
      continue;
    }
    if (t.highway && STREET.test(t.highway)) {
      const arr = streetsRaw.get(name) ?? [];
      arr.push([lat, lon]);
      streetsRaw.set(name, arr);
      continue;
    }
    const key = KEYS.find((k) => t[k] && t[k] !== 'yes' || (k === 'building' && t[k]));
    if (!key || key === 'building') continue; // здания без «смысла» не берём (дома — через адрес)
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
    pois.push([name, addr, lat, lon, key, t[key]]);
  }

  // Ближайший населённый пункт — подпись к улицам и домам (сетка 0.2°, чтобы не перебирать всё)
  const grid = new Map<string, typeof places>();
  const gk = (lat: number, lon: number) => `${Math.floor(lat / 0.2)}:${Math.floor(lon / 0.2)}`;
  for (const p of places) { const k = gk(p.lat, p.lon); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  const cityOf = (lat: number, lon: number): string => {
    let best = '', bd = Infinity;
    const y = Math.floor(lat / 0.2), x = Math.floor(lon / 0.2);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const p of grid.get(`${y + dy}:${x + dx}`) ?? []) {
        const d = ((p.lat - lat) ** 2 + ((p.lon - lon) * 0.7) ** 2) / (p.rank * p.rank); // город «притягивает» сильнее деревни
        if (d < bd) { bd = d; best = p.name; }
      }
    }
    return best;
  };

  // Улицы: куски одной улицы склеиваем, если они ближе ~1,5 км (иначе это улицы в разных местах)
  const items: Item[] = [...pois];
  for (const [name, pts] of streetsRaw) {
    const clusters: { lat: number; lon: number; n: number }[] = [];
    for (const [lat, lon] of pts) {
      const c = clusters.find((k) => Math.abs(k.lat - lat) < 0.014 && Math.abs(k.lon - lon) < 0.02);
      if (c) { c.lat = (c.lat * c.n + lat) / (c.n + 1); c.lon = (c.lon * c.n + lon) / (c.n + 1); c.n++; }
      else clusters.push({ lat, lon, n: 1 });
    }
    for (const c of clusters) items.push([name, cityOf(c.lat, c.lon), +c.lat.toFixed(5), +c.lon.toFixed(5), 'highway', 'residential']);
  }
  for (const it of items) if (!it[1] && it[4] !== 'place') it[1] = cityOf(it[2], it[3]);

  // Дома по улицам
  const cities: string[] = [];
  const cityIdx = new Map<string, number>();
  const ci = (name: string) => { let i = cityIdx.get(name); if (i === undefined) { i = cities.length; cities.push(name); cityIdx.set(name, i); } return i; };
  const houses: Record<string, [string, number, number, number][]> = {};
  const seen = new Set<string>();
  for (const h of housesRaw) {
    const key = `${h.street}|${h.hn}|${h.lat.toFixed(3)}|${h.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (houses[h.street] ??= []).push([h.hn, h.lat, h.lon, ci(h.city || cityOf(h.lat, h.lon))]);
  }
  return { v: 1 as const, items, cities, houses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('node tools/build-search-index.ts named.geojsonseq search.json'); process.exit(1); }
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  const idx = await buildIndex(rl);
  fs.writeFileSync(output, JSON.stringify(idx));
  const houses = Object.values(idx.houses).reduce((a, h) => a + h.length, 0);
  console.log(`search.json: мест и улиц ${idx.items.length}, домов ${houses}, ${(fs.statSync(output).size / 1e6).toFixed(1)} МБ`);
}
