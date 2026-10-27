// Все датчики -> ядро навигации. Экран только читает отсюда состояние раз в секунду.

import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { NavEngine, type NavState } from './core/engine';
import { CellDb, CellLearner, cellKey, type CellId, type WifiAp } from './core/cells';
import { MotionSensors } from './sensors';
import { TripLog, loadLearned, saveLearned } from './data';
import { beaconLocate, mylnikovCell, mylnikovWifi } from './online';
import { wifiKey } from './core/cells';
import { ObdLink, type ObdState } from './obdLink';
import CarSensors from '../modules/car-sensors';
import { dlog, dlogError, dlogEvery } from './debugLog';
import { voice } from './voice';

const now = () => Date.now() / 1000;

export function useNavigation() {
  const engine = useRef(new NavEngine()).current;
  const sensors = useRef(new MotionSensors()).current;
  const log = useRef(new TripLog()).current;
  const obdRef = useRef<ObdLink | null>(null);
  const learner = useRef(new CellLearner()).current;
  const lastFixRef = useRef<{ t: number; lat: number; lon: number; acc: number } | null>(null);

  /** Подмешать свою базу вышек/Wi‑Fi в ядро (после загрузки файла вышек — тоже). */
  const applyLearned = () => {
    if (!engine.cellDb) engine.setCellDb(new CellDb());
    learner.applyTo(engine.cellDb!);
  };

  const [nav, setNav] = useState<NavState | null>(null);
  const [obd, setObd] = useState<{ s: ObdState; err: string }>({ s: 'off', err: '' });
  const [gyroOk, setGyroOk] = useState<boolean | null>(null);
  const [permError, setPermError] = useState('');
  const [servicesOff, setServicesOff] = useState(false);

  useEffect(() => {
    let alive = true;
    const cleanups: (() => void)[] = [];

    obdRef.current = new ObdLink(
      (t, kmh) => { engine.onObd(t, kmh); log.add({ e: 'obd', t, kmh }); },
      (s, err) => setObd({ s, err }),
    );

    const onFix = (loc: Location.LocationObject, src: string) => {
      try {
        const c = loc.coords;
        dlogEvery('gps', 10, `${src} ${c.latitude.toFixed(5)},${c.longitude.toFixed(5)} ±${Math.round(c.accuracy ?? -1)}м v=${c.speed?.toFixed(1)} курс=${c.heading?.toFixed(0)} mocked=${loc.mocked}`);
        if (loc.mocked) { dlog('⚠ точка помечена как «фальшивая» (mocked) — пропускаю'); return; }
        const t = now();
        const fix = { t, lat: c.latitude, lon: c.longitude, accuracy: c.accuracy ?? 999, speed: c.speed, bearing: c.heading };

        // Если точка пришла от сети/вышека — отправляем в нативную сетевую привязку
        const provider = (loc as any).provider;
        if (provider === 'network' || src === 'network') {
          engine.onNetworkFix(t, fix, 'сети');
          return;
        }

        // «Последняя известная точка» — это кэш Android, он может быть подменённым и старым
        // (так стрелка «уезжала» со скоростью 41 м/с на стоящем телефоне). Берём только свежую,
        // без скорости и курса, и только если она согласуется с сетью.
        if (src === 'last') {
          const age = (Date.now() - (loc.timestamp ?? 0)) / 1000;
          if (!(age >= 0 && age < 10)) { dlog(`⚠ старая точка (${Math.round(age)} с назад) — игнорирую`); return; }
          fix.speed = null; fix.bearing = null;
          const st = engine.getState(t);
          if (!st.coarse) { dlog('⚠ старая точка без проверки сетью — игнорирую'); return; }
          if (Math.hypot((fix.lat - st.coarse.lat) * 111.32, (fix.lon - st.coarse.lon) * 111.32) > 3.0) {
            dlog(`⚠ старая точка далека от сети — игнорирую`);
            return;
          }
        }

        if (src !== 'last') lastFixRef.current = { t, lat: fix.lat, lon: fix.lon, acc: fix.accuracy };
        const before = engine.getState(t);
        engine.onGps(fix);
        const after = engine.getState(t);
        if (before.ready !== after.ready || before.gps !== after.gps) {
          dlog(`ядро: ready ${before.ready}→${after.ready}, gps ${before.gps}→${after.gps} ${after.gpsReason}`);
          voice.announceGpsStatus(after.gps, after.gpsReason);
        }
        if (after.gps === 'ok') sensors.feedGps(t, fix.bearing, fix.speed);
        log.add({ e: 'gps', ...fix });
      } catch (e) { dlogError('onFix', e); }
    };

    (async () => {
      try {
        dlog('старт: CarSensors (родной модуль) =', CarSensors ? 'есть' : 'НЕТ');
        try {
          const txt = await loadLearned();
          if (txt) learner.load(txt);
          applyLearned();
          dlog(`своя база вышек/Wi‑Fi: ${learner.size} источников, годных ${learner.records().length}`);
        } catch (e) { dlogError('своя база', e); }
        log.start();
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!alive) return;
        dlog('разрешение геолокации:', perm.status, 'точность:', (perm as any).android?.accuracy ?? '?');
        if (perm.status !== 'granted') setPermError('Без разрешения на геолокацию не работают ни GPS, ни вышки.');
        else if ((perm as any).android?.accuracy === 'coarse') setPermError('Разрешено только «приблизительное» местоположение. Включите «Точное» в настройках приложения.');

        let n = 0;
        const guard = <A extends unknown[]>(name: string, f: (...a: A) => void) => (...a: A) => { try { f(...a); } catch (e) { dlogError(name, e); } };
        const ok = await sensors.start({
          onRate: guard('onRate', (t: number, r: number) => { engine.onGyro(t, r); if (++n % 5 === 0) log.add({ e: 'gyro', t, r }); }),
          onMotion: guard('onMotion', (t: number, aH: number, vib: number, tilt: number) => {
            engine.onMotion(t, aH, vib, tilt); log.add({ e: 'motion', t, aH, vib, tilt });
            dlogEvery('движение', 20, `aH=${aH.toFixed(2)} тряска=${vib.toFixed(2)} наклон=${tilt.toFixed(1)}°/с`);
          }),
          onStep: guard('onStep', (t: number) => { engine.onStep(t); log.add({ e: 'step', t }); }),
          onAzimuth: guard('onAzimuth', (t: number, az: number) => { engine.onAzimuth(t, az); log.add({ e: 'az', t, az }); }),
        });
        dlog('датчики (гироскоп+акселерометр):', ok ? 'запущены' : 'НЕДОСТУПНЫ');
        setGyroOk(ok);
        cleanups.push(() => sensors.stop());

        if (perm.status !== 'granted') return;

        // Native-мониторы (спутники, «место по сети») — отдельно от GPS-подписки,
        // чтобы ошибка одного не останавливала остальное.
        if (CarSensors) {
          try {
            const gs = CarSensors.addListener('onGnssSignal', (g) => {
              try {
                const t = now();
                dlogEvery('спутники', 15, `в решении ${g.used} из ${g.total}, C/N0 ${g.cn0Top?.toFixed?.(1)}, AGC ${g.agc ?? '-'}`);
                const sig = { used: g.used, cn0Top: g.cn0Top, cn0Std: g.cn0Std, agc: g.agc ?? null };
                engine.onGnssSignal(t, sig);
                log.add({ e: 'gnss', t, ...sig });
              } catch (e) { dlogError('onGnssSignal', e); }
            });
            CarSensors.startGnssMonitor().then((r) => dlog('монитор спутников:', r)).catch((e) => dlogError('startGnssMonitor', e));
            cleanups.push(() => { gs.remove(); CarSensors?.stopGnssMonitor().catch(() => {}); });
          } catch (e) { dlogError('монитор спутников', e); }
          try {
            // Место «по сети»: Android сам считает по вышкам и Wi‑Fi (спутники не участвуют)
            const ns = CarSensors.addListener('onNetworkLocation', (e) => {
              try {
                dlogEvery('сеть', 6, `место по сети ${e.lat.toFixed(5)},${e.lon.toFixed(5)} ±${Math.round(e.accuracy)}м, возраст ${e.age.toFixed(0)} с`);
                if (e.age > 60) return;
                const t = now();
                engine.onNetworkFix(t, { lat: e.lat, lon: e.lon, accuracy: e.accuracy }, 'сети (вышки/Wi‑Fi)');
                log.add({ e: 'net', t, lat: e.lat, lon: e.lon, acc: e.accuracy });
              } catch (x) { dlogError('onNetworkLocation', x); }
            });
            CarSensors.startNetworkLocation().then((r) => dlog('место по сети (NETWORK_PROVIDER):', r ? 'включено' : 'НЕТ в телефоне')).catch((e) => dlogError('startNetworkLocation', e));
            cleanups.push(() => { ns.remove(); CarSensors?.stopNetworkLocation().catch(() => {}); });
          } catch (e) { dlogError('место по сети', e); }
        }

        // GPS-подписка. Если геолокация в телефоне выключена — Android её не даёт;
        // проверяем каждые 5 с и запускаем, как только включат.
        let watching = false, starting = false, lastOn: boolean | null = null;
        const startWatch = async () => {
          if (watching || starting) return;
          starting = true;
          try {
            Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 })
              .then((l) => { dlog('последняя известная точка:', l ? 'есть' : 'нет'); if (l) onFix(l, 'last'); })
              .catch((e) => dlogError('lastKnown', e));
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation })
              .then((l) => onFix(l, 'current'))
              .catch((e) => dlogError('currentPosition', e));
            const sub = await Location.watchPositionAsync(
              { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 0, mayShowUserSettingsDialog: true },
              (loc) => onFix(loc, 'watch'),
              (reason) => dlog('❌ watchPosition ошибка:', reason),
            );
            if (!alive) { sub.remove(); return; }
            watching = true;
            dlog('подписка на GPS запущена');
            cleanups.push(() => sub.remove());
          } catch (e) { dlogError('подписка на GPS', e); }
          finally { starting = false; }
        };
        const checkServices = async () => {
          try {
            const on = await Location.hasServicesEnabledAsync();
            if (on !== lastOn) {
              lastOn = on;
              dlog('геолокация в телефоне:', on ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА', on ? JSON.stringify(await Location.getProviderStatusAsync()) : '');
              setServicesOff(!on);
            }
            if (on) startWatch();
          } catch (e) { dlogError('проверка геолокации', e); }
        };
        await checkServices();
        const svcTimer = setInterval(checkServices, 5000);
        cleanups.push(() => clearInterval(svcTimer));
      } catch (e) { dlogError('запуск', e); }
    })();

    // Вышки и Wi‑Fi раз в 5 с: определяем место, учим свою базу, спрашиваем beaconDB
    const asked = new Set<string>();     // какие вышки уже спрашивали у beaconDB
    let lastBeaconT = 0, lastLearnSaveT = now(), beaconFails = 0;
    // База Мыльникова: свои счётчики, чтобы не долбить сервер
    const askedMyl = new Set<string>();
    let lastMylT = 0, mylFails = 0, mylTotal = 0;
    const cellTimer = setInterval(async () => {
      if (!CarSensors) return;
      try {
        const t = now();
        const cells = await CarSensors.getCells();
        let wifi: WifiAp[] = [];
        try { wifi = (await CarSensors.getWifi?.()) ?? []; } catch (e) { dlogEvery('wifi-ошибка', 20, 'Wi‑Fi:', String((e as Error)?.message ?? e)); }
        const ids: CellId[] = cells.map((c) => ({ mcc: c.mcc, mnc: c.mnc, area: c.area, cid: c.cid, dbm: c.dbm, radio: c.radio, registered: c.registered, ta: c.ta ?? null }));
        engine.onCells(t, ids, wifi);
        log.add({ e: 'cells', t, cells: ids, wifi: wifi.length });
        const st = engine.getState(t);
        dlogEvery('вышки', 12, `видно вышек ${ids.length}, Wi‑Fi ${wifi.length}; знаем ${st.cellsKnown}; своя: ${ids.filter((c) => c.registered).map((c) => `${c.radio} ${cellKey(c)} ta=${c.ta ?? '-'}`).join(', ') || 'нет'}`);

        // 1) Учимся: GPS честный, точный и согласуется с вышками/сетью
        const f = lastFixRef.current;
        // Если точность GPS отличная (<= 20 м), считаем спутники нормальными даже если Android не отдал их count
        const realSats = st.gnssUsed == null || st.gnssUsed >= 4 || (f != null && f.acc <= 20);
        const netAgrees = !st.coarse || Math.hypot((f?.lat ?? 0) - st.coarse.lat, (f?.lon ?? 0) - st.coarse.lon) < 0.02; // < 2.2 км от сети
        if (f && t - f.t < 5 && st.gps === 'ok' && !st.gpsReason && !st.signalHint && realSats && netAgrees) {
          const n = learner.observe(t, f, f.acc, ids, wifi);
          if (n) dlogEvery('учёба', 15, `запомнил ${n} источников у точки ±${Math.round(f.acc)}м; всего ${learner.size}`);
        }
        if (learner.dirty && t - lastLearnSaveT > 60) {
          lastLearnSaveT = t; learner.dirty = false;
          applyLearned();
          saveLearned(learner.toJson()).catch((e) => dlogError('сохранить базу', e));
        }

        // 2) Интернет есть — спрашиваем beaconDB (не чаще раза в 20 с, после ошибок реже)
        if (t - lastBeaconT > 20 * (1 + Math.min(beaconFails, 5)) && (ids.length || wifi.length >= 2)) {
          lastBeaconT = t;
          const unknown = ids.find((c) => c.registered && !engine.cellDb?.has(cellKey(c)) && !asked.has(cellKey(c)));
          try {
            if (unknown) {
              // где стоит «своя» вышка — запомним её в базу на будущее (офлайн)
              asked.add(cellKey(unknown));
              const r = await beaconLocate([unknown], [], { areaFallback: false });
              dlog(`beaconDB: вышка ${cellKey(unknown)} →`, r ? `${r.lat.toFixed(4)},${r.lon.toFixed(4)} ±${Math.round(r.accuracy)}м` : 'не знает');
              if (r && r.accuracy < 15000) { learner.putKnown(cellKey(unknown), { lat: r.lat, lon: r.lon, range: Math.max(500, r.accuracy) }); applyLearned(); }
            } else if (st.gps !== 'ok') {
              // GPS нет/подменён — просим место по всем вышкам и Wi‑Fi
              const r = await beaconLocate(ids, wifi, { areaFallback: true });
              dlog('beaconDB: место по вышкам/Wi‑Fi →', r ? `${r.lat.toFixed(5)},${r.lon.toFixed(5)} ±${Math.round(r.accuracy)}м` : 'не знает');
              if (r) engine.onNetworkFix(now(), r, 'beaconDB');
            }
            beaconFails = 0;
          } catch (e) {
            beaconFails++;
            dlogEvery('beaconDB-ошибка', 5, 'beaconDB недоступен:', String((e as Error)?.message ?? e));
          }
        }

        // 3) База Мыльникова: вышка и самые сильные Wi‑Fi, которых ещё нет в нашей базе.
        //    Не чаще раза в 10 с, не больше 4 запросов за раз и 400 за запуск; после ошибок — реже.
        if (t - lastMylT > 10 * (1 + Math.min(mylFails, 6)) && mylTotal < 400 && (ids.length || wifi.length)) {
          lastMylT = t;
          const near = (r: { lat: number; lon: number }, km: number) =>
            !st.coarse || Math.hypot((r.lat - st.coarse.lat) * 111.32, (r.lon - st.coarse.lon) * 78) < km; // отсекаем явный мусор
          const jobs: Promise<void>[] = [];
          const cell = ids.find((c) => c.registered && !engine.cellDb?.has(cellKey(c)) && !askedMyl.has(cellKey(c)));
          if (cell) {
            askedMyl.add(cellKey(cell)); mylTotal++;
            jobs.push(mylnikovCell(cell).then((r) => {
              dlog(`Мыльников: вышка ${cellKey(cell)} →`, r ? `${r.lat.toFixed(4)},${r.lon.toFixed(4)} ±${Math.round(r.accuracy)}м` : 'не знает');
              if (r && near(r, 25)) { learner.putKnown(cellKey(cell), { lat: r.lat, lon: r.lon, range: Math.max(500, r.accuracy) }); applyLearned(); }
            }));
          }
          const todo = [...wifi].sort((a, b) => b.dbm - a.dbm)
            .filter((w) => !engine.cellDb?.has(wifiKey(w)) && !askedMyl.has(wifiKey(w))).slice(0, 4);
          for (const w of todo) {
            askedMyl.add(wifiKey(w)); mylTotal++;
            jobs.push(mylnikovWifi(w.bssid).then((r) => {
              if (r && near(r, 5)) { learner.putKnown(wifiKey(w), { lat: r.lat, lon: r.lon, range: Math.max(50, Math.min(300, r.accuracy)) }); applyLearned(); }
            }));
          }
          if (jobs.length) {
            try {
              await Promise.all(jobs);
              if (todo.length) dlogEvery('Мыльников-wifi', 3, `Мыльников: Wi‑Fi спросили ${todo.length}, в базе теперь ${engine.cellDb?.size ?? 0} записей`);
              mylFails = 0;
            } catch (e) {
              mylFails++;
              dlogEvery('Мыльников-ошибка', 5, 'база Мыльникова недоступна:', String((e as Error)?.message ?? e));
            }
          }
        }
      } catch (e) { dlogError('вышки', e); }
    }, 5000);

    // Экран — раз в секунду, журнал — раз в 10 с
    let k = 0;
    const uiTimer = setInterval(() => {
      try {
        const st = engine.getState(now());
        setNav(st);
        if (k % 15 === 0) dlog(`состояние: ready=${st.ready} gps=${st.gps} (${st.gpsReason}) ±${Math.round(st.sigma)}м ведёт: ${st.mode}; ${st.context} | ${st.dbg}`);
      } catch (e) { dlogError('getState', e); }
      if (++k % 10 === 0) { try { log.flush(); } catch (e) { dlogError('журнал', e); } }
    }, 1000);

    return () => {
      alive = false;
      clearInterval(cellTimer);
      clearInterval(uiTimer);
      cleanups.forEach((f) => f());
      obdRef.current?.disconnect();
      log.flush();
      if (learner.dirty) saveLearned(learner.toJson()).catch(() => {});
    };
  }, []);

  /** Показать системное окно «Включить геолокацию?» (Android). */
  const enableLocation = () => Location.enableNetworkProviderAsync().catch((e) => dlogError('включить геолокацию', e));

  return { engine, log, nav, obd, obdLink: obdRef, gyroOk, permError, servicesOff, enableLocation, now, applyLearned, learner, runSelfTest: () => engine.runSelfTest() };
}
