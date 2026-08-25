// НЕОФИЦИАЛЬНЫЙ источник (для себя, не для публикации): живая карта Waze.
//
// Это тот же адрес, с которого берёт данные сайт waze.com/live-map. Официального API нет,
// поэтому адрес и формат могут поменяться, а частые запросы — заблокировать. Всё обёрнуто так,
// чтобы при поломке приложение просто писало причину в журнал (🐞) и работало дальше.
//
// Что даёт: пробки линиями (уровень 0–5, скорость, задержка) и метки водителей:
// ACCIDENT (ДТП), ROAD_CLOSED (перекрыто), HAZARD (опасность), POLICE (ДПС), JAM (затор).
// В России пользователей Waze мало — данных может не быть совсем.

import type { LatLon } from './core/geo.ts';
import { fetchJson } from './net.ts';

export type WazeJam = { pts: LatLon[]; level: number; speedKmh: number; delayS: number; street: string; lengthM: number };
export type WazeAlert = { type: string; subtype: string; lat: number; lon: number; street: string; reliability: number; at: number };
export type WazeData = { jams: WazeJam[]; alerts: WazeAlert[] };

const URL_ = 'https://www.waze.com/live-map/api/georss';

/** Прямоугольник вокруг точек с запасом (км). */
export function bboxOf(pts: LatLon[], padKm = 2): { top: number; bottom: number; left: number; right: number } {
  let n = -90, s = 90, e = -180, w = 180;
  for (const p of pts) { n = Math.max(n, p.lat); s = Math.min(s, p.lat); e = Math.max(e, p.lon); w = Math.min(w, p.lon); }
  const dLat = padKm / 111.32, dLon = padKm / (111.32 * Math.cos((((n + s) / 2) * Math.PI) / 180));
  return { top: n + dLat, bottom: s - dLat, left: w - dLon, right: e + dLon };
}

export function parseWaze(j: any): WazeData {
  const jams: WazeJam[] = [];
  for (const x of Array.isArray(j?.jams) ? j.jams : []) {
    const pts = (Array.isArray(x.line) ? x.line : []).map((p: any) => ({ lat: +p.y, lon: +p.x })).filter((p: LatLon) => isFinite(p.lat) && isFinite(p.lon));
    if (pts.length < 2) continue;
    jams.push({
      pts, level: +(x.level ?? 0), speedKmh: +(x.speedKMH ?? (x.speed != null ? x.speed * 3.6 : 0)),
      delayS: Math.max(0, +(x.delay ?? 0)), street: String(x.street ?? ''), lengthM: +(x.length ?? 0),
    });
  }
  const alerts: WazeAlert[] = [];
  for (const a of Array.isArray(j?.alerts) ? j.alerts : []) {
    const lat = +(a.location?.y ?? a.latitude), lon = +(a.location?.x ?? a.longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    alerts.push({ type: String(a.type ?? ''), subtype: String(a.subtype ?? ''), lat, lon, street: String(a.street ?? ''), reliability: +(a.reliability ?? 0), at: +(a.pubMillis ?? 0) });
  }
  return { jams, alerts };
}

/**
 * Данные Waze для прямоугольника. Большие области режем на куски ~0,5°
 * (живая карта отдаёт ограниченное число объектов на запрос).
 */
export async function fetchWaze(box: { top: number; bottom: number; left: number; right: number }, signal?: AbortSignal): Promise<WazeData> {
  const out: WazeData = { jams: [], alerts: [] };
  const STEP = 0.5;
  const tasks: Promise<void>[] = [];
  for (let s = box.bottom; s < box.top; s += STEP) for (let w = box.left; w < box.right; w += STEP) {
    const t = Math.min(box.top, s + STEP), e = Math.min(box.right, w + STEP);
    const env = (s + t) / 2 > 15 && (w + e) / 2 > -30 ? 'row' : 'na'; // Россия — «row» (весь мир кроме США/Израиля)
    const url = `${URL_}?top=${t.toFixed(5)}&bottom=${s.toFixed(5)}&left=${w.toFixed(5)}&right=${e.toFixed(5)}&env=${env}&types=alerts,traffic`;
    tasks.push((async () => {
      const d = parseWaze(await fetchJson(url, { headers: { Referer: 'https://www.waze.com/live-map/', Accept: 'application/json' }, signal, timeoutMs: 10_000 }));
      out.jams.push(...d.jams); out.alerts.push(...d.alerts);
    })());
    if (tasks.length > 12) break; // не больше 12 кусков за раз
  }
  const res = await Promise.allSettled(tasks);
  const bad = res.filter((r) => r.status === 'rejected');
  if (bad.length === res.length && bad.length) throw (bad[0] as PromiseRejectedResult).reason;
  return out;
}

/** Подпись и цвет метки. */
export function alertInfo(a: WazeAlert): { label: string; color: string; blocking: boolean } {
  switch (a.type) {
    case 'ACCIDENT': return { label: 'ДТП', color: '#e03131', blocking: true };
    case 'ROAD_CLOSED': return { label: 'Перекрыто', color: '#212529', blocking: true };
    case 'HAZARD': return { label: a.subtype.includes('WEATHER') ? 'Погода' : a.subtype.includes('CONSTRUCTION') ? 'Ремонт' : 'Опасность', color: '#f08c00', blocking: false };
    case 'POLICE': return { label: 'ДПС', color: '#1c7ed6', blocking: false };
    case 'JAM': return { label: 'Затор', color: '#c92a2a', blocking: false };
    default: return { label: '!', color: '#868e96', blocking: false };
  }
}

/** Цвет пробки по уровню Waze (1 — слабая … 5 — стоим). */
export const jamColor = (level: number) => (level >= 4 ? '#c92a2a' : level === 3 ? '#f76707' : '#f2c200');

const kx = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Расстояние от точки до ломаной (м) и где на ней (м от начала). */
export function onLine(p: LatLon, line: LatLon[], from = 0): { d: number; s: number } {
  let best = Infinity, bs = 0, acc = 0;
  const k = kx(p.lat);
  for (let i = Math.max(0, from); i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const ax = (a.lon - p.lon) * k, ay = (a.lat - p.lat) * 111320, bx = (b.lon - p.lon) * k, by = (b.lat - p.lat) * 111320;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, L = Math.sqrt(L2) || 1;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    const d = Math.hypot(ax + t * vx, ay + t * vy);
    if (d < best) { best = d; bs = acc + t * L; }
    acc += L;
  }
  return { d: best, s: bs };
}

export type RouteProblem = { kind: 'alert' | 'jam'; label: string; at: LatLon; distM: number; delayS: number; street: string; source?: string };

/**
 * Что из этого лежит на нашем маршруте впереди (до aheadM): ДТП/перекрытия (≤40 м от линии)
 * и сильные пробки (уровень ≥3, ≥60 % линии пробки вдоль маршрута).
 */
export function problemsOnRoute(route: LatLon[], fromIdx: number, data: WazeData, aheadM = 30_000): RouteProblem[] {
  const ahead = route.slice(Math.max(0, fromIdx));
  const out: RouteProblem[] = [];
  for (const a of data.alerts) {
    const inf = alertInfo(a);
    if (!inf.blocking) continue;
    const { d, s } = onLine(a, ahead);
    if (d <= 40 && s <= aheadM) out.push({ kind: 'alert', label: inf.label, at: { lat: a.lat, lon: a.lon }, distM: s, delayS: 0, street: a.street });
  }
  for (const j of data.jams) {
    if (j.level < 3) continue;
    const near = j.pts.filter((p) => onLine(p, ahead).d <= 30).length / j.pts.length;
    if (near < 0.6) continue;
    const mid = j.pts[Math.floor(j.pts.length / 2)];
    const { s } = onLine(mid, ahead);
    if (s <= aheadM) out.push({ kind: 'jam', label: j.level >= 4 ? 'Пробка' : 'Затор', at: mid, distM: s, delayS: j.delayS, street: j.street });
  }
  return out.sort((a, b) => a.distM - b.distM);
}
