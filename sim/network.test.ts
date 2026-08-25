// Тесты сетевой части и офлайн-маршрутизатора: node --test sim/network.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchText, firstOk, isHostBad, resetHostHealth, TimeoutError } from '../src/net.ts';
import { buildGraph, loadGraph, route, corridorBoxes, turnsAlong, graphPathToPlannedRoute } from '../src/offlineRouter.ts';

/** Сервер, который отдаёт заголовки и начало ответа, а потом «замирает» (как ТСПУ после ~16 КБ). */
function stallingServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const socks = new Set<any>();
    const srv = http.createServer((req, res) => {
      if (req.url?.startsWith('/ok')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"trip":'.padEnd(16 * 1024, ' ')); // и больше ничего
    });
    srv.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as any;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => { socks.forEach((s) => s.destroy()); srv.close(); } });
    });
  });
}

test('таймаут действует на чтение тела: замерший ответ не висит вечно', async () => {
  resetHostHealth();
  const s = await stallingServer();
  const t0 = Date.now();
  await assert.rejects(fetchText(`${s.url}/stall`, { timeoutMs: 600, markBad: true }), (e: any) => e instanceof TimeoutError);
  assert.ok(Date.now() - t0 < 2000, 'должно оборваться по таймауту');
  assert.ok(isHostBad(`${s.url}/x`), 'сервер помечен молчащим');
  s.close();
});

test('отмена снаружи прерывает чтение тела', async () => {
  resetHostHealth();
  const s = await stallingServer();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(fetchText(`${s.url}/stall`, { timeoutMs: 10_000, signal: ctrl.signal }), (e: any) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 1500);
  s.close();
});

test('firstOk: молчащий сервер не держит — отвечает следующий, потом молчащий пропускается', async () => {
  resetHostHealth();
  const calls: string[] = [];
  const hang = (label: string) => ({ label, host: `${label}.test`, run: (sig: AbortSignal) => { calls.push(label); return new Promise<string>((_, rej) => sig.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })); } });
  const ok = (label: string, ms: number) => ({ label, host: `${label}.test`, run: async () => { calls.push(label); await new Promise((r) => setTimeout(r, ms)); return label; } });
  const t0 = Date.now();
  const v = await firstOk([hang('a'), ok('b', 50)], { staggerMs: 300, budgetMs: 5000 });
  assert.equal(v, 'b');
  assert.ok(Date.now() - t0 < 1000, 'ответ после stagger, а не после таймаута');

  // упавший быстро — следующий стартует сразу, не ждёт stagger
  const t1 = Date.now();
  const v2 = await firstOk([{ label: 'x', run: async () => { throw new Error('502'); } }, ok('y', 10)], { staggerMs: 5000, budgetMs: 8000 });
  assert.equal(v2, 'y');
  assert.ok(Date.now() - t1 < 500);

  // общий бюджет
  await assert.rejects(firstOk([hang('c'), hang('d')], { staggerMs: 50, budgetMs: 300 }), /нет ответа/);
});

// ---------- Офлайн-граф ----------

/** Сетка улиц N×N с шагом ~100 м; горизонтальная улица y=1 — односторонняя на восток; одна пешеходная дорожка. */
function gridOverpass(N: number) {
  const elements: any[] = [];
  const id = (x: number, y: number) => y * N + x + 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) elements.push({ type: 'node', id: id(x, y), lat: 44.6 + y * 0.0009, lon: 33.5 + x * 0.00126 });
  let w = 1;
  for (let y = 0; y < N; y++) elements.push({ type: 'way', id: w++, nodes: Array.from({ length: N }, (_, x) => id(x, y)), tags: { highway: 'residential', ...(y === 1 ? { oneway: 'yes' } : {}) } });
  for (let x = 0; x < N; x++) elements.push({ type: 'way', id: w++, nodes: Array.from({ length: N }, (_, y) => id(x, y)), tags: { highway: x === 2 ? 'footway' : 'residential' } });
  return { elements };
}

test('офлайн-граф: компактный формат, односторонние для машины, пешком — все тропы', () => {
  const st = buildGraph([gridOverpass(6)]);
  const g = loadGraph(JSON.parse(JSON.stringify(st)))!; // как с диска
  assert.equal(g.n, 36);
  const p = (x: number, y: number) => ({ lat: 44.6 + y * 0.0009, lon: 33.5 + x * 0.00126 });
  // по односторонней на запад машиной нельзя — объезд длиннее, пешком — напрямую
  const car = route(g, p(4, 1), p(1, 1), 'car')!;
  const walk = route(g, p(4, 1), p(1, 1), 'walk')!;
  assert.ok(car && walk);
  assert.equal(walk.length, 4);
  assert.ok(car.length > walk.length, `машина объезжает одностороннюю (${car.length} > ${walk.length})`);
  // пешеходная дорожка x=2 машине не годится
  const r = graphPathToPlannedRoute(car, 'car');
  assert.ok(r.offlineGraph && r.maneuvers.length >= 3, 'есть повороты');
  assert.ok(!car.some((q, i) => i > 0 && Math.abs(q.lon - p(2, 0).lon) < 1e-9 && Math.abs(car[i - 1].lon - q.lon) < 1e-9), 'не едет вдоль пешеходной дорожки');
});

test('офлайн-граф: старый формат {nodes, adj} читается', () => {
  const old = { nodes: { 1: { lat: 44.6, lon: 33.5 }, 2: { lat: 44.601, lon: 33.5 }, 3: { lat: 44.602, lon: 33.5 } }, adj: { 1: [['2', 111]], 2: [['1', 111], ['3', 111]], 3: [['2', 111]] } };
  const g = loadGraph(old)!;
  const path = route(g, { lat: 44.6, lon: 33.5 }, { lat: 44.602, lon: 33.5 }, 'car')!;
  assert.equal(path.length, 3);
});

test('офлайн-граф: точка дальше 2,5 км от дорог — честно null, а не маршрут через поле', () => {
  const g = loadGraph(buildGraph([gridOverpass(4)]))!;
  assert.equal(route(g, { lat: 44.6, lon: 33.5 }, { lat: 44.7, lon: 33.6 }, 'car'), null);
});

test('офлайн-граф: A* быстрый на большом графе (250×250 = 62 500 узлов)', () => {
  const g = loadGraph(buildGraph([gridOverpass(250)]))!;
  const t0 = performance.now();
  const path = route(g, { lat: 44.6, lon: 33.5 }, { lat: 44.6 + 249 * 0.0009, lon: 33.5 + 249 * 0.00126 }, 'walk');
  const ms = performance.now() - t0;
  assert.ok(path && path.length >= 499);
  assert.ok(ms < 1500, `A* занял ${ms.toFixed(0)} мс`);
});

test('коридор: прямоугольники вдоль маршрута, а не один огромный', () => {
  const pts = Array.from({ length: 101 }, (_, i) => ({ lat: 44 + i * 0.009, lon: 34 })); // ~100 км на север
  const boxes = corridorBoxes(pts, 1.5, 8);
  assert.ok(boxes.length >= 12 && boxes.length <= 14, `кусков ${boxes.length}`);
  for (const [s, w, n, e] of boxes) {
    assert.ok((e - w) * 79 < 3.5, 'ширина полосы ~3 км');
    assert.ok(n > s);
  }
});

test('повороты по изгибу пути: направо и налево', () => {
  const L = (lat: number, lon: number) => ({ lat, lon });
  // на север 200 м → на восток 200 м (направо) → на север (налево)
  const path = [L(44.6, 33.5), L(44.6018, 33.5), L(44.6018, 33.5025), L(44.6036, 33.5025)];
  const t = turnsAlong(path);
  assert.deepEqual(t.map((x) => x.text), ['Направо', 'Налево']);
});

test('недавно молчавший сервер не пропускается, а идёт последним (включили VPN — заработает)', async () => {
  resetHostHealth();
  const { markHostBad } = await import('../src/net.ts');
  markHostBad('a.test');
  const order: string[] = [];
  const v = await firstOk([
    { label: 'a', host: 'a.test', run: async () => { order.push('a'); return 'a'; } },
    { label: 'b', host: 'b.test', run: async () => { order.push('b'); throw new Error('502'); } },
  ], { staggerMs: 50, budgetMs: 2000 });
  assert.deepEqual(order, ['b', 'a'], 'сначала живой, потом «молчавший»');
  assert.equal(v, 'a');
});

test('фоновый запрос не «портит» сервер для маршрутов', async () => {
  resetHostHealth();
  const s = await stallingServer();
  await assert.rejects(fetchText(`${s.url}/stall`, { timeoutMs: 300 }));
  assert.equal(isHostBad(`${s.url}/x`), false, 'без markBad сервер не помечается');
  await assert.rejects(fetchText(`${s.url}/stall`, { timeoutMs: 300, markBad: true }));
  assert.equal(isHostBad(`${s.url}/x`), true);
  s.close();
});
