// Стоим на месте, маршрут построен (3 км на запад), GPS «подменён» (0 спутников), сеть ±80–140 м. По логу 27.10 09:53–09:54.
import { NavEngine } from '../src/core/engine.ts';
const M = 1 / 111320, K = 79500;
const TRUE = { lat: 44.59730, lon: 33.49560 };
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
export function run(verbose = true, hand = false) {
  const e = new NavEngine(); e.setTravelMode('car');
  const T0 = 1_790_000_000;
  const route = Array.from({ length: 60 }, (_, i) => ({ lat: 44.5973 - i * 0.00002, lon: 33.4947 - i * 0.0005 }));
  const wifiAll = Array.from({ length: 12 }, (_, i) => ({ bssid: `aa:bb:00:00:00:${i.toString(16).padStart(2, '0')}`, dbm: -55 - i * 3 }));
  let maxErr = 0, maxV = 0;
  for (let s = 0; s <= 100; s++) {
    const t = T0 + s;
    for (let k = 0; k < 10; k++) e.onGyro(t - 1 + k * 0.1, toR(0.25) + rnd() * toR(0.4) + (hand ? rnd() * 0.1 : 0));
    e.onGnssSignal(t, { used: 0, cn0Top: 0, cn0Std: 0, agc: -65 });
    const tilt = hand ? 3 + Math.abs(rnd()) * 2 : 0.3 + Math.abs(rnd()) * 0.8;
    e.onMotion(t, 0.1 + Math.abs(rnd()) * 0.8, 0.07 + Math.abs(rnd()) * 0.2, tilt);
    if (s === 14) e.setRoute(route);
    if (s === 0 || s === 30 || s === 66 || s === 90) e.onNetworkFix(t, { lat: TRUE.lat + rnd() * 70 * M, lon: TRUE.lon + rnd() * 70 * M / 0.71, accuracy: s === 0 ? 140 : 80 + Math.abs(rnd()) * 20 }, 'сеть');
    if (s % 2 === 0) e.onGps({ t, lat: 44.59742, lon: 33.49589, accuracy: 88, speed: 0, bearing: 0 });
    if (s % 5 === 0) e.onCells(t, [], wifiAll.filter((w, i) => i < 4 || Math.abs(rnd()) > FLICK));
    if (s % 5 === 0 && s >= 10) {
      const st = e.getState(t);
      const err = Math.hypot((st.lat - TRUE.lat) / M, (st.lon - TRUE.lon) * K);
      maxErr = Math.max(maxErr, err); maxV = Math.max(maxV, st.speedKmh);
      if (verbose) console.log(String(s).padStart(3), 'err', err.toFixed(0).padStart(4), 'м  v', st.speedKmh.toFixed(1).padStart(5), 'σ', Math.round(st.sigma), st.gps, '|', st.mode);
    }
  }
  return { maxErr: Math.round(maxErr), maxKmh: +maxV.toFixed(1) };
}
let FLICK = 0.5;
const toR = (d: number) => d * Math.PI / 180;
if (process.argv[1]?.endsWith('standing_route.ts')) { for (const f of [0.35, 0.5, 0.6]) { FLICK = f; console.log('мерцание Wi‑Fi', f, run(false), 'в руке', run(false, true)); } }
