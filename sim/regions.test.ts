// Этап 2: области без интернета, встроенный Valhalla, офлайн-поиск.  node --test sim/regions.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseOf, parseManifest, regionFor, fmtBytes, type InstalledRegion } from '../src/regionsCore.ts';
import { prepare, searchIndex, norm } from '../src/offlineSearch.ts';
import { buildIndex } from '../tools/build-search-index.ts';
import { buildManifest } from '../tools/build-manifest.ts';
import { planRoute, setDeviceRouter, setOfflineSearch, searchPlaces, fetchSpeedLimits } from '../src/online.ts';
import { resetHostHealth } from '../src/net.ts';

test('manifest: относительные ссылки, битые записи пропускаются, база вышек', () => {
  const base = baseOf('https://storage.yandexcloud.net/tropa-data');
  assert.equal(base, 'https://storage.yandexcloud.net/tropa-data/');
  assert.equal(baseOf('https://x.ru/d/manifest.json'), 'https://x.ru/d/');
  const m = parseManifest({
    version: 1, updated: '2026-10-20', cells: 'cellid.pmtiles',
    regions: [
      { id: 'crimea', name: 'Крым', bbox: [32.4, 44.35, 36.7, 46.25], map: { url: 'crimea/map.pmtiles', bytes: 120e6 }, roads: { url: 'https://cdn.example/crimea.tar', bytes: 80e6 } },
      { id: 'bad', name: 'Без рамки', map: { url: 'x' } },
      { id: 'empty', name: 'Без файлов', bbox: [1, 2, 3, 4] },
    ],
  }, base);
  assert.equal(m.regions.length, 1);
  assert.equal(m.regions[0].map!.url, 'https://storage.yandexcloud.net/tropa-data/crimea/map.pmtiles');
  assert.equal(m.regions[0].roads!.url, 'https://cdn.example/crimea.tar');
  assert.equal(m.regions[0].version, '2026-10-20');
  assert.equal(m.cells, 'https://storage.yandexcloud.net/tropa-data/cellid.pmtiles');
  assert.equal(fmtBytes(80e6), '80 МБ');
  assert.equal(fmtBytes(2.4e9), '2,4 ГБ');
});

test('выбор области: все точки внутри, нужная часть есть, берётся меньшая', () => {
  const inst: InstalledRegion[] = [
    { id: 'south', name: 'Юг', bbox: [30, 43, 42, 48], files: { roads: '/r/south.tar' }, installedAt: 0 },
    { id: 'crimea', name: 'Крым', bbox: [32.4, 44.35, 36.7, 46.25], files: { roads: '/r/crimea.tar', map: '/r/crimea.pmtiles' }, installedAt: 0 },
  ];
  const sev = { lat: 44.6, lon: 33.52 }, yalta = { lat: 44.5, lon: 34.17 }, krasnodar = { lat: 45.04, lon: 38.98 };
  assert.equal(regionFor(inst, 'roads', [sev, yalta])!.id, 'crimea');
  assert.equal(regionFor(inst, 'roads', [sev, krasnodar])!.id, 'south');
  assert.equal(regionFor(inst, 'map', [krasnodar]), null);
  assert.equal(regionFor(inst, 'roads', [{ lat: 55.75, lon: 37.6 }]), null);
});

// Небольшая выгрузка OSM «как из osmium export»
const RS = '\x1e';
const feats = [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [33.5225, 44.6166] }, properties: { place: 'city', name: 'Севастополь' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [34.1667, 44.4952] }, properties: { place: 'town', name: 'Ялта' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[33.52, 44.60], [33.523, 44.602]] }, properties: { highway: 'residential', name: 'улица Ленина' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[33.523, 44.602], [33.526, 44.604]] }, properties: { highway: 'residential', name: 'улица Ленина' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[34.16, 44.49], [34.165, 44.492]] }, properties: { highway: 'tertiary', name: 'улица Ленина' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [33.521, 44.601] }, properties: { 'addr:street': 'улица Ленина', 'addr:housenumber': '5Б' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [33.522, 44.6015] }, properties: { 'addr:street': 'улица Ленина', 'addr:housenumber': '50' } },
  { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[33.53, 44.61], [33.531, 44.61], [33.531, 44.611], [33.53, 44.61]]] }, properties: { amenity: 'pharmacy', name: 'Аптека Здоровье', building: 'yes' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [33.55, 44.57] }, properties: { railway: 'station', name: 'Севастополь', 'name:ru': 'Вокзал Севастополь' } },
];

test('индекс поиска: города, улица по разу на место, места, дома по улицам', async () => {
  const idx = await buildIndex(feats.map((f) => RS + JSON.stringify(f)));
  const lenina = idx.items.filter((i) => i[0] === 'улица Ленина');
  assert.equal(lenina.length, 2, 'Севастопольская (из двух кусков) и ялтинская');
  assert.deepEqual(lenina.map((i) => i[1]).sort(), ['Севастополь', 'Ялта']);
  assert.ok(idx.items.some((i) => i[0] === 'Аптека Здоровье' && i[4] === 'amenity'));
  assert.ok(idx.items.some((i) => i[0] === 'Вокзал Севастополь'), 'русское имя приоритетно');
  assert.equal(idx.houses['улица Ленина'].length, 2);
  assert.equal(idx.cities[idx.houses['улица Ленина'][0][3]], 'Севастополь');
});

test('офлайн-поиск: «ул. Ленина 5б», «ленина», «аптека», ё=е', async () => {
  const p = prepare(await buildIndex(feats.map((f) => JSON.stringify(f))));
  const h = searchIndex(p, 'ул. Ленина, 5б');
  assert.equal(h[0].name, 'улица Ленина, 5Б');
  assert.equal(h[0].detail, 'Севастополь');
  assert.ok(searchIndex(p, 'ленина 5').slice(0, 2).every((x) => /5/.test(x.name)));
  assert.equal(searchIndex(p, 'Ленина').filter((x) => x.name === 'улица Ленина').length, 2);
  assert.equal(searchIndex(p, 'аптека')[0].name, 'Аптека Здоровье');
  assert.equal(norm('Ёлочная ул.'), 'елочная ул');
  assert.equal(searchIndex(p, 'улица').length, 0, 'одно служебное слово — ничего');
});

test('manifest из папки областей', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tropa-'));
  fs.mkdirSync(path.join(dir, 'crimea'));
  fs.writeFileSync(path.join(dir, 'crimea', 'region.json'), JSON.stringify({ id: 'crimea', name: 'Крым', bbox: [32.4, 44.35, 36.7, 46.25] }));
  fs.writeFileSync(path.join(dir, 'crimea', 'valhalla.tar'), Buffer.alloc(1234));
  fs.writeFileSync(path.join(dir, 'crimea', 'search.json'), '{}');
  fs.writeFileSync(path.join(dir, 'cellid.pmtiles'), 'x');
  const m = buildManifest(dir, '2026-10-23');
  assert.equal(m.regions.length, 1);
  assert.deepEqual(m.regions[0].roads, { url: 'crimea/valhalla.tar', bytes: 1234 });
  assert.equal(m.regions[0].map, undefined);
  assert.equal(m.cells, 'cellid.pmtiles');
  const parsed = parseManifest(m, 'https://s/');
  assert.equal(parsed.regions[0].search!.url, 'https://s/crimea/search.json');
});

// Ответ Valhalla /route (как от сервера и от встроенного движка — формат одинаковый)
const trip = {
  trip: {
    summary: { time: 300, length: 2.5 },
    legs: [{
      shape: '_kdatA_ut{~@_af@_af@', // две точки
      maneuvers: [
        { type: 1, instruction: 'Двигайтесь на север.', length: 2.5, time: 300, begin_shape_index: 0 },
        { type: 4, instruction: 'Вы прибыли.', length: 0, time: 0, begin_shape_index: 1 },
      ],
    }],
  },
};

test('встроенный Valhalla: маршрут без сети, тот же JSON, что у сервера', async () => {
  resetHostHealth();
  const calls: string[] = [];
  setDeviceRouter(async (kind, pts, body: any) => {
    calls.push(kind);
    assert.equal(body.costing, 'auto');
    assert.equal(body.language, 'ru-RU');
    assert.ok(pts.length >= 2);
    return trip;
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('сеть не нужна'); }) as any;
  try {
    const t0 = Date.now();
    const r = await planRoute({ lat: 44.6, lon: 33.5 }, { lat: 44.62, lon: 33.52 }, 'car');
    assert.ok(r.onDevice);
    assert.equal(r.maneuvers[0].text, 'Двигайтесь на север.');
    assert.ok(Date.now() - t0 < 500, 'мгновенно, без ожидания серверов');
    assert.deepEqual(calls, ['route']);
  } finally {
    globalThis.fetch = realFetch;
    setDeviceRouter(null);
  }
});

test('встроенный Valhalla: нет области (null) → дальше онлайн-цепочка', async () => {
  resetHostHealth();
  setDeviceRouter(async () => null);
  const realFetch = globalThis.fetch;
  let online = 0;
  globalThis.fetch = (async (url: string) => {
    online++;
    if (String(url).includes('valhalla')) return new Response(JSON.stringify(trip), { status: 200 });
    return new Response('{}', { status: 502 });
  }) as any;
  try {
    const r = await planRoute({ lat: 44.6, lon: 33.5 }, { lat: 44.62, lon: 33.52 }, 'walk');
    assert.ok(!r.onDevice && online > 0);
  } finally { globalThis.fetch = realFetch; setDeviceRouter(null); }
});

test('знаки скорости: сначала встроенный Valhalla', async () => {
  resetHostHealth();
  setDeviceRouter(async (kind) => (kind === 'trace' ? { edges: [{ speed_limit: 60, begin_shape_index: 0, end_shape_index: 1, road_class: 'primary' }] } : null));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('сеть не нужна'); }) as any;
  try {
    const lim = await fetchSpeedLimits([{ lat: 44.6, lon: 33.5 }, { lat: 44.61, lon: 33.5 }]);
    assert.equal(lim[0].kmh, 60);
  } finally { globalThis.fetch = realFetch; setDeviceRouter(null); }
});

test('поиск: онлайн молчит — находим по скачанной области', async () => {
  resetHostHealth();
  const p = prepare(await buildIndex(feats.map((f) => JSON.stringify(f))));
  setOfflineSearch(async (q) => searchIndex(p, q));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 503 })) as any;
  try {
    const r = await searchPlaces('Ленина 5Б', { lat: 44.6, lon: 33.52 });
    assert.equal(r[0].name, 'улица Ленина, 5Б');
  } finally { globalThis.fetch = realFetch; setOfflineSearch(null); }
});

test('manifest для GitHub Releases: плоские имена, размеры из списка ассетов', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tropa-rel-'));
  fs.writeFileSync(path.join(dir, 'crimea-region.json'), JSON.stringify({ id: 'crimea', name: 'Крым', bbox: [32.4, 44.35, 36.7, 46.25], version: '2026-10-23' }));
  const sizes = { 'crimea-map.pmtiles': 150e6, 'crimea-valhalla.tar': 90e6, 'crimea-search.json': 9e6, 'cellid.pmtiles': 530e6, 'crimea-region.json': 100 };
  const m = buildManifest(dir, '2026-10-23', sizes);
  assert.equal(m.regions[0].map.url, 'crimea-map.pmtiles');
  assert.equal(m.regions[0].roads.bytes, 90e6);
  assert.equal(m.cells, 'cellid.pmtiles');
  const parsed = parseManifest(m, baseOf('https://github.com/me/tropa/releases/download/data'));
  assert.equal(parsed.regions[0].roads!.url, 'https://github.com/me/tropa/releases/download/data/crimea-valhalla.tar');
});
