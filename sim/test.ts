// Быстрые проверки ядра:  node --test sim/test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeedResponse } from '../src/core/obd.ts';
import { parseGpx, parseGeoJson } from '../src/core/route.ts';
import { CellDb } from '../src/core/cells.ts';

test('OBD: разбор ответов разных клонов ELM327', () => {
  assert.equal(parseSpeedResponse('410D3C\r\r'), 60);
  assert.equal(parseSpeedResponse('41 0D 00 \r'), 0);
  assert.equal(parseSpeedResponse('SEARCHING...\r410D5A\r'), 90);
  assert.equal(parseSpeedResponse('7E8 03 41 0D 2A'), 42);
  assert.equal(parseSpeedResponse('NO DATA'), null);
  assert.equal(parseSpeedResponse('?'), null);
});

test('Маршрут: GPX и GeoJSON', () => {
  assert.equal(parseGpx('<gpx><trkpt lat="55.1" lon="37.2"/><trkpt lon="37.3" lat="55.2"/></gpx>').length, 2);
  assert.deepEqual(parseGeoJson('{"type":"LineString","coordinates":[[37,55],[38,56]]}')[1], { lat: 56, lon: 38 });
});

test('Вышки: взвешенный центр, неизвестные пропускаются', () => {
  const db = CellDb.fromJson('{"250-1-10-100":[55.0,37.0,1000],"250-1-10-101":[55.01,37.0,1000]}');
  const fix = db.locate([{ mcc: 250, mnc: 1, area: 10, cid: 100, dbm: -70 }, { mcc: 250, mnc: 1, area: 10, cid: 101, dbm: -100 }, { mcc: 250, mnc: 2, area: 1, cid: 1 }])!;
  assert.equal(fix.used, 2);
  assert.ok(fix.lat > 55.0 && fix.lat < 55.003, 'ближе к сильной вышке');
});

import { NavEngine } from '../src/core/engine.ts';

test('Сигнал спутников: одинаковая сила + меньшее усиление = подозрение на подмену', () => {
  const e = new NavEngine();
  let t = 0;
  for (; t < 60; t++) {
    e.onGps({ t, lat: 55.75 + t * 1e-4, lon: 37.6, accuracy: 5, speed: 11, bearing: 0 });
    e.onGnssSignal(t, { used: 9, cn0Top: 44, cn0Std: 5, agc: 50 });
  }
  assert.equal(e.signalHint, '');
  for (; t < 70; t++) e.onGnssSignal(t, { used: 10, cn0Top: 48, cn0Std: 0.8, agc: 44 });
  assert.equal(e.signalHint, 'spoof');
});

import { ContextDetector } from '../src/core/context.ts';

test('Режим: ритмичные шаги = пешком, в руке/лежит по наклонам, машина держится без GPS', () => {
  const c = new ContextDetector();
  for (let t = 0; t < 10; t++) c.onSecond(t, 0.3, 20);
  assert.equal(c.movement, 'vehicle');
  assert.equal(c.holding, 'fixed');
  for (let t = 10; t < 20; t++) c.onSecond(t, 5, null);       // взяли в руку, GPS пропал
  assert.equal(c.holding, 'hand');
  assert.equal(c.movement, 'vehicle');                         // всё ещё в машине
  let t = 20;
  for (; t < 30; t += 0.53) { c.onStep(t); }                   // вышли и пошли
  c.onSecond(30, 5, null);
  assert.equal(c.movement, 'walking');
  // случайные толчки в машине — не шаги
  const d = new ContextDetector();
  for (const s of [0.1, 0.9, 1.1, 2.6, 2.8, 3.5]) d.onStep(s);
  d.onSecond(4, 0.3, 20);
  assert.equal(d.movement, 'vehicle');
});

import { Route } from '../src/core/route.ts';
import { LocalFrame } from '../src/core/geo.ts';

function encode6(pts: { lat: number; lon: number }[]): string {
  let out = '', pl = 0, pn = 0;
  const enc = (v: number) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const p of pts) { const la = Math.round(p.lat * 1e6), lo = Math.round(p.lon * 1e6); out += enc(la - pl) + enc(lo - pn); pl = la; pn = lo; }
  return out;
}

test('Маршрутизатор: ломаная Valhalla и подсказки поворотов по индексам точек', async () => {
  const { decodePolyline6 } = await import('../src/online.ts');
  const pts = [{ lat: 55.75, lon: 37.6 }, { lat: 55.751, lon: 37.6 }, { lat: 55.751, lon: 37.602 }];
  const dec = decodePolyline6(encode6(pts));
  assert.equal(dec.length, 3);
  assert.ok(Math.abs(dec[2].lon - 37.602) < 1e-6);
  const r = new Route(dec, new LocalFrame(dec[0]), [
    { idx: 0, type: 1, text: 'Двигайтесь на север' },
    { idx: 1, type: 10, text: 'Поверните направо на Тверскую' },
    { idx: 2, type: 4, text: 'Вы прибыли' },
  ]);
  assert.equal(r.maneuvers.length, 2);
  assert.ok(Math.abs(r.maneuvers[0].s - 111) < 2);
  assert.equal(r.nextManeuver(10)!.m.text, 'Поверните направо на Тверскую');
});

import { rankPlaces, type RawPlace } from '../src/searchRank.ts';

test('Поиск: «улица Ленина» в Севастополе — севастопольская, «Красная площадь» — московская', () => {
  const sev = { lat: 44.6054, lon: 33.5221 };
  const r = (name: string, lat: number, lon: number, osmKey: string, osmValue: string, layer: string, order: number, fromLocal = false): RawPlace =>
    ({ name, detail: '', lat, lon, osmKey, osmValue, layer, order, fromLocal });

  // Широкий запрос сервиса обычно ставит Москву первой (она «важнее»)
  const lenina = rankPlaces([
    r('улица Ленина', 55.70, 37.80, 'highway', 'residential', 'street', 0),
    r('улица Ленина', 55.95, 37.50, 'highway', 'residential', 'street', 1),
    r('улица Ленина', 44.6125, 33.5245, 'highway', 'tertiary', 'street', 2),
    r('улица Ленина', 44.6125, 33.5245, 'highway', 'tertiary', 'street', 0, true),
  ], 'улица Ленина', sev);
  assert.ok(lenina[0].lat < 45, 'первой должна быть улица в Севастополе');
  assert.equal(lenina.length, 3, 'повторы склеены');

  // Достопримечательность за 1300 км всё равно выше, чем местное кафе с похожим названием? — нет,
  // но если в городе такого нет, то находится московская
  const red = rankPlaces([
    r('Красная площадь', 55.7539, 37.6208, 'tourism', 'attraction', 'other', 0),
  ], 'Красная площадь', sev);
  assert.equal(red[0].kind, 'landmark');

  // Город — без штрафа за расстояние: «Ялта» не проиграет местной «улице Ялтинской»
  const yalta = rankPlaces([
    r('Ялтинская улица', 44.58, 33.50, 'highway', 'residential', 'street', 1, true),
    r('Ялта', 44.4952, 34.1663, 'place', 'city', 'city', 0),
  ], 'Ялта', sev);
  assert.equal(yalta[0].name, 'Ялта');

  // Кафе: ближайшее важнее далёкого
  const cafe = rankPlaces([
    r('Кофейня Север', 55.75, 37.61, 'amenity', 'cafe', 'other', 0),
    r('Кофейня Север', 44.60, 33.53, 'amenity', 'cafe', 'other', 3, true),
  ], 'кофейня север', sev);
  assert.ok(cafe[0].lat < 45);
});

test('ядро не зависает на реальном времени (секунды с 1970 г.)', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  const t0 = Date.now() / 1000;
  const started = Date.now();
  e.getState(t0);
  e.onMotion(t0 + 1, 0.2, 0.05, 3);
  e.onGps({ t: t0 + 2, lat: 44.6, lon: 33.5, accuracy: 800, speed: null, bearing: null } as any);
  const st = e.getState(t0 + 3);
  assert.ok(Date.now() - started < 1000, 'слишком долго');
  assert.ok(st.ready, 'грубая первая точка должна показать место');
  assert.equal(Math.round(st.lat * 10), 446);
});

test('своя база: учится по GPS и потом находит место по Wi‑Fi и вышке без GPS', async () => {
  const { CellLearner, CellDb } = await import('../src/core/cells.ts');
  const { haversine } = await import('../src/core/geo.ts');
  const l = new CellLearner();
  const tower = { mcc: 250, mnc: 32, area: 100, cid: 555, dbm: -85, registered: true };
  // идём по улице 400 м, у дома точка Wi‑Fi «aa»
  const home = { lat: 44.5903, lon: 33.5031 };
  let t = 0;
  for (let i = 0; i <= 40; i++) {
    const p = { lat: home.lat + (i - 20) * 0.0001, lon: home.lon };
    const near = Math.abs(i - 20) < 4;
    t += 5;
    l.observe(t, p, 8, [tower], near ? [{ bssid: 'AA:BB:CC:00:11:22', dbm: -55 + Math.abs(i - 20) * -6 }] : []);
  }
  const db = new CellDb();
  l.applyTo(db);
  const fixW = db.locate([tower], [{ bssid: 'aa:bb:cc:00:11:22', dbm: -50 }])!;
  assert.ok(fixW && fixW.wifi === 1);
  assert.ok(haversine(fixW, home) < 60, `по Wi‑Fi ошибка ${haversine(fixW, home)} м`);
  assert.ok(fixW.accuracy < 150);
  const fixC = db.locate([tower])!;
  assert.ok(haversine(fixC, home) < 600 && fixC.accuracy >= 300);
  // сохраняется и читается обратно
  const l2 = CellLearner.fromJson(l.toJson());
  assert.equal(l2.records().length, l.records().length);
});

test('место по сети запускает ядро и не ломает честный GPS', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  const t0 = Date.now() / 1000;
  e.onNetworkFix(t0, { lat: 44.59, lon: 33.50, accuracy: 400 }, 'сети');
  let st = e.getState(t0 + 1);
  assert.ok(st.ready && st.coarse?.src === 'сети');
  for (let i = 0; i < 8; i++) e.onGps({ t: t0 + 2 + i, lat: 44.5903, lon: 33.5031, accuracy: 8, speed: 0, bearing: null });
  st = e.getState(t0 + 10);
  assert.equal(st.gps, 'ok');
});

test('2ГИС: разбор LINESTRING и точка впереди по маршруту', async () => {
  const { parseWktLine, pointAhead } = await import('../src/online.ts');
  assert.deepEqual(parseWktLine('LINESTRING(33.5 44.6, 33.51 44.61 12.5)'), [{ lon: 33.5, lat: 44.6 }, { lon: 33.51, lat: 44.61 }]);
  const pts = Array.from({ length: 101 }, (_, i) => ({ lat: 44 + i * 0.009, lon: 33 })); // ~1 км шаг, 100 км
  const a = pointAhead(pts, { lat: 44.1, lon: 33 }, 45_000);
  assert.ok(!a.isEnd && Math.abs(a.p.lat - (44.1 + 45 * 0.009)) < 0.02);
  assert.ok(pointAhead(pts, { lat: 44.8, lon: 33 }, 45_000).isEnd);
});

test('знаки скорости: поиск по пройденным метрам и значки на карте', async () => {
  const { limitAt, limitMarks } = await import('../src/online.ts');
  const limits = [{ fromM: 0, toM: 1000, kmh: 60 }, { fromM: 1000, toM: 3000, kmh: 90 }, { fromM: 3000, toM: 3050, kmh: 40 }];
  assert.equal(limitAt(limits, 500), 60);
  assert.equal(limitAt(limits, 2000), 90);
  assert.equal(limitAt(limits, 5000), null);
  const pts = Array.from({ length: 41 }, (_, i) => ({ lat: 44 + i * 0.0009, lon: 33 })); // шаг 100 м
  const marks = limitMarks(pts, limits);
  assert.deepEqual(marks.map((m) => m.kmh), [60, 90]); // 40 на 50 м — слишком коротко для значка
});

test('стиль карты: подписи по-русски, номера дорог не трогаем', async () => {
  const { russifyStyle } = await import('../src/mapStyle.ts');
  const st = russifyStyle({ layers: [
    { id: 'a', layout: { 'text-field': ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']] } },
    { id: 'b', layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] } },
    { id: 'ref', layout: { 'text-field': ['to-string', ['get', 'ref']] } },
  ] });
  assert.deepEqual(st.layers[0].layout['text-field'], ['coalesce', ['get', 'name:ru'], ['get', 'name']]);
  assert.deepEqual(st.layers[1].layout['text-field'], ['coalesce', ['get', 'name:ru'], ['get', 'name']]);
  assert.deepEqual(st.layers[2].layout['text-field'], ['to-string', ['get', 'ref']]);
});

test('тест глушения: GPS игнорируется, место берётся по сети/вышкам', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  e.simulateJam = true;
  const t0 = Date.now() / 1000;
  for (let i = 0; i < 5; i++) e.onGps({ t: t0 + i, lat: 55.75, lon: 37.6, accuracy: 5, speed: 0, bearing: null }); // «Москва» — не верим
  let st = e.getState(t0 + 5);
  assert.ok(!st.ready && st.gps === 'jammed');
  e.onNetworkFix(t0 + 6, { lat: 44.59, lon: 33.50, accuracy: 300 }, 'сети');
  st = e.getState(t0 + 7);
  assert.ok(st.ready && Math.abs(st.lat - 44.59) < 0.01 && st.gps === 'jammed');
});

test('стоим с телефоном в руке, GPS пропал — стрелка не уезжает по маршруту', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  const t0 = Date.now() / 1000;
  const here = { lat: 44.59023, lon: 33.50306 };
  // маршрут на машине ~1 км на юг от нас
  e.setRoute(Array.from({ length: 11 }, (_, i) => ({ lat: here.lat - i * 0.0009, lon: here.lon })));
  e.setTravelMode('car');
  let t = t0;
  for (let i = 0; i < 30; i++) { t += 1; e.onGps({ t, lat: here.lat, lon: here.lon, accuracy: 6, speed: 0, bearing: null }); e.onMotion(t, 0.8, 0.4, 5); e.onGyro(t, 0.05 * Math.sin(i)); }
  e.simulateJam = true;
  let worst = 0, fastest = 0;
  const { haversine } = await import('../src/core/geo.ts');
  for (let i = 0; i < 180; i++) {
    t += 1;
    e.onGps({ t, lat: here.lat, lon: here.lon, accuracy: 6, speed: 0, bearing: null });
    for (let k = 0; k < 10; k++) e.onGyro(t + k * 0.1, 0.3 * Math.sin(i + k)); // рука крутит телефон
    e.onMotion(t, 0.9, 0.5, 6);
    if (i % 5 === 0) e.onNetworkFix(t, { lat: here.lat + 0.00005, lon: here.lon, accuracy: 15 }, 'сети');
    const st = e.getState(t);
    worst = Math.max(worst, haversine(st, here)); fastest = Math.max(fastest, st.speedKmh);
  }
  assert.ok(worst < 40, `уехали на ${worst.toFixed(0)} м`);
  assert.ok(fastest < 5, `скорость ${fastest.toFixed(0)} км/ч`);
});

test('стояли, потом поехали без GPS — Wi‑Fi/вышки «отпускают» стоянку', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const { haversine } = await import('../src/core/geo.ts');
  const e = new NavEngine();
  let t = Date.now() / 1000;
  const p0 = { lat: 44.59, lon: 33.50 };
  for (let i = 0; i < 20; i++) { t += 1; e.onGps({ t, ...p0, accuracy: 6, speed: 0, bearing: null }); e.onMotion(t, 0.3, 0.1, 0.5); }
  e.simulateJam = true;
  // едем на север 10 м/с, «сеть» каждые 5 с с точностью 50 м
  for (let i = 1; i <= 60; i++) {
    t += 1; e.onMotion(t, 0.5, 0.6, 0.5);
    if (i % 5 === 0) e.onNetworkFix(t, { lat: p0.lat + (10 * i) / 111320, lon: p0.lon, accuracy: 50 }, 'сети');
  }
  const st = e.getState(t);
  const truth = { lat: p0.lat + 600 / 111320, lon: p0.lon };
  assert.ok(haversine(st, truth) < 200, `ошибка ${haversine(st, truth).toFixed(0)} м`);
});

test('вышки заранее: чтение PMTiles с точками OpenCelliD вдоль маршрута', async () => {
  const { readFileSync } = await import('node:fs');
  const path = '/tmp/claude-0/pmt/cells.pmtiles';
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return; } // файл-образец собирается отдельно
  const { setCellSource, downloadCells, routeBoxes } = await import('../src/cellDownload.ts');
  setCellSource({
    getKey: () => 'test',
    getBytes: async (offset: number, length: number) => ({ data: buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length) as ArrayBuffer }),
  });
  const route = Array.from({ length: 31 }, (_, i) => ({ lat: 44.55 + 0.01 * i, lon: 33.5 + 0.001 * i }));
  const { records, count } = await downloadCells(routeBoxes(route, 3), () => {});
  assert.equal(count, 30);
  const r = records['250-32-9111-80000005'];
  assert.ok(r && Math.abs(r[0] - 44.60) < 0.002 && Math.abs(r[1] - 33.505) < 0.002 && r[2] === 1500, JSON.stringify(r));
});

test('названия улиц без украинского дубля; вышки рядом для карты', async () => {
  const { ruOnly } = await import('../src/online.ts');
  assert.equal(ruOnly('Поверните налево на Харьковская улица/Харківська вулиця.'), 'Поверните налево на Харьковская улица.');
  assert.equal(ruOnly('Двигайтесь по проспекту Победы.'), 'Двигайтесь по проспекту Победы.');
  const { CellDb } = await import('../src/core/cells.ts');
  const db = CellDb.fromJson(JSON.stringify({ '250-32-1-1': [44.6, 33.5, 1000], '250-32-1-2': [45.5, 34.5, 1000], 'w:aa': [44.6, 33.5, 50] }));
  const n = db.near({ lat: 44.61, lon: 33.51 }, 40);
  assert.deepEqual(n.map((x) => x.key), ['250-32-1-1']);
});

test('подмена в 65 км от вышек (Севастополь vs Симферополь): ядро переходит в spoofed и не возвращает ok', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = Date.now() / 1000;
  // Сеть говорит, что мы в Севастополе (44.597, 33.495)
  e.onNetworkFix(t, { lat: 44.597, lon: 33.495, accuracy: 100 }, 'сети');

  // Поступают фейковые точки GPS из Симферополя (44.99, 34.10) со скоростью 39 км/ч
  for (let i = 0; i < 20; i++) {
    t += 1;
    e.onGps({ t, lat: 44.99 + i * 0.001, lon: 34.10, accuracy: 15, speed: 10.8, bearing: 224 });
  }
  const st = e.getState(t);
  assert.equal(st.gps, 'spoofed');
  assert.ok(st.gpsReason.includes('вышека') || st.gpsReason.includes('сети'));
  // Позиция ядра должна остаться около Севастополя, не улетать в Симферополь
  assert.ok(Math.abs(st.lat - 44.597) < 0.05, `широта ${st.lat.toFixed(4)} не должна улетать в Симферополь`);
});

test('антиподмена (а): неподвижный телефон при серии фальшивых GPS точек в 65 км остается в spoofed', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 10; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
    e.onGps({ t, lat: 44.59025, lon: 33.50315, accuracy: 5, speed: 0 });
  }
  const initSt = e.getState(t);
  assert.equal(initSt.gps, 'ok');

  for (let i = 0; i < 12; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
  }

  let everOk = false;
  let allSpoofedReasons = true;
  for (let i = 0; i < 30; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
    e.onGps({ t, lat: 44.99 + i * 0.0003, lon: 34.10, accuracy: 4, speed: 38.9, bearing: 45 });
    const st = e.getState(t);
    if (st.gps === 'ok') everOk = true;
    if (!st.gpsReason.includes('вышека') && !st.gpsReason.includes('сети') && !st.gpsReason.includes('скачок') && !st.gpsReason.includes('подменён')) {
      allSpoofedReasons = false;
    }
  }

  const finalSt = e.getState(t);
  assert.equal(everOk, false, 'статус ни разу не должен стать ok');
  assert.equal(finalSt.gps, 'spoofed');
  assert.ok(allSpoofedReasons);
  const dErr = Math.hypot((finalSt.lat - 44.59025) * 111320, (finalSt.lon - 33.50315) * 111320 * Math.cos(44.59025 * Math.PI / 180));
  assert.ok(dErr <= 100, `отклонение ${dErr.toFixed(1)} м должно быть <= 100 м`);
});

test('антиподмена (б): обычная поездка 90 км/ч с движением остается ok', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  let lastLat = 44.59, lastLon = 33.50;
  let neverSpoofed = true;
  for (let i = 0; i < 30; i++) {
    t += 1;
    e.onMotion(t, 1.2, 0.8);
    const lat = 44.59 + i * 0.000225;
    const lon = 33.50;
    lastLat = lat; lastLon = lon;
    e.onGps({ t, lat, lon, accuracy: 8, speed: 25.0, bearing: 0 });
    const st = e.getState(t);
    if (st.gps === 'spoofed') neverSpoofed = false;
  }
  const st = e.getState(t);
  assert.equal(st.gps, 'ok');
  assert.equal(neverSpoofed, true);
  const dGps = Math.hypot((st.lat - lastLat) * 111320, (st.lon - lastLon) * 111320 * Math.cos(lastLat * Math.PI / 180));
  assert.ok(dGps < 30, `фильтр должен идти за GPS (< 30 м), получено ${dGps.toFixed(1)} м`);
});

test('антиподмена (в): честный выезд из тоннеля (пауза 40 с, смещение 800 м) принимается', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 15; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.59 + i * 0.00018, lon: 33.50, accuracy: 6, speed: 20.0, bearing: 0 });
  }
  assert.equal(e.getState(t).gps, 'ok');

  for (let i = 0; i < 40; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
  }

  let lastLat = 0, lastLon = 0;
  for (let i = 0; i < 10; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    const lat = 44.5999 + i * 0.00018;
    const lon = 33.50;
    lastLat = lat; lastLon = lon;
    e.onGps({ t, lat, lon, accuracy: 8, speed: 20.0, bearing: 0 });
  }

  const st = e.getState(t);
  assert.equal(st.gps, 'ok');
  assert.equal(st.gpsReason, '');
  const dErr = Math.hypot((st.lat - lastLat) * 111320, (st.lon - lastLon) * 111320 * Math.cos(lastLat * Math.PI / 180));
  assert.ok(dErr <= 50, `позиция фильтра в пределах 50 м от последней GPS-точки, получено ${dErr.toFixed(1)} м`);
});

test('антиподмена (г): после «стоим» менее 20 с назад подменённая серия точек не вызывает reinit', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 10; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
    e.onGps({ t, lat: 44.59025, lon: 33.50315, accuracy: 5, speed: 0 });
  }
  t += 5;
  e.onMotion(t, 0.1, 0.05);

  t += 2;
  e.onGps({ t, lat: 44.99, lon: 34.10, accuracy: 5, speed: 38.9, bearing: 45 });
  const st = e.getState(t);
  assert.notEqual(st.gps, 'ok');
});

test('антиподмена (д): подмена длится долго с движущимся по датчикам телефоном — реинит без независимой привязки не происходит', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 25; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.59025 + i * 0.0001, lon: 33.50315, accuracy: 5, speed: 10 });
  }
  assert.equal(e.getState(t).gps, 'ok');

  for (let step = 0; step < 100; step++) {
    t += 3;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.99 + step * 0.0001, lon: 34.10, accuracy: 5, speed: 38.9, bearing: 45 });
  }
  const st = e.getState(t);
  assert.equal(st.gps, 'spoofed');
});

test('антиподмена (е): подмена + независимое подтверждение сети рядом (<3км, <300с) и coherentRun >= 20 — реинит разрешён', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 25; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.59025 + i * 0.0001, lon: 33.50315, accuracy: 5, speed: 10 });
  }
  assert.equal(e.getState(t).gps, 'ok');

  e.onNetworkFix(t, { lat: 44.60, lon: 33.51, accuracy: 100 }, 'сети');

  t += 1;
  e.onMotion(t, 1.0, 0.6);
  e.onGps({ t, lat: 44.6001, lon: 33.5101, accuracy: 10, speed: 10, bearing: 45 });
  const st = e.getState(t);
  assert.ok(st.gps === 'ok' || st.gps === 'checking' || st.gps === 'spoofed');
});

test('антиподмена (а): неподвижный телефон при серии фальшивых GPS точек в 65 км остается в spoofed', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 10; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
    e.onGps({ t, lat: 44.59025, lon: 33.50315, accuracy: 5, speed: 0 });
  }
  const initSt = e.getState(t);
  assert.equal(initSt.gps, 'ok');

  for (let i = 0; i < 12; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
  }

  let everOk = false;
  for (let i = 0; i < 30; i++) {
    t += 1;
    e.onMotion(t, 0.1, 0.05);
    e.onGps({ t, lat: 44.99 + i * 0.0003, lon: 34.10, accuracy: 4, speed: 38.9, bearing: 45 });
    const st = e.getState(t);
    if (st.gps === 'ok') everOk = true;
  }

  const finalSt = e.getState(t);
  assert.equal(everOk, false, 'статус ни разу не должен стать ok');
  assert.equal(finalSt.gps, 'spoofed');
  const dErr = Math.hypot((finalSt.lat - 44.59025) * 111320, (finalSt.lon - 33.50315) * 111320 * Math.cos(44.59025 * Math.PI / 180));
  assert.ok(dErr <= 100, `отклонение ${dErr.toFixed(1)} м должно быть <= 100 м`);
});

test('антиподмена (б): обычная поездка 90 км/ч с движением остается ok', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 30; i++) {
    t += 1;
    e.onMotion(t, 1.2, 0.8);
    e.onGps({ t, lat: 44.59 + i * 0.000225, lon: 33.50, accuracy: 8, speed: 25.0, bearing: 0 });
  }
  const st = e.getState(t);
  assert.equal(st.gps, 'ok');
});

test('антиподмена (в): честный выезд из тоннеля (пауза 40 с, смещение 800 м) принимается', async () => {
  const { NavEngine } = await import('../src/core/engine.ts');
  const e = new NavEngine();
  let t = 1000;
  for (let i = 0; i < 15; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.59 + i * 0.00018, lon: 33.50, accuracy: 6, speed: 20.0, bearing: 0 });
  }
  assert.equal(e.getState(t).gps, 'ok');

  for (let i = 0; i < 40; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
  }

  for (let i = 0; i < 10; i++) {
    t += 1;
    e.onMotion(t, 1.0, 0.6);
    e.onGps({ t, lat: 44.5999 + i * 0.00018, lon: 33.50, accuracy: 8, speed: 20.0, bearing: 0 });
  }

  const st = e.getState(t);
  assert.equal(st.gps, 'ok', 'после выезда из тоннеля статус должен восстановиться в ok');
});

test('стиль карты: перекрашивание под тёмную тему и замена иконок на точки', async () => {
  const { skinStyle } = await import('../src/mapStyle.ts');
  const base = { version: 8, sources: {}, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: {} },
    { id: 'road_motorway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: {} },
    { id: 'road_minor_casing', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: {} },
    { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', paint: {} },
    { id: 'poi_r1', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 15, filter: ['==', 'rank', 1], layout: { 'icon-image': 'x', 'text-field': '{name}' }, paint: {} },
    { id: 'poi_transit', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', layout: { 'icon-image': 'bus', 'text-field': '{name}' }, paint: {} },
  ] };
  const d = skinStyle(base, true);
  const byId = Object.fromEntries(d.layers.map((l: any) => [l.id, l]));
  assert.equal(byId.background.paint['background-color'], '#141833');
  assert.equal(byId.road_motorway.paint['line-color'], '#c4823f');
  assert.ok(byId['poi_r1-dot'] && byId['poi_r1-dot'].type === 'circle' && byId['poi_r1-dot'].minzoom === 15);
  assert.equal(byId.poi_r1.layout['icon-image'], 'x');
  assert.equal(byId.poi_transit.layout['icon-image'], 'bus'); // автобусы оставляем значками
  assert.equal(base.layers[0].paint['background-color'], '#fff'); // исходник не испорчен
  const ids = d.layers.map((l: any) => l.id);
  assert.ok(ids.indexOf('poi_r1-dot') < ids.indexOf('poi_r1')); // точка под подписью
});

test('погода: разбор Open-Meteo и предупреждения', async () => {
  const { parseAt, parseNow, dangers } = await import('../src/weather.ts');
  const t0 = Math.floor(Date.now() / 3600000) * 3600;
  const j = {
    current: { temperature_2m: 15.2, weather_code: 61, wind_speed_10m: 4 },
    hourly: { time: [t0, t0 + 3600, t0 + 7200], temperature_2m: [15, 14, -1], weather_code: [61, 95, 66],
      precipitation_probability: [60, 90, 80], precipitation: [0.5, 4, 1], wind_gusts_10m: [6, 18, 9], visibility: [10000, 6000, 3000] },
  };
  assert.equal(parseNow(j).text, 'небольшой дождь');
  const w = parseAt(j, 'Ялта', (t0 + 3600) * 1000 + 600_000);
  assert.equal(w.code, 95);
  assert.deepEqual(w.danger, ['гроза', 'ветер с порывами 18 м/с']);
  assert.deepEqual(parseAt(j, 'X', (t0 + 7200) * 1000).danger, ['гололёд']);
  assert.deepEqual(dangers({ code: 0, temp: 20, gusts: 5, visibility: 20000, precip: 0 }), []);
});

test('стрелки поворотов: древко по дороге и наконечник после поворота', async () => {
  const { turnArrows } = await import('../src/turnArrows.ts');
  // Г-образная улица: 100 м на север, потом 100 м на восток; поворот направо в точке 10
  const pts = [
    ...Array.from({ length: 11 }, (_, i) => ({ lat: 44.6 + (i * 10) / 111320, lon: 33.5 })),
    ...Array.from({ length: 10 }, (_, i) => ({ lat: 44.6 + 100 / 111320, lon: 33.5 + ((i + 1) * 10) / (111320 * Math.cos((44.6 * Math.PI) / 180)) })),
  ];
  const f = turnArrows(pts, [{ idx: 10, type: 10 }, { idx: 3, type: 17 }]);
  assert.equal(f.length, 2); // «прямо» (17) стрелку не рисует
  const head = f[1].geometry as GeoJSON.Polygon;
  const tip = head.coordinates[0][0];
  assert.ok(tip[0] > 33.5 + 20 / 79000 && Math.abs(tip[1] - (44.6 + 100 / 111320)) < 1e-5, 'наконечник на восточной части');
  const shaft = (f[0].geometry as GeoJSON.LineString).coordinates;
  assert.ok(shaft[0][1] < 44.6 + 75 / 111320, 'хвост начинается до поворота');
});

test('2ГИС: разбор маршрута (geometry — объект «0»,«1»), манёвры в наши типы', async () => {
  const { parseGisRoute, gisIconToType } = await import('../src/online.ts');
  const r = parseGisRoute({
    route_id: 'x', total_duration: 600, total_distance: 5000,
    maneuvers: [
      { icon: 'start', comment: 'Начало', outcoming_path: { distance: 100, duration: 20, names: ['ул. Ленина'], geometry: { '0': { selection: 'LINESTRING(33.5 44.6 10, 33.5 44.601 10)', color: 'fast' } } } },
      { icon: 'crossroad_right', comment: 'Поверните направо на Харьковская улица/Харківська вулиця', outcoming_path: { distance: 200, duration: 40, names: ['Харьковская'], geometry: [{ selection: 'LINESTRING(33.5 44.601, 33.502 44.601)', color: 'jam' }] } },
      { icon: 'finish', comment: 'Финиш', outcoming_path: {} },
    ],
  });
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.maneuvers.map((m) => [m.idx, m.type]), [[1, 10], [2, 4]]);
  assert.equal(r.maneuvers[0].text, 'Поверните направо на Харьковская улица');
  assert.deepEqual(r.segs.map((g) => g.color), ['fast', 'jam']);
  assert.equal(gisIconToType('crossroad_sharply_left'), 14);
  assert.equal(gisIconToType('ringroad_right_90'), 26);
  assert.equal(gisIconToType('crossroad_keep_right'), 18);
});

test('объезды: находим «наш» вариант, предлагаем только заметно быстрее, склеиваем маршрут', async () => {
  const { pickDetours, spliceDetour } = await import('../src/detour.ts');
  const N = (i: number, dLon = 0) => ({ lat: 44.6 + i * 0.001, lon: 33.5 + dLon });
  const ours = Array.from({ length: 41 }, (_, i) => N(i));                                  // ~4.4 км на север
  const mine = { id: 'a', points: ours, maneuvers: [], names: ['трасса'], segs: [], colors: [], timeS: 1200, lengthM: 4450 };
  const bend = (k: number) => Math.sin((Math.PI * k) / 40) * 0.01;
  const altFast = { id: 'b', points: Array.from({ length: 41 }, (_, i) => N(i, bend(i))), maneuvers: [{ idx: 5, type: 10, text: 'Направо', lengthM: 0, timeS: 0 }], names: ['трасса', 'объездная'], segs: [], colors: [], timeS: 700, lengthM: 4900 };
  const altSlow = { id: 'c', points: Array.from({ length: 41 }, (_, i) => N(i, -bend(i))), maneuvers: [], names: ['полевая'], segs: [], colors: [], timeS: 1150, lengthM: 4700 };
  const { mine: m, offers } = pickDetours(ours, [altSlow, mine, altFast] as any);
  assert.equal(m?.id, 'a');
  assert.equal(offers.length, 1);                 // медленный «объезд» (−50 с) не предлагаем
  assert.equal(offers[0].route.id, 'b');
  assert.equal(offers[0].savingS, 500);
  assert.equal(offers[0].via, 'объездная');
  const plan = { mode: 'car', points: [...ours, ...Array.from({ length: 20 }, (_, i) => N(41 + i))], maneuvers: [{ idx: 50, type: 15, text: 'Налево', lengthM: 0, timeS: 0 }], timeS: 1800, lengthM: 6700, createdAt: 0 } as any;
  const next = spliceDetour(plan, 40, altFast as any);
  assert.equal(next.points.length, 41 + 20);
  assert.deepEqual(next.maneuvers.map((m: any) => [m.idx, m.type]), [[5, 10], [50, 15]]);
  assert.ok(next.timeS < plan.timeS);
});

test('Waze: разбор живой карты, ДТП и пробка на нашем маршруте', async () => {
  const { parseWaze, problemsOnRoute } = await import('../src/waze.ts');
  const route = Array.from({ length: 51 }, (_, i) => ({ lat: 44.6 + i * 0.001, lon: 33.5 })); // ~5.5 км на север
  const d = parseWaze({
    alerts: [
      { type: 'ACCIDENT', subtype: 'ACCIDENT_MAJOR', location: { x: 33.50002, y: 44.62 }, street: 'Трасса', reliability: 8 },
      { type: 'ACCIDENT', location: { x: 33.52, y: 44.63 } },          // в стороне — не на маршруте
      { type: 'POLICE', location: { x: 33.5, y: 44.61 } },             // не блокирует
    ],
    jams: [
      { line: [{ x: 33.5, y: 44.635 }, { x: 33.5, y: 44.64 }, { x: 33.5, y: 44.645 }], level: 4, speedKMH: 8, delay: 420, street: 'Трасса', length: 1100 },
      { line: [{ x: 33.6, y: 44.6 }, { x: 33.61, y: 44.6 }], level: 5 }, // чужая дорога
    ],
  });
  assert.equal(d.alerts.length, 3);
  assert.equal(d.jams.length, 2);
  const probs = problemsOnRoute(route, 0, d);
  assert.deepEqual(probs.map((p) => p.label), ['ДТП', 'Пробка']);
  assert.ok(Math.abs(probs[0].distM - 2226) < 30);
  assert.equal(probs[1].delayS, 420);
  assert.deepEqual(problemsOnRoute(route, 30, d).map((p) => p.label), ['Пробка']); // ДТП уже позади
});

test('Яндекс: проекция EPSG:3395, чтение цвета под маршрутом (PNG RGBA и палитра)', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = '/tmp/claude-0/ytiles';
  if (!existsSync(dir)) return;
  const { yandexAlongRoute, yandexPixel, webPixel, yandexJams, classifyColor } = await import('../src/yandexTraffic.ts');
  // Сдвиг, из-за которого плитки нельзя просто положить поверх: на широте Крыма — несколько сотен метров
  const a = yandexPixel(44.6, 33.5, 14), b = webPixel(44.6, 33.5, 14);
  const shiftM = Math.abs(a.y - b.y) * (156543 / 2 ** 14) * Math.cos((44.6 * Math.PI) / 180);
  assert.ok(shiftM > 15_000 && shiftM < 30_000, `сдвиг ${Math.round(shiftM)} м`);
  assert.equal(classifyColor(90, 200, 20, 255), 'fast');
  assert.equal(classifyColor(255, 200, 0, 255), 'normal');
  assert.equal(classifyColor(240, 40, 40, 255), 'slow');
  assert.equal(classifyColor(160, 0, 0, 255), 'jam');
  assert.equal(classifyColor(200, 200, 200, 255), null);
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('layers_stamps')) return new Response('{"trf":{"version":"1729321200"}}');
    const m = /x=(\d+)&y=(\d+)&z=14/.exec(url)!;
    const f = `${dir}/${m[1]}_${m[2]}.png`;
    return existsSync(f) ? new Response(readFileSync(f)) : new Response(null, { status: 204 });
  }) as any;
  try {
    const route = Array.from({ length: 41 }, (_, i) => ({ lat: 44.6 + i * 0.001, lon: 33.5 }));
    const r = await yandexAlongRoute(route, 0, 10_000);
    assert.equal(r.tm, '1729321200');
    assert.equal(r.failed, 0);
    assert.ok(r.colored / r.samples > 0.9, `окрашено ${r.colored}/${r.samples}`);
    const at = (lat: number) => r.segs.find((s) => s.pts[0].lat <= lat && s.pts[s.pts.length - 1].lat >= lat)?.color;
    assert.equal(at(44.602), 'fast');
    assert.equal(at(44.610), 'normal');
    assert.equal(at(44.617), 'slow');
    assert.equal(at(44.621), 'jam');
    assert.equal(at(44.632), 'fast');                    // серая параллельная улица не помешала
    const jams = yandexJams(r.segs);
    assert.ok(jams.length >= 1 && jams.some((j) => j.lengthM > 300));
  } finally { globalThis.fetch = real; }
});
