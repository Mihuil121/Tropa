// Главный экран «Тропы» — по образцу Яндекс Навигатора и 2ГИС:
//   карта + строка «Куда?» → выбор транспорта с временем → ведение по маршруту.
// Вся логика определения места — в src/core (ядро) и src/useNavigation (датчики).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { Camera, GeoJSONSource, Images, Layer, Map, RasterSource } from '@maplibre/maplibre-react-native';

import { useNavigation } from './src/useNavigation';
import { clearLearned, clearPlan, importFile, loadAll, loadSettings, savePlan, saveSettings, type Kind, type Loaded, type Settings } from './src/data';
import { downloadCorridor } from './src/offlineRouter';
import { deleteTrip, finalizeTripPart, getTripRoute, listTrips, saveTrip, saveTripGraph, saveTripRoute, subscribeTrips, updateTrip, type BBox, type Trip } from './src/trips';
import { addRecent, clearRecent, loadRecent, removeRecent, type RecentPlace } from './src/recent';
import { findFuel, loadReports, matchesFuel, displayStatus, setReport, statusOf, type FuelKind, type FuelReports, type FuelStation } from './src/fuel';
import { FuelSheet } from './src/ui/FuelSheet';
import { PlaceCard, StopsPill } from './src/ui/PlaceCard';
import { haversine } from './src/core/geo';
import { listAdapters } from './src/obdLink';
import { buildStyle, fileStyle, liteStyle, loadOnlineStyle, skinStyle } from './src/mapStyle';
import { Appear } from './src/ui/motion';
import { MeLayer } from './src/ui/MeLayer';
import { isLite } from './src/device';
import { setLiteFlag } from './src/ui/liteFlag';
import { WeatherChip } from './src/ui/WeatherUI';
import { MODES, fetchSpeedLimits, fmtDistance, fmtDuration, limitAt, limitMarks, planRoute, planRouteVia, pointAhead, routes2gis, setOnlineKeys, speedLimitHere, type Place, type PlannedRoute, type Stop, type TrafficRoute, type TravelMode } from './src/online';
import { dlogError, dlogEvery } from './src/debugLog';
import { SearchScreen } from './src/ui/SearchScreen';
import { RoutePreview, type Plans } from './src/ui/RoutePreview';
import { ManeuverCard, NavBottom, SpeedOverlay } from './src/ui/NavPanels';
import { SettingsSheet } from './src/ui/SettingsSheet';
import { MapDownloads } from './src/ui/MapDownloads';
import { deleteTripMaps, enqueue, listAreas, planCorridor, queueState, setAfterMap, subscribeQueue } from './src/offlineMaps';
import { weatherAlong, weatherNow, type WeatherAt, type WeatherNow } from './src/weather';
import { turnArrows } from './src/turnArrows';
import { pickDetours, spliceDetour, type DetourOffer } from './src/detour';
import { DetourCard } from './src/ui/DetourCard';
import { ProblemCard } from './src/ui/ProblemCard';
import { alertInfo, bboxOf, fetchWaze, jamColor, onLine, problemsOnRoute, type RouteProblem, type WazeData } from './src/waze';
import { yandexAlongRoute, yandexJams } from './src/yandexTraffic';
import { ONLINE_STYLE } from './src/mapStyle';
import { downloadCells, cellSourceUrl } from './src/cellDownload';
import { probe, resetHostHealth } from './src/net';
import { loadAreaCells, mergeCells, saveAreaCells } from './src/data';
import { DebugPanel } from './src/ui/DebugPanel';
import { RegionsSheet } from './src/ui/RegionsSheet';
import { installDeviceHooks, regionMapFor, subscribeRegions } from './src/regions';
import { GpsStatusIndicator } from './src/ui/GpsStatusIndicator';
import { dlog } from './src/debugLog';
import { voice } from './src/voice';
import { fetchRoutePois, type PoiItem } from './src/poi';
import { Chip, MapButton, MapButtonGroup } from './src/ui/components';
import { Icon, type IconName } from './src/ui/Icon';
import { C, GPS_LABEL, PANEL_W, applyScreen, applyTheme, compact, shadow, themed, ui, useInsets, useWide, sz } from './src/ui/theme';

type Screen = 'map' | 'search' | 'preview' | 'nav';

/** Цвета линии маршрута: у каждого вида транспорта свой, у пробок — светофор. */
const MODE_COLOR: Record<TravelMode, string> = { car: C.blue, walk: '#2f9e44', scooter: '#7048e8' };
const TRAFFIC_COLOR: Record<string, string> = { fast: '#2fb344', normal: '#f2c200', slow: '#f76707', jam: '#c92a2a' };
const TRAFFIC_AHEAD_M = 45_000; // демо-ключ 2ГИС: до ~50 км между точками

// ---------- Геометрия для отрисовки ----------
function offset(lat: number, lon: number, dx: number, dy: number): [number, number] {
  return [lon + dx / (111320 * Math.cos((lat * Math.PI) / 180)), lat + dy / 111320];
}
/** Накопленные метры вдоль линии (считаем один раз на маршрут, а не каждую секунду). */
function cumDist(pts: { lat: number; lon: number }[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i].lat - pts[i - 1].lat) * 111320, (pts[i].lon - pts[i - 1].lon) * 111320 * Math.cos((pts[i].lat * Math.PI) / 180)));
  return cum;
}
/** Индекс вершины, после которой лежит точка на расстоянии s (двоичный поиск). */
function idxAt(cum: number[], s: number): number {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}
function arrow(lat: number, lon: number, headingDeg: number, size: number): GeoJSON.Feature {
  const h = (headingDeg * Math.PI) / 180;
  const pt = (fwd: number, side: number) => offset(lat, lon, fwd * Math.sin(h) + side * Math.cos(h), fwd * Math.cos(h) - side * Math.sin(h));
  const ring = [pt(size, 0), pt(-size * 0.7, size * 0.75), pt(-size * 0.35, 0), pt(-size * 0.7, -size * 0.75), pt(size, 0)];
  return { type: 'Feature', properties: { kind: 'arrow' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}
const line = (pts: { lat: number; lon: number }[], props: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) },
});
function bounds(pts: { lat: number; lon: number }[]): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of pts) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  return [w, s, e, n];
}

export default function App() {
  useKeepAwake();
  const scheme = useColorScheme();
  const win = useWindowDimensions();
  applyScreen(win.width, win.height); // до отрисовки детей: размеры под маленький экран
  const { wide } = useWide();
  const { top, bottom } = useInsets();
  const { engine, log, nav, obd, obdLink, gyroOk, permError, servicesOff, enableLocation, now, applyLearned, learner, runSelfTest } = useNavigation();
  const [jam, setJam] = useState(false);
  const [areaCells, setAreaCells] = useState<Record<string, number>>({});
  const [showCells, setShowCells] = useState(false);

  const [data, setData] = useState<Loaded | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const dark = settings.theme === 'dark' || ((settings.theme ?? 'auto') === 'auto' && scheme === 'dark');
  const lite = isLite(settings.lite); // слабый телефон: без 3D, анимаций и тяжёлых слоёв
  setLiteFlag(lite);
  applyTheme(dark); // до отрисовки детей — все цвета уже нужной темы
  const [screen, setScreen] = useState<Screen>('map');
  const [dest, setDest] = useState<Place | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [cand, setCand] = useState<(Place & { sub?: string }) | null>(null);
  const [plans, setPlans] = useState<Plans>({});
  const [planning, setPlanning] = useState(false);
  const [planNonce, setPlanNonce] = useState(0);
  const [mode, setMode] = useState<TravelMode>('car');
  const [plan, setPlan] = useState<PlannedRoute | null>(null);
  const [follow, setFollow] = useState(true);
  const [mapBearing, setMapBearing] = useState(0);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'settings' | 'maps' | 'regions'>('none');
  const [mapsSummary, setMapsSummary] = useState('Выберите города — Крым, юг, Москва…');
  const [adapters, setAdapters] = useState<{ name: string; address: string }[]>([]);
  const [toast, setToast] = useState('');
  const [debug, setDebug] = useState(false);
  const [traffic, setTraffic] = useState<(TrafficRoute & { isEnd: boolean; at: number }) | null>(null);
  const [detours, setDetours] = useState<{ offers: DetourOffer[]; targetIdx: number; forPlan: PlannedRoute } | null>(null);
  const dismissed = useRef(new globalThis.Map<string, number>()); // объезды, от которых отказались (на 15 мин)
  const navRef = useRef(nav); navRef.current = nav;
  const [onlineStyle, setOnlineStyle] = useState<Awaited<ReturnType<typeof loadOnlineStyle>> | null>(null);
  const [hereLimit, setHereLimit] = useState<{ kmh: number | null; t: number } | null>(null);
  const [pois, setPois] = useState<PoiItem[]>([]);

  // ---------- Заправки рядом (кнопка «Бензин») ----------
  const [fuelOn, setFuelOn] = useState(false);
  const [fuelBusy, setFuelBusy] = useState(false);
  const [fuelList, setFuelList] = useState<FuelStation[]>([]);
  const [fuelNote, setFuelNote] = useState('');
  const [fuelFilter, setFuelFilter] = useState<FuelKind | null>(null);
  const [fuelReports, setFuelReports] = useState<FuelReports>({});
  const fuelCtrl = useRef<AbortController | null>(null);
  useEffect(() => { loadReports().then(setFuelReports); }, []);

  async function loadFuel() {
    if (!nav?.ready) { setToast('Место ещё не определено — заправки ищем рядом с вами'); return; }
    fuelCtrl.current?.abort();
    const c = new AbortController();
    fuelCtrl.current = c;
    setFuelBusy(true);
    try {
      const r = await findFuel({ lat: nav.lat, lon: nav.lon }, c.signal);
      setFuelList(r.stations);
      setFuelNote(r.error ? r.error
        : r.fromCache ? `Нет сети: показаны данные от ${new Date(r.cachedAt ?? Date.now()).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
        : r.stations.length ? '' : 'Заправок рядом не нашлось');
    } catch (e: any) {
      if (e?.name !== 'AbortError') dlogError('заправки', e);
    } finally {
      if (fuelCtrl.current === c) setFuelBusy(false);
    }
  }
  function toggleFuel() {
    if (fuelOn) { fuelCtrl.current?.abort(); setFuelBusy(false); setFuelOn(false); return; }
    setFuelOn(true);
    loadFuel();
  }
  function routeToFuel(st: FuelStation) {
    setFuelOn(false);
    pickDest({ name: st.name, detail: 'АЗС', lat: st.lat, lon: st.lon });
  }
  function markFuel(st: FuelStation, status: 'yes' | 'low' | 'no') {
    setReport(st.id, status).then(setFuelReports).catch((e) => dlogError('отметка заправки', e));
    const label = status === 'yes' ? 'Есть топливо' : status === 'low' ? 'Мало / очередь' : 'Нет топлива';
    setToast(`Отметка «${label}» сохранена (только на этом телефоне)`);
  }
  const fuelGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: !fuelOn ? [] : fuelList.filter((st) => matchesFuel(st, fuelFilter)).map((st) => {
      const ds = displayStatus(fuelReports[st.id]);
      return { type: 'Feature', properties: { name: st.name, c: ds.color }, geometry: { type: 'Point', coordinates: [st.lon, st.lat] } } as GeoJSON.Feature;
    }),
  }), [fuelOn, fuelList, fuelFilter, fuelReports]);
  const routePts = screen === 'preview' ? (typeof plans[mode] === 'object' ? (plans[mode] as PlannedRoute).points : null) : screen === 'nav' ? plan?.points ?? null : null;
  useEffect(() => {
    setPois([]);
    if (!routePts || routePts.length < 2) return;
    const ctrl = new AbortController();
    fetchRoutePois(routePts, ctrl.signal)
      .then(setPois)
      .catch((e: any) => {
        if (e?.name !== 'AbortError') {
          dlogError('poi: заправки вдоль маршрута недоступны', e);
          setToast(`POI: заправки вдоль маршрута недоступны (${e?.message ?? e})`);
        }
      });
    return () => ctrl.abort();
  }, [routePts]);

  const poisGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: pois.filter((p) => !(fuelOn && p.category === 'fuel')).map((p) => ({
      type: 'Feature',
      properties: { name: p.name, c: p.category === 'fuel' ? '#f59f00' : p.category === 'food' ? '#7048e8' : '#228be6' },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  }), [pois, fuelOn]);

  const stopsGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const list = screen === 'preview' ? stops : plan?.stops ?? [];
    return {
      type: 'FeatureCollection',
      features: list.map((st, i) => ({
        type: 'Feature',
        properties: { n: String(i + 1), name: st.name },
        geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
      })),
    };
  }, [screen, stops, plan?.stops]);
  useEffect(() => { loadOnlineStyle().then((st) => { setOnlineStyle(st); dlog('стиль карты:', typeof st === 'string' ? 'по ссылке (без русификации)' : 'русские подписи'); }); }, []);
  useEffect(() => { setOnlineKeys({ gisKey: settings.gisKey }); }, [settings.gisKey]);
  // Встроенный Valhalla и офлайн-поиск по скачанным областям
  useEffect(() => { installDeviceHooks(); }, []);
  const [regionsVer, setRegionsVer] = useState(0);
  useEffect(() => subscribeRegions(() => setRegionsVer((v) => v + 1)), []);
  // Карта скачанной области, где мы сейчас (или куда едем) — работает без интернета
  const mapKey = nav?.ready ? `${nav.lat.toFixed(1)},${nav.lon.toFixed(1)}` : '';
  const regionMap = useMemo(() => {
    const p = nav?.ready ? { lat: nav.lat, lon: nav.lon } : plan?.points[0] ?? null;
    return regionMapFor(p);
  }, [mapKey, plan, regionsVer]);
  const fileMap = data?.mapUri ?? regionMap;

  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  useEffect(() => {
    listTrips().then(setTrips);
    return subscribeTrips(() => { listTrips().then(setTrips); });
  }, []);

  const [recent, setRecent] = useState<RecentPlace[]>([]);
  useEffect(() => { loadRecent().then(setRecent); }, []);

  // ---------- Загрузка сохранённого ----------
  async function reloadData(resume = false) {
    const d = await loadAll();
    setData(d);
    if (d.cells) engine.setCellDb(d.cells);
    applyLearned(); // своя база вышек/Wi‑Fi поверх файла
    if (resume && d.plan && d.plan.points.length > 1) {
      setPlan(d.plan);
      setMode(d.plan.mode);
      engine.setRoute(d.plan.points, d.plan.maneuvers);
      engine.setTravelMode(d.plan.mode);
      setScreen('nav');
    }
  }
  useEffect(() => { reloadData(true); loadSettings().then((st) => { setSettings(st); voice.enabled = st.voice !== false; }); }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); } }, [toast]);

  // ---------- Маршрут: прокладываем все три варианта, как только знаем, где мы ----------
  useEffect(() => {
    if (screen !== 'preview' || !dest || planning || Object.keys(plans).length) return;
    if (!nav?.ready) return; // ждём своё местоположение
    const ctrl = new AbortController();
    setPlanning(true);
    // Все три вида транспорта — одновременно; каждый показывается, как только готов.
    // (Повторную попытку убрали: внутри planRoute и так опрашиваются все серверы внахлёст.)
    const from = { lat: nav.lat, lon: nav.lon };
    Promise.allSettled(MODES.map((m) => planRouteVia(from, stops, dest, m.id, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setPlans((ps) => ({ ...ps, [m.id]: r })); return r; })
      .catch((e: any) => { if (!ctrl.signal.aborted && e?.name !== 'AbortError') setPlans((ps) => ({ ...ps, [m.id]: String(e?.message ?? e) })); throw e; })))
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res.some((x) => x.status === 'fulfilled')) setToast('Маршрут по дорогам не построился: серверы не отвечают. Сохраните поездку для офлайна, пока есть сеть.');
      })
      .finally(() => { if (!ctrl.signal.aborted) setPlanning(false); });
    // Отмена (ушли с экрана, пропало место) — снимаем «строим…», иначе крутилось бы вечно
    return () => { ctrl.abort(); setPlanning(false); };
  }, [screen, dest, nav?.ready, planNonce, stops]);

  // ---------- Знаки скорости вдоль авто-маршрута (сохраняются вместе с маршрутом) ----------
  const carPlan = typeof plans.car === 'object' ? plans.car : null;
  useEffect(() => {
    if (screen !== 'preview' || !carPlan || carPlan.limits) return;
    const ctrl = new AbortController();
    fetchSpeedLimits(carPlan.points, ctrl.signal)
      .then((limits) => {
        dlog(`знаки скорости: ${limits.length} участков, ${[...new Set(limits.map((l) => l.kmh))].join('/')} км/ч`);
        setPlans((ps) => (ps.car === carPlan ? { ...ps, car: { ...carPlan, limits } } : ps));
      })
      .catch((e) => { if (e?.name !== 'AbortError') { dlogError('знаки скорости', e); setPlans((ps) => (ps.car === carPlan ? { ...ps, car: { ...carPlan, limits: [] } } : ps)); } });
    return () => ctrl.abort();
  }, [screen, carPlan]);

  // Без маршрута: спрашиваем знак на текущей дороге (если есть интернет), раз в 15 с в движении
  useEffect(() => {
    const t = setInterval(async () => {
      const me = navRef.current;
      if (!me?.ready || me.walking || me.speedKmh < 10 || me.sigma > 40) return;
      if (plan?.limits?.length) return; // по маршруту знаки уже есть
      if (lite) return; // слабый телефон: не дёргаем сеть каждые 15 с
      try {
        const kmh = await speedLimitHere({ lat: me.lat, lon: me.lon }, me.speedKmh > 15 ? me.headingDeg : null);
        setHereLimit({ kmh, t: Date.now() });
        dlogEvery('знак-здесь', 10, 'знак на этой дороге:', kmh ?? 'нет данных');
      } catch { /* нет интернета — не страшно */ }
    }, 15_000);
    return () => clearInterval(t);
  }, [plan, lite]);

  // ---------- Погода (Open-Meteo, без ключа) ----------
  const [wxNow, setWxNow] = useState<WeatherNow | null>(null);
  const [wxRoute, setWxRoute] = useState<WeatherAt[] | null>(null);
  const wxKey = nav?.ready ? `${nav.lat.toFixed(1)},${nav.lon.toFixed(1)}` : '';
  useEffect(() => {
    if (!wxKey) return;
    const get = () => weatherNow({ lat: navRef.current!.lat, lon: navRef.current!.lon }).then(setWxNow).catch(() => {});
    get();
    const t = setInterval(get, 20 * 60_000);
    return () => clearInterval(t);
  }, [wxKey]);
  // В месте назначения ко времени прибытия (и по пути на длинной дороге)
  const wxPlan = screen === 'preview' ? (typeof plans[mode] === 'object' ? (plans[mode] as PlannedRoute) : null) : screen === 'nav' ? plan : null;
  const wxDestName = (screen === 'preview' ? dest?.name : plan?.dest?.name) ?? 'на месте';
  const wxRouteKey = wxPlan ? `${wxPlan.points[0].lat.toFixed(4)},${wxPlan.points[0].lon.toFixed(4)}-${wxPlan.points[wxPlan.points.length - 1].lat.toFixed(4)},${wxPlan.points[wxPlan.points.length - 1].lon.toFixed(4)}-${wxPlan.points.length}` : '';
  useEffect(() => {
    setWxRoute(null);
    if (!wxPlan || wxPlan.points.length < 2) return;
    const ctrl = new AbortController();
    const totalS = wxPlan.timeS || wxPlan.lengthM / 16;
    weatherAlong(wxPlan.points, totalS, wxDestName, ctrl.signal)
      .then((w) => { setWxRoute(w); dlog('погода по пути:', w.map((x) => `${x.name}: ${Math.round(x.temp)}° ${x.text}${x.danger.length ? ' ⚠ ' + x.danger.join(', ') : ''}`).join(' | ')); })
      .catch((e) => { if (e?.name !== 'AbortError') dlogError('погода', e); });
    return () => ctrl.abort();
  }, [wxRouteKey, wxDestName]);

  // ---------- Подкачка впереди: в пути, пока есть интернет ----------
  const prefetched = useRef(new Set<number>());
  useEffect(() => {
    prefetched.current.clear();
    const mode = settings.prefetch ?? 'all';
    if (screen !== 'nav' || !plan || mode === 'off' || plan.points.length < 2) return;
    const CHUNK = 30_000; // куски по 30 км, держим скачанными ~60 км впереди
    const cum: number[] = [0];
    for (let i = 1; i < plan.points.length; i++) cum.push(cum[i - 1] + Math.hypot((plan.points[i].lat - plan.points[i - 1].lat) * 111320, (plan.points[i].lon - plan.points[i - 1].lon) * 111320 * Math.cos((plan.points[i].lat * Math.PI) / 180)));
    const tick = async () => {
      const s = navRef.current?.routeS ?? 0;
      const first = Math.floor(s / CHUNK), last = Math.floor(Math.min(cum[cum.length - 1], s + 2 * CHUNK) / CHUNK);
      const todo = [];
      for (let k = first; k <= last; k++) if (!prefetched.current.has(k)) todo.push(k);
      if (!todo.length) return;
      // Проверяем не «интернет вообще», а именно те серверы, откуда качаем:
      // карта (OpenFreeMap) и вышки (source.coop) из России доступны по-разному.
      const [mapOk, cellsOk] = await Promise.all([
        mode === 'all' && !fileMap ? probe(ONLINE_STYLE) : Promise.resolve(false),
        probe(cellSourceUrl()),
      ]);
      if (!mapOk && !cellsOk) return; // ничего не доступно — попробуем через 2 минуты
      for (const k of todo) {
        prefetched.current.add(k);
        const pts = plan.points.filter((_, i) => cum[i] >= k * CHUNK - 500 && cum[i] <= (k + 1) * CHUNK + 500);
        if (pts.length < 2) continue;
        const withMap = mapOk;
        enqueue(planCorridor(`Впереди: ${k * 30}–${(k + 1) * 30} км`, pts, withMap));
        dlog(`подкачка впереди: ${k * 30}–${(k + 1) * 30} км (${withMap ? 'карта + вышки' : 'вышки'})`);
      }
    };
    tick();
    const t = setInterval(tick, 120_000);
    return () => clearInterval(t);
  }, [screen, plan, settings.prefetch, fileMap]);

  // ---------- Стрелки поворотов на дороге ----------
  const planCum = useMemo(() => (plan ? cumDist(plan.points) : null), [plan]);
  const arrowsGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const p = screen === 'preview' ? (typeof plans[mode] === 'object' ? (plans[mode] as PlannedRoute) : null) : screen === 'nav' ? plan : null;
    if (!p?.maneuvers?.length) return { type: 'FeatureCollection', features: [] };
    let mans = p.maneuvers;
    if (screen === 'nav' && planCum) {
      // Только ближайшие: следующий поворот и тот, что сразу за ним (если до него < 800 м)
      const cum = planCum;
      const s = nav?.routeS ?? 0;
      const ahead = mans.filter((m) => (cum[m.idx] ?? 0) > s - 15 && m.type > 3 && ![4, 5, 6].includes(m.type));
      mans = ahead.slice(0, 2).filter((m, i) => i === 0 || (cum[m.idx] ?? 0) - s < 800);
    }
    return { type: 'FeatureCollection', features: turnArrows(p.points, mans) };
  }, [screen, plans, mode, plan, Math.round((nav?.routeS ?? 0) / 20)]);

  const curLimit = plan?.mode === 'car' && plan.limits?.length
    ? limitAt(plan.limits, nav?.routeS ?? null)
    : hereLimit && Date.now() - hereLimit.t < 45_000 ? hereLimit.kmh : null;

  const shownLimitsPlan = screen === 'preview' ? (mode === 'car' ? carPlan : null) : screen === 'nav' && plan?.mode === 'car' ? plan : null;
  const limitsGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: shownLimitsPlan ? limitMarks(shownLimitsPlan.points, shownLimitsPlan.limits).map((m) => ({
      type: 'Feature', properties: { kmh: String(m.kmh) }, geometry: { type: 'Point', coordinates: [m.p.lon, m.p.lat] },
    })) : [],
  }), [shownLimitsPlan]);

  // Вместе с картой скачиваем вышки этой области — и сразу подключаем их к ядру
  useEffect(() => {
    setAfterMap(async (plan, progress) => {
      try {
        const { records, count, fields } = await downloadCells(plan.cellBoxes ?? [], (pct, found) => progress(pct, found ? `найдено вышек: ${found}` : undefined));
        await saveAreaCells(plan.name, count);
        setAreaCells(await loadAreaCells());
        if (!count) {
          dlog(`вышки: для «${plan.name}» ничего не нашлось (поля в файле: ${fields.join(', ') || 'нет данных'})`);
          progress(100, 'вышек в этой области в базе нет');
        } else {
          const total = await mergeCells(records);
          await reloadData();
          progress(100, `вышек: ${count} (всего в базе ${total})`);
          if (!plan.name.startsWith('Впереди')) setToast(`«${plan.name}»: скачано ${count} вышек`);
        }
        if (plan.tripId) {
          const areas = await listAreas();
          const matching = areas.find((a) => a.tripId === plan.tripId);
          const mb = Math.round((matching?.bytes ?? 0) / 1e6);
          if (!matching || matching.percent < 99.9) {
            await finalizeTripPart(plan.tripId, 'queue', 'Карта скачалась не полностью (сервер карт не отвечает?). Нажмите «Повторить»', mb);
          } else {
            await updateTrip(plan.tripId, { cellsCount: count });
            await finalizeTripPart(plan.tripId, 'queue', undefined, mb);
          }
        }
      } catch (e: any) {
        if (plan.tripId) await finalizeTripPart(plan.tripId, 'queue', `Вышки: ${e?.message ?? e}`);
        throw e;
      }
    });
  }, []);

  useEffect(() => { loadAreaCells().then(setAreaCells); }, []);

  // Вышки на карте (по желанию): ближайшие к нам ~1500 из базы телефона
  const cellKeyPos = nav?.ready ? `${nav.lat.toFixed(2)},${nav.lon.toFixed(2)}` : '';
  const towersGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!showCells || !nav?.ready || !engine.cellDb) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: engine.cellDb.near({ lat: nav.lat, lon: nav.lon }, 40).map(({ key, rec }) => ({
        type: 'Feature', properties: { key }, geometry: { type: 'Point', coordinates: [rec.lon, rec.lat] },
      })),
    };
  }, [showCells, cellKeyPos, data?.cells]);

  // Подпись «скачано N городов» в настройках + сообщение, когда город докачался
  useEffect(() => {
    const upd = () => listAreas().then((a) => {
      const ok = a.filter((x) => x.percent >= 99.9);
      const q = queueState();
      setMapsSummary(q.current ? `Качается «${q.current.name}» — ${Math.floor(q.current.pct)}%`
        : ok.length ? `Скачано: ${ok.map((x) => x.name).slice(0, 3).join(', ')}${ok.length > 3 ? ` и ещё ${ok.length - 3}` : ''} · ${ok.reduce((m, x) => m + x.mb, 0)} МБ`
        : 'Выберите города — Крым, юг, Москва…');
    });
    let prev: string | null = null;
    const un = subscribeQueue(() => {
      const qs = queueState();
      const cur = qs.current;
      if (cur?.tripId) {
        const pct = Math.floor(cur.pct);
        if (cur.phase === 'вышки') updateTrip(cur.tripId, { progress: { cells: pct } });
        else updateTrip(cur.tripId, { progress: { map: pct } });
      }
      const curName = cur?.name ?? null;
      if (prev && prev !== curName && !prev.startsWith('Впереди')) setToast(`Карта «${prev}» скачана`);
      prev = curName;
      upd();
    });
    upd();
    return un;
  }, []);

  // ---------- Пробки (2ГИС): для выбранного авто-маршрута, в пути — обновляем раз в 3 мин ----------
  const trafficOn = !!settings.traffic && !!settings.gisKey;
  const carPts = screen === 'preview' ? (mode === 'car' && typeof plans.car === 'object' ? plans.car.points : null)
    : screen === 'nav' && plan?.mode === 'car' ? plan.points : null;
  useEffect(() => {
    setTraffic(null);
    setDetours(null);
    if (!trafficOn || !carPts || carPts.length < 2) return;
    const ctrl = new AbortController();
    const ask = async () => {
      const me = navRef.current;
      const from = screen === 'nav' && me?.ready ? { lat: me.lat, lon: me.lon } : carPts[0];
      const { p: to, isEnd, idx: targetIdx, startIdx } = pointAhead(carPts, from, TRAFFIC_AHEAD_M);
      const ours = carPts.slice(startIdx, targetIdx + 1);
      const forPlan = (screen === 'nav' ? plan : (plans.car as PlannedRoute))!;
      try {
        // Основной вариант 2ГИС + до двух других — сразу с пробками
        const routes = await routes2gis(settings.gisKey!, from, to, { alternatives: 2 }, ctrl.signal);
        let { mine, offers } = pickDetours(ours, routes);
        if (!mine && ours.length > 4) {
          // Наш путь не совпал ни с одним — узнаём его время с пробками «через наши точки»
          try {
            const via = [0.25, 0.5, 0.75].map((f) => ours[Math.floor(f * (ours.length - 1))]);
            const [m] = await routes2gis(settings.gisKey!, from, to, { via }, ctrl.signal);
            mine = m;
            offers = pickDetours(ours, routes, m.timeS).offers;
          } catch (e) { dlogError('2ГИС: время нашего маршрута', e); }
        }
        const colored = mine ?? routes[0];
        dlog(`пробки 2ГИС: вариантов ${routes.length}, наш ${mine ? Math.round(mine.timeS / 60) + ' мин' : 'не найден'}, цвета: ${colored.colors.join(', ')}; объезды: ${offers.map((o) => `−${Math.round(o.savingS / 60)} мин`).join(', ') || 'нет'}`);
        setTraffic({ ...colored, isEnd, at: Date.now() });
        const now = Date.now();
        const fresh = offers.filter((o) => (dismissed.current.get(keyOf(o)) ?? 0) < now);
        setDetours(fresh.length ? { offers: fresh, targetIdx, forPlan } : null);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        dlogError('пробки 2ГИС', e);
        setToast(`Пробки 2ГИС: ${e?.message ?? e}`);
      }
    };
    ask();
    const t = screen === 'nav' ? setInterval(ask, 3 * 60_000) : null;
    return () => { ctrl.abort(); if (t) clearInterval(t); };
  }, [trafficOn, carPts, screen, settings.gisKey]);

  // ---------- НЕОФИЦИАЛЬНО (для себя): Waze — пробки, ДТП, перекрытия ----------
  const [waze, setWaze] = useState<WazeData | null>(null);
  const [problem, setProblem] = useState<RouteProblem | null>(null);
  const [avoiding, setAvoiding] = useState(false);
  const skippedProblems = useRef(new globalThis.Map<string, number>());
  const wazeRoute = screen === 'nav' && plan?.mode === 'car' ? plan : screen === 'preview' && mode === 'car' && typeof plans.car === 'object' ? (plans.car as PlannedRoute) : null;
  useEffect(() => {
    setWaze(null); setProblem(null);
    if (!settings.waze) return;
    const ctrl = new AbortController();
    const ask = async () => {
      const me = navRef.current;
      let area: { lat: number; lon: number }[];
      let startIdx = 0;
      if (wazeRoute) {
        const from = screen === 'nav' && me?.ready ? { lat: me.lat, lon: me.lon } : wazeRoute.points[0];
        const a = pointAhead(wazeRoute.points, from, 30_000);
        startIdx = a.startIdx;
        area = wazeRoute.points.slice(a.startIdx, a.idx + 1);
      } else if (me?.ready) {
        area = [{ lat: me.lat, lon: me.lon }];
      } else return;
      try {
        const d = await fetchWaze(bboxOf(area, wazeRoute ? 1.5 : 8), ctrl.signal);
        setWaze(d);
        const probs = wazeRoute ? problemsOnRoute(wazeRoute.points, startIdx, d) : [];
        const now = Date.now();
        const p = probs.find((x) => (skippedProblems.current.get(probKey(x)) ?? 0) < now) ?? null;
        setProblem(p);
        dlogEvery('waze', 3, `Waze: пробок ${d.jams.length}, меток ${d.alerts.length}${probs.length ? `; на маршруте: ${probs.map((x) => `${x.label} ${Math.round(x.distM / 100) / 10} км`).join(', ')}` : ''}`);
      } catch (e: any) {
        if (e?.name !== 'AbortError') dlogEvery('waze-ошибка', 5, 'Waze недоступен:', String(e?.message ?? e));
      }
    };
    ask();
    const t = setInterval(ask, 120_000);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [settings.waze, wazeRoute, screen, nav?.ready]);

  // ---------- НЕОФИЦИАЛЬНО: пробки Яндекса — читаем цвет плиток под маршрутом, рисуем своей линией ----------
  const [ytraffic, setYtraffic] = useState<{ segs: TrafficRoute['segs']; at: number; jamDelayS: number } | null>(null);
  const [yProblem, setYProblem] = useState<RouteProblem | null>(null);
  useEffect(() => {
    setYtraffic(null); setYProblem(null);
    if (!settings.yandex || !wazeRoute) return;
    const ctrl = new AbortController();
    const ask = async () => {
      const me = navRef.current;
      const from = screen === 'nav' && me?.ready ? { lat: me.lat, lon: me.lon } : wazeRoute.points[0];
      const { startIdx } = pointAhead(wazeRoute.points, from, 0);
      try {
        const r = await yandexAlongRoute(wazeRoute.points, startIdx, 40_000, { urlTemplate: settings.yandexUrl, signal: ctrl.signal });
        const jams = yandexJams(r.segs);
        const jamDelayS = jams.reduce((a, j) => a + j.delayS, 0);
        setYtraffic({ segs: r.segs, at: Date.now(), jamDelayS });
        dlog(`пробки Яндекса: плиток ${r.tiles} (ошибок ${r.failed}), окрашено ${r.colored}/${r.samples} точек ${JSON.stringify(r.stats)}, пробок ${jams.length}${jamDelayS > 60 ? `, +${Math.round(jamDelayS / 60)} мин` : ''}`);
        const ahead = wazeRoute.points.slice(startIdx);
        const now = Date.now();
        const big = jams.filter((j) => j.delayS >= 180)
          .map((j) => ({ kind: 'jam' as const, label: j.level === 'jam' ? 'Пробка' : 'Затор', at: j.at, distM: onLine(j.startPt, ahead).s, delayS: j.delayS, street: '', source: 'Яндекса' }))
          .filter((p) => (skippedProblems.current.get(probKey(p)) ?? 0) < now)
          .sort((a, b) => a.distM - b.distM);
        setYProblem(big[0] ?? null);
      } catch (e: any) {
        if (e?.name !== 'AbortError') dlogEvery('яндекс-ошибка', 3, 'пробки Яндекса недоступны:', String(e?.message ?? e));
      }
    };
    ask();
    const t = setInterval(ask, 180_000);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [settings.yandex, settings.yandexUrl, wazeRoute, screen, nav?.ready]);
  const shownProblem = problem ?? yProblem;

  const probKey = (p: RouteProblem) => `${p.kind}:${p.at.lat.toFixed(3)},${p.at.lon.toFixed(3)}`;

  /** Объехать ДТП/перекрытие/пробку: новый маршрут Valhalla в обход этих мест. */
  async function avoidProblem(p: RouteProblem) {
    const base = wazeRoute;
    if (!base || avoiding) return;
    setAvoiding(true);
    try {
      const me = navRef.current;
      const from = screen === 'nav' && me?.ready ? { lat: me.lat, lon: me.lon } : base.points[0];
      const to = base.points[base.points.length - 1];
      // Обходим все блокирующие места на маршруте, а не только первое
      const all = waze ? problemsOnRoute(base.points, pointAhead(base.points, from, 0).startIdx, waze, 60_000) : [p];
      const avoid = [...all.filter((x) => x.kind === 'alert').map((x) => x.at), p.at];
      const alt = await planRoute(from, to, 'car', undefined, avoid);
      const left = base.lengthM > 0 ? base.timeS * (1 - (pointAhead(base.points, from, 0).startIdx / Math.max(1, base.points.length - 1))) : 0;
      const oursWithDelay = left + (p.kind === 'jam' ? p.delayS : 0);
      if (p.kind === 'jam' && alt.timeS > oursWithDelay - 60) {
        setToast(`Объезд не быстрее: ${fmtDuration(alt.timeS)} против ~${fmtDuration(oursWithDelay)} с пробкой`);
        skippedProblems.current.set(probKey(p), Date.now() + 15 * 60_000);
        setProblem(null);
        return;
      }
      const next: PlannedRoute = { ...alt, dest: base.dest };
      dlog(`объезд ${p.label}: новый маршрут ${fmtDuration(alt.timeS)}, ${fmtDistance(alt.lengthM)}`);
      if (screen === 'preview') setPlans((ps) => ({ ...ps, car: next }));
      else { setPlan(next); engine.setRoute(next.points, next.maneuvers); await savePlan(next); }
      setProblem(null); setYProblem(null);
      setToast(`Едем в объезд: ${p.label.toLowerCase()} позади`);
      if (screen === 'nav') attachLimits(next);
    } catch (e: any) {
      dlogError('объезд', e);
      setToast(`Не удалось проложить объезд: ${e?.message ?? e}`);
    } finally { setAvoiding(false); }
  }

  const wazeGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: [
      ...(waze?.jams ?? []).filter((j) => j.level >= 1).map((j) => line(j.pts, { c: jamColor(j.level) })),
      ...(waze?.alerts ?? []).map((a) => {
        const inf = alertInfo(a);
        return { type: 'Feature', properties: { label: inf.label, c: inf.color }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } } as GeoJSON.Feature;
      }),
    ],
  }), [waze]);

  const gUrl = settings.gTrafficUrl || 'https://mt{s}.google.com/vt/lyrs=h,traffic&hl=ru&x={x}&y={y}&z={z}';
  const gTiles = [0, 1, 2, 3].map((n) => gUrl.replace('{s}', String(n)));

  const keyOf = (o: DetourOffer) => `${o.divergeAt.lat.toFixed(3)},${o.divergeAt.lon.toFixed(3)}:${Math.round(o.route.lengthM / 500)}`;

  /** Согласились на объезд: меняем кусок маршрута. */
  async function takeDetour(o: DetourOffer) {
    if (!detours) return;
    const next = spliceDetour(detours.forPlan, detours.targetIdx, o.route);
    setDetours(null);
    dlog(`объезд принят: −${Math.round(o.savingS / 60)} мин, ${o.via || 'другая дорога'}`);
    if (screen === 'preview') {
      setPlans((ps) => ({ ...ps, car: next }));
      setToast(`Выбран объезд: быстрее на ${fmtDuration(o.savingS)}`);
      return;
    }
    setPlan(next);
    engine.setRoute(next.points, next.maneuvers);
    await savePlan(next);
    setToast(`Едем в объезд: быстрее на ${fmtDuration(o.savingS)}`);
    attachLimits(next);
  }
  function skipDetour(o: DetourOffer) {
    dismissed.current.set(keyOf(o), Date.now() + 15 * 60_000);
    setDetours((d) => (d ? (d.offers.length > 1 ? { ...d, offers: d.offers.filter((x) => x !== o) } : null) : null));
  }

  const detourGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: (detours?.offers ?? []).flatMap((o, i) => {
      const mid = o.route.points[Math.floor(o.route.points.length / 2)];
      return [
        line(o.route.points, { n: i }),
        { type: 'Feature', properties: { label: `−${Math.max(1, Math.round(o.savingS / 60))} мин` }, geometry: { type: 'Point', coordinates: [mid.lon, mid.lat] } } as GeoJSON.Feature,
      ];
    }),
  }), [detours]);

  const trafficGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    // 2ГИС главнее; нет его — рисуем пробки, прочитанные с плиток Яндекса
    features: (traffic?.segs ?? ytraffic?.segs ?? []).filter((g) => TRAFFIC_COLOR[g.color]).map((g) => line(g.pts, { c: TRAFFIC_COLOR[g.color] })),
  }), [traffic, ytraffic]);

  const trafficNote = traffic && mode === 'car'
    ? (traffic.isEnd ? `с пробками ${fmtDuration(traffic.timeS)} (2ГИС)` : `пробки показаны на ближайшие ${Math.round(TRAFFIC_AHEAD_M / 1000)} км`)
    : ytraffic && mode === 'car' ? (ytraffic.jamDelayS > 60 ? `пробки Яндекса впереди: +${fmtDuration(ytraffic.jamDelayS)}` : 'по Яндексу пробок нет')
    : trafficOn ? 'считаем пробки…' : '';

  function pickDest(p: Place) {
    resetHostHealth(); // новое действие пользователя — заново пробуем все серверы
    setDest(p);
    setStops([]);
    setCand(null);
    setPlans({});
    setScreen('preview');
    setFollow(false);
    setActiveTripId(null);
    setFuelOn(false);
    addRecent(p).then(setRecent).catch((e) => dlogError('недавние', e));
  }

  async function replanNav(newStops: Stop[]) {
    if (!plan || !nav?.ready) return;
    const from = { lat: nav.lat, lon: nav.lon };
    const destPlace: Place = plan.dest ?? { lat: plan.points[plan.points.length - 1].lat, lon: plan.points[plan.points.length - 1].lon, name: 'Финиш', detail: '' };
    try {
      const newPlan = await planRouteVia(from, newStops, destPlace, plan.mode);
      const full: PlannedRoute = { ...newPlan, dest: destPlace };
      setPlan(full);
      engine.setRoute(full.points, full.maneuvers);
      savePlan(full);
      if (full.mode === 'car' && !full.offline) attachLimits(full);
    } catch (e) {
      dlogError('пересчёт с остановками', e);
      setToast('Не удалось перестроить маршрут через остановку');
    }
  }

  function addStop(st: Stop) {
    setCand(null);
    if (screen === 'preview') {
      setStops((prev) => [...prev, st]);
      setPlans({});
      return;
    }
    if (screen === 'nav' && plan) {
      const nextStops = [...(plan.stops ?? []), st];
      replanNav(nextStops);
      return;
    }
    pickDest({ name: st.name, detail: 'Остановка', lat: st.lat, lon: st.lon });
  }

  function removeStop(idx: number) {
    if (screen === 'preview') {
      setStops((prev) => prev.filter((_, i) => i !== idx));
      setPlans({});
      return;
    }
    if (screen === 'nav' && plan) {
      const nextStops = (plan.stops ?? []).filter((_, i) => i !== idx);
      replanNav(nextStops);
    }
  }

  // Если подъехали к очередной остановке ближе 70 м — считаем пройденной и удаляем
  useEffect(() => {
    if (screen !== 'nav' || !plan?.stops?.length || !nav?.ready) return;
    const first = plan.stops[0];
    if (haversine({ lat: nav.lat, lon: nav.lon }, first) < 70) {
      voice.speak(`Остановка ${first.name} пройдена`);
      setToast(`Остановка «${first.name}» пройдена`);
      removeStop(0);
    }
  }, [screen, plan?.stops, nav?.ready, nav?.lat, nav?.lon]);

  /** Тап по скачанной поездке: готовая открывается сразу, с ошибкой — открывает превью, там кнопка «Повторить». */
  async function openTrip(t: Trip) {
    if (t.status === 'queued' || t.status === 'downloading') { setToast('Поездка ещё скачивается'); return; }
    if (t.status === 'error') {
      pickDest(t.dest);
      setActiveTripId(t.id); // кнопка в превью покажет ошибку, повтор использует тот же id
      return;
    }
    const route = await getTripRoute(t.id);
    if (!route || route.points.length < 2) { setToast('У этой поездки нет сохранённого маршрута'); return; }
    setPlan(route);
    setMode(route.mode);
    engine.setRoute(route.points, route.maneuvers);
    engine.setTravelMode(route.mode);
    savePlan(route).catch((e) => dlogError('сохранить маршрут', e));
    setScreen('nav');
    setFollow(true);
    setToast(`Едем по сохранённому маршруту: ${t.name}`);
  }

  function removeTrip(t: Trip) {
    if (t.status === 'queued' || t.status === 'downloading') { setToast('Дождитесь конца загрузки'); return; }
    Alert.alert(`Удалить «${t.name}»?`, 'Карта, дороги и маршрут этой поездки будут удалены с телефона. Вышки останутся в общей базе.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => {
        deleteTrip(t.id, deleteTripMaps)
          .then(() => { if (activeTripId === t.id) setActiveTripId(null); setToast('Поездка удалена'); })
          .catch((e) => dlogError('удалить поездку', e));
      } },
    ]);
  }

  async function go() {
    setFuelOn(false);
    const p = plans[mode];
    if (typeof p !== 'object') return;
    const full: PlannedRoute = { ...p, dest: dest ?? undefined };
    // Едем сразу. Знаки скорости догружаются в фоне (раньше кнопка ждала сервер без таймаута).
    setPlan(full);
    engine.setRoute(full.points, full.maneuvers);
    engine.setTravelMode(mode);
    setScreen('nav');
    setFollow(true);
    savePlan(full).then(() => reloadData()).catch((e) => dlogError('сохранить маршрут', e));
    if (mode === 'car' && !full.limits) attachLimits(full);
  }

  /** Знаки скорости в фоне: пришли — дописываем в текущий маршрут и сохраняем. */
  function attachLimits(base: PlannedRoute) {
    fetchSpeedLimits(base.points)
      .then((limits) => {
        setPlan((cur) => {
          if (!cur || cur.createdAt !== base.createdAt) return cur;
          const p2 = { ...cur, limits };
          savePlan(p2).catch(() => {});
          return p2;
        });
      })
      .catch((e) => dlogError('знаки скорости', e));
  }

  async function prepareOffline(r: PlannedRoute) {
    let full: PlannedRoute = { ...r, dest: dest ?? undefined };
    setToast('Подготавливаем маршрут, вышки и карту для офлайна…');
    await savePlan(full);
    if (mode === 'car' && !full.limits) {
      try { full = { ...full, limits: await fetchSpeedLimits(full.points) }; await savePlan(full); } catch (e) { dlogError('знаки для офлайна', e); }
    }
    setPlan(full);
    const routeName = full.dest?.name || 'Запланированный маршрут';

    const tripId = activeTripId || `trip_${full.createdAt || Date.now()}`;
    setActiveTripId(tripId);
    if (activeTripId) await deleteTripMaps(tripId); // повтор после ошибки: убрать недокачанные паки этой поездки

    let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
    for (const p of full.points) {
      minLon = Math.min(minLon, p.lon); minLat = Math.min(minLat, p.lat);
      maxLon = Math.max(maxLon, p.lon); maxLat = Math.max(maxLat, p.lat);
    }
    const bbox: BBox = [minLon - 0.05, minLat - 0.05, maxLon + 0.05, maxLat + 0.05];
    const destPlace: Place = full.dest ?? { name: routeName, detail: '', lat: full.points[full.points.length - 1].lat, lon: full.points[full.points.length - 1].lon };

    const trip: Trip = {
      id: tripId,
      name: routeName,
      dest: destPlace,
      mode: full.mode || mode,
      createdAt: full.createdAt || Date.now(),
      status: 'downloading',
      progress: { map: 0, cells: 0, graph: 0 },
      totalPct: 0,
      mb: 0,
      cellsCount: 0,
      bbox,
      queueDone: false,
      graphDone: false,
    };
    await saveTrip(trip);
    await saveTripRoute(tripId, full);

    // 1) Ставим карту и вышки в очередь с привязкой к tripId
    const corridorPlan = planCorridor(routeName, full.points, true);
    corridorPlan.tripId = tripId;
    corridorPlan.forceCells = true;
    enqueue(corridorPlan);

    // 2) Скачиваем граф дорог для этой поездки
    try {
      const graph = await downloadCorridor(full.points, {
        onProgress: (pct) => {
          updateTrip(tripId, { progress: { graph: Math.round(pct) } });
        },
      });
      await saveTripGraph(tripId, graph);
      await finalizeTripPart(tripId, 'graph');
      dlog(`офлайн-граф дорог для поездки «${routeName}» сохранён`);
    } catch (e: any) {
      dlogError('офлайн граф дорог', e);
      await finalizeTripPart(tripId, 'graph', String(e?.message ?? e));
    }

    await reloadData();
    setToast(`Маршрут «${routeName}» сохранён и качается в фоне!`);
  }

  // ---------- Автоматический пересчёт при съезде с маршрута ----------
  const reroutingRef = useRef(false);
  useEffect(() => {
    if (screen !== 'nav' || !plan || !nav?.ready || nav.onRoute || reroutingRef.current) return;
    reroutingRef.current = true;
    dlog('съезд с маршрута! Пробуем перестроить путь…');
    voice.speak('Вы съехали с маршрута, перестраиваем путь');
    setToast('Съезд с маршрута — перестраиваем путь…');

    const from = { lat: nav.lat, lon: nav.lon };
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 12_000);
    const destPlace: Place = plan.dest ?? { lat: plan.points[plan.points.length - 1].lat, lon: plan.points[plan.points.length - 1].lon, name: 'Финиш', detail: '' };

    planRouteVia(from, plan.stops ?? [], destPlace, plan.mode, ctrl.signal)
      .then((newPlan) => {
        clearTimeout(tm);
        const full: PlannedRoute = { ...newPlan, dest: destPlace };
        setPlan(full);
        engine.setRoute(full.points, full.maneuvers);
        savePlan(full);
        voice.speak('Маршрут перестроен');
        setToast(full.offlineGraph ? 'Маршрут перестроен по сохранённым дорогам' : 'Маршрут перестроен');
        if (full.mode === 'car' && !full.offline) attachLimits(full);
      })
      .catch((e) => {
        clearTimeout(tm);
        dlogError('офлайн-перестройка (нет интернета / сервер недоступен)', e);
        if (plan.points.length >= 2) {
          const { p: targetPt, idx } = pointAhead(plan.points, from, 300);
          const remaining = plan.points.slice(Math.max(0, idx));
          const reconnectedPts = [from, targetPt, ...remaining];
          const reconnectedPlan: PlannedRoute = { ...plan, points: reconnectedPts };
          setPlan(reconnectedPlan);
          engine.setRoute(reconnectedPts, reconnectedPlan.maneuvers);
          voice.speak('Возвращаем на исходную тропу');
          setToast('Возвращаем на заготовленный маршрут');
        }
      })
      .finally(() => {
        setTimeout(() => { reroutingRef.current = false; }, 10_000);
      });
  }, [screen, plan, nav?.ready, nav?.onRoute]);

  function stop() {
    engine.clearRoute();
    clearPlan();
    setPlan(null);
    setPlans({});
    setDest(null);
    setScreen('map');
    setActiveTripId(null);
    reloadData();
  }

  async function doImport(kind: Kind) {
    setToast('Копируем файл…');
    const err = await importFile(kind);
    setToast(err || 'Готово');
    await reloadData(kind === 'route');
  }

  function updateSettings(st: Settings) {
    setSettings(st);
    saveSettings(st);
  }

  // ---------- Карта ----------
  const style = useMemo(() => {
    if (fileMap) return fileStyle(fileMap, dark);
    if (onlineStyle && typeof onlineStyle === 'object') { const sk = skinStyle(onlineStyle, dark); return lite ? liteStyle(sk) : sk; }
    return buildStyle(null);
  }, [fileMap, onlineStyle, dark, lite]);

  const routesGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const f: GeoJSON.Feature[] = [];
    if (screen === 'preview') {
      for (const [m, p] of Object.entries(plans)) {
        if (typeof p === 'object') {
          f.push(line(p.points, { sel: m === mode ? 1 : 0, dashed: m === 'walk' ? 1 : 0 }));
        }
      }
      f.sort((a, b) => (a.properties!.sel as number) - (b.properties!.sel as number));
    } else if (plan) {
      f.push(line(plan.points, { sel: 1, dashed: plan.mode === 'walk' ? 1 : 0 }));
    }
    return { type: 'FeatureCollection', features: f };
  }, [screen, plans, mode, plan]);

  // Пройденная часть маршрута — серым, как в навигаторах
  // Обновляем раз в ~25 м пути (а не каждую секунду с перебором всех точек маршрута)
  const passedStep = nav?.routeS != null ? Math.floor(nav.routeS / 25) : -1;
  const passedGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (screen !== 'nav' || !plan || !planCum || passedStep < 1 || plan.points.length < 2) return { type: 'FeatureCollection', features: [] };
    const s = passedStep * 25;
    const i = idxAt(planCum, s);
    if (i >= plan.points.length - 1) return { type: 'FeatureCollection', features: [line(plan.points, {})] };
    const a = plan.points[i], b = plan.points[i + 1];
    const seg = planCum[i + 1] - planCum[i];
    const k = seg > 0 ? (s - planCum[i]) / seg : 0;
    const end = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
    return { type: 'FeatureCollection', features: [line([...plan.points.slice(0, i + 1), end], {})] };
  }, [screen, plan, planCum, passedStep]);
  const routeColor = MODE_COLOR[screen === 'preview' ? mode : plan?.mode ?? 'car'];
  const dashed = (screen === 'preview' ? mode : plan?.mode) === 'walk';

  const target = screen === 'preview' ? dest : plan?.dest ?? null;
  const destGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: target ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [target.lon, target.lat] } }] : [],
  }), [target?.lat, target?.lon]);

  // «Я» рисует отдельный компонент MeLayer — его анимация не перерисовывает весь экран.

  const view3d = settings.view3d ?? !lite;
  const selPlan = typeof plans[mode] === 'object' ? (plans[mode] as PlannedRoute) : null;
  useEffect(() => { if (nav?.ready) dlog(`карта: показываю себя ${nav.lat.toFixed(5)},${nav.lon.toFixed(5)} follow=${follow} экран=${screen}`); }, [nav?.ready]);
  const camera = (() => {
    // Поля камеры = место под панелями: «я» и маршрут не должны прятаться за карточками
    const previewPad = wide ? { top: 60, bottom: 60, left: PANEL_W + 60, right: 90 } : { top: top + sz(120), bottom: Math.round(win.height * 0.55), left: sz(40), right: sz(40) };
    if (screen === 'preview') {
      // Маршрут есть — показываем его целиком; нет (строится / не построился) — меня и точку назначения
      const pts = selPlan ? selPlan.points : nav?.ready && dest ? [{ lat: nav.lat, lon: nav.lon }, dest] : null;
      if (pts) {
        const [w, s0, e, n] = bounds(pts);
        const m = 0.003; // чтобы две близкие точки не давали бесконечный зум
        return <Camera bounds={[w - m, s0 - m, e + m, n + m]} padding={previewPad} duration={700} easing="ease" />;
      }
    }
    if (follow && nav?.ready) {
      if (screen === 'nav') {
        const walk = plan?.mode === 'walk' || nav.walking;
        // стрелка — в нижней трети, как в навигаторах: сверху карточка манёвра, снизу панель
        const navPad = wide ? { top: 40, bottom: 40, left: PANEL_W + 40, right: 40 } : { top: Math.round(win.height * 0.42), bottom: sz(150), left: 0, right: 0 };
        return <Camera center={[nav.lon, nav.lat]} zoom={walk ? 17.5 : 16} bearing={nav.speedKmh > 4 ? nav.headingDeg : undefined} pitch={view3d ? (walk ? 40 : 55) : 0} padding={navPad} duration={1000} easing="linear" />;
      }
      const mapPad = wide ? { top: 0, bottom: 0, left: PANEL_W, right: 0 } : { top: top + sz(60), bottom: sz(130), left: 0, right: 0 };
      return <Camera center={[nav.lon, nav.lat]} zoom={15} pitch={view3d ? 45 : 0} padding={mapPad} duration={1000} easing="linear" />;
    }
    return <Camera />;
  })();

  const showTraffic = trafficOn;
  const gps = !nav ? GPS_LABEL.none
    : nav.gps === 'ok' && nav.gnssUsed === 0 ? { text: 'Место по Wi‑Fi/сети', color: C.blue }
    : nav.gps !== 'ok' && nav.coarse && nav.coarse.age < 30 ? { text: `${GPS_LABEL[nav.gps].text} · вышки ±${Math.round(nav.coarse.accuracy)} м`, color: GPS_LABEL[nav.gps].color }
    : GPS_LABEL[nav.gps];

  const details = (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {obd.s !== 'off' && <Chip text={obd.s === 'on' ? 'Колёса (OBD)' : obd.s === 'connecting' ? 'OBD: связь…' : 'OBD: ошибка'} color={obd.s === 'on' ? C.green : C.red} />}
        {gyroOk === false && <Chip text="Гироскопа нет" color={C.hint} />}
        <Chip text={`Вышки: ${nav?.cells ?? 0}, Wi‑Fi: ${nav?.wifiSeen ?? 0}, знаем ${nav?.cellsKnown ?? 0}`} color={(nav?.cellsKnown ?? 0) > 0 ? C.green : C.hint} />
        {nav?.ready && <Chip text={`Точность ±${Math.round(nav.sigma)} м`} color={C.blue} />}
        {nav?.walking && <Chip text={`Шаг ${nav.stepLen.toFixed(2)} м`} color={C.blue} />}
      </View>
      {!!nav?.mode && <Text style={[ui.sub, { marginTop: 6 }]}>Сейчас ведёт: {nav.mode}</Text>}
      {!!nav?.gpsReason && nav.gps !== 'ok' && <Text style={[ui.sub, { color: C.redText }]}>Почему: {nav.gpsReason}</Text>}
      {!!nav?.signalHint && <Text style={[ui.sub, { color: C.redText }]}>Сигнал спутников {nav.signalHint}</Text>}
      {!!nav?.lastFix && <Text style={ui.sub}>Последняя привязка: {nav.lastFix}</Text>}
    </View>
  );

  return (
    <View style={s.root}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Map
        style={s.map}
        mapStyle={style}
        compass={false}
        logo={false}
        attributionPosition={{ bottom: 8, left: 8 }}
        onRegionWillChange={(e) => { if (e.nativeEvent.userInteraction) setFollow(false); }}
        onRegionDidChange={(e) => {
          const b = (e as any)?.properties?.heading ?? (e as any)?.geometry?.heading ?? 0;
          if (Math.abs(b - mapBearing) > 2) setMapBearing(Math.round(b));
        }}
        onPress={(e) => {
          if (!picking) return;
          const [lon, lat] = e.nativeEvent.lngLat;
          engine.manualFix(now(), lat, lon);
          log.add({ e: 'manual', t: now(), lat, lon });
          setPicking(false);
          setFollow(true);
          setToast('Позиция отмечена');
        }}
        onLongPress={(e) => {
          const [lon, lat] = e.nativeEvent.lngLat;
          const pt = { name: 'Точка на карте', detail: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
          if (screen === 'map' && !plan) {
            pickDest(pt);
          } else {
            setCand(pt);
          }
        }}
      >
        {camera}
        <Images images={{
          'me-arrow': require('./assets/map/me-arrow.png'), 'me-arrow-warn': require('./assets/map/me-arrow-warn.png'),
          'me-dot': require('./assets/map/me-dot.png'), 'me-dot-warn': require('./assets/map/me-dot-warn.png'),
        }} />
        {!!settings.gTraffic && (
          <RasterSource id="g-traffic" tiles={gTiles} tileSize={256}>
            <Layer type="raster" id="g-traffic-layer" paint={{ 'raster-opacity': dark ? 0.75 : 0.9 }} />
          </RasterSource>
        )}
        <GeoJSONSource id="routes" data={routesGeo}>
          {!lite && <Layer type="line" id="route-glow" filter={['==', ['get', 'sel'], 1]} paint={{ 'line-color': routeColor, 'line-width': 22, 'line-blur': 10, 'line-opacity': dark ? 0.45 : 0.22 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />}
          <Layer type="line" id="route-casing" filter={['==', ['get', 'sel'], 1]} paint={{ 'line-color': C.casing, 'line-width': 11 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="route-alt" filter={['==', ['get', 'sel'], 0]} paint={{ 'line-color': C.altRoute, 'line-width': 5, 'line-opacity': 0.8 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="route-solid" filter={['all', ['==', ['get', 'sel'], 1], ['!=', ['get', 'dashed'], 1]]}
            paint={{ 'line-color': routeColor, 'line-width': 7 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="route-dashed" filter={['all', ['==', ['get', 'sel'], 1], ['==', ['get', 'dashed'], 1]]}
            paint={{ 'line-color': routeColor, 'line-width': 7, 'line-dasharray': [1.2, 1.2] }}
            layout={{ 'line-cap': 'butt', 'line-join': 'round' }} />
        </GeoJSONSource>
        <GeoJSONSource id="detours" data={detourGeo}>
          <Layer type="line" id="detour-case" filter={['==', ['geometry-type'], 'LineString']} paint={{ 'line-color': C.casing, 'line-width': 9, 'line-opacity': 0.9 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="line" id="detour-line" filter={['==', ['geometry-type'], 'LineString']} paint={{ 'line-color': '#2fb344', 'line-width': 5, 'line-dasharray': [2, 1.2] }} layout={{ 'line-join': 'round' }} />
          <Layer type="symbol" id="detour-label" filter={['==', ['geometry-type'], 'Point']}
            layout={{ 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 14, 'text-allow-overlap': true }}
            paint={{ 'text-color': '#ffffff', 'text-halo-color': '#2fb344', 'text-halo-width': 6 }} />
        </GeoJSONSource>
        <GeoJSONSource id="traffic" data={trafficGeo}>
          <Layer type="line" id="traffic-line" paint={{ 'line-color': ['get', 'c'], 'line-width': 7 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        </GeoJSONSource>
        <GeoJSONSource id="waze" data={wazeGeo}>
          <Layer type="line" id="waze-jam" filter={['==', ['geometry-type'], 'LineString']} paint={{ 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 7], 'line-opacity': 0.9 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          <Layer type="circle" id="waze-alert" filter={['==', ['geometry-type'], 'Point']} paint={{ 'circle-radius': 9, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }} />
          <Layer type="symbol" id="waze-alert-text" minzoom={12} filter={['==', ['geometry-type'], 'Point']}
            layout={{ 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.4], 'text-anchor': 'top' }}
            paint={{ 'text-color': C.text, 'text-halo-color': C.card, 'text-halo-width': 1.5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="passed" data={passedGeo}>
          <Layer type="line" id="passed-line" paint={{ 'line-color': C.passed, 'line-width': 7 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        </GeoJSONSource>
        <GeoJSONSource id="turn-arrows" data={arrowsGeo}>
          <Layer type="line" id="turn-shaft-case" minzoom={13} filter={['==', ['get', 'part'], 'shaft']} paint={{ 'line-color': '#020617', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 8, 18, 28] }} layout={{ 'line-cap': 'butt', 'line-join': 'round' }} />
          <Layer type="line" id="turn-shaft" minzoom={13} filter={['==', ['get', 'part'], 'shaft']} paint={{ 'line-color': '#ffffff', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 4, 18, 16] }} layout={{ 'line-cap': 'butt', 'line-join': 'round' }} />
          <Layer type="line" id="turn-head-case" minzoom={13} filter={['==', ['get', 'part'], 'head']} paint={{ 'line-color': '#020617', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 2.5, 18, 7] }} layout={{ 'line-join': 'round' }} />
          <Layer type="fill" id="turn-head" minzoom={13} filter={['==', ['get', 'part'], 'head']} paint={{ 'fill-color': '#ffffff' }} />
        </GeoJSONSource>
        <GeoJSONSource id="pois" data={poisGeo}>
          <Layer type="circle" id="poi-dot" minzoom={11} paint={{ 'circle-radius': 7, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 }} />
          <Layer type="symbol" id="poi-text" minzoom={13}
            layout={{ 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' }}
            paint={{ 'text-color': C.text, 'text-halo-color': C.card, 'text-halo-width': 1.5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="fuel" data={fuelGeo} cluster clusterRadius={45}>
          <Layer type="circle" id="fuel-cluster" filter={['has', 'point_count']} paint={{ 'circle-radius': 17, 'circle-color': '#2f9e44', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }} />
          <Layer type="symbol" id="fuel-cluster-n" filter={['has', 'point_count']}
            layout={{ 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-allow-overlap': true }}
            paint={{ 'text-color': '#ffffff' }} />
          <Layer type="circle" id="fuel-dot" filter={['!', ['has', 'point_count']]} paint={{ 'circle-radius': 9, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }} />
          <Layer type="symbol" id="fuel-name" minzoom={13} filter={['!', ['has', 'point_count']]}
            layout={{ 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' }}
            paint={{ 'text-color': C.text, 'text-halo-color': C.card, 'text-halo-width': 1.5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="stops" data={stopsGeo}>
          <Layer type="circle" id="stops-dot" paint={{ 'circle-radius': 11, 'circle-color': C.blue, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 }} />
          <Layer type="symbol" id="stops-n" layout={{ 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 }} paint={{ 'text-color': '#ffffff' }} />
        </GeoJSONSource>
        <GeoJSONSource id="dest" data={destGeo}>
          <Layer type="circle" id="dest-dot" paint={{ 'circle-radius': 9, 'circle-color': C.red, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 }} />
        </GeoJSONSource>
        <MeLayer nav={nav} smooth={!lite} />
        <GeoJSONSource id="towers" data={towersGeo}>
          <Layer type="circle" id="tower-dot" paint={{ 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 6], 'circle-color': '#7048e8', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.85 }} />
        </GeoJSONSource>
        <GeoJSONSource id="limits" data={limitsGeo}>
          <Layer type="circle" id="limit-sign" minzoom={11} paint={{ 'circle-radius': 13, 'circle-color': '#ffffff', 'circle-stroke-color': '#e03131', 'circle-stroke-width': 3.5 }} />
          <Layer type="symbol" id="limit-text" minzoom={11}
            layout={{ 'text-field': ['get', 'kmh'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': true, 'icon-allow-overlap': true }}
            paint={{ 'text-color': '#111111' }} />
        </GeoJSONSource>
      </Map>

      {/* ---------- Карта: строка «Куда?» ---------- */}
      {screen === 'map' && sheet === 'none' && (
        <>
          <Pressable style={[ui.card, s.search, { top }, wide && { right: undefined, width: PANEL_W }]} onPress={() => setScreen('search')}>
            <Icon name="magnify" size={24} color={C.sub} style={{ marginRight: 10 }} />
            <Text style={s.searchText}>Куда поедем?</Text>
          </Pressable>
          {data?.plan && !fuelOn && (
            <Pressable
              style={[ui.card, s.savedPlanBanner, { top: top + sz(62) }, wide && { right: undefined, width: PANEL_W }]}
              onPress={() => {
                setPlan(data.plan);
                engine.setRoute(data.plan!.points, data.plan!.maneuvers);
                engine.setTravelMode(data.plan!.mode);
                setScreen('nav');
                setFollow(true);
                setToast(`Запущен заготовленный маршрут: ${data.plan!.dest?.name || 'Офлайн'}`);
              }}
            >
              <Icon name="navigation-variant" size={20} color={C.green} style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={s.savedPlanTitle} numberOfLines={1}>
                  Офлайн-маршрут: {data.plan.dest?.name || 'Заготовленный'}
                </Text>
                <Text style={ui.sub} numberOfLines={1}>
                  {fmtDistance(data.plan.lengthM)} · Нажмите, чтобы поехать без интернета
                </Text>
              </View>
            </Pressable>
          )}
          {!fuelOn && (
            <>
              <View style={[ui.card, s.status, { bottom }, wide && { right: undefined, width: PANEL_W }]}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <GpsStatusIndicator nav={nav} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: -6 }}>
                      <Chip text={nav?.context ?? 'Датчики…'} color={C.blue} />
                      {nav?.ready && <Chip text={`±${Math.round(nav.sigma)} м`} color={nav.gps === 'ok' ? C.green : C.amber} />}
                    </View>
                    {!compact && <Text style={[ui.sub, { marginTop: 6 }]}>Зажмите карту — маршрут в эту точку</Text>}
                  </View>
                </View>
              </View>
              <SpeedOverlay nav={nav} limit={curLimit} top={top + sz(data?.plan ? 132 : 66)} />
              <WeatherChip now={wxNow} style={{ position: 'absolute', left: sz(12), bottom: bottom + sz(compact ? 92 : 108) }}
                onPress={() => wxNow && setToast(`Сейчас ${wxNow.temp > 0 ? '+' : ''}${Math.round(wxNow.temp)}°, ${wxNow.text}, ветер ${Math.round(wxNow.wind)} м/с`)} />
            </>
          )}
        </>
      )}

      {/* ---------- Кнопки справа ---------- */}
      {screen !== 'search' && (
        <View style={[s.side, { bottom: bottom + sz(compact ? 100 : 118) }, screen === 'nav' && { bottom: sz(230) }]}>
          <MapButtonGroup items={[
            ...(Math.abs(mapBearing) > 5 ? [{ icon: 'compass-outline' as IconName, active: true, onPress: () => { setMapBearing(0); setFollow(true); setToast('Карта ориентирована на север'); } }] : []),
            { icon: 'gas-station' as IconName, active: fuelOn, onPress: toggleFuel },
            { icon: 'cog-outline', onPress: () => setSheet('settings') },
            { icon: view3d ? 'video-3d' : 'video-2d', active: view3d, onPress: () => { updateSettings({ ...settings, view3d: !view3d }); setFollow(true); } },
            { icon: 'traffic-light-outline', active: showTraffic, onPress: () => {
              if (!settings.gisKey) { setToast('Для пробок нужен бесплатный ключ 2ГИС — введите его в настройках'); setSheet('settings'); return; }
              const on = !settings.traffic;
              updateSettings({ ...settings, traffic: on });
              setToast(on ? (carPts ? 'Пробки: красим маршрут' : 'Пробки покажутся на линии авто-маршрута') : 'Пробки выключены');
            } },
            { icon: 'bug-outline', active: debug, onPress: () => setDebug((x) => !x) },
          ]} />
          <MapButton icon="navigation-variant" active={follow} onPress={() => {
            setFollow(true);
            dlog('нажата «где я»: ready=', nav?.ready, nav ? `${nav.lat.toFixed(5)},${nav.lon.toFixed(5)}` : 'nav=null');
            if (!nav?.ready) setToast('Место ещё не определено. Нажмите кнопку с жуком — там видно, что происходит.');
          }} />
        </View>
      )}

      {/* ---------- Ведение ---------- */}
      {screen === 'nav' && sheet === 'none' && !fuelOn && (
        <>
          <Appear key="man" from="top"><ManeuverCard nav={nav} hasRoute={!!plan} /></Appear>
          <SpeedOverlay nav={nav} limit={curLimit} top={plan ? sz(150) : sz(50)} />
          <Appear key="navb"><NavBottom
            nav={nav}
            plan={plan}
            onStop={stop}
            onHere={() => { setPicking(true); setFollow(false); }}
            onTurnNow={() => {
              const text = engine.snapToManeuver(now());
              log.add({ e: 'turnNow', t: now() });
              setToast(text ? `Встали на поворот: ${text.toLowerCase()}` : 'Рядом нет поворота на маршруте');
            }}
            details={details}
            weather={wxRoute}
            extra={(shownProblem || detours || plan?.stops?.length) ? <>
              {plan?.stops?.length ? <StopsPill stops={plan.stops} onRemove={removeStop} /> : null}
              {shownProblem && <ProblemCard p={shownProblem} busy={avoiding} onAvoid={() => avoidProblem(shownProblem)} onSkip={() => { skippedProblems.current.set(probKey(shownProblem), Date.now() + 15 * 60_000); setProblem(null); setYProblem(null); }} />}
              {detours && <DetourCard offers={detours.offers} onTake={takeDetour} onSkip={skipDetour} />}
            </> : null}
          /></Appear>
        </>
      )}

      {screen === 'preview' && dest && (
        <Appear key="preview"><RoutePreview dest={dest} plans={plans} loading={planning || !nav?.ready} mode={mode} onMode={setMode} onGo={go} trafficNote={trafficNote} weather={wxRoute}
          trip={trips.find((t) => t.id === activeTripId)}
          onRemoveStop={removeStop}
          extra={(shownProblem || detours) ? <>
            {shownProblem && <ProblemCard p={shownProblem} busy={avoiding} onAvoid={() => avoidProblem(shownProblem)} onSkip={() => { skippedProblems.current.set(probKey(shownProblem), Date.now() + 15 * 60_000); setProblem(null); setYProblem(null); }} />}
            {detours && <DetourCard offers={detours.offers} onTake={takeDetour} onSkip={skipDetour} />}
          </> : null}
          onPrepareOffline={prepareOffline}
          onRetry={() => { resetHostHealth(); setPlans({}); setPlanNonce((n) => n + 1); }}
          hasGisKey={!!settings.gisKey}
          onClose={() => { setScreen('map'); setDest(null); setPlans({}); setFollow(true); }} /></Appear>
      )}

      {fuelOn && (screen === 'map' || screen === 'nav' || screen === 'preview') && (
        <Appear key="fuel"><FuelSheet stations={fuelList} reports={fuelReports} filter={fuelFilter} onFilter={setFuelFilter} busy={fuelBusy} note={fuelNote}
          onRefresh={loadFuel} onClose={toggleFuel} onRoute={routeToFuel}
          onAddStop={screen === 'map' && !dest ? undefined : (st) => { setFuelOn(false); addStop({ name: st.name, lat: st.lat, lon: st.lon }); }}
          onMark={markFuel} /></Appear>
      )}

      {cand && (
        <PlaceCard
          place={cand}
          top={top + sz(12)}
          wide={wide}
          onGo={() => { const p = cand; setCand(null); pickDest(p); }}
          onAddStop={() => { const p = cand; setCand(null); addStop({ name: p.name, lat: p.lat, lon: p.lon }); }}
          onClose={() => setCand(null)}
        />
      )}

      {screen === 'search' && (
        <Appear key="search" from="fade"><SearchScreen near={nav?.ready ? { lat: nav.lat, lon: nav.lon } : undefined} trips={trips} recent={recent} onPick={pickDest} onClose={() => setScreen('map')}
          onOpenTrip={openTrip} onDeleteTrip={removeTrip} onToast={setToast}
          onFuelCommand={() => { setScreen('map'); if (!fuelOn) toggleFuel(); }}
          onDeleteRecent={(p) => removeRecent(p).then(setRecent)} onClearRecent={() => clearRecent().then(setRecent)} /></Appear>
      )}

      {picking && (
        <View style={[ui.card, s.pick]}>
          <View style={{ flex: 1 }}>
            <Text style={s.pickText}>Нажмите на карте, где вы сейчас</Text>
            {nav?.next && (
              <Pressable style={{ marginTop: 6 }} onPress={() => {
                const text = engine.snapToManeuver(now());
                setPicking(false);
                setFollow(true);
                setToast(text ? `Встали на: ${text}` : 'Привязано к маневру');
              }}>
                <Text style={{ color: C.blue, fontWeight: '700', fontSize: 13 }}>📍 Ориентир: {nav.next.text}</Text>
              </Pressable>
            )}
          </View>
          <Pressable onPress={() => setPicking(false)}><Text style={s.pickCancel}>Отмена</Text></Pressable>
        </View>
      )}

      {sheet === 'settings' && (
        <Appear key="settings"><SettingsSheet
          near={nav?.ready ? { lat: nav.lat, lon: nav.lon } : undefined}
          learned={{ total: learner.size, usable: learner.records().length }}
          onClearLearned={() => { learner.clear(); clearLearned(); setToast('Своя база вышек очищена'); }}
          data={data} settings={settings} onSettings={updateSettings} onImport={doImport}
          obd={obd} adapters={adapters}
          onScanObd={async () => setAdapters(await listAdapters())}
          onConnectObd={(a) => { obdLink.current?.connect(a); }}
          onDisconnectObd={() => obdLink.current?.disconnect()}
          onClose={() => setSheet('none')}
          onOpenMaps={() => setSheet('maps')}
          onOpenRegions={() => setSheet('regions')}
          mapsSummary={mapsSummary}
          onSelfTest={runSelfTest}
        /></Appear>
      )}

      {sheet === 'maps' && (
        <Appear key="maps" from="fade"><MapDownloads near={nav?.ready ? { lat: nav.lat, lon: nav.lon } : undefined} route={data?.route ?? null} trips={trips} onDeleteTrip={removeTrip}
          routeName={data?.plan?.dest?.name} usingFileMap={!!data?.mapUri} onClose={() => setSheet('settings')}
          areaCells={areaCells} cellsTotal={data?.cells?.size ?? 0} showCells={showCells}
          onShowCells={(v) => { setShowCells(v); if (v) setToast(`На карте — вышки рядом с вами (${engine.cellDb?.near(nav ? { lat: nav.lat, lon: nav.lon } : { lat: 0, lon: 0 }, 40).length ?? 0})`); }} /></Appear>
      )}

      {sheet === 'regions' && (
        <Appear key="regions" from="fade"><RegionsSheet near={nav?.ready ? { lat: nav.lat, lon: nav.lon } : undefined}
          settings={settings} onSettings={updateSettings} onToast={setToast} onClose={() => setSheet('settings')} /></Appear>
      )}

      {debug && <DebugPanel onClose={() => setDebug(false)} jam={jam} onJam={(v) => { setJam(v); engine.simulateJam = v; dlog(v ? '🧪 тест глушения ВКЛ: GPS игнорируется' : '🧪 тест глушения ВЫКЛ'); }} />}

      {servicesOff && (
        <Pressable style={[ui.card, s.locOff]} onPress={enableLocation}>
          <Icon name="map-marker-off-outline" size={26} color={C.red} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={s.locOffTitle}>Геолокация в телефоне выключена</Text>
            <Text style={ui.sub}>Без неё Android не даёт ни GPS, ни вышки, ни Wi‑Fi. Нажмите, чтобы включить.</Text>
          </View>
        </Pressable>
      )}

      {!!(toast || permError) && (
        <Appear key={toast || permError} from={screen === 'nav' ? 'bottom' : 'top'}>
          <View style={[s.toast, screen === 'nav' && { top: undefined, bottom: sz(230) }, wide && { right: undefined, width: PANEL_W - 16 }]}><Text style={s.toastText}>{toast || permError}</Text></View>
        </Appear>
      )}
    </View>
  );
}

const s = themed(() => ({
  root: { flex: 1, backgroundColor: C.bg },
  map: { flex: 1 },
  search: { position: 'absolute', top: sz(44), left: sz(12), right: sz(12), height: sz(54), flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16) },
  searchIcon: { fontSize: sz(22), color: C.sub, marginRight: sz(10) },
  searchText: { fontSize: sz(17), color: C.hint },
  savedPlanBanner: { position: 'absolute', top: sz(108), left: sz(12), right: sz(12), padding: sz(12), flexDirection: 'row', alignItems: 'center', backgroundColor: C.cardAlt, borderRadius: sz(16), ...shadow },
  savedPlanTitle: { fontSize: sz(15), fontWeight: '700', color: C.text },
  status: { position: 'absolute', left: sz(12), right: sz(12), bottom: sz(24), padding: sz(12), paddingTop: sz(6) },
  side: { position: 'absolute', right: sz(12), bottom: sz(140) },
  locOff: { position: 'absolute', top: sz(108), left: sz(12), right: sz(12), padding: sz(12), flexDirection: 'row', alignItems: 'center', backgroundColor: C.redSoft },
  locOffTitle: { fontSize: sz(15), fontWeight: '700', color: C.red },
  pick: { position: 'absolute', top: sz(150), left: sz(12), right: sz(12), padding: sz(14), flexDirection: 'row', alignItems: 'center', backgroundColor: C.warnSoft },
  pickText: { fontSize: sz(15), color: C.warnText, flex: 1 },
  pickCancel: { fontSize: sz(15), fontWeight: '700', color: C.blue, marginLeft: sz(12) },
  toast: { position: 'absolute', top: sz(110), left: sz(24), right: sz(24), backgroundColor: C.toast, borderRadius: sz(12), padding: sz(12), ...shadow },
  toastText: { color: '#fff', fontSize: sz(14), textAlign: 'center' },
}));
