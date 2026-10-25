// Онлайн-сервисы. Нужны только дома / там, где есть интернет: найти адрес, проложить
// маршрут и сохранить его. Дальше навигатор работает офлайн.
//
//   Поиск адресов  — Photon, Nominatim, при ключе — 2ГИС. Несколько адресов: в РФ без VPN
//                    западные OSM-серверы часто недоступны.
//   Маршруты       — 2ГИС (если есть ключ), затем Valhalla/OSRM. Паромы и прямая по морю
//                    отбрасываем; Крым ↔ материк всегда через Крымский мост.
//   Пробки         — 2ГИС Routing API: у каждого участка маршрута есть цвет загруженности.
//                    Нужен свой ключ (бесплатный демо-ключ — platform.2gis.ru). TomTom Россию не покрывает.
//   Место по сети  — beaconDB (api.beacondb.net): вышки + Wi‑Fi → координаты. Бесплатно, без ключа.
//
// Публичные серверы бесплатны «по-честному»: не долбим их запросами (поиск — с паузой).

import { haversine, type LatLon } from './core/geo.ts';
import type { CellId, WifiAp } from './core/cells.ts';
import { bboxAround, rankPlaces, type PlaceKind, type RawPlace } from './searchRank.ts';
import { dlog, dlogError } from './debugLog.ts';
import { isOpenWater, kerchVias, routeCrossesSea, snapToLand } from './sea.ts';
import { fetchJson, fetchText, firstOk, isHostBad, type Attempt } from './net.ts';
// data.ts / offlineRouter.ts подгружаем лениво: им нужен expo-file-system, а этот файл
// должен работать и в тестах на Node.

const UA = 'TropaNav/0.4 (offline-capable navigator; open source)';

/** Ключ 2ГИС — маршруты и поиск в России без VPN. Задаётся из настроек. */
let gisApiKey = '';
export function setOnlineKeys(k: { gisKey?: string }) {
  gisApiKey = (k.gisKey ?? '').trim();
}

/**
 * Встроенный в телефон Valhalla (подключает regions.ts). Принимает тот же JSON, что сервер,
 * и возвращает ответ — или null, если для этих точек нет скачанного файла дорог.
 */
export type DeviceRouter = (kind: 'route' | 'trace', pts: LatLon[], body: object) => Promise<any | null>;
let deviceRouter: DeviceRouter | null = null;
export function setDeviceRouter(f: DeviceRouter | null) { deviceRouter = f; }

/** Поиск по скачанным индексам областей (подключает regions.ts). */
export type OfflineSearch = (q: string, near?: LatLon) => Promise<RawPlace[]>;
let offlineSearch: OfflineSearch | null = null;
export function setOfflineSearch(f: OfflineSearch | null) { offlineSearch = f; }

/** Сколько всего ждём маршрут от онлайн-серверов, прежде чем перейти к офлайну. */
const ROUTE_BUDGET_MS = 25_000; // с VPN серверы отвечают медленнее
/** Через сколько подключать следующий сервер, если текущий молчит. */
const ROUTE_STAGGER_MS = 2_500;

export type Place = {
  name: string; detail: string; lat: number; lon: number;
  kind?: PlaceKind; distKm?: number | null;
};

export type TravelMode = 'car' | 'walk' | 'scooter';
export type Stop = { name: string; lat: number; lon: number };

export const MODES: { id: TravelMode; label: string; icon: 'car' | 'walk' | 'scooter-electric' }[] = [
  { id: 'car', label: 'Авто', icon: 'car' },
  { id: 'walk', label: 'Пешком', icon: 'walk' },
  { id: 'scooter', label: 'Самокат', icon: 'scooter-electric' },
];

export type Maneuver = { idx: number; type: number; text: string; lengthM: number; timeS: number };

/** Ограничение скорости на участке маршрута: от fromM до toM метров от начала. */
export type SpeedLimit = { fromM: number; toM: number; kmh: number };

export type PlannedRoute = {
  mode: TravelMode;
  points: LatLon[];
  maneuvers: Maneuver[];
  timeS: number;
  lengthM: number;
  dest?: Place;
  stops?: Stop[];
  createdAt: number;
  limits?: SpeedLimit[];  // знаки ограничения скорости (из OpenStreetMap), сохраняются для офлайна
  /** Построено без дорожного сервера (офлайн). */
  offline?: boolean;
  /** Офлайн, но по сохранённому графу дорог (а не по прямой). */
  offlineGraph?: boolean;
  /** Построено встроенным Valhalla по скачанной области (полноценный маршрут без сети). */
  onDevice?: boolean;
  /** На маршруте остался участок открытой воды (паром / прямая через море). */
  seaCrossing?: boolean;
};

// ---------------- Поиск ----------------

/**
 * Поиск «как у навигаторов»: два запроса сразу —
 *   1) только вокруг вас (±40 км): улицы, дома, кафе вашего города;
 *   2) широкий, с лёгким смещением к вам: известные места, города, вокзалы где угодно.
 * Потом общая сортировка (src/searchRank.ts): для улиц и домов расстояние решает почти всё,
 * для достопримечательностей и городов — почти ничего.
 */
const PHOTON_HOSTS = ['https://photon.komoot.io/api/', 'https://photon.komoot.de/api/'];
const NOMINATIM_HOSTS = [
  'https://nominatim.openstreetmap.org/search',
  'https://nominatim.openstreetmap.de/search',
];

export async function searchPlaces(q: string, near?: LatLon, signal?: AbortSignal): Promise<Place[]> {
  q = q.trim();
  if (q.length < 2) return [];
  const raw: RawPlace[] = [];
  const collect = async (label: string, fn: () => Promise<RawPlace[]>) => {
    try {
      const v = await fn();
      if (v.length) raw.push(...v);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      dlog(`поиск ${label}:`, String(e?.message ?? e));
    }
  };
  // Всё, что можно, — одновременно: раньше запросы шли по очереди и без VPN ждали каждый таймаут.
  const jobs: Promise<void>[] = [];
  if (near) {
    const bb = bboxAround(near, 40).map((x) => x.toFixed(5)).join(',');
    jobs.push(collect('photon-рядом', () => photon(`q=${encodeURIComponent(q)}&limit=10&lat=${near.lat}&lon=${near.lon}&zoom=13&location_bias_scale=0.1&bbox=${bb}`, true, signal)));
    jobs.push(collect('photon-широко', () => photon(`q=${encodeURIComponent(q)}&limit=10&lat=${near.lat}&lon=${near.lon}&zoom=7&location_bias_scale=0.5`, false, signal)));
  } else {
    jobs.push(collect('photon', () => photon(`q=${encodeURIComponent(q)}&limit=10`, false, signal)));
  }
  if (gisApiKey) jobs.push(collect('2gis', () => gisGeocode(q, near, signal)));
  // Скачанные области — сразу и без сети; их результаты смешиваются с онлайновыми
  const offline: RawPlace[] = [];
  if (offlineSearch) jobs.push(offlineSearch(q, near).then((v) => { offline.push(...v); }).catch((e) => dlog('поиск офлайн:', String(e?.message ?? e))));
  await Promise.all(jobs);
  if (!raw.length && !offline.length) await collect('nominatim', () => nominatim(q, near, signal));
  raw.push(...dedupeAgainst(offline, raw));
  if (!raw.length) throw new Error(offlineSearch
    ? 'Ничего не нашлось. Онлайн-поиск недоступен (серверы не отвечают), а в скачанных областях такого нет. Зажмите точку на карте.'
    : 'Поиск недоступен (серверы не отвечают — часто так без VPN). Зажмите точку на карте.');
  return rankPlaces(raw, q, near).slice(0, 12).map((p) => ({
    name: p.name, detail: p.detail, lat: p.lat, lon: p.lon, kind: p.kind, distKm: p.distKm,
  }));
}

/** Офлайн-результаты, которых нет среди онлайновых (то же название в пределах ~300 м). */
function dedupeAgainst(extra: RawPlace[], base: RawPlace[]): RawPlace[] {
  return extra.filter((e) => !base.some((b) => b.name.toLowerCase() === e.name.toLowerCase() && Math.abs(b.lat - e.lat) < 0.003 && Math.abs(b.lon - e.lon) < 0.004));
}

function parsePhoton(j: any, local: boolean): RawPlace[] {
  return (j.features ?? []).map((f: any, i: number) => {
    const p = f.properties ?? {};
    const street = [p.street, p.housenumber].filter(Boolean).join(', ');
    const name = p.name || street || p.city || 'Без названия';
    const area = [p.name ? street : '', p.district, p.city || p.county, p.state].filter((x: string) => x && x !== name);
    return {
      name, detail: [...new Set(area)].join(', '),
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      osmKey: p.osm_key, osmValue: p.osm_value, layer: p.type,
      fromLocal: local, order: i,
    } as RawPlace;
  });
}

async function photon(params: string, local: boolean, signal?: AbortSignal): Promise<RawPlace[]> {
  return firstOk(PHOTON_HOSTS.map((host) => ({
    label: 'photon', host,
    run: async (sig) => parsePhoton(await fetchJson(`${host}?${params}`, { headers: { 'User-Agent': UA }, signal: sig, timeoutMs: 8000, markBad: true }), local),
  })), { signal, staggerMs: 1500, budgetMs: 9000 });
}

/** Запасной поиск — Nominatim: окрестности и вся страна одновременно. */
async function nominatim(q: string, near: LatLon | undefined, signal?: AbortSignal): Promise<RawPlace[]> {
  const get = async (host: string, extra: string, local: boolean, sig: AbortSignal) => {
    const j = await fetchJson<any[]>(`${host}?format=jsonv2&limit=8&accept-language=ru&q=${encodeURIComponent(q)}${extra}`, { headers: { 'User-Agent': UA }, signal: sig, timeoutMs: 9000, markBad: true });
    return j.map((x: any, i: number) => {
      const parts = String(x.display_name).split(', ');
      return { name: x.name || parts[0], detail: parts.slice(1, 4).join(', '), lat: +x.lat, lon: +x.lon, osmKey: x.category, osmValue: x.type, fromLocal: local, order: i } as RawPlace;
    });
  };
  return firstOk(NOMINATIM_HOSTS.map((host) => ({
    label: 'nominatim', host,
    run: async (sig) => {
      if (!near) return get(host, '', false, sig);
      const [w, s, e, n] = bboxAround(near, 40);
      const [local, wide] = await Promise.all([
        get(host, `&viewbox=${w},${n},${e},${s}&bounded=1`, true, sig).catch(() => [] as RawPlace[]),
        get(host, '', false, sig),
      ]);
      return [...local, ...wide];
    },
  })), { signal, staggerMs: 2000, budgetMs: 10_000 });
}

async function gisGeocode(q: string, near: LatLon | undefined, signal?: AbortSignal): Promise<RawPlace[]> {
  const loc = near ? `&location=${near.lon},${near.lat}` : '';
  const j = await fetchJson(
    `https://catalog.api.2gis.com/3.0/items?q=${encodeURIComponent(q)}${loc}&page_size=10&fields=items.point,items.full_name,items.address_name&key=${encodeURIComponent(gisApiKey)}`,
    { headers: { 'User-Agent': UA }, signal, timeoutMs: 8000 },
  );
  const items = j?.result?.items ?? [];
  return items.map((x: any, i: number) => ({
    name: x.name || x.address_name || 'Без названия',
    detail: [x.address_name, x.full_name].filter((s: string) => s && s !== x.name).slice(0, 2).join(', '),
    lat: +x.point?.lat, lon: +x.point?.lon,
    osmKey: x.type, osmValue: x.subtype, fromLocal: !!near, order: i,
  } as RawPlace)).filter((p: RawPlace) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// ---------------- Маршруты ----------------

/** Как едет каждый вид транспорта в Valhalla. Паромы выключены — не ведём по морю. */
function costingFor(mode: TravelMode) {
  if (mode === 'car') return { costing: 'auto', costing_options: { auto: { use_highways: 1, use_ferry: 0 } } };
  if (mode === 'walk') return {
    costing: 'pedestrian',
    costing_options: {
      pedestrian: {
        walking_speed: 5.1,
        use_highways: 0.0,
        use_ferry: 0.0,
        use_tracks: 1.0,
        use_foot: 1.0,
        walkway_factor: 2.0,
        alley_factor: 0.2,
        driveway_factor: 0.3,
        use_living_streets: 1.0,
        service_penalty: 0,
        shortcut_penalty: -10,
        step_penalty: 0,
      },
    },
  };
  return {
    costing: 'pedestrian',
    costing_options: {
      pedestrian: {
        walking_speed: 15,
        use_highways: 0.0,
        use_ferry: 0.0,
        use_tracks: 0.8,
        use_foot: 1.0,
        walkway_factor: 1.5,
        alley_factor: 0.5,
        driveway_factor: 0.5,
        use_living_streets: 0.8,
        service_penalty: 0,
        shortcut_penalty: 0,
        step_penalty: 60,
      },
    },
  };
}

export function planOfflineRoute(from: LatLon, to: LatLon, mode: TravelMode): PlannedRoute {
  const distM = haversine(from, to);
  const speedMps = mode === 'walk' ? 1.4 : mode === 'scooter' ? 4.0 : 13.8;
  const timeS = Math.round(distM / speedMps);
  const ptsCount = Math.max(2, Math.min(30, Math.floor(distM / 150)));
  const points: LatLon[] = [];
  for (let i = 0; i <= ptsCount; i++) {
    const f = i / ptsCount;
    points.push({ lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f });
  }
  if (distM > 2000) {
    throw new Error('Точка слишком далеко для офлайна (более 2 км). Нужен интернет, чтобы проложить маршрут по дорогам.');
  }
  // Не ведём по воде: точки, попавшие в открытое море, притягиваем к ближайшей суше
  const fixed = points.map((p) => (isOpenWater(p.lat, p.lon) ? snapToLand(p) : p));
  return {
    mode, points: fixed,
    maneuvers: [
      { idx: 0, type: 1, text: 'Начало короткого маршрута', lengthM: distM, timeS },
      { idx: fixed.length - 1, type: 4, text: 'Пункт назначения', lengthM: 0, timeS: 0 },
    ],
    timeS, lengthM: distM, createdAt: Date.now(),
    offline: true,
    seaCrossing: routeCrossesSea(fixed),
  };
}

function acceptRoute(mode: TravelMode, points: LatLon[], maneuvers: Maneuver[], timeS: number, lengthM: number, src: string): PlannedRoute {
  if (points.length < 2) throw new Error(`${src}: пустой маршрут`);
  // Если сервер провёл маршрут по воде — притягиваем водяные точки к суше, чтобы не ехать «прямо по морю».
  let fixed = points;
  let sea = false;
  if (routeCrossesSea(points)) {
    fixed = points.map((p) => (isOpenWater(p.lat, p.lon) ? snapToLand(p) : p));
    sea = routeCrossesSea(fixed);
  }
  dlog(`маршрут ${mode} через ${src}: ${(lengthM / 1000).toFixed(1)} км${sea ? ' (остался водный участок)' : ''}`);
  return { mode, points: fixed, maneuvers, timeS, lengthM, createdAt: Date.now(), seaCrossing: sea };
}

const VALHALLA_URLS = [
  'https://valhalla1.openstreetmap.de/route',
  'https://valhalla.kumi.systems/route',
];

function valhallaBody(from: LatLon, to: LatLon, mode: TravelMode, vias: LatLon[], avoid: LatLon[] | undefined) {
  return {
    locations: [
      { lat: from.lat, lon: from.lon },
      ...vias.map((p) => ({ lat: p.lat, lon: p.lon, type: 'through' as const })),
      { lat: to.lat, lon: to.lon },
    ],
    ...(avoid?.length ? { exclude_locations: avoid.map((p) => ({ lat: p.lat, lon: p.lon })) } : {}),
    ...costingFor(mode),
    language: 'ru-RU',
    units: 'kilometers',
    directions_type: 'instructions',
  };
}

/** Один сервер Valhalla. Ответ читается целиком под таймаутом (см. net.ts). */
async function planValhallaAt(url: string, body: object, mode: TravelMode, signal: AbortSignal): Promise<PlannedRoute> {
  const r = await fetchText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
    signal,
    timeoutMs: 15_000, markBad: true,
  });
  let j: any = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch {}
  if (!r.ok || !j?.trip) throw new Error(j?.error ?? j?.error_code ?? `Valhalla ${r.status}`);
  return parseValhallaTrip(j, mode, 'Valhalla');
}

/** Ответ Valhalla /route (с сервера или встроенного) → наш маршрут. */
export function parseValhallaTrip(j: any, mode: TravelMode, src: string): PlannedRoute {
  if (!j?.trip) throw new Error(`${src}: пустой ответ`);
  const legs = j.trip.legs ?? [];
  const points: LatLon[] = [];
  const maneuvers: Maneuver[] = [];
  for (const leg of legs) {
    const pts = decodePolyline6(leg.shape);
    const base = Math.max(0, points.length - 1);
    if (!points.length) points.push(...pts);
    else points.push(...pts.slice(1));
    for (const m of leg.maneuvers ?? []) {
      maneuvers.push({
        idx: base + (m.begin_shape_index ?? 0),
        type: m.type,
        text: ruOnly(m.instruction ?? ''),
        lengthM: m.length * 1000,
        timeS: m.time,
      });
    }
  }
  return acceptRoute(mode, points, maneuvers, j.trip.summary.time, j.trip.summary.length * 1000, src);
}

function osrmProfile(mode: TravelMode): { fossgis: string; demo: string } {
  if (mode === 'car') return { fossgis: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/', demo: 'driving' };
  if (mode === 'walk') return { fossgis: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/', demo: 'foot' };
  return { fossgis: 'https://routing.openstreetmap.de/routed-bike/route/v1/cycling/', demo: 'bike' };
}

function osrmManType(type: string, modifier: string): number {
  if (type === 'depart') return 1;
  if (type === 'arrive') return 4;
  if (type.includes('roundabout') || type === 'rotary') return type.includes('exit') ? 27 : 26;
  if (type === 'uturn' || modifier === 'uturn') return 12;
  const right = modifier.includes('right'), left = modifier.includes('left');
  if (modifier.includes('sharp')) return right ? 11 : left ? 14 : 17;
  if (modifier.includes('slight') || type === 'continue') return right ? 9 : left ? 16 : 17;
  if (type === 'fork' || type === 'merge' || modifier.includes('straight')) return right ? 18 : left ? 19 : 17;
  if (right) return 10;
  if (left) return 15;
  return 17;
}

function osrmText(type: string, modifier: string, name: string): string {
  const n = name ? ` на ${ruOnly(name)}` : '';
  if (type === 'depart') return 'Начало маршрута';
  if (type === 'arrive') return 'Пункт назначения';
  if (type.includes('roundabout')) return 'Круговое движение' + n;
  if (modifier.includes('uturn')) return 'Разворот' + n;
  if (modifier.includes('sharp') && modifier.includes('right')) return 'Круто направо' + n;
  if (modifier.includes('sharp') && modifier.includes('left')) return 'Круто налево' + n;
  if (modifier.includes('slight') && modifier.includes('right')) return 'Правее' + n;
  if (modifier.includes('slight') && modifier.includes('left')) return 'Левее' + n;
  if (modifier.includes('right')) return 'Направо' + n;
  if (modifier.includes('left')) return 'Налево' + n;
  return (name ? ruOnly(name) : 'Прямо');
}

async function planOsrmUrl(base: string, coords: string, mode: TravelMode, signal: AbortSignal): Promise<PlannedRoute> {
  // Без exclude=ferry: публичные серверы OSRM его не поддерживают («Exclude flag combination
  // is not supported»). Паромы и «прямую по морю» отсекает acceptRoute (притягивает к суше).
  const r = await fetchText(`${base}${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`, {
    headers: { 'User-Agent': UA }, signal, timeoutMs: 15_000, markBad: true,
  });
  let j: any = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch {}
  if (!r.ok || j?.code !== 'Ok' || !j?.routes?.[0]) throw new Error(j?.message ?? `OSRM ${r.status}`);
  const route = j.routes[0];
  const points: LatLon[] = (route.geometry?.coordinates ?? []).map((c: number[]) => ({ lon: c[0], lat: c[1] }));
  const maneuvers: Maneuver[] = [];
  let idx = 0;
  for (const leg of route.legs ?? []) {
    for (const st of leg.steps ?? []) {
      const loc = st.maneuver?.location;
      if (loc) {
        // ищем точку манёвра вперёд от прошлой, но не дальше 400 вершин — не O(n²) на длинном маршруте
        let best = idx, bd = Infinity;
        const lim = Math.min(points.length, idx + 400);
        for (let i = idx; i < lim; i++) {
          const d = Math.abs(points[i].lat - loc[1]) + Math.abs(points[i].lon - loc[0]);
          if (d < bd) { bd = d; best = i; if (d < 1e-7) break; }
        }
        idx = best;
      }
      const type = String(st.maneuver?.type ?? '');
      const modifier = String(st.maneuver?.modifier ?? '');
      maneuvers.push({
        idx, type: osrmManType(type, modifier),
        text: osrmText(type, modifier, st.name ?? ''),
        lengthM: st.distance ?? 0, timeS: st.duration ?? 0,
      });
    }
  }
  return acceptRoute(mode, points, maneuvers, route.duration, route.distance, 'OSRM');
}

/** Адреса OSRM для вида транспорта (без повторов). Демо-сервер project-osrm умеет только машину. */
function osrmBases(mode: TravelMode): string[] {
  const p = osrmProfile(mode);
  const kind = mode === 'car' ? 'car' : mode === 'walk' ? 'foot' : 'bike';
  const list = [
    p.fossgis,
    ...(mode === 'car' ? ['https://router.project-osrm.org/route/v1/driving/'] : []),
  ];
  return [...new Set(list)];
}

function gisTransport(mode: TravelMode): string {
  if (mode === 'car') return 'driving';
  if (mode === 'scooter') return 'bicycle';
  return 'walking';
}

async function planGis(from: LatLon, to: LatLon, mode: TravelMode, vias: LatLon[], signal?: AbortSignal): Promise<PlannedRoute> {
  if (!gisApiKey) throw new Error('нет ключа 2ГИС');
  const [g] = await routes2gis(gisApiKey, from, to, { via: vias, transport: gisTransport(mode) }, signal);
  const mans = g.maneuvers.length ? g.maneuvers : [
    { idx: 0, type: 1, text: 'Начало маршрута', lengthM: g.lengthM, timeS: g.timeS },
    { idx: Math.max(0, g.points.length - 1), type: 4, text: 'Пункт назначения', lengthM: 0, timeS: 0 },
  ];
  return acceptRoute(mode, g.points, mans, g.timeS, g.lengthM, '2ГИС');
}

/** Все онлайн-источники маршрута по порядку предпочтения. */
function routeAttempts(from: LatLon, to: LatLon, mode: TravelMode, vias: LatLon[], avoid?: LatLon[]): Attempt<PlannedRoute>[] {
  const out: Attempt<PlannedRoute>[] = [];
  if (gisApiKey && !avoid?.length) out.push({ label: '2ГИС', host: 'routing.api.2gis.com', run: (sig) => planGis(from, to, mode, vias, sig) });
  const body = valhallaBody(from, to, mode, vias, avoid);
  const valhalla = VALHALLA_URLS.map((url) => ({ label: 'Valhalla', host: url, run: (sig: AbortSignal) => planValhallaAt(url, body, mode, sig) }));
  const coords = [from, ...vias, to].map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const osrm = avoid?.length ? [] : osrmBases(mode).map((base) => ({ label: 'OSRM', host: base, run: (sig: AbortSignal) => planOsrmUrl(base, coords, mode, sig) }));
  // чередуем: Valhalla (лучшие подсказки), OSRM, вторая Valhalla, остальные OSRM
  out.push(valhalla[0], ...osrm.slice(0, 1), ...valhalla.slice(1), ...osrm.slice(1));
  return out.filter(Boolean);
}

/** Онлайн-серверы маршрутов сейчас все «молчат» (недавно не ответили)? Тогда сразу офлайн. */
export function routingServersSilent(mode: TravelMode = 'car'): boolean {
  return routeAttempts({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, mode, []).every((a) => a.host && isHostBad(a.host));
}

/** Маршрут по сохранённому в телефоне графу дорог (A*). null — графа нет или точки вне него. */
export async function planOfflineGraph(from: LatLon, to: LatLon, mode: TravelMode): Promise<PlannedRoute | null> {
  try {
    const { getOfflineGraph } = await import('./data');
    const { route, graphPathToPlannedRoute } = await import('./offlineRouter');
    const g = await getOfflineGraph(from, to);
    if (!g) return null;
    const path = route(g, from, to, mode);
    if (!path || path.length < 2) return null;
    dlog(`маршрут ${mode} построен по офлайн-графу дорог (${path.length} точек)`);
    return graphPathToPlannedRoute(path, mode);
  } catch (e) {
    dlogError('офлайн-роутинг по графу', e);
    return null;
  }
}

export async function planRoute(from: LatLon, to: LatLon, mode: TravelMode, signal?: AbortSignal, avoid?: LatLon[]): Promise<PlannedRoute> {
  const vias = kerchVias(from, to);
  if (vias.length) dlog('маршрут через Крымский мост, чтобы не идти по морю');
  const t0 = Date.now();
  // 1) Встроенный Valhalla по скачанному файлу дорог — мгновенно и без сети.
  //    (Объезд конкретных мест он тоже умеет — exclude_locations.)
  if (deviceRouter) {
    try {
      const j = await deviceRouter('route', [from, ...vias, to], valhallaBody(from, to, mode, vias, avoid));
      if (j) {
        const r = parseValhallaTrip(j, mode, 'встроенный Valhalla');
        dlog(`маршрут ${mode} — в телефоне за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
        return { ...r, onDevice: true };
      }
    } catch (e: any) {
      dlog(`маршрут ${mode}: встроенный Valhalla —`, String(e?.message ?? e));
    }
  }
  let onlineErr = '';
  {
    try {
      const r = await firstOk(routeAttempts(from, to, mode, vias, avoid), { signal, staggerMs: ROUTE_STAGGER_MS, budgetMs: ROUTE_BUDGET_MS });
      dlog(`маршрут ${mode}: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      return r;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      onlineErr = String(e?.message ?? e);
      dlog(`маршрут ${mode} онлайн не построен за ${((Date.now() - t0) / 1000).toFixed(1)} с:`, onlineErr);
    }
  }

  const off = await planOfflineGraph(from, to, mode);
  if (off) return off;

  throw new Error(
    `Не удалось проложить по дорогам: ${onlineErr}`
  );
}

/** «Харьковская улица/Харківська вулиця» → «Харьковская улица»: второе (украинское) название убираем. */
export function ruOnly(text: string): string {
  return text.replace(/\s*\/\s*[^/.,;]*[іїєґІЇЄҐ][^/.,;]*/g, '');
}

/** Все три варианта сразу — чтобы показать время для каждого, как в Яндексе/2ГИС. */
export async function planAll(from: LatLon, to: LatLon, signal?: AbortSignal) {
  const res = await Promise.allSettled(MODES.map((m) => planRoute(from, to, m.id, signal)));
  const out: Partial<Record<TravelMode, PlannedRoute | string>> = {};
  res.forEach((r, i) => { out[MODES[i].id] = r.status === 'fulfilled' ? r.value : String((r.reason as Error)?.message ?? r.reason); });
  return out;
}

/** Расшифровка ломаной Valhalla (точность 6 знаков). */
export function decodePolyline6(str: string): LatLon[] {
  const out: LatLon[] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return out;
}

// ---------------- Ограничения скорости (OpenStreetMap через Valhalla) ----------------

const hav = (a: LatLon, b: LatLon) => {
  const R = 6371000, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/**
 * Узнаём знаки вдоль уже проложенного маршрута: Valhalla «проходит» по нашей линии
 * (trace_attributes) и для каждого участка дороги отдаёт speed_limit из OpenStreetMap.
 * Где знака в OSM нет — участок пропускаем (на экране знак не рисуем, чтобы не врать).
 * Длинную дорогу шлём кусками (сервер не принимает слишком длинные линии).
 */
export async function fetchSpeedLimits(points: LatLon[], signal?: AbortSignal): Promise<SpeedLimit[]> {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + hav(points[i - 1], points[i]));
  const out: SpeedLimit[] = [];
  const MAX_PTS = 2500, MAX_M = 90_000;
  for (let start = 0; start < points.length - 1;) {
    let end = start + 1;
    while (end < points.length - 1 && end - start < MAX_PTS && cum[end] - cum[start] < MAX_M) end++;
    const shape = points.slice(start, end + 1).map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
    const body = JSON.stringify({
      shape, costing: 'auto', shape_match: 'map_snap',
      filters: { attributes: ['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index', 'edge.road_class', 'shape'], action: 'include' },
    });
    const local = deviceRouter ? await deviceRouter('trace', [shape[0], shape[shape.length - 1]], JSON.parse(body)).catch(() => null) : null;
    const j = local?.edges ? local : await firstOk(VALHALLA_URLS.map((u) => u.replace(/\/route$/, '/trace_attributes')).map((url) => ({
      label: 'знаки', host: url,
      run: async (sig: AbortSignal) => {
        const r = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, signal: sig, body, timeoutMs: 15_000 });
        if (!r?.edges) throw new Error(r?.error ?? 'нет данных о дорогах');
        return r;
      },
    })), { signal, staggerMs: 3000, budgetMs: 20_000 });
    // Индексы рёбер — в «своей» линии сервера; переводим в метры по ней
    const sh: LatLon[] = j.shape ? decodePolyline6(j.shape) : shape;
    const sc: number[] = [0];
    for (let i = 1; i < sh.length; i++) sc.push(sc[i - 1] + hav(sh[i - 1], sh[i]));
    const k = sc[sc.length - 1] > 0 ? (cum[end] - cum[start]) / sc[sc.length - 1] : 1; // подгонка длины
    for (const e of j.edges) {
      let kmh = typeof e.speed_limit === 'number' ? e.speed_limit : 0;
      if (kmh === 255 || kmh <= 0 || kmh > 150) kmh = e.road_class === 'motorway' && kmh !== 255 ? 110 : 0; // 110 — общее правило для автомагистралей
      if (!kmh) continue;
      const a = sc[Math.min(e.begin_shape_index ?? 0, sc.length - 1)], b = sc[Math.min(e.end_shape_index ?? 0, sc.length - 1)];
      const fromM = cum[start] + a * k, toM = cum[start] + b * k;
      const last = out[out.length - 1];
      if (last && last.kmh === kmh && fromM - last.toM < 30) last.toM = toM;
      else out.push({ fromM, toM, kmh });
    }
    start = end;
  }
  return out;
}

/** Ограничение в точке маршрута (по пройденным метрам). */
export function limitAt(limits: SpeedLimit[] | undefined, s: number | null): number | null {
  if (!limits || s == null) return null;
  for (const l of limits) if (s >= l.fromM - 10 && s <= l.toM + 10) return l.kmh;
  return null;
}

/** Ограничение на дороге, где мы сейчас (без маршрута, нужен интернет). */
export async function speedLimitHere(p: LatLon, headingDeg: number | null, signal?: AbortSignal): Promise<number | null> {
  const url = 'https://valhalla1.openstreetmap.de/locate';
  if (isHostBad(url)) return null; // сервер недавно молчал — не копим висящие запросы
  const r = await fetchText(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, signal, timeoutMs: 6000,
    body: JSON.stringify({
      locations: [{ lat: p.lat, lon: p.lon, ...(headingDeg != null ? { heading: Math.round(headingDeg), heading_tolerance: 45 } : {}), radius: 25 }],
      costing: 'auto', verbose: true,
    }),
  });
  if (!r.ok) return null;
  let j: any = null;
  try { j = JSON.parse(r.text); } catch {}
  const edge = j?.[0]?.edges?.[0];
  if (!edge) return null;
  const v = edge.edge?.speed_limit ?? edge.edge_info?.speed_limit ?? findNum(edge, 'speed_limit');
  return typeof v === 'number' && v > 0 && v <= 150 ? v : null;
}

function findNum(o: any, key: string, depth = 0): number | undefined {
  if (!o || typeof o !== 'object' || depth > 4) return undefined;
  if (typeof o[key] === 'number') return o[key];
  for (const k in o) { const v = findNum(o[k], key, depth + 1); if (v !== undefined) return v; }
  return undefined;
}

/** Где на карте поставить значки «60», «40»…: в начале каждого участка с новым ограничением. */
export function limitMarks(points: LatLon[], limits: SpeedLimit[] | undefined): { p: LatLon; kmh: number }[] {
  if (!limits?.length) return [];
  const out: { p: LatLon; kmh: number }[] = [];
  let acc = 0, li = 0, prevKmh = -1;
  for (let i = 1; i < points.length && li < limits.length; i++) {
    acc += hav(points[i - 1], points[i]);
    while (li < limits.length && limits[li].fromM <= acc) {
      const L = limits[li];
      if (L.kmh !== prevKmh && L.toM - L.fromM > 80) { out.push({ p: points[i], kmh: L.kmh }); prevKmh = L.kmh; }
      li++;
    }
  }
  return out;
}

// ---------------- Пробки (2ГИС) ----------------

export type TrafficColor = 'fast' | 'normal' | 'slow' | 'jam' | 'none';
export type TrafficSeg = { color: TrafficColor; raw: string; pts: LatLon[] };
export type TrafficRoute = { segs: TrafficSeg[]; timeS: number; lengthM: number; colors: string[] };

/** Цвет участка из ответа 2ГИС → наш (зелёный / жёлтый / красный / бордовый). */
function trafficColor(c: string | undefined): TrafficColor {
  switch (c) {
    case 'fast': return 'fast';
    case 'normal': return 'normal';
    case 'slow': return 'slow';
    case 'slow-jams': case 'jams': case 'jam': case 'stop': return 'jam';
    default: return 'none';
  }
}

/** "LINESTRING(33.5 44.6, 33.51 44.61)" → точки (бывает и с высотой третьим числом). */
export function parseWktLine(wkt: string): LatLon[] {
  const m = /\(([^()]*)\)/.exec(wkt ?? '');
  if (!m) return [];
  return m[1].split(',').map((p) => p.trim().split(/\s+/).map(Number)).filter((a) => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map((a) => ({ lon: a[0], lat: a[1] }));
}

/** Маршрут 2ГИС целиком: линия, манёвры (в наших типах), пробки по участкам, время с пробками. */
export type GisRoute = TrafficRoute & { points: LatLon[]; maneuvers: Maneuver[]; id: string; names: string[] };

/** Значок манёвра 2ГИС → тип манёвра Valhalla (им у нас рисуются стрелки и иконки). */
export function gisIconToType(icon: string | undefined): number {
  const i = icon ?? '';
  if (i === 'start') return 1;
  if (i === 'finish') return 4;
  if (/turn_over|uturn|turn_around/.test(i)) return /left/.test(i) ? 13 : 12;
  if (/ringroad_exit/.test(i)) return 27;
  if (/ringroad/.test(i)) return 26;
  const right = /right/.test(i), left = /left/.test(i);
  if (/keep/.test(i)) return right ? 18 : left ? 19 : 17;
  if (/slightly/.test(i)) return right ? 9 : left ? 16 : 17;
  if (/sharply/.test(i)) return right ? 11 : left ? 14 : 17;
  if (right) return 10;
  if (left) return 15;
  return 17; // прямо
}

const asList = (x: any): any[] => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

/** Разбор одного маршрута из ответа 2ГИС. */
export function parseGisRoute(res: any): GisRoute {
  const segs: TrafficSeg[] = [];
  const colors = new Set<string>();
  const points: LatLon[] = [];
  const maneuvers: Maneuver[] = [];
  const names: string[] = [];
  const push = (pts: LatLon[]) => {
    for (const p of pts) {
      const last = points[points.length - 1];
      if (!last || Math.abs(last.lat - p.lat) > 1e-7 || Math.abs(last.lon - p.lon) > 1e-7) points.push(p);
    }
  };
  for (const m of asList(res.maneuvers)) {
    const type = gisIconToType(m.icon);
    const idx = Math.max(0, points.length - 1);
    if (m.comment && type !== 1) maneuvers.push({ idx, type, text: ruOnly(String(m.comment)), lengthM: m.outcoming_path?.distance ?? 0, timeS: m.outcoming_path?.duration ?? 0 });
    for (const n of asList(m.outcoming_path?.names)) if (n && !names.includes(n)) names.push(String(n));
    for (const g of asList(m.outcoming_path?.geometry)) {
      const pts = parseWktLine(g.selection);
      if (pts.length < 2) continue;
      colors.add(String(g.color));
      segs.push({ color: trafficColor(g.color), raw: String(g.color), pts });
      push(pts);
    }
  }
  return { id: String(res.route_id ?? res.id ?? ''), segs, colors: [...colors], points, maneuvers, names,
    timeS: res.total_duration ?? 0, lengthM: res.total_distance ?? 0 };
}

/**
 * Маршруты на машине с учётом пробок от 2ГИС: основной + до `alternatives` других.
 * via — точки, через которые проехать (чтобы узнать время «нашего» маршрута с пробками).
 * Демо-ключ ограничен ~50 км между точками, поэтому для длинной дороги спрашиваем кусок впереди.
 */
export async function routes2gis(key: string, from: LatLon, to: LatLon, opts: { alternatives?: number; via?: LatLon[]; transport?: string } = {}, signal?: AbortSignal): Promise<GisRoute[]> {
  const body = {
    points: [
      { type: 'stop', lon: from.lon, lat: from.lat, start: true },
      ...(opts.via ?? []).map((p) => ({ type: 'stop', lon: p.lon, lat: p.lat })),
      { type: 'stop', lon: to.lon, lat: to.lat },
    ],
    transport: opts.transport ?? 'driving',
    route_mode: 'fastest',
    traffic_mode: 'jam',
    locale: 'ru',
    output: 'detailed',
    alternative: opts.alternatives ?? 0,
  };
  const r = await fetchText(`https://routing.api.2gis.com/routing/7.0.0/global?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body), signal, timeoutMs: 12_000,
  });
  let j: any = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch {}
  const list = asList(j?.result);
  if (!r.ok || !list.length) throw new Error(j?.message ?? j?.error?.message ?? `2ГИС ответил ${r.status}`);
  return list.map(parseGisRoute);
}

/** Пробки для куска маршрута (для раскраски линии). */
export async function traffic2gis(key: string, from: LatLon, to: LatLon, signal?: AbortSignal): Promise<TrafficRoute> {
  const [r] = await routes2gis(key, from, to, {}, signal);
  return r;
}

/** Точка на маршруте примерно в `aheadM` метрах впереди от `fromIdx` (для запроса пробок кусками). */
export function pointAhead(points: LatLon[], from: LatLon, aheadM: number): { p: LatLon; isEnd: boolean; idx: number; startIdx: number } {
  // ближайшая вершина к нам
  let best = 0, bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].lat - from.lat) ** 2 + ((points[i].lon - from.lon) * Math.cos((from.lat * Math.PI) / 180)) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  let acc = 0;
  for (let i = best + 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    acc += Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
    if (acc >= aheadM) return { p: b, isEnd: i === points.length - 1, idx: i, startIdx: best };
  }
  return { p: points[points.length - 1], isEnd: true, idx: points.length - 1, startIdx: best };
}

// ---------------- Место по вышкам и Wi‑Fi онлайн (beaconDB) ----------------

/**
 * beaconDB — открытая замена Mozilla Location Service: по списку вышек и Wi‑Fi отвечает координатами.
 * Без ключа. IP-адрес для оценки не используем (через VPN он покажет другую страну).
 */
export async function beaconLocate(cells: CellId[], wifi: WifiAp[], opts: { areaFallback?: boolean } = {}, signal?: AbortSignal):
  Promise<{ lat: number; lon: number; accuracy: number } | null> {
  const radio = (r?: string) => (r === 'GSM' ? 'gsm' : r === 'UMTS' ? 'wcdma' : r === 'NR' ? 'nr' : 'lte');
  const body = {
    considerIp: false,
    fallbacks: { ipf: false, lacf: !!opts.areaFallback },
    cellTowers: cells.map((c) => ({
      radioType: radio(c.radio), mobileCountryCode: c.mcc, mobileNetworkCode: c.mnc,
      locationAreaCode: c.area, cellId: c.cid, ...(c.dbm != null ? { signalStrength: c.dbm } : {}),
      ...(c.ta != null ? { timingAdvance: c.ta } : {}),
    })),
    wifiAccessPoints: wifi.length >= 2 ? wifi.map((w) => ({ macAddress: w.bssid, signalStrength: w.dbm })) : [],
  };
  const url = 'https://api.beacondb.net/v1/geolocate';
  if (isHostBad(url)) throw new Error('beaconDB недавно не отвечал');
  const r = await fetchText(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body), signal, timeoutMs: 8000,
  });
  if (r.status === 404) return null; // «не знаю таких»
  if (!r.ok) throw new Error(`beaconDB ответил ${r.status}`);
  let j: any = null;
  try { j = JSON.parse(r.text); } catch {}
  if (!j?.location) return null;
  return { lat: j.location.lat, lon: j.location.lng, accuracy: j.accuracy ?? 1000 };
}

// ---------------- Форматирование ----------------

export function fmtDuration(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} ч ${mm} мин` : `${h} ч`;
}

export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} км` : `${Math.round(m / 10) * 10} м`;
}

export function fmtClock(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Стрелка для типа манёвра Valhalla. */
export function maneuverArrow(type: number): string {
  switch (type) {
    case 9: case 18: case 20: case 23: return '↗';
    case 10: return '→';
    case 11: return '↘';
    case 12: case 13: return '↶';
    case 14: return '↙';
    case 15: return '←';
    case 16: case 19: case 21: case 24: return '↖';
    case 26: case 27: return '⟳';
    case 4: case 5: case 6: return '⚑';
    default: return '↑';
  }
}

export async function planRouteVia(from: LatLon, stops: Stop[], to: LatLon, mode: TravelMode, signal?: AbortSignal, avoid?: LatLon[]): Promise<PlannedRoute> {
  if (!stops.length) return planRoute(from, to, mode, signal, avoid);
  const chain: LatLon[] = [from, ...stops, to];
  // Каждый отрезок строим обычным planRoute (работает и онлайн, и в офлайне), потом склеиваем.
  const legs = await Promise.all(chain.slice(0, -1).map((a, i) => planRoute(a, chain[i + 1], mode, signal, avoid)));
  const points: LatLon[] = [];
  const maneuvers: Maneuver[] = [];
  let timeS = 0, lengthM = 0;
  legs.forEach((leg, i) => {
    const base = points.length ? points.length - 1 : 0; // индекс общей точки склейки
    points.push(...(points.length ? leg.points.slice(1) : leg.points));
    const notLast = i < legs.length - 1;
    leg.maneuvers.forEach((m, k) => {
      if (i > 0 && k === 0 && (m.type === 1 || m.type === 2 || m.type === 3)) return; // «Начните движение» второго отрезка не нужно
      const isStop = notLast && k === leg.maneuvers.length - 1;                          // «Вы прибыли» посреди маршрута = остановка
      maneuvers.push({ ...m, idx: base + m.idx, ...(isStop ? { text: `Остановка: ${stops[i].name}` } : {}) });
    });
    timeS += leg.timeS;
    lengthM += leg.lengthM;
  });
  const lastLeg = legs[legs.length - 1];
  return {
    ...lastLeg, mode, points, maneuvers, timeS, lengthM, stops, createdAt: Date.now(),
    dest: undefined,        // dest выставляет вызывающий код
    limits: undefined,      // знаки скорости последнего отрезка к склеенному маршруту не подходят
    seaCrossing: legs.some((l) => l.seaCrossing),
    offline: legs.some((l) => l.offline) || undefined,
    offlineGraph: legs.some((l) => l.offlineGraph) || undefined,
    onDevice: legs.every((l) => l.onDevice) || undefined,
  };
}
