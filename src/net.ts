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
