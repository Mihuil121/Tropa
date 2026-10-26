// Сеть «по-честному» для России без VPN.
//
// Зарубежные серверы из РФ часто не отказывают, а молчат: соединение висит, или приходят
// заголовки и первые ~16 КБ, а дальше поток замирает. Поэтому:
//   1) таймаут действует на ВЕСЬ ответ, включая чтение тела (а не только до заголовков);
//   2) отмена снаружи (signal) прерывает запрос на любой стадии;
//   3) сервер, который не ответил, на несколько минут помечается «молчащим» — следующие
//      запросы его пропускают и не ждут таймаут заново;
//   4) несколько серверов опрашиваются внахлёст: следующий стартует, если предыдущий
//      не ответил за пару секунд; берём первый удачный ответ, остальные отменяем.

import { dlog } from './debugLog.ts';

export type FetchOpts = RequestInit & {
  timeoutMs?: number;
  /**
   * Помечать сервер «молчащим», если не ответил. Только для запросов, которые пользователь
   * ждёт (маршрут, поиск). Фоновые опросы (знак скорости, погода…) — нет: иначе один
   * неудачный фоновый запрос без VPN «портил» сервер и потом мешал маршрутам даже с VPN.
   */
  markBad?: boolean;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'HttpError'; }
}

export class TimeoutError extends Error {
  constructor(host: string, ms: number) { super(`${host}: нет ответа за ${Math.round(ms / 1000)} с`); this.name = 'TimeoutError'; }
}

export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : url;
}

// ---------- «Молчащие» серверы ----------

const BAD_MS = 60_000; // недолго: сеть меняется (включили VPN, поймали Wi‑Fi)
const bad = new Map<string, number>(); // host → до какого времени не трогать

export function isHostBad(urlOrHost: string): boolean {
  const h = urlOrHost.includes('/') ? hostOf(urlOrHost) : urlOrHost;
  const until = bad.get(h);
  if (!until) return false;
  if (until < Date.now()) { bad.delete(h); return false; }
  return true;
}
export function markHostBad(urlOrHost: string, ms = BAD_MS) {
  const h = urlOrHost.includes('/') ? hostOf(urlOrHost) : urlOrHost;
  bad.set(h, Date.now() + ms);
}
export function markHostOk(urlOrHost: string) {
  bad.delete(urlOrHost.includes('/') ? hostOf(urlOrHost) : urlOrHost);
}
/** Забыть «молчащие» серверы (кнопка «Попробовать снова», смена сети, тесты). */
export function resetHostHealth() { bad.clear(); probeCache.clear(); }

const isAbort = (e: any) => e?.name === 'AbortError';

/**
 * Запрос, у которого таймаут покрывает и чтение тела. Возвращает статус и текст.
 * Сетевые ошибки и таймаут помечают сервер «молчащим»; HTTP-ошибки (4xx/5xx) — нет:
 * сервер жив, просто ответил отказом.
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<{ status: number; ok: boolean; text: string }> {
  const { timeoutMs = 10_000, signal, markBad = false, ...rest } = opts;
  if (signal?.aborted) throw abortError();
  const ctrl = new AbortController();
  let timedOut = false;
  const tm = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const r = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await r.text(); // ещё под таймаутом и под отменой
    markHostOk(url);
    return { status: r.status, ok: r.ok, text };
  } catch (e: any) {
    if (signal?.aborted) throw abortError();
    if (timedOut) { if (markBad) markHostBad(url); throw new TimeoutError(hostOf(url), timeoutMs); }
    if (!isAbort(e) && markBad) markHostBad(url);
    throw e;
  } finally {
    clearTimeout(tm);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** То же, но сразу JSON. Бросает HttpError, если ответ не 2xx (с текстом ошибки сервера, если есть). */
export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const r = await fetchText(url, opts);
  let j: any = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch { /* не JSON */ }
  if (!r.ok) throw new HttpError(r.status, j?.error?.message ?? j?.error ?? j?.message ?? `${hostOf(url)} ответил ${r.status}`);
  if (j == null) throw new Error(`${hostOf(url)}: пустой или битый ответ`);
  return j as T;
}

function abortError() {
  const e = new Error('Отменено');
  e.name = 'AbortError';
  return e;
}

export type Attempt<T> = { label: string; host?: string; run: (signal: AbortSignal) => Promise<T> };

/**
 * Опросить несколько источников внахлёст и вернуть первый удачный ответ.
 *   staggerMs — через сколько запускать следующий, если предыдущий ещё молчит;
 *   budgetMs  — общий предел на всё.
 * Источники с недавно «молчавшим» сервером не пропускаются, а идут последними —
 * сеть могла поменяться (включили VPN), и такой сервер уже может ответить.
 */
export async function firstOk<T>(attempts: Attempt<T>[], opts: { signal?: AbortSignal; staggerMs?: number; budgetMs?: number } = {}): Promise<T> {
  const { signal, staggerMs = 1500, budgetMs = 20_000 } = opts;
  if (signal?.aborted) throw abortError();
  const isBad = (a: Attempt<T>) => !!a.host && isHostBad(a.host);
  const list = [...attempts.filter((a) => !isBad(a)), ...attempts.filter(isBad)];
  if (!list.length) throw new Error('нет источников');

  return new Promise<T>((resolve, reject) => {
    const ctrl = new AbortController();
    const errors: string[] = [];
    let started = 0, finished = 0, done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', onOuterAbort);
      ctrl.abort();
      fn();
    };
    const onOuterAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onOuterAbort);
    timers.push(setTimeout(() => finish(() => reject(new Error(`нет ответа за ${Math.round(budgetMs / 1000)} с (${errors.join('; ') || 'серверы молчат'})`))), budgetMs));

    const launch = () => {
      if (done || started >= list.length) return;
      const a = list[started++];
      // следующий — если этот не уложится в staggerMs
      if (started < list.length) timers.push(setTimeout(launch, staggerMs));
      a.run(ctrl.signal).then(
        (v) => finish(() => resolve(v)),
        (e: any) => {
          finished++;
          if (done) return;
          if (!isAbort(e)) errors.push(`${a.label}: ${String(e?.message ?? e)}`);
          // упал быстро — не ждём stagger, сразу следующий
          if (started < list.length) launch();
          else if (finished >= list.length) finish(() => reject(new Error(errors.join('; ') || 'все источники недоступны')));
        },
      );
    };
    launch();
  });
}

/** Быстрая проверка: отвечает ли сервер вообще (любой HTTP-ответ = жив). Результат кэшируется. */
const probeCache = new Map<string, { ok: boolean; t: number }>();
export async function probe(url: string, timeoutMs = 4000): Promise<boolean> {
  const h = hostOf(url);
  const c = probeCache.get(h);
  if (c && Date.now() - c.t < 60_000) return c.ok;
  let ok = false;
  try { await fetchText(url, { method: 'HEAD', timeoutMs }); ok = true; } catch { ok = false; }
  probeCache.set(h, { ok, t: Date.now() });
  return ok;
}

export type HostCheckResult = { name: string; url: string; ok: boolean; status?: number; error?: string; ms: number };

export async function checkNetworkHosts(customDataUrl?: string): Promise<HostCheckResult[]> {
  const hosts: { name: string; url: string; method: 'GET' | 'POST'; body?: string; contentType?: string }[] = [
    { name: 'Overpass #1 (ru)', url: 'https://overpass.openstreetmap.ru/api/interpreter', method: 'POST', body: 'data=' + encodeURIComponent('[out:json];node(1);out;'), contentType: 'application/x-www-form-urlencoded' },
    { name: 'Overpass #2 (kumi)', url: 'https://overpass.kumi.systems/api/interpreter', method: 'POST', body: 'data=' + encodeURIComponent('[out:json];node(1);out;'), contentType: 'application/x-www-form-urlencoded' },
    { name: 'Overpass #3 (de)', url: 'https://overpass-api.de/api/interpreter', method: 'POST', body: 'data=' + encodeURIComponent('[out:json];node(1);out;'), contentType: 'application/x-www-form-urlencoded' },
    { name: 'Valhalla #1 (de)', url: 'https://valhalla1.openstreetmap.de/route', method: 'POST', body: '{"locations":[{"lat":44.6,"lon":33.5},{"lat":44.61,"lon":33.51}],"costing":"auto"}', contentType: 'application/json' },
    { name: 'Valhalla #2 (kumi)', url: 'https://valhalla.kumi.systems/route', method: 'POST', body: '{"locations":[{"lat":44.6,"lon":33.5},{"lat":44.61,"lon":33.51}],"costing":"auto"}', contentType: 'application/json' },
    { name: 'OSRM (public)', url: 'https://router.project-osrm.org/route/v1/driving/33.5,44.5;33.6,44.6', method: 'GET' },
    { name: 'Open-Meteo', url: 'https://api.open-meteo.com/v1/forecast?latitude=44.5&longitude=33.5&current_weather=true', method: 'GET' },
    { name: 'OpenFreeMap', url: 'https://tiles.openfreemap.org/planet/0/0/0.pbf', method: 'GET' },
    { name: 'data.source.coop', url: 'https://data.source.coop', method: 'GET' },
    { name: 'beaconDB', url: 'https://api.beacondb.net/v1/geolocate', method: 'POST', body: '{"wifiAccessPoints":[]}', contentType: 'application/json' },
    { name: 'Мыльников (вышки/Wi‑Fi)', url: 'https://api.mylnikov.org/geolocation/wifi?v=1.1&data=open&bssid=00:0C:42:1F:65:E9', method: 'GET' },
  ];
  if (customDataUrl) {
    hosts.push({ name: 'Свой сервер данных', url: customDataUrl, method: 'GET' });
  }

  const results: HostCheckResult[] = [];
  for (const h of hosts) {
    const t0 = performance.now();
    try {
      const opts: FetchOpts = {
        method: h.method,
        timeoutMs: 6000,
        ...(h.body ? { body: h.body, headers: { 'Content-Type': h.contentType || 'application/json' } } : {}),
      };
      const res = await fetchText(h.url, opts);
      const ms = Math.round(performance.now() - t0);
      const isAliveCode = (res.status >= 200 && res.status < 300) || res.status === 400 || res.status === 422;
      const statusLabel = res.status >= 200 && res.status < 300 ? `HTTP ${res.status}` : `жив, ${res.status}`;
      const snippet = (res.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      results.push({
        name: h.name, url: h.url, ok: isAliveCode, status: res.status, ms,
        error: isAliveCode ? undefined : `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
      });
      dlog(`сеть [${isAliveCode ? '✓' : '✗'}]: ${h.name} (${ms} мс, ${statusLabel})`);
    } catch (e: any) {
      const ms = Math.round(performance.now() - t0);
      let errType = String(e?.message ?? e);
      if (errType.includes('UnknownHostException') || errType.includes('ENOTFOUND') || errType.includes('resolve host')) {
        errType = 'DNS ошибка (нет хоста)';
      } else if (e instanceof TimeoutError || errType.includes('нет ответа')) {
        errType = 'Таймаут (сервер молчит)';
      } else if (errType.includes('Connection reset') || errType.includes('connection abort') || errType.includes('Failed to connect')) {
        errType = 'Обрыв / нет соединения';
      }
      results.push({ name: h.name, url: h.url, ok: false, error: errType, ms });
      dlog(`сеть [✗]: ${h.name} (${ms} мс, ошибка: ${errType})`);
    }
  }
  return results;
}
