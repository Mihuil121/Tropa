// Погода — Open-Meteo (open-meteo.com): бесплатно, без ключа, сразу для нескольких точек.
//
//   • сейчас — там, где вы (значок «15°» на карте);
//   • в пути — в месте назначения ко времени прибытия, а на длинной дороге ещё в 1–2 точках по пути
//     ко времени, когда вы там будете. Опасное (гроза, снег, гололёд, туман, сильный ветер) — предупреждаем.

import type { LatLon } from './core/geo.ts';
import { fetchJson, isHostBad } from './net.ts';

export type WeatherNow = { temp: number; code: number; wind: number; text: string; icon: string };
export type WeatherAt = WeatherNow & {
  name: string; atMs: number; precipProb: number; precip: number; gusts: number; visibility: number;
  danger: string[];          // что опасно (для водителя/пешехода)
};

const API = 'https://api.open-meteo.com/v1/forecast';
const UA = 'TropaNav/0.4 (offline-capable navigator; open source)';

/** Код погоды WMO → слова и значок (MaterialCommunityIcons). */
export function describe(code: number): { text: string; icon: string } {
  if (code === 0) return { text: 'ясно', icon: 'weather-sunny' };
  if (code <= 2) return { text: 'переменная облачность', icon: 'weather-partly-cloudy' };
  if (code === 3) return { text: 'пасмурно', icon: 'weather-cloudy' };
  if (code === 45 || code === 48) return { text: 'туман', icon: 'weather-fog' };
  if (code === 56 || code === 57) return { text: 'ледяная морось', icon: 'snowflake-alert' };
  if (code >= 51 && code <= 55) return { text: 'морось', icon: 'weather-rainy' };
  if (code === 66 || code === 67) return { text: 'ледяной дождь', icon: 'snowflake-alert' };
  if (code === 61 || code === 80) return { text: 'небольшой дождь', icon: 'weather-rainy' };
  if (code === 63 || code === 81) return { text: 'дождь', icon: 'weather-pouring' };
  if (code === 65 || code === 82) return { text: 'ливень', icon: 'weather-pouring' };
  if (code === 71 || code === 85) return { text: 'небольшой снег', icon: 'weather-snowy' };
  if (code === 73 || code === 75 || code === 77 || code === 86) return { text: 'снегопад', icon: 'weather-snowy-heavy' };
  if (code === 95) return { text: 'гроза', icon: 'weather-lightning-rainy' };
  if (code === 96 || code === 99) return { text: 'гроза с градом', icon: 'weather-hail' };
  return { text: 'облачно', icon: 'weather-cloudy' };
}

/** Что из этого опасно в дороге. */
export function dangers(w: { code: number; temp: number; gusts: number; visibility: number; precip: number }): string[] {
  const d: string[] = [];
  if (w.code >= 95) d.push(w.code >= 96 ? 'гроза с градом' : 'гроза');
  if ([56, 57, 66, 67].includes(w.code) || (w.temp <= 0.5 && w.precip > 0.1 && w.code >= 51 && w.code < 70)) d.push('гололёд');
  if ([73, 75, 86].includes(w.code)) d.push('сильный снег');
  else if (w.code >= 71 && w.code <= 77 && w.temp <= 0) d.push('снег, скользко');
  if ([65, 82].includes(w.code) || w.precip >= 6) d.push('ливень');
  if (w.code === 45 || w.code === 48 || (w.visibility > 0 && w.visibility < 800)) d.push('туман, плохая видимость');
  if (w.gusts >= 15) d.push(`ветер с порывами ${Math.round(w.gusts)} м/с`);
  if (w.temp >= 35) d.push(`жара ${Math.round(w.temp)}°`);
  return [...new Set(d)];
}

const fmt = (x: number) => x.toFixed(3);

async function query(points: LatLon[], signal?: AbortSignal): Promise<any[]> {
  const url = `${API}?latitude=${points.map((p) => fmt(p.lat)).join(',')}&longitude=${points.map((p) => fmt(p.lon)).join(',')}` +
    '&current=temperature_2m,weather_code,wind_speed_10m' +
    '&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,wind_gusts_10m,visibility' +
    '&wind_speed_unit=ms&timezone=auto&forecast_days=3&timeformat=unixtime';
  if (isHostBad(url)) throw new Error('погода: сервер недавно не отвечал');
  const j = await fetchJson(url, { headers: { 'User-Agent': UA }, signal, timeoutMs: 10_000 });
  return Array.isArray(j) ? j : [j];
}

export async function weatherNow(p: LatLon, signal?: AbortSignal): Promise<WeatherNow> {
  const [j] = await query([p], signal);
  return parseNow(j);
}

export function parseNow(j: any): WeatherNow {
  const c = j.current ?? {};
  const code = c.weather_code ?? 3;
  return { temp: c.temperature_2m ?? NaN, code, wind: c.wind_speed_10m ?? 0, ...describe(code) };
}

/** Прогноз из ответа на нужный час (ближайший к atMs). */
export function parseAt(j: any, name: string, atMs: number): WeatherAt {
  const h = j.hourly ?? {};
  const times: number[] = h.time ?? [];
  let i = 0, best = Infinity;
  times.forEach((t, k) => { const d = Math.abs(t * 1000 - atMs); if (d < best) { best = d; i = k; } });
  const code = h.weather_code?.[i] ?? 3;
  const w = {
    temp: h.temperature_2m?.[i] ?? NaN, code, wind: 0,
    precipProb: h.precipitation_probability?.[i] ?? 0, precip: h.precipitation?.[i] ?? 0,
    gusts: h.wind_gusts_10m?.[i] ?? 0, visibility: h.visibility?.[i] ?? 0,
  };
  return { ...w, ...describe(code), name, atMs, danger: dangers(w) };
}

/**
 * Погода по дороге: место назначения ко времени прибытия + на длинной дороге (>150 км)
 * две точки по пути ко времени проезда. Один запрос на все точки.
 */
export async function weatherAlong(points: LatLon[], totalS: number, destName: string, signal?: AbortSignal): Promise<WeatherAt[]> {
  const now = Date.now();
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot((points[i].lat - points[i - 1].lat) * 111320, (points[i].lon - points[i - 1].lon) * 111320 * Math.cos((points[i].lat * Math.PI) / 180)));
  const len = cum[cum.length - 1] || 1;
  const stops: { p: LatLon; frac: number; name: string }[] = [];
  if (len > 150_000) for (const f of [1 / 3, 2 / 3]) {
    const i = cum.findIndex((c) => c >= f * len);
    stops.push({ p: points[Math.max(0, i)], frac: f, name: `через ${Math.round((f * len) / 1000)} км` });
  }
  stops.push({ p: points[points.length - 1], frac: 1, name: destName });
  const res = await query(stops.map((s) => s.p), signal);
  return stops.map((s, k) => parseAt(res[k], s.name, now + s.frac * totalS * 1000));
}
